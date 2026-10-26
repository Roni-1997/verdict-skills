import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ExecutionStatus, LighterIntentPlan, validateExecution } from '@verdict/core';
import { z } from 'zod';
import { AuthorityRef, Digest, HostedError, Job } from './hosted-model.js';

const Input = Job.pick({ owner: true, bindingHash: true, purpose: true, proposal: true, leg: true, expiresAt: true, authorization: true })
  .extend({ expiresAt: z.number().int().nonnegative().safe() });
type Input = z.input<typeof Input>;
const Lookup = Job.pick({ owner: true, purpose: true, leg: true }).extend({ digest: Digest }).strict();
type Lookup = z.input<typeof Lookup>;
const Claim = Job.pick({ id: true, owner: true, bindingHash: true }).extend({ now: z.number().int().nonnegative().safe() }).strict();
type Claim = z.input<typeof Claim>;
const Marker = z.object({ version: z.literal(1), databaseId: z.string().uuid(), intentVersion: z.literal(1).optional() }).strict();
const Row = z.object({ id: z.string(), owner: z.string(), binding_hash: z.string(), purpose: z.string(),
  digest: z.string(), leg: z.number().int(), data: z.string().max(1_048_576),
}).strict();
const IntentIdentity = z.object({ owner: Digest, bindingHash: Digest, authorization: AuthorityRef,
  intentId: z.string().uuid(), inputHash: Digest }).strict();
type IntentIdentity = z.infer<typeof IntentIdentity>;
const IntentRow = z.object({ owner: Digest, binding_hash: Digest, grant_id: z.string().uuid(), epoch: z.number().int().nonnegative().safe(),
  intent_id: z.string().uuid(), input_hash: Digest, claim_id: z.string().uuid(), lease_until: z.number().int().nonnegative().safe(), data: z.string().max(1_048_576).nullable(),
}).strict();

function storageError(): HostedError {
  return new HostedError(503, 'storage_unavailable', 'Hosted execution state is unavailable. Restore the original private state before trading; do not recreate or retry an uncertain order.');
}
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HostedError(400, 'invalid_job', 'Invalid hosted execution job data.');
  return result.data;
}
function privateFile(path: string): { dev: number; ino: number } {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600) throw storageError();
  return { dev: info.dev, ino: info.ino };
}
function readMarker(path: string): z.output<typeof Marker> {
  privateFile(path);
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(file).size > 1024) throw storageError();
    return Marker.parse(JSON.parse(readFileSync(file, 'utf8')));
  } finally { closeSync(file); }
}
function createFile(path: string, contents: string): void {
  const file = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(file, contents, 'utf8'); fsyncSync(file); } finally { closeSync(file); }
}
function syncDirectory(path: string): void {
  const directory = openSync(path, constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function sameDecimal(a: string, b: string): boolean {
  const normalized = (value: string) => value.replace(/^0+(?=\d)/, '').replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
  return normalized(a) === normalized(b);
}
function checkResult(proposal: Job['proposal'], value: unknown): ExecutionStatus {
  const result = ExecutionStatus.parse(value);
  if (result.digest !== proposal.digest || result.legs.length !== proposal.payload.legs.length
    || result.legs.some((leg, index) => leg.leg !== index)) throw storageError();
  if (result.state === 'complete' && result.legs.some((row, index) => {
    const leg = proposal.payload.legs[index];
    return !leg || !row.settled || !['filled', 'canceled', 'expired', 'rejected'].includes(row.state)
      || row.filled === null || row.netInventoryChange === null
      || !sameDecimal(row.filled, leg.shares) || !sameDecimal(row.netInventoryChange, leg.shares);
  })) throw storageError();
  return result;
}
function canonicalJob(value: unknown): Job {
  const job = Job.parse(value);
  const proposal = validateExecution(job.proposal);
  if (!Number.isSafeInteger(job.expiresAt) || (job.purpose === 'submit' && job.leg !== null)
    || (job.purpose === 'cancel' && (job.leg === null || job.leg >= proposal.payload.legs.length))
    || (job.purpose === 'submit' && job.expiresAt > proposal.payload.expiresAt)
    || (job.state === 'observed') !== (job.result !== null)) throw storageError();
  if (job.result !== null) checkResult(proposal, job.result);
  return { ...job, proposal };
}

/** Durable consumer consent and dispatch fencing; trading policy remains in the private Broker. */
export class HostedJobs {
  private readonly database: DatabaseSync;
  private readonly root: string;
  private readonly databasePath: string;
  private readonly markerPath: string;
  private readonly marker: z.output<typeof Marker>;
  private readonly identity: { dev: number; ino: number };
  private closed = false;

  constructor(stateDir: string) {
    let database: DatabaseSync | undefined;
    try {
      if (!isAbsolute(stateDir) || stateDir.includes('\0')) throw storageError();
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const directory = lstatSync(stateDir);
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o7777) !== 0o700) throw storageError();
      this.root = stateDir;
      this.databasePath = join(stateDir, 'jobs.sqlite');
      this.markerPath = join(stateDir, '.jobs-initialized');
      const markerExists = existsSync(this.markerPath);
      const databaseExists = existsSync(this.databasePath);
      if (markerExists !== databaseExists) throw storageError();
      if (!markerExists) {
        this.marker = { version: 1, databaseId: randomUUID(), intentVersion: 1 };
        createFile(this.markerPath, `${JSON.stringify(this.marker)}\n`);
        syncDirectory(stateDir);
        createFile(this.databasePath, '');
        syncDirectory(stateDir);
      } else this.marker = readMarker(this.markerPath);
      this.identity = privateFile(this.databasePath);
      // This module is loaded only by explicit hosted execution, never keyless startup.
      const sqlite: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite');
      database = new sqlite.DatabaseSync(this.databasePath);
      database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      if (!markerExists) {
        database.exec(`BEGIN IMMEDIATE;
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, binding_hash TEXT NOT NULL,
            purpose TEXT NOT NULL, digest TEXT NOT NULL, leg INTEGER NOT NULL, data TEXT NOT NULL,
            UNIQUE(owner,binding_hash,purpose,digest,leg)) STRICT;
          CREATE INDEX job_intent ON jobs(owner,purpose,digest,leg);`);
        database.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('database_id', this.marker.databaseId);
        database.exec('COMMIT;');
        syncDirectory(stateDir);
      }
      const metadata = z.object({ value: z.string() }).strict().parse(database.prepare("SELECT value FROM metadata WHERE key='database_id'").get());
      if (metadata.value !== this.marker.databaseId) throw storageError();
      const intentTable = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='lighter_intents'").get();
      if (markerExists && this.marker.intentVersion === 1 && !intentTable) throw storageError();
      if (!markerExists || this.marker.intentVersion === undefined) {
        database.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS lighter_intents (
          owner TEXT NOT NULL, binding_hash TEXT NOT NULL, grant_id TEXT NOT NULL, epoch INTEGER NOT NULL,
          intent_id TEXT NOT NULL, input_hash TEXT NOT NULL, claim_id TEXT NOT NULL, lease_until INTEGER NOT NULL, data TEXT,
          PRIMARY KEY(owner,binding_hash,grant_id,epoch,intent_id)) STRICT;`);
        database.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('intent_version','1')").run();
        database.exec('COMMIT');
        if (this.marker.intentVersion === undefined) {
          const next = { ...this.marker, intentVersion: 1 } satisfies z.output<typeof Marker>;
          const temporary = join(stateDir, `.jobs-upgrade-${randomUUID()}`);
          createFile(temporary, `${JSON.stringify(next)}\n`); renameSync(temporary, this.markerPath); syncDirectory(stateDir);
          this.marker = next;
        }
      }
      if (database.prepare("SELECT value FROM metadata WHERE key='intent_version'").get()?.value !== '1') throw storageError();
      const integrity = z.object({ integrity_check: z.literal('ok') }).strict().parse(database.prepare('PRAGMA integrity_check').get());
      if (integrity.integrity_check !== 'ok') throw storageError();
      this.database = database;
    } catch {
      try { database?.close(); } catch { /* Preserve the sanitized state failure. */ }
      throw storageError();
    }
  }

  private guard(): void {
    if (this.closed) throw storageError();
    const root = lstatSync(this.root);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o7777) !== 0o700) throw storageError();
    const identity = privateFile(this.databasePath);
    if (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino
      || JSON.stringify(readMarker(this.markerPath)) !== JSON.stringify(this.marker)) throw storageError();
  }
  private safe<T>(operation: () => T): T {
    try { this.guard(); return operation(); }
    catch (error) { if (error instanceof HostedError) throw error; throw storageError(); }
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* A failed write never authorizes another dispatch. */ }
      throw error;
    }
  }
  private row(value: unknown): Job | null {
    if (value === undefined) return null;
    const row = Row.parse(value);
    const job = canonicalJob(JSON.parse(row.data));
    if (row.id !== job.id || row.owner !== job.owner || row.binding_hash !== job.bindingHash || row.purpose !== job.purpose
      || row.digest !== job.proposal.digest || row.leg !== (job.leg ?? -1)) throw storageError();
    return job;
  }
  private byId(id: string): Job | null { return this.row(this.database.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  private write(job: Job): void {
    const data = JSON.stringify(canonicalJob(job));
    if (Buffer.byteLength(data) > 1_048_576) throw new HostedError(400, 'invalid_job', 'Hosted execution job exceeds the state size limit.');
    this.database.prepare('UPDATE jobs SET data=? WHERE id=?').run(data, job.id);
  }

  getOrCreate(value: Input): Job {
    const input = parse(Input, value);
    let proposal: Job['proposal'];
    try { proposal = validateExecution(input.proposal); }
    catch { throw new HostedError(400, 'invalid_job', 'Expected an unchanged canonical execution proposal.'); }
    if ((input.purpose === 'submit' && input.leg !== null)
      || (input.purpose === 'cancel' && (input.leg === null || input.leg >= proposal.payload.legs.length))
      || (input.purpose === 'submit' && input.expiresAt > proposal.payload.expiresAt)) {
      throw new HostedError(400, 'invalid_job', 'Job purpose, leg or approval expiry does not match the proposal.');
    }
    return this.safe(() => this.transaction(() => {
      const existing = this.row(this.database.prepare('SELECT * FROM jobs WHERE owner=? AND binding_hash=? AND purpose=? AND digest=? AND leg=?')
        .get(input.owner, input.bindingHash, input.purpose, proposal.digest, input.leg ?? -1));
      if (existing) return existing;
      const job: Job = { ...input, proposal, id: randomUUID(), state: 'pending', result: null };
      const data = JSON.stringify(canonicalJob(job));
      if (Buffer.byteLength(data) > 1_048_576) throw new HostedError(400, 'invalid_job', 'Hosted execution job exceeds the state size limit.');
      this.database.prepare('INSERT INTO jobs(id,owner,binding_hash,purpose,digest,leg,data) VALUES (?,?,?,?,?,?,?)')
        .run(job.id, job.owner, job.bindingHash, job.purpose, job.proposal.digest, job.leg ?? -1, data);
      return job;
    }));
  }
  get(id: string): Job | null { parse(Job.shape.id, id); return this.safe(() => this.byId(id)); }
  find(value: Lookup): Job | null {
    const input = parse(Lookup, value);
    return this.safe(() => this.row(this.database.prepare('SELECT * FROM jobs WHERE owner=? AND purpose=? AND digest=? AND leg=? ORDER BY rowid LIMIT 1')
      .get(input.owner, input.purpose, input.digest, input.leg ?? -1)));
  }
  claim(value: Claim): { kind: 'claimed' | 'already_attempted'; job: Job } {
    const input = parse(Claim, value);
    return this.safe(() => this.transaction(() => {
      const job = this.owned(input);
      if (job.state === 'attempted' || job.state === 'observed') return { kind: 'already_attempted', job };
      if (job.state === 'declined') throw new HostedError(409, 'approval_declined', 'This execution request was declined.');
      if (input.now >= job.expiresAt) throw new HostedError(410, 'approval_expired', 'This execution approval has expired.');
      const attempted: Job = { ...job, state: 'attempted' };
      this.write(attempted);
      return { kind: 'claimed', job: attempted };
    }));
  }
  private owned(input: Claim): Job {
    const job = this.byId(input.id);
    if (!job) throw new HostedError(404, 'job_not_found', 'Execution request was not found.');
    if (job.owner !== input.owner) throw new HostedError(403, 'job_owner', 'Execution request belongs to another account connection.');
    if (job.bindingHash !== input.bindingHash) throw new HostedError(409, 'binding_changed', 'Account connection changed; the original request cannot execute.');
    return job;
  }
  observe(id: string, value: ExecutionStatus): void {
    parse(Job.shape.id, id);
    this.safe(() => this.transaction(() => {
      const job = this.byId(id);
      if (!job || !['attempted', 'observed'].includes(job.state)) throw new HostedError(409, 'not_attempted', 'Only an attempted execution can receive an observation.');
      const result = checkResult(job.proposal, value);
      this.write({ ...job, state: 'observed', result });
    }));
  }
  decline(value: Claim): Job {
    const input = parse(Claim, value);
    return this.safe(() => this.transaction(() => {
      const job = this.owned(input);
      if (job.state !== 'pending') throw new HostedError(409, 'not_pending', 'Only a pending request can be declined.');
      const declined: Job = { ...job, state: 'declined' };
      this.write(declined);
      return declined;
    }));
  }

  claimIntent(value: IntentIdentity & { now: number }): { kind: 'prepared'; plan: LighterIntentPlan } | { kind: 'claimed'; claimId: string } {
    const input = parse(IntentIdentity.extend({ now: z.number().int().nonnegative().safe() }), value);
    return this.safe(() => this.transaction(() => {
      const args = [input.owner, input.bindingHash, input.authorization.grantId, input.authorization.epoch, input.intentId];
      const value = this.database.prepare('SELECT * FROM lighter_intents WHERE owner=? AND binding_hash=? AND grant_id=? AND epoch=? AND intent_id=?').get(...args);
      if (value !== undefined) {
        const row = IntentRow.parse(value);
        if (row.input_hash !== input.inputHash) throw new HostedError(409, 'intent_changed', 'This intent ID already belongs to a different trade request.');
        if (row.data !== null) {
          const plan = LighterIntentPlan.parse(JSON.parse(row.data)); validateExecution(plan.proposal);
          if (plan.proposal.payload.requestId !== input.intentId) throw storageError();
          return { kind: 'prepared', plan };
        }
        if (row.lease_until > input.now) throw new HostedError(409, 'intent_preparing', 'This intent is being prepared. Retry the same intent ID after its read completes.');
      }
      const claimId = randomUUID();
      this.database.prepare(`INSERT INTO lighter_intents(owner,binding_hash,grant_id,epoch,intent_id,input_hash,claim_id,lease_until,data)
        VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(owner,binding_hash,grant_id,epoch,intent_id)
        DO UPDATE SET claim_id=excluded.claim_id,lease_until=excluded.lease_until`)
        .run(...args, input.inputHash, claimId, input.now + 30_000);
      return { kind: 'claimed', claimId };
    }));
  }

  saveIntent(value: IntentIdentity & { claimId: string; plan: LighterIntentPlan }): LighterIntentPlan {
    const input = parse(IntentIdentity.extend({ claimId: z.string().uuid(), plan: LighterIntentPlan }), value);
    const plan = { ...input.plan, proposal: validateExecution(input.plan.proposal) };
    if (plan.proposal.payload.requestId !== input.intentId) throw new HostedError(400, 'invalid_intent', 'Proposal does not match the reserved intent.');
    const data = JSON.stringify(plan);
    if (Buffer.byteLength(data) > 1_048_576) throw new HostedError(400, 'invalid_intent', 'Prepared intent exceeds its state size limit.');
    return this.safe(() => this.transaction(() => {
      const result = this.database.prepare(`UPDATE lighter_intents SET data=? WHERE owner=? AND binding_hash=? AND grant_id=? AND epoch=? AND intent_id=? AND input_hash=? AND claim_id=? AND data IS NULL`)
        .run(data, input.owner, input.bindingHash, input.authorization.grantId, input.authorization.epoch, input.intentId, input.inputHash, input.claimId);
      if (result.changes !== 1) throw new HostedError(409, 'intent_claim_changed', 'The intent preparation claim changed. Retrieve the same intent ID; do not submit an unsaved proposal.');
      return plan;
    }));
  }

  abandonIntent(value: IntentIdentity & { claimId: string }): void {
    const input = parse(IntentIdentity.extend({ claimId: z.string().uuid() }), value);
    this.safe(() => {
      this.database.prepare(`UPDATE lighter_intents SET lease_until=0 WHERE owner=? AND binding_hash=? AND grant_id=? AND epoch=? AND intent_id=? AND input_hash=? AND claim_id=? AND data IS NULL`)
        .run(input.owner, input.bindingHash, input.authorization.grantId, input.authorization.epoch, input.intentId, input.inputHash, input.claimId);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.database.close(); } catch { throw storageError(); }
  }
}
