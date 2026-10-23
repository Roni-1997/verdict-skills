import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionStatus, prepareExecution } from '../packages/core/src/index.js';
import { HostedJobs } from '../packages/mcp/src/hosted-jobs.js';
import { HostedError, type Job } from '../packages/mcp/src/hosted-model.js';

const stores: HostedJobs[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'verdict-jobs-'));
  roots.push(directory);
  return directory;
}
function open(directory = root()): HostedJobs {
  const store = new HostedJobs(directory);
  stores.push(store);
  return store;
}
function proposal() {
  return prepareExecution({ legs: [{ venue: 'hl', network: 'testnet', account: `0x${'1'.repeat(40)}`, outcome: 123,
    title: 'Oracle event', settlementRule: 'The specified oracle resolves YES when the closing value exceeds 100.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'Ioc',
    builder: { address: `0x${'2'.repeat(40)}`, feeTenthsBp: 0 }, allInFeeBpsCap: '10',
  }], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } });
}
function input(): Pick<Job, 'owner' | 'bindingHash' | 'purpose' | 'proposal' | 'leg' | 'expiresAt'> {
  const p = proposal();
  return { owner: 'a'.repeat(64), bindingHash: 'b'.repeat(64), purpose: 'submit', proposal: p, leg: null, expiresAt: p.payload.expiresAt - 1000 };
}
function claim(job: Job, now = Date.now()) { return { id: job.id, owner: job.owner, bindingHash: job.bindingHash, now }; }
function observation(job: Job, complete = false): ExecutionStatus {
  return ExecutionStatus.parse({ digest: job.proposal.digest, state: complete ? 'complete' : 'needs_reconciliation',
    legs: [{ leg: 0, state: complete ? 'filled' : 'unknown', filled: complete ? '10.000' : null,
      netInventoryChange: complete ? '10' : null, settled: complete }], automaticRetry: false, note: 'Public nonfunded observation.' });
}
function errorCode(operation: () => unknown, code: string) {
  expect(operation).toThrow(HostedError);
  try { operation(); } catch (error) { expect(error).toMatchObject({ code }); }
}

describe('durable hosted approval and dispatch state', () => {
  it('creates a canonical private job once, never extends approval expiry and survives reopening', () => {
    const directory = root(); const first = open(directory); const data = input();
    const job = first.getOrCreate(data);
    expect(job).toMatchObject({ ...data, state: 'pending', result: null });
    expect(first.getOrCreate({ ...data, expiresAt: data.expiresAt + 100 })).toEqual(job);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'jobs.sqlite')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, '.jobs-initialized')).mode & 0o777).toBe(0o600);
    first.close();
    const reopened = open(directory);
    expect(reopened.get(job.id)).toEqual(job);
    expect(reopened.find({ owner: job.owner, purpose: 'submit', digest: job.proposal.digest, leg: null })).toEqual(job);
    const raw = readFileSync(join(directory, 'jobs.sqlite'));
    expect(raw.includes(Buffer.from('access_token'))).toBe(false);
    expect(raw.includes(Buffer.from('privateKey'))).toBe(false);
  });

  it('isolates users, purpose, exact leg and binding revision without losing original intent lookup', () => {
    const store = open(); const data = input(); const original = store.getOrCreate(data);
    const other = store.getOrCreate({ ...data, owner: 'c'.repeat(64) });
    const revision = store.getOrCreate({ ...data, bindingHash: 'd'.repeat(64) });
    const cancel = store.getOrCreate({ ...data, purpose: 'cancel', leg: 0, expiresAt: data.proposal.payload.expiresAt + 60_000 });
    expect(new Set([original.id, other.id, revision.id, cancel.id]).size).toBe(4);
    expect(store.find({ owner: data.owner, purpose: 'submit', digest: data.proposal.digest, leg: null })).toEqual(original);
    expect(store.find({ owner: other.owner, purpose: 'submit', digest: data.proposal.digest, leg: null })).toEqual(other);
    expect(store.find({ owner: data.owner, purpose: 'cancel', digest: data.proposal.digest, leg: 0 })).toEqual(cancel);
    expect(store.find({ owner: 'e'.repeat(64), purpose: 'submit', digest: data.proposal.digest, leg: null })).toBeNull();
  });

  it('atomically claims once across independent connections and keeps attempted state across restart and expiry', () => {
    const directory = root(); const first = open(directory); const second = open(directory); const job = first.getOrCreate(input());
    expect(first.claim(claim(job)).kind).toBe('claimed');
    expect(second.claim(claim(job)).kind).toBe('already_attempted');
    first.close(); second.close();
    const reopened = open(directory);
    expect(reopened.claim(claim(job, job.expiresAt + 1))).toMatchObject({ kind: 'already_attempted', job: { state: 'attempted', result: null } });
    reopened.observe(job.id, observation(job, true));
    expect(reopened.claim(claim(job, job.expiresAt + 2))).toMatchObject({ kind: 'already_attempted', job: { state: 'observed' } });
  });

  it('denies wrong owner, changed binding, expiry, declined jobs and invalid states before claiming', () => {
    const store = open(); const job = store.getOrCreate(input());
    errorCode(() => store.claim({ ...claim(job), owner: 'c'.repeat(64) }), 'job_owner');
    errorCode(() => store.claim({ ...claim(job), bindingHash: 'c'.repeat(64) }), 'binding_changed');
    errorCode(() => store.claim(claim(job, job.expiresAt)), 'approval_expired');
    expect(store.get(job.id)?.state).toBe('pending');
    errorCode(() => store.observe(job.id, observation(job)), 'not_attempted');
    expect(store.decline(claim(job, job.expiresAt + 1)).state).toBe('declined');
    errorCode(() => store.claim(claim(job)), 'approval_declined');
    errorCode(() => store.decline(claim(job)), 'not_pending');
  });

  it('validates canonical proposals and submit/cancel purpose rather than persisting arbitrary payloads', () => {
    const store = open(); const data = input();
    const altered = structuredClone(data); altered.proposal.digest = 'e'.repeat(64);
    errorCode(() => store.getOrCreate(altered), 'invalid_job');
    errorCode(() => store.getOrCreate({ ...data, leg: 0 }), 'invalid_job');
    errorCode(() => store.getOrCreate({ ...data, purpose: 'cancel', leg: null }), 'invalid_job');
    errorCode(() => store.getOrCreate({ ...data, purpose: 'cancel', leg: 1 }), 'invalid_job');
    errorCode(() => store.getOrCreate({ ...data, expiresAt: data.proposal.payload.expiresAt + 1 }), 'invalid_job');
    const injected = { ...data, approved: true, access_token: 'must-not-persist' };
    errorCode(() => store.getOrCreate(injected), 'invalid_job');
    const job = store.getOrCreate(data);
    expect(store.get(job.id)).toEqual(job);
  });

  it('accepts cleanup expiry independent of the original proposal and never replays a claimed cancellation', () => {
    const store = open(); const data = input();
    const cancel = store.getOrCreate({ ...data, purpose: 'cancel', leg: 0, expiresAt: data.proposal.payload.expiresAt + 60_000 });
    expect(store.claim(claim(cancel, data.proposal.payload.expiresAt + 100)).kind).toBe('claimed');
    expect(store.claim(claim(cancel, cancel.expiresAt + 1)).kind).toBe('already_attempted');
  });

  it('persists correlated observations without granting approval or accepting mismatched results', () => {
    const store = open(); const job = store.getOrCreate(input()); store.claim(claim(job));
    errorCode(() => store.observe(job.id, { ...observation(job), digest: 'c'.repeat(64) }), 'storage_unavailable');
    const impossible = observation(job, true); const firstLeg = impossible.legs[0];
    if (!firstLeg) throw new Error('Expected the single fake leg');
    firstLeg.filled = '0';
    errorCode(() => store.observe(job.id, impossible), 'storage_unavailable');
    expect(store.get(job.id)?.state).toBe('attempted');
    store.observe(job.id, observation(job));
    expect(store.get(job.id)).toMatchObject({ state: 'observed', result: { state: 'needs_reconciliation' } });
    store.observe(job.id, observation(job, true));
    expect(store.get(job.id)?.result?.state).toBe('complete');
  });

  it('fails closed after missing, replaced or corrupt initialized database/marker', () => {
    for (const damage of ['missing-db', 'missing-marker', 'truncate-db', 'change-marker']) {
      const directory = root(); const store = open(directory); store.getOrCreate(input()); store.close();
      if (damage === 'missing-db') unlinkSync(join(directory, 'jobs.sqlite'));
      else if (damage === 'missing-marker') unlinkSync(join(directory, '.jobs-initialized'));
      else if (damage === 'truncate-db') writeFileSync(join(directory, 'jobs.sqlite'), '');
      else writeFileSync(join(directory, '.jobs-initialized'), '{"version":1,"databaseId":"11111111-1111-4111-8111-111111111111"}');
      expect(() => new HostedJobs(directory)).toThrow(HostedError);
    }
  });

  it('refuses unsafe directories, symlinks and database modes without exposing their paths', () => {
    const directory = root(); chmodSync(directory, 0o755);
    errorCode(() => new HostedJobs(directory), 'storage_unavailable');
    chmodSync(directory, 0o700);
    const alias = join(root(), 'alias'); symlinkSync(directory, alias);
    errorCode(() => new HostedJobs(alias), 'storage_unavailable');
    const store = open(directory); store.close(); chmodSync(join(directory, 'jobs.sqlite'), 0o644);
    try { new HostedJobs(directory); } catch (error) {
      expect(error).toBeInstanceOf(HostedError);
      expect(String(error)).not.toContain(directory);
    }
    expect(existsSync(join(directory, 'jobs.sqlite'))).toBe(true);
  });

  it('detects state removal and permission changes while a connection remains open', () => {
    const directory = root(); const store = open(directory); const job = store.getOrCreate(input());
    chmodSync(join(directory, 'jobs.sqlite'), 0o644);
    errorCode(() => store.get(job.id), 'storage_unavailable');
    chmodSync(join(directory, 'jobs.sqlite'), 0o600);
    unlinkSync(join(directory, '.jobs-initialized'));
    errorCode(() => store.get(job.id), 'storage_unavailable');
  });

  it('allows only one mutation claimant across real competing processes', async () => {
    const directory = root(); const store = open(directory); const job = store.getOrCreate(input());
    const fixture = root();
    const core = new URL('../packages/core/dist/index.js', import.meta.url).href;
    for (const name of ['hosted-model', 'hosted-jobs']) {
      const source = readFileSync(new URL(`../packages/mcp/src/${name}.ts`, import.meta.url), 'utf8');
      const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText
        .replace(/(['"])@verdict\/core\1/g, JSON.stringify(core)).replaceAll('./hosted-model.js', './hosted-model.mjs');
      writeFileSync(join(fixture, `${name}.mjs`), compiled);
    }
    // Resolve the existing Zod package from the repository for the temporary real-process modules.
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(fixture, 'node_modules'));
    const childCode = `import {HostedJobs} from ${JSON.stringify(new URL(`file://${join(fixture, 'hosted-jobs.mjs')}`).href)};
      const store=new HostedJobs(process.argv[1]); const claim=JSON.parse(process.argv[2]);
      process.stdout.write('ready\\n'); process.stdin.once('data',()=>{process.stdout.write(store.claim(claim).kind+'\\n');store.close();});`;
    const start = () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, directory, JSON.stringify(claim(job))], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let error = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', () => { if (output.includes('ready\n')) resolve(); });
        child.once('error', reject); child.once('exit', (code) => { if (!output.includes('ready\n')) reject(new Error(`Child startup failed: ${code}: ${error}`)); });
      });
      const result = new Promise<string>((resolve, reject) => {
        child.once('exit', (code) => code === 0 ? resolve(output.trim().split('\n').at(-1) ?? '') : reject(new Error(`Child failed: ${error}`)));
      });
      return { child, ready, result };
    };
    const first = start(); const second = start();
    try {
      await Promise.all([first.ready, second.ready]); first.child.stdin.end('go'); second.child.stdin.end('go');
      expect((await Promise.all([first.result, second.result])).sort()).toEqual(['already_attempted', 'claimed']);
      expect(store.get(job.id)?.state).toBe('attempted');
    } finally { first.child.kill(); second.child.kill(); }
  });
});
