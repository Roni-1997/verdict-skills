import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prepareExecution } from '../packages/core/src/index.js';
import { AccountAuthority } from '../packages/mcp/src/connect-authority.js';
import { AccountServiceConfig, hash, opaque, ownerHash } from '../packages/mcp/src/connect-model.js';
import type { ConnectWriteTx } from '../packages/mcp/src/connect-store.js';
import { POSTGRES_AUTHORITY_DDL, PostgresAuthorityStore } from '../packages/mcp/src/postgres-authority.js';
import { POSTGRES_JOBS_DDL, PostgresHostedJobs } from '../packages/mcp/src/postgres-jobs.js';

const testDsn = process.env.VERDICT_TEST_POSTGRES;
const childDatabase = `verdict_mcp_test_auth_${randomUUID().replaceAll('-', '')}`;
const stores: PostgresAuthorityStore[] = []; const pools: Pool[] = []; const authorities: AccountAuthority[] = [];
let admin: Pool; let database: Pool; let childUrl: string; let created = false; let deploymentId: string; let databaseId: string;
const origin = 'https://mcp.authority.fixture';
function safeLocalTestUrl(value: string): URL {
  const url = new URL(value); const host = url.searchParams.get('host') ?? url.hostname;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.has('hostaddr') || url.searchParams.has('service')
    || !(['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.startsWith('/'))
    || !/^verdict_(?:mcp_)?test(?:_[a-z0-9_]+)?$/.test(decodeURIComponent(url.pathname.slice(1)))) throw new Error('An explicit local disposable verdict test database is required.');
  return url;
}
function open() { const pool = new Pool({ connectionString: childUrl, max: 2 }); pools.push(pool); const store = new PostgresAuthorityStore(pool, { deploymentId, databaseId }); stores.push(store); return store; }
function grant() { return { id: randomUUID(), subject: 'did:privy:alice', clientId: 'client', profileId: null, revision: null,
  scopes: ['verdict:read' as const, 'verdict:trade' as const], resource: `${origin}/mcp`, createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, epoch: 0 }; }
async function authority(store = open()) {
  const key = await generateKeyPair('ES256'); process.env.VERDICT_AUTHORITY_TEST_RELAY = 'a'.repeat(64);
  const config = AccountServiceConfig.parse({ publicOrigin: origin, appOrigin: 'https://app.authority.fixture', appNetwork: 'lighter-testnet',
    privyAppId: 'nonfunded-fixture', privyVerification: { kind: 'spki', key: await exportSPKI(key.publicKey) }, relaySecretEnv: 'VERDICT_AUTHORITY_TEST_RELAY',
    storage: { kind: 'postgres', connectionStringEnv: 'VERDICT_TEST_POSTGRES', deploymentId, databaseId }, profiles: [] });
  const value = await AccountAuthority.create(config, undefined, undefined, store); authorities.push(value); return value;
}

describe.skipIf(!testDsn)('real PostgreSQL authority transaction and revocation boundaries', () => {
  beforeAll(async () => { if (!testDsn) throw new Error('Explicit test database required'); const url = safeLocalTestUrl(testDsn);
    admin = new Pool({ connectionString: url.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${childDatabase}`); created = true;
    url.pathname = `/${childDatabase}`; childUrl = url.toString(); database = new Pool({ connectionString: childUrl, max: 4 });
    await database.query(POSTGRES_AUTHORITY_DDL); await database.query(POSTGRES_JOBS_DDL);
  }, 20_000);
  beforeEach(async () => { deploymentId = randomUUID(); databaseId = randomUUID();
    await database.query('INSERT INTO verdict_mcp.authority_metadata VALUES($1,$2,1)', [deploymentId, databaseId]);
    await database.query('INSERT INTO verdict_mcp.jobs_metadata VALUES($1,$2,1,1)', [deploymentId, databaseId]);
  });
  afterEach(async () => { for (const value of authorities.splice(0)) await value.close(); for (const store of stores.splice(0)) await store.close(); await Promise.all(pools.splice(0).map(pool => pool.end())); delete process.env.VERDICT_AUTHORITY_TEST_RELAY; });
  afterAll(async () => { await database?.end(); if (created) await admin.query(`DROP DATABASE ${childDatabase} WITH (FORCE)`); await admin?.end(); });

  it('serializes two processes across awaited writes and preserves the committed epoch', async () => {
    const first = open(); const second = open(); const value = grant(); await first.write([], tx => tx.put('grant', value.id, value, value.expiresAt));
    let release = () => {}; let entered = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const mutation = first.write([], async tx => { const previous = await tx.get('grant', value.id); if (!previous) throw new Error('missing grant'); entered(); await gate; await tx.put('grant', value.id, { ...previous, epoch: previous.epoch + 1 }, value.expiresAt); });
    await started; let finished = false; const reading = second.read(async tx => { const result = await tx.get('grant', value.id); finished = true; return result; });
    await Promise.resolve(); expect(finished).toBe(false); release(); await mutation; expect(await reading).toMatchObject({ epoch: 1 });
  });

  it('rolls back, rejects nesting, and invalidates both escaped record and SQL capabilities', async () => {
    const store = open(); const value = grant(); let escaped: ConnectWriteTx | undefined;
    await expect(store.write([], async tx => { escaped = tx; await tx.put('grant', value.id, value, value.expiresAt);
      await expect(store.read(inner => inner.get('grant', value.id))).rejects.toMatchObject({ code: 'authority_storage' }); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await store.read(tx => tx.get('grant', value.id))).toBeNull(); if (!escaped) throw new Error('missing capability');
    await expect(escaped.get('grant', value.id)).rejects.toMatchObject({ code: 'authority_storage' });
    if (escaped.transaction.kind !== 'postgres') throw new Error('missing SQL capability');
    expect(() => escaped?.transaction.kind === 'postgres' && escaped.transaction.client.query('SELECT 1')).toThrow();
  });

  it('enforces read-only SQL even if a caller reaches the shared connection capability', async () => {
    const store = open(); const value = grant();
    await expect(store.read(async tx => {
      if (tx.transaction.kind !== 'postgres') throw new Error('missing SQL capability');
      await tx.transaction.client.query('DELETE FROM verdict_mcp.authority_records WHERE deployment_id=$1', [deploymentId]);
    })).rejects.toMatchObject({ code: '25006' });
    expect(await store.read(tx => tx.get('grant', value.id))).toBeNull();
  });

  it('fails closed for missing markers, mismatched fixed database identity and lost tables', async () => {
    const store = open(); await database.query('DELETE FROM verdict_mcp.authority_metadata WHERE deployment_id=$1', [deploymentId]);
    await expect(store.read(tx => tx.get('grant', randomUUID()))).rejects.toMatchObject({ code: 'authority_storage' });
    await database.query('INSERT INTO verdict_mcp.authority_metadata VALUES($1,$2,1)', [deploymentId, randomUUID()]);
    await expect(store.read(tx => tx.get('grant', randomUUID()))).rejects.toMatchObject({ code: 'authority_storage' });
    await database.query('UPDATE verdict_mcp.authority_metadata SET database_id=$2 WHERE deployment_id=$1', [deploymentId, databaseId]);
    await database.query('ALTER TABLE verdict_mcp.authority_records RENAME TO lost_records');
    try { await expect(store.read(tx => tx.get('grant', randomUUID()))).rejects.toMatchObject({ code: 'authority_storage' }); }
    finally { await database.query('ALTER TABLE verdict_mcp.lost_records RENAME TO authority_records'); }
  });

  it('allows only one code exchange across processes and commits refresh replay revocation', async () => {
    const first = open(); const second = open(); const firstAuthority = await authority(first); const secondAuthority = await authority(second);
    const client = await firstAuthority.clientsStore.registerClient({ redirect_uris: ['https://agent.authority.fixture/callback'], token_endpoint_auth_method: 'none' });
    const value = { ...grant(), clientId: client.client_id }; const code = opaque(); const expiresAt = Date.now() + 60_000;
    await first.write([], async tx => {
      await tx.put('grant', value.id, value, value.expiresAt);
      await tx.put('code', hash(code), { grantId: value.id, epoch: 0, clientId: client.client_id, resource: value.resource, scopes: value.scopes,
        expiresAt, used: false, challenge: 'a'.repeat(43), redirectUri: client.redirect_uris[0] ?? '' }, expiresAt);
    });
    const exchanges = await Promise.allSettled([firstAuthority, secondAuthority].map(service => service.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], new URL(value.resource))));
    expect(exchanges.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const tokens = exchanges.find(result => result.status === 'fulfilled'); if (tokens?.status !== 'fulfilled' || !tokens.value.refresh_token) throw new Error('missing original credential');
    const refresh = tokens.value.refresh_token;
    const rotating = await Promise.allSettled([firstAuthority, secondAuthority].map(service => service.exchangeRefreshToken(client, refresh, undefined, new URL(value.resource))));
    expect(rotating.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await first.read(tx => tx.get('grant', value.id))).toMatchObject({ revoked: true, epoch: 1 });
    await expect(firstAuthority.authenticate(`Bearer ${tokens.value.access_token}`, 'verdict:read')).rejects.toMatchObject({ code: 'invalid_token' });
    for (const result of rotating) if (result.status === 'fulfilled') await expect(secondAuthority.authenticate(`Bearer ${result.value.access_token}`, 'verdict:read')).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects stale epochs, foreign subjects and invalid scopes on a fresh durable grant', async () => {
    const store = open(); const value = grant(); const service = await authority(store);
    await store.write([], tx => tx.put('grant', value.id, value, value.expiresAt));
    const principal = { issuer: origin, subject: value.subject, scopes: value.scopes, expiresAt: value.expiresAt,
      authorization: { kind: 'first_party' as const, grantId: value.id, epoch: 0 } };
    await service.assertActive(principal);
    for (const altered of [{ ...principal, subject: 'did:privy:bob' }, { ...principal, scopes: ['withdraw'] },
      { ...principal, authorization: { ...principal.authorization, epoch: 1 } }, { ...principal, issuer: 'https://attacker.fixture' }]) {
      await expect(service.assertActive(altered)).rejects.toMatchObject({ code: 'invalid_token' });
    }
  });

  it('atomically fences original grant revocation with a job claim on the borrowed connection', async () => {
    const store = open(); const value = grant(); await store.write([], tx => tx.put('grant', value.id, value, value.expiresAt)); const service = await authority(store);
    const jobs = new PostgresHostedJobs({ pool: database, deploymentId, databaseId });
    const proposal = prepareExecution({ legs: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5, market: 9001, creator: 7,
      title: 'Nonfunded PostgreSQL event', settlementRule: 'Synthetic fixture event resolves YES.', side: 'yes', action: 'buy', shares: '1', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }], policy: { maxTotalDebitUSDC: '1', maxLegDebitUSDC: '1' } });
    const job = await jobs.getOrCreate({ owner: ownerHash(origin, value.subject), bindingHash: 'a'.repeat(64), purpose: 'submit', proposal, leg: null,
      expiresAt: proposal.payload.expiresAt, authorization: { kind: 'first_party', grantId: value.id, epoch: 0 } });
    const claim = { id: job.id, owner: job.owner, bindingHash: job.bindingHash, now: Date.now() };
    const other = open(); let release = () => {}; let entered = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const claiming = service.withJobAuthorization(job, async tx => { const result = await jobs.claim(claim, tx); entered(); await gate; return result; });
    await started; let revoked = false; const revoking = other.write([], async tx => { await tx.put('grant', value.id, { ...value, revoked: true, epoch: 1 }, value.expiresAt); revoked = true; });
    await Promise.resolve(); expect(revoked).toBe(false); release(); expect(await claiming).toMatchObject({ kind: 'claimed' }); await revoking;
    await expect(service.withJobAuthorization(job, tx => jobs.claim(claim, tx))).rejects.toMatchObject({ code: 'connection_revoked' });
    expect(await jobs.get(job.id)).toMatchObject({ state: 'attempted' });
  });
});
