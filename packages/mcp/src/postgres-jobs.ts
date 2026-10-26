import { randomUUID } from 'node:crypto';
import { ExecutionStatus, LighterIntentPlan, validateExecution } from '@verdict/core';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { HostedJobs } from './hosted-jobs.js';
import { AuthorityRef, Digest, HostedError, Job } from './hosted-model.js';
import type { SharedPublicTransaction } from './hosted-security.js';

/** Migration/admin entry point only. Runtime repositories never execute DDL or create their marker. */
export const POSTGRES_JOBS_DDL = `
CREATE SCHEMA IF NOT EXISTS verdict_mcp;
CREATE TABLE IF NOT EXISTS verdict_mcp.jobs_metadata (
  deployment_id UUID PRIMARY KEY, database_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1), intent_version INTEGER NOT NULL CHECK (intent_version = 1)
);
CREATE TABLE IF NOT EXISTS verdict_mcp.hosted_jobs (
  deployment_id UUID NOT NULL REFERENCES verdict_mcp.jobs_metadata(deployment_id),
  id UUID NOT NULL, owner TEXT NOT NULL, binding_hash TEXT NOT NULL, purpose TEXT NOT NULL,
  digest TEXT NOT NULL, leg INTEGER NOT NULL, data JSONB NOT NULL,
  created_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (deployment_id,id), UNIQUE (deployment_id,owner,binding_hash,purpose,digest,leg),
  CHECK (purpose IN ('submit','cancel')), CHECK (leg BETWEEN -1 AND 1), CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS hosted_jobs_original_intent ON verdict_mcp.hosted_jobs
  (deployment_id,owner,purpose,digest,leg,created_sequence);
CREATE TABLE IF NOT EXISTS verdict_mcp.lighter_intents (
  deployment_id UUID NOT NULL REFERENCES verdict_mcp.jobs_metadata(deployment_id),
  owner TEXT NOT NULL, binding_hash TEXT NOT NULL, grant_id UUID NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch BETWEEN 0 AND 9007199254740991), intent_id UUID NOT NULL,
  input_hash TEXT NOT NULL, claim_id UUID NOT NULL,
  lease_until BIGINT NOT NULL CHECK (lease_until BETWEEN 0 AND 9007199254740991), data JSONB,
  PRIMARY KEY (deployment_id,owner,binding_hash,grant_id,epoch,intent_id),
  CHECK (data IS NULL OR jsonb_typeof(data) = 'object')
);`;

const Config = z.object({ deploymentId: z.string().uuid(), databaseId: z.string().uuid() }).strict();
const Marker = z.object({ database_id: z.string().uuid(), version: z.literal(1), intent_version: z.literal(1) }).strict();
const Tables = z.object({ jobs: z.literal(true), intents: z.literal(true) }).strict();
const Input = Job.pick({ owner: true, bindingHash: true, purpose: true, proposal: true, leg: true, expiresAt: true, authorization: true })
  .extend({ expiresAt: z.number().int().nonnegative().safe() });
const Lookup = Job.pick({ owner: true, purpose: true, leg: true }).extend({ digest: Digest }).strict();
const Claim = Job.pick({ id: true, owner: true, bindingHash: true }).extend({ now: z.number().int().nonnegative().safe() }).strict();
const IntentIdentity = z.object({ owner: Digest, bindingHash: Digest, authorization: AuthorityRef,
  intentId: z.string().uuid(), inputHash: Digest }).strict();
const SafeInteger = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative().safe());
const JobRow = z.object({ id: z.string().uuid(), owner: Digest, binding_hash: Digest,
  purpose: z.enum(['submit', 'cancel']), digest: Digest, leg: z.number().int(), data: z.unknown() }).strict();
const IntentRow = z.object({ owner: Digest, binding_hash: Digest, grant_id: z.string().uuid(), epoch: SafeInteger,
  intent_id: z.string().uuid(), input_hash: Digest, claim_id: z.string().uuid(), lease_until: SafeInteger, data: z.unknown() }).strict();
const jobColumns = 'id,owner,binding_hash,purpose,digest,leg,data';
const intentColumns = 'owner,binding_hash,grant_id,epoch,intent_id,input_hash,claim_id,lease_until,data';

function storageError(): HostedError {
  return new HostedError(503, 'storage_unavailable', 'Hosted execution state is unavailable. Restore the original private state before trading; do not recreate or retry an uncertain order.');
}
function input<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HostedError(400, 'invalid_job', 'Invalid hosted execution job data.');
  return result.data;
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
function encoded(value: unknown): string {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 1_048_576) throw new HostedError(400, 'invalid_job', 'Hosted execution job exceeds the state size limit.');
  return data;
}
function jobRow(value: unknown): Job | null {
  if (value === undefined) return null;
  const row = JobRow.parse(value);
  if (Buffer.byteLength(JSON.stringify(row.data)) > 1_048_576) throw storageError();
  const job = canonicalJob(row.data);
  if (row.id !== job.id || row.owner !== job.owner || row.binding_hash !== job.bindingHash || row.purpose !== job.purpose
    || row.digest !== job.proposal.digest || row.leg !== (job.leg ?? -1)) throw storageError();
  return job;
}

/** Shared durable jobs. The injected Pool is borrowed and remains owned by the application. */
export class PostgresHostedJobs {
  private readonly deploymentId: string;
  private readonly databaseId: string;
  private readonly pool: Pool;
  private closed = false;

  constructor(options: { pool: Pool; deploymentId: string; databaseId: string }) {
    const config = Config.safeParse({ deploymentId: options.deploymentId, databaseId: options.databaseId });
    if (!config.success) throw storageError();
    this.deploymentId = config.data.deploymentId;
    this.databaseId = config.data.databaseId;
    this.pool = options.pool;
  }

  private async guard(tx: PoolClient): Promise<void> {
    if (this.closed) throw storageError();
    const marker = await tx.query('SELECT database_id,version,intent_version FROM verdict_mcp.jobs_metadata WHERE deployment_id=$1', [this.deploymentId]);
    if (marker.rowCount !== 1 || Marker.parse(marker.rows[0]).database_id !== this.databaseId) throw storageError();
    const tables = await tx.query("SELECT to_regclass('verdict_mcp.hosted_jobs') IS NOT NULL AS jobs,to_regclass('verdict_mcp.lighter_intents') IS NOT NULL AS intents");
    Tables.parse(tables.rows[0]);
  }

  private async transaction<T>(body: (tx: PoolClient) => Promise<T>): Promise<T> {
    if (this.closed) throw storageError();
    let tx: PoolClient | undefined;
    try {
      tx = await this.pool.connect();
      await tx.query('BEGIN');
      await tx.query("SET LOCAL statement_timeout = '5s'");
      await tx.query("SET LOCAL lock_timeout = '1s'");
      await this.guard(tx);
      const result = await body(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      try { await tx?.query('ROLLBACK'); } catch { /* State loss never authorizes another dispatch. */ }
      if (error instanceof HostedError) throw error;
      throw storageError();
    } finally { tx?.release(); }
  }

  private async byId(tx: PoolClient, id: string, lock = false): Promise<Job | null> {
    const result = await tx.query(`SELECT ${jobColumns} FROM verdict_mcp.hosted_jobs WHERE deployment_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [this.deploymentId, id]);
    return jobRow(result.rows[0]);
  }
  private async owned(tx: PoolClient, value: z.output<typeof Claim>): Promise<Job> {
    const job = await this.byId(tx, value.id, true);
    if (!job) throw new HostedError(404, 'job_not_found', 'Execution request was not found.');
    if (job.owner !== value.owner) throw new HostedError(403, 'job_owner', 'Execution request belongs to another account connection.');
    if (job.bindingHash !== value.bindingHash) throw new HostedError(409, 'binding_changed', 'Account connection changed; the original request cannot execute.');
    return job;
  }
  private async write(tx: PoolClient, job: Job, states: readonly Job['state'][]): Promise<Job> {
    const result = await tx.query(`UPDATE verdict_mcp.hosted_jobs SET data=$3::jsonb
      WHERE deployment_id=$1 AND id=$2 AND data->>'state'=ANY($4::text[]) RETURNING ${jobColumns}`,
    [this.deploymentId, job.id, encoded(canonicalJob(job)), states]);
    const saved = jobRow(result.rows[0]);
    if (!saved || result.rowCount !== 1) throw storageError();
    return saved;
  }

  async getOrCreate(value: Parameters<HostedJobs['getOrCreate']>[0]): Promise<ReturnType<HostedJobs['getOrCreate']>> {
    const parsed = input(Input, value);
    let proposal: Job['proposal'];
    try { proposal = validateExecution(parsed.proposal); }
    catch { throw new HostedError(400, 'invalid_job', 'Expected an unchanged canonical execution proposal.'); }
    if ((parsed.purpose === 'submit' && parsed.leg !== null)
      || (parsed.purpose === 'cancel' && (parsed.leg === null || parsed.leg >= proposal.payload.legs.length))
      || (parsed.purpose === 'submit' && parsed.expiresAt > proposal.payload.expiresAt)) {
      throw new HostedError(400, 'invalid_job', 'Job purpose, leg or approval expiry does not match the proposal.');
    }
    const job: Job = { ...parsed, proposal, id: randomUUID(), state: 'pending', result: null };
    const data = encoded(canonicalJob(job));
    return this.transaction(async (tx) => {
      await tx.query(`INSERT INTO verdict_mcp.hosted_jobs(deployment_id,id,owner,binding_hash,purpose,digest,leg,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(deployment_id,owner,binding_hash,purpose,digest,leg) DO NOTHING`,
      [this.deploymentId, job.id, job.owner, job.bindingHash, job.purpose, proposal.digest, job.leg ?? -1, data]);
      const found = await tx.query(`SELECT ${jobColumns} FROM verdict_mcp.hosted_jobs
        WHERE deployment_id=$1 AND owner=$2 AND binding_hash=$3 AND purpose=$4 AND digest=$5 AND leg=$6`,
      [this.deploymentId, job.owner, job.bindingHash, job.purpose, proposal.digest, job.leg ?? -1]);
      const original = jobRow(found.rows[0]);
      if (!original) throw storageError();
      return original;
    });
  }
  async get(id: Parameters<HostedJobs['get']>[0]): Promise<ReturnType<HostedJobs['get']>> {
    input(Job.shape.id, id);
    return this.transaction((tx) => this.byId(tx, id));
  }
  async find(value: Parameters<HostedJobs['find']>[0]): Promise<ReturnType<HostedJobs['find']>> {
    const parsed = input(Lookup, value);
    return this.transaction(async (tx) => {
      const result = await tx.query(`SELECT ${jobColumns} FROM verdict_mcp.hosted_jobs
        WHERE deployment_id=$1 AND owner=$2 AND purpose=$3 AND digest=$4 AND leg=$5 ORDER BY created_sequence LIMIT 1`,
      [this.deploymentId, parsed.owner, parsed.purpose, parsed.digest, parsed.leg ?? -1]);
      return jobRow(result.rows[0]);
    });
  }
  async claim(value: Parameters<HostedJobs['claim']>[0], transaction?: SharedPublicTransaction): Promise<ReturnType<HostedJobs['claim']>> {
    const parsed = input(Claim, value);
    const operation = async (tx: PoolClient): Promise<ReturnType<HostedJobs['claim']>> => {
      const job = await this.owned(tx, parsed);
      if (job.state === 'attempted' || job.state === 'observed') return { kind: 'already_attempted', job };
      if (job.state === 'declined') throw new HostedError(409, 'approval_declined', 'This execution request was declined.');
      if (parsed.now >= job.expiresAt) throw new HostedError(410, 'approval_expired', 'This execution approval has expired.');
      const attempted = await this.write(tx, { ...job, state: 'attempted' }, ['pending']);
      return { kind: 'claimed', job: attempted };
    };
    if (transaction === undefined) return this.transaction(operation);
    if (transaction.kind !== 'postgres' || transaction.deploymentId !== this.deploymentId || transaction.databaseId !== this.databaseId) throw storageError();
    try {
      await this.guard(transaction.client);
      return await operation(transaction.client);
    } catch (error) {
      if (error instanceof HostedError) throw error;
      throw storageError();
    }
  }
  async observe(...args: Parameters<HostedJobs['observe']>): Promise<ReturnType<HostedJobs['observe']>> {
    const [id, value] = args;
    input(Job.shape.id, id);
    await this.transaction(async (tx) => {
      const job = await this.byId(tx, id, true);
      if (!job || !['attempted', 'observed'].includes(job.state)) throw new HostedError(409, 'not_attempted', 'Only an attempted execution can receive an observation.');
      const result = checkResult(job.proposal, value);
      await this.write(tx, { ...job, state: 'observed', result }, ['attempted', 'observed']);
    });
  }
  async decline(value: Parameters<HostedJobs['decline']>[0]): Promise<ReturnType<HostedJobs['decline']>> {
    const parsed = input(Claim, value);
    return this.transaction(async (tx) => {
      const job = await this.owned(tx, parsed);
      if (job.state !== 'pending') throw new HostedError(409, 'not_pending', 'Only a pending request can be declined.');
      return this.write(tx, { ...job, state: 'declined' }, ['pending']);
    });
  }

  async claimIntent(value: Parameters<HostedJobs['claimIntent']>[0]): Promise<ReturnType<HostedJobs['claimIntent']>> {
    const parsed = input(IntentIdentity.extend({ now: z.number().int().nonnegative().safe() }), value);
    if (!Number.isSafeInteger(parsed.now + 30_000)) throw new HostedError(400, 'invalid_job', 'Invalid intent preparation time.');
    return this.transaction(async (tx) => {
      const values = [this.deploymentId, parsed.owner, parsed.bindingHash, parsed.authorization.grantId, parsed.authorization.epoch, parsed.intentId];
      const claimId = randomUUID();
      const inserted = await tx.query(`INSERT INTO verdict_mcp.lighter_intents(deployment_id,owner,binding_hash,grant_id,epoch,intent_id,input_hash,claim_id,lease_until,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL) ON CONFLICT(deployment_id,owner,binding_hash,grant_id,epoch,intent_id) DO NOTHING`,
      [...values, parsed.inputHash, claimId, parsed.now + 30_000]);
      if (inserted.rowCount === 1) return { kind: 'claimed', claimId };
      const found = await tx.query(`SELECT ${intentColumns} FROM verdict_mcp.lighter_intents
        WHERE deployment_id=$1 AND owner=$2 AND binding_hash=$3 AND grant_id=$4 AND epoch=$5 AND intent_id=$6 FOR UPDATE`, values);
      const row = IntentRow.parse(found.rows[0]);
      if (row.input_hash !== parsed.inputHash) throw new HostedError(409, 'intent_changed', 'This intent ID already belongs to a different trade request.');
      if (row.data !== null) {
        if (Buffer.byteLength(JSON.stringify(row.data)) > 1_048_576) throw storageError();
        const plan = LighterIntentPlan.parse(row.data);
        validateExecution(plan.proposal);
        if (plan.proposal.payload.requestId !== parsed.intentId) throw storageError();
        return { kind: 'prepared', plan };
      }
      if (row.lease_until > parsed.now) throw new HostedError(409, 'intent_preparing', 'This intent is being prepared. Retry the same intent ID after its read completes.');
      const changed = await tx.query(`UPDATE verdict_mcp.lighter_intents SET claim_id=$7,lease_until=$8
        WHERE deployment_id=$1 AND owner=$2 AND binding_hash=$3 AND grant_id=$4 AND epoch=$5 AND intent_id=$6 AND data IS NULL AND lease_until<=$9`,
      [...values, claimId, parsed.now + 30_000, parsed.now]);
      if (changed.rowCount !== 1) throw storageError();
      return { kind: 'claimed', claimId };
    });
  }
  async saveIntent(value: Parameters<HostedJobs['saveIntent']>[0]): Promise<ReturnType<HostedJobs['saveIntent']>> {
    const parsed = input(IntentIdentity.extend({ claimId: z.string().uuid(), plan: LighterIntentPlan }), value);
    const plan = { ...parsed.plan, proposal: validateExecution(parsed.plan.proposal) };
    if (plan.proposal.payload.requestId !== parsed.intentId) throw new HostedError(400, 'invalid_intent', 'Proposal does not match the reserved intent.');
    const data = encoded(plan);
    return this.transaction(async (tx) => {
      const result = await tx.query(`UPDATE verdict_mcp.lighter_intents SET data=$9::jsonb
        WHERE deployment_id=$1 AND owner=$2 AND binding_hash=$3 AND grant_id=$4 AND epoch=$5 AND intent_id=$6 AND input_hash=$7 AND claim_id=$8 AND data IS NULL`,
      [this.deploymentId, parsed.owner, parsed.bindingHash, parsed.authorization.grantId, parsed.authorization.epoch, parsed.intentId, parsed.inputHash, parsed.claimId, data]);
      if (result.rowCount !== 1) throw new HostedError(409, 'intent_claim_changed', 'The intent preparation claim changed. Retrieve the same intent ID; do not submit an unsaved proposal.');
      return plan;
    });
  }
  async abandonIntent(value: Parameters<HostedJobs['abandonIntent']>[0]): Promise<ReturnType<HostedJobs['abandonIntent']>> {
    const parsed = input(IntentIdentity.extend({ claimId: z.string().uuid() }), value);
    await this.transaction(async (tx) => {
      await tx.query(`UPDATE verdict_mcp.lighter_intents SET lease_until=0
        WHERE deployment_id=$1 AND owner=$2 AND binding_hash=$3 AND grant_id=$4 AND epoch=$5 AND intent_id=$6 AND input_hash=$7 AND claim_id=$8 AND data IS NULL`,
      [this.deploymentId, parsed.owner, parsed.bindingHash, parsed.authorization.grantId, parsed.authorization.epoch, parsed.intentId, parsed.inputHash, parsed.claimId]);
    });
  }
  async close(): Promise<void> { this.closed = true; }
}
