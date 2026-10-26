import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionStatus, LighterIntentPlan, prepareExecution } from '../packages/core/src/index.js';
import type { HostedJobs } from '../packages/mcp/src/hosted-jobs.js';
import type { Job } from '../packages/mcp/src/hosted-model.js';
import { POSTGRES_JOBS_DDL, PostgresHostedJobs } from '../packages/mcp/src/postgres-jobs.js';

const testDsn = process.env.VERDICT_TEST_POSTGRES;
const now = Date.now();
const stores: PostgresHostedJobs[] = [];
const pools: Pool[] = [];
const poolConnections = new Map<Pool, Set<Promise<void>>>();
let admin: Pool;
let database: Pool;
let childUrl: string;
let deploymentId: string;
let databaseId: string;
const childDatabase = `verdict_mcp_test_jobs_${randomUUID().replaceAll('-', '')}`;
let created = false;

function createPool(connectionString: string, max: number): Pool {
  const pool = new Pool({ connectionString, max });
  const connections = new Set<Promise<void>>();
  poolConnections.set(pool, connections);
  pool.on('connect', (client) => {
    const ended = new Promise<void>((resolve) => {
      client.once('end', () => { connections.delete(ended); resolve(); });
    });
    connections.add(ended);
  });
  return pool;
}
async function endPool(pool: Pool): Promise<void> {
  const connections = poolConnections.get(pool);
  if (!connections) return;
  // pg-pool resolves end() after removing clients, before their sockets finish closing.
  await pool.end();
  await Promise.all(connections);
  poolConnections.delete(pool);
}
async function waitForClosedChildConnections(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (true) {
    const result = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [childDatabase]);
    if (result.rows[0].count === 0) return;
    if (Date.now() >= deadline) throw new Error('Test-owned PostgreSQL connections did not close before database cleanup.');
    await delay(10);
  }
}
function safeLocalTestUrl(value: string): URL {
  const url = new URL(value);
  const host = url.searchParams.get('host') ?? url.hostname;
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.has('hostaddr') || url.searchParams.has('service')
    || !(['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.startsWith('/'))
    || !/^verdict_(?:mcp_)?test(?:_[a-z0-9_]+)?$/.test(name)) {
    throw new Error('PostgreSQL tests require an explicitly configured local disposable verdict_test database.');
  }
  return url;
}
function open(): PostgresHostedJobs {
  const pool = createPool(childUrl, 2);
  pools.push(pool);
  const store = new PostgresHostedJobs({ pool, deploymentId, databaseId });
  stores.push(store);
  return store;
}
function plan(intentId = randomUUID()): LighterIntentPlan {
  const proposal = prepareExecution({ legs: [{ venue: 'lighter', network: 'testnet', account: 99, apiKeyIndex: 5,
    market: 4555, creator: 11359, title: 'Test oracle event', settlementRule: 'The specified oracle resolves YES when its closing value exceeds 100.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }],
  policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' }, validForSeconds: 120 }, now, intentId);
  return LighterIntentPlan.parse({ proposal, quote: { market: 4555, side: 'yes', maxSpendUSDC: '10', shares: '10',
    limitPrice: '0.4', feeReserveUSDC: '0.1', maxDebitUSDC: '4.1', visibleSharesAtLimit: '100', observedAt: now,
    sourceTimestamp: null, depthTruncated: false, expiresAt: proposal.payload.expiresAt, note: 'Nonfunded PostgreSQL fixture; no venue requests.' } });
}
function jobInput(value = plan()): Parameters<HostedJobs['getOrCreate']>[0] {
  return { owner: 'a'.repeat(64), bindingHash: 'b'.repeat(64), purpose: 'submit', proposal: value.proposal,
    leg: null, expiresAt: value.proposal.payload.expiresAt - 1000,
    authorization: { kind: 'first_party', grantId: randomUUID(), epoch: 3 } };
}
function claim(job: Job, time = now): Parameters<HostedJobs['claim']>[0] {
  return { id: job.id, owner: job.owner, bindingHash: job.bindingHash, now: time };
}
function intent(value = plan()): Omit<Parameters<HostedJobs['claimIntent']>[0], 'now'> {
  return { owner: 'a'.repeat(64), bindingHash: 'b'.repeat(64),
    authorization: { kind: 'first_party', grantId: randomUUID(), epoch: 3 },
    intentId: value.proposal.payload.requestId, inputHash: 'c'.repeat(64) };
}
function observation(job: Job, complete = false): ExecutionStatus {
  return ExecutionStatus.parse({ digest: job.proposal.digest, state: complete ? 'complete' : 'needs_reconciliation',
    legs: [{ leg: 0, state: complete ? 'filled' : 'unknown', filled: complete ? '10.000' : null,
      netInventoryChange: complete ? '10' : null, settled: complete }], automaticRetry: false, note: 'Nonfunded database observation.' });
}

describe.skipIf(!testDsn)('PostgreSQL hosted jobs with real independent database connections', () => {
  beforeAll(async () => {
    if (!testDsn) throw new Error('Explicit local PostgreSQL test configuration is required.');
    const url = safeLocalTestUrl(testDsn);
    // The input DB is only a safety-checked administrative connection. Never mutate its schemas.
    admin = createPool(url.toString(), 1);
    await admin.query(`CREATE DATABASE ${childDatabase}`);
    created = true;
    url.pathname = `/${childDatabase}`;
    childUrl = url.toString();
    database = createPool(childUrl, 2);
    await database.query(POSTGRES_JOBS_DDL);
  }, 20_000);

  beforeEach(async () => {
    deploymentId = randomUUID(); databaseId = randomUUID();
    await database.query('INSERT INTO verdict_mcp.jobs_metadata(deployment_id,database_id,version,intent_version) VALUES($1,$2,1,1)', [deploymentId, databaseId]);
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(pools.splice(0).map(endPool));
  });

  afterAll(async () => {
    try {
      await Promise.all(stores.splice(0).map((store) => store.close()));
      await Promise.all([...poolConnections.keys()].filter((pool) => pool !== admin).map(endPool));
      if (created) {
        await waitForClosedChildConnections();
        await admin.query(`DROP DATABASE ${childDatabase}`);
      }
    } finally { if (admin) await endPool(admin); }
  });

  it('deduplicates concurrent creation and preserves the exact original authorization and expiry', async () => {
    const first = open(); const second = open(); const value = jobInput();
    const original = await first.getOrCreate(value);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).getOrCreate({
      ...value, expiresAt: value.expiresAt + 100,
      authorization: { kind: 'first_party', grantId: randomUUID(), epoch: 99 },
    })));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(original))).toBe(true);
    expect(original.authorization).toEqual(value.authorization);
    expect(original.expiresAt).toBe(value.expiresAt);
    expect(await second.find({ owner: original.owner, purpose: 'submit', digest: original.proposal.digest, leg: null })).toEqual(original);
  });

  it('lets exactly one of two repository instances claim and never reclaims after restart or expiry', async () => {
    const first = open(); const second = open(); const job = await first.getOrCreate(jobInput());
    const results = await Promise.all([first.claim(claim(job)), second.claim(claim(job))]);
    expect(results.map((result) => result.kind).sort()).toEqual(['already_attempted', 'claimed']);
    await first.close(); await second.close();
    await Promise.all(pools.splice(0).map(endPool));
    const restarted = open();
    expect(await restarted.claim(claim(job, job.expiresAt + 1))).toMatchObject({ kind: 'already_attempted', job: { state: 'attempted', result: null } });
    await restarted.observe(job.id, observation(job, true));
    expect(await restarted.claim(claim(job, job.expiresAt + 2))).toMatchObject({ kind: 'already_attempted', job: { state: 'observed' } });
    expect(await restarted.get(job.id)).toMatchObject({ result: { state: 'complete' } });
  });

  it('isolates users, binding revisions, purposes and deployments while lookup returns original binding', async () => {
    const first = open(); const value = jobInput(); const job = await first.getOrCreate(value);
    const otherUser = await first.getOrCreate({ ...value, owner: 'd'.repeat(64) });
    const otherBinding = await first.getOrCreate({ ...value, bindingHash: 'e'.repeat(64) });
    const cleanup = await first.getOrCreate({ ...value, purpose: 'cancel', leg: 0, expiresAt: value.proposal.payload.expiresAt + 60_000 });
    expect(new Set([job.id, otherUser.id, otherBinding.id, cleanup.id]).size).toBe(4);
    expect(await first.find({ owner: value.owner, purpose: 'submit', digest: value.proposal.digest, leg: null })).toEqual(job);
    const secondDeployment = randomUUID();
    await database.query('INSERT INTO verdict_mcp.jobs_metadata(deployment_id,database_id,version,intent_version) VALUES($1,$2,1,1)', [secondDeployment, databaseId]);
    const isolated = new PostgresHostedJobs({ pool: database, deploymentId: secondDeployment, databaseId });
    stores.push(isolated);
    expect(await isolated.get(job.id)).toBeNull();
    await expect(isolated.claim(claim(job))).rejects.toMatchObject({ code: 'job_not_found' });
  });

  it('denies wrong owner/binding, expiry, unauthorized observation and declined requests', async () => {
    const store = open(); const job = await store.getOrCreate(jobInput());
    await expect(store.claim({ ...claim(job), owner: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'job_owner' });
    await expect(store.claim({ ...claim(job), bindingHash: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'binding_changed' });
    await expect(store.claim(claim(job, job.expiresAt))).rejects.toMatchObject({ code: 'approval_expired' });
    await expect(store.observe(job.id, observation(job))).rejects.toMatchObject({ code: 'not_attempted' });
    expect(await store.get(job.id)).toMatchObject({ state: 'pending' });
    expect(await store.decline(claim(job))).toMatchObject({ state: 'declined' });
    await expect(store.claim(claim(job))).rejects.toMatchObject({ code: 'approval_declined' });
    await expect(store.decline(claim(job))).rejects.toMatchObject({ code: 'not_pending' });
  });

  it('serializes competing decline and confirm into one outcome', async () => {
    const first = open(); const second = open(); const job = await first.getOrCreate(jobInput());
    const results = await Promise.allSettled([first.claim(claim(job)), second.decline(claim(job))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(['declined', 'attempted']).toContain((await first.get(job.id))?.state);
  });

  it('borrows the original authority transaction without committing or checking out another connection', async () => {
    const store = open(); const observer = open(); const job = await store.getOrCreate(jobInput());
    const tx = await database.connect();
    try {
      await tx.query('BEGIN');
      expect(await store.claim(claim(job), { kind: 'postgres', client: tx, deploymentId, databaseId })).toMatchObject({ kind: 'claimed' });
      expect(await observer.get(job.id)).toMatchObject({ state: 'pending' });
      await tx.query('ROLLBACK');
      expect(await observer.get(job.id)).toMatchObject({ state: 'pending' });
      await tx.query('BEGIN');
      await store.claim(claim(job), { kind: 'postgres', client: tx, deploymentId, databaseId });
      await tx.query('COMMIT');
      expect(await observer.claim(claim(job))).toMatchObject({ kind: 'already_attempted' });
    } finally { try { await tx.query('ROLLBACK'); } finally { tx.release(); } }
  });

  it('rejects local, foreign-deployment and foreign-database transaction scopes before changing a job', async () => {
    const store = open(); const job = await store.getOrCreate(jobInput()); const tx = await database.connect();
    try {
      await tx.query('BEGIN');
      await expect(store.claim(claim(job), { kind: 'local' })).rejects.toMatchObject({ code: 'storage_unavailable' });
      await expect(store.claim(claim(job), { kind: 'postgres', client: tx, deploymentId: randomUUID(), databaseId })).rejects.toMatchObject({ code: 'storage_unavailable' });
      await expect(store.claim(claim(job), { kind: 'postgres', client: tx, deploymentId, databaseId: randomUUID() })).rejects.toMatchObject({ code: 'storage_unavailable' });
      await tx.query('ROLLBACK');
      expect(await store.get(job.id)).toMatchObject({ state: 'pending' });
    } finally { try { await tx.query('ROLLBACK'); } finally { tx.release(); } }
  });

  it('validates proposals and observations, rolling back invalid correlations', async () => {
    const store = open(); const value = jobInput(); const changed = structuredClone(value); changed.proposal.digest = 'e'.repeat(64);
    await expect(store.getOrCreate(changed)).rejects.toMatchObject({ code: 'invalid_job' });
    await expect(store.getOrCreate({ ...value, leg: 0 })).rejects.toMatchObject({ code: 'invalid_job' });
    await expect(store.getOrCreate({ ...value, purpose: 'cancel', leg: null })).rejects.toMatchObject({ code: 'invalid_job' });
    const job = await store.getOrCreate(value); await store.claim(claim(job));
    await expect(store.observe(job.id, { ...observation(job), digest: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'storage_unavailable' });
    const impossible = observation(job, true); const leg = impossible.legs[0];
    if (!leg) throw new Error('Expected fixture leg');
    leg.filled = '0';
    await expect(store.observe(job.id, impossible)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await store.get(job.id)).toMatchObject({ state: 'attempted', result: null });
    await store.observe(job.id, observation(job));
    expect(await store.get(job.id)).toMatchObject({ state: 'observed', result: { state: 'needs_reconciliation' } });
  });

  it('fences concurrent preparation and stale saves without extending an expired original intent', async () => {
    const first = open(); const second = open(); const original = plan(); const identity = intent(original);
    const attempts = await Promise.allSettled([first.claimIntent({ ...identity, now }), second.claimIntent({ ...identity, now })]);
    const winner = attempts.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled' || winner.value.kind !== 'claimed') throw new Error('Expected one original preparation claimant');
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(second.claimIntent({ ...identity, inputHash: 'd'.repeat(64), now })).rejects.toMatchObject({ code: 'intent_changed' });
    const replacement = await second.claimIntent({ ...identity, now: now + 30_000 });
    if (replacement.kind !== 'claimed') throw new Error('Expected expired planning lease to be reclaimed');
    await expect(first.saveIntent({ ...identity, claimId: winner.value.claimId, plan: original })).rejects.toMatchObject({ code: 'intent_claim_changed' });
    await second.saveIntent({ ...identity, claimId: replacement.claimId, plan: original });
    await first.abandonIntent({ ...identity, claimId: winner.value.claimId });
    await first.close();
    const restarted = open();
    expect(await restarted.claimIntent({ ...identity, now: original.proposal.payload.expiresAt + 900_000 })).toEqual({ kind: 'prepared', plan: original });
    await expect(restarted.claimIntent({ ...identity, inputHash: 'd'.repeat(64), now: now + 900_000 })).rejects.toMatchObject({ code: 'intent_changed' });
    const job = await restarted.getOrCreate(jobInput(original));
    await expect(restarted.claim(claim(job, job.expiresAt + 1))).rejects.toMatchObject({ code: 'approval_expired' });
  });

  it('binds saved intents to request identity and permits only the current preparation claim to abandon', async () => {
    const store = open(); const original = plan(); const identity = intent(original);
    const prepared = await store.claimIntent({ ...identity, now });
    if (prepared.kind !== 'claimed') throw new Error('Expected preparation claim');
    await store.abandonIntent({ ...identity, claimId: randomUUID() });
    await expect(store.claimIntent({ ...identity, now })).rejects.toMatchObject({ code: 'intent_preparing' });
    await expect(store.saveIntent({ ...identity, claimId: prepared.claimId, plan: plan() })).rejects.toMatchObject({ code: 'invalid_intent' });
    await store.abandonIntent({ ...identity, claimId: prepared.claimId });
    const replacement = await store.claimIntent({ ...identity, now });
    expect(replacement.kind).toBe('claimed');
  });

  it('fails closed for missing/replaced marker and corrupt canonical row without leaking SQL details', async () => {
    const store = open(); const job = await store.getOrCreate(jobInput());
    const missing = new PostgresHostedJobs({ pool: database, deploymentId: randomUUID(), databaseId }); stores.push(missing);
    await expect(missing.get(job.id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await database.query('UPDATE verdict_mcp.hosted_jobs SET data=jsonb_set(data,\'{proposal,digest}\',$3::jsonb) WHERE deployment_id=$1 AND id=$2', [deploymentId, job.id, JSON.stringify('e'.repeat(64))]);
    await expect(store.get(job.id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await database.query('UPDATE verdict_mcp.jobs_metadata SET database_id=$2 WHERE deployment_id=$1', [deploymentId, randomUUID()]);
    try { await store.get(job.id); throw new Error('Expected marker mismatch'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'storage_unavailable' });
      expect(String(error)).not.toContain('SELECT'); expect(String(error)).not.toContain(childDatabase);
    }
  });

  it('close blocks the instance but never ends its borrowed application pool', async () => {
    const store = new PostgresHostedJobs({ pool: database, deploymentId, databaseId });
    const job = await store.getOrCreate(jobInput()); await store.close();
    await expect(store.get(job.id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await database.query('SELECT 1 AS available')).rows[0]).toEqual({ available: 1 });
  });

  it('fails closed after either initialized table is removed; runtime never recreates schema', async () => {
    const store = open(); const job = await store.getOrCreate(jobInput());
    // This entire database was created by this test suite, never a supplied existing schema.
    await database.query('DROP TABLE verdict_mcp.lighter_intents');
    await expect(store.get(job.id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await database.query("SELECT to_regclass('verdict_mcp.lighter_intents') AS relation")).rows[0]).toEqual({ relation: null });
    await database.query('DROP TABLE verdict_mcp.hosted_jobs');
    await expect(store.claim(claim(job))).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await database.query("SELECT to_regclass('verdict_mcp.hosted_jobs') AS relation")).rows[0]).toEqual({ relation: null });
  });
});
