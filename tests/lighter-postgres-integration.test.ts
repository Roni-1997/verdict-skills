import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as localRequest, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareExecution } from '../packages/core/src/index.js';
import { ConnectResponse, type ConnectRequest, type LighterScopePlan } from '../packages/mcp/src/connect-contract.js';
import { AccountServiceConfig } from '../packages/mcp/src/connect-model.js';
import { createPostgresAccountService } from '../packages/mcp/src/vercel.js';
import { POSTGRES_AUTHORITY_DDL } from '../packages/mcp/src/postgres-authority.js';
import { POSTGRES_JOBS_DDL } from '../packages/mcp/src/postgres-jobs.js';
import type { Pool } from 'pg';
import { PostgresTestPools } from './fixtures/postgres-lifecycle.js';
import { randomBytes, randomUUID } from 'node:crypto';

// Real production Node factory, PostgreSQL repositories, strict signer HTTP and cold native worker processes.
// Only routing, synthetic Privy issuer and venue adapter are fixtures; no venue or real funds are contacted.
const testDsn = process.env.VERDICT_TEST_POSTGRES;
const postgres = new PostgresTestPools();
const childDatabase = `verdict_mcp_test_e2e_${randomUUID().replaceAll('-', '')}`;
let admin: Pool; let database: Pool; let publicPool: Pool; let childUrl = ''; let created = false;
let deploymentId = ''; let databaseId = ''; let privateLocalOrigin = '';
const privateOrigin = 'https://private.signer.fixture';
const origin = 'https://mcp.local.fixture'; const appOrigin = 'https://app.local.fixture'; const subject = 'did:privy:hosted-integration';
const owner = privateKeyToAccount(generatePrivateKey()); const root = fileURLToPath(new URL('..', import.meta.url));
let directory: string | undefined; let listener: Server | undefined; let child: ChildProcess | undefined;
let service: Awaited<ReturnType<typeof createPostgresAccountService>> | undefined;
let config: AccountServiceConfig; let signing: Awaited<ReturnType<typeof generateKeyPair>>; let localOrigin = '';
const clients: Client[] = [];
const localFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init); const url = new URL(request.url);
  if (url.origin !== origin) throw new Error('Fixture refused nonlocal network');
  const headers = Object.fromEntries(request.headers); headers.host = new URL(origin).host;
  const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const local = localRequest(new URL(url.pathname + url.search, localOrigin), { method: request.method, headers, signal: request.signal }, (incoming) => {
      const chunks: Buffer[] = []; incoming.on('data', (chunk: Buffer) => chunks.push(chunk)); incoming.on('error', reject);
      incoming.on('end', () => {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) { const key = incoming.rawHeaders[i]; const value = incoming.rawHeaders[i + 1]; if (key && value) headers.append(key, value); }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500, headers }));
      });
    });
    local.on('error', reject); local.end(bytes);
  });
};
class Agent implements OAuthClientProvider {
  readonly redirectUrl = 'https://agent.local.fixture/callback';
  readonly clientMetadata = { redirect_uris: [this.redirectUrl], client_name: 'Private-integration fixture', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  info: OAuthClientInformationMixed | undefined; saved: OAuthTokens | undefined; location: URL | undefined; verifier = '';
  clientInformation() { return this.info; } saveClientInformation(value: OAuthClientInformationMixed) { this.info = value; }
  tokens() { return this.saved; } saveTokens(value: OAuthTokens) { this.saved = value; }
  redirectToAuthorization(value: URL) { this.location = value; } saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { return this.verifier; } state() { return 'private-integration-state'; }
}
class Browser {
  private cookie = '';
  async fetch(url: string, input: RequestInit = {}) {
    const headers = new Headers(input.headers); if (this.cookie) headers.set('cookie', this.cookie);
    const response = await localFetch(new URL(url, origin), { ...input, headers, redirect: 'manual' });
    for (const value of response.headers.getSetCookie()) {
      const entry = value.split(';')[0]; if (!entry) continue; const name = entry.split('=')[0];
      const old = this.cookie.split('; ').filter((item) => item && !item.startsWith(`${name}=`)); if (!/Max-Age=0(?:;|$)/.test(value)) old.push(entry); this.cookie = old.join('; ');
    }
    return response;
  }
}
async function identity() { return new SignJWT({ sid: 'inert-staging-session' }).setProtectedHeader({ alg: 'ES256' }).setSubject(subject)
  .setAudience(config.privyAppId).setIssuer('privy.io').setIssuedAt().setExpirationTime('1h').sign(signing.privateKey); }
async function app(request: ConnectRequest) {
  const response = await localFetch(`${origin}/connect/app`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Relay ${process.env.VERDICT_PRIVATE_INTEGRATION_RELAY}`,
    origin: appOrigin, 'x-verdict-app-session': 'b'.repeat(64) }, body: JSON.stringify(request) });
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return ConnectResponse.parse(value);
}
const privateFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init); const url = new URL(request.url);
  if (url.origin !== privateOrigin || url.pathname !== '/internal/operation' || url.search || url.hash) throw new Error('Fixture refused nonlocal signer traffic');
  return fetch(new URL(url.pathname, privateLocalOrigin), { method: request.method, headers: request.headers, body: await request.text(), redirect: 'error', signal: request.signal });
};
async function startPrivate(mode: 'per_order' | 'policy') {
  if (!directory) throw new Error('Missing private fixture directory');
  child = spawn(process.env.VERDICT_BROKER_PYTHON ?? join(root, 'local-runner/.venv/bin/python'), [join(root, 'local-runner/tests/signer_http_fixture.py'), '--root', directory,
    '--owner', owner.address.toLowerCase(), '--origin', origin, '--mode', mode, '--deployment-id', deploymentId, '--database-id', databaseId], { cwd: root,
    env: { PATH: process.env.PATH ?? '', PYTHONPATH: join(root, 'local-runner'), PYTHONDONTWRITEBYTECODE: '1', VERDICT_NODE_BINARY: process.execPath,
      VERDICT_TEST_POSTGRES_DSN: childUrl, VERDICT_TEST_SIGNER_SERVICE_KEY: process.env.VERDICT_PG_INTEGRATION_SIGNER ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let output = ''; let diagnostics = ''; const timer = setTimeout(() => reject(new Error(`Private HTTP fixture timed out: ${diagnostics}`)), 15_000);
    child?.stderr?.on('data', (value: Buffer) => { diagnostics += value.toString(); });
    child?.once('error', error => { clearTimeout(timer); reject(error); });
    child?.once('exit', () => { clearTimeout(timer); reject(new Error(`Private HTTP fixture exited: ${diagnostics}`)); });
    child?.stdout?.on('data', (value: Buffer) => {
      output += value.toString(); if (!output.includes('\n')) return;
      try { const ready = z.object({ inert: z.literal(true), port: z.number().int().positive() }).strict().parse(JSON.parse(output.trim()));
        privateLocalOrigin = `http://127.0.0.1:${ready.port}`; clearTimeout(timer); resolve(); } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
}
async function stopPrivate() {
  if (child && child.exitCode === null) { const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve())); child.kill('SIGTERM'); await stopped; }
  child = undefined;
}
async function startPublic() {
  publicPool = postgres.create(childUrl, 3);
  const artifact = process.env.VERDICT_TEST_PUBLIC_BUNDLE;
  const factory = artifact ? z.object({ createPostgresAccountService: z.custom<typeof createPostgresAccountService>(value => typeof value === 'function') }).passthrough()
    .parse(await import(pathToFileURL(resolve(root, artifact)).href)).createPostgresAccountService : createPostgresAccountService;
  service = await factory(config, { pool: publicPool, signerTransport: privateFetch }); listener?.on('request', service.handle);
}
async function start(mode: 'per_order' | 'policy') {
  directory = await mkdtemp('/tmp/verdict-pg-e2e-'); signing = await generateKeyPair('ES256');
  deploymentId = randomUUID(); databaseId = randomUUID();
  await database.query('INSERT INTO verdict_mcp.authority_metadata VALUES($1,$2,1)', [deploymentId, databaseId]);
  await database.query('INSERT INTO verdict_mcp.jobs_metadata VALUES($1,$2,1,1)', [deploymentId, databaseId]);
  process.env.VERDICT_PG_INTEGRATION_SIGNER = randomBytes(32).toString('base64url');
  listener = createServer(); await new Promise<void>((resolve) => listener?.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address'); localOrigin = `http://127.0.0.1:${address.port}`;
  await startPrivate(mode); process.env.VERDICT_PRIVATE_INTEGRATION_RELAY = generatePrivateKey();
  config = AccountServiceConfig.parse({ publicOrigin: origin, appOrigin, appNetwork: 'lighter-testnet', privyAppId: 'fixture-app', privyVerificationKey: await exportSPKI(signing.publicKey),
    relaySecretEnv: 'VERDICT_PRIVATE_INTEGRATION_RELAY', storage: { kind: 'postgres', connectionStringEnv: 'VERDICT_TEST_POSTGRES', deploymentId, databaseId }, profiles: [],
    lighterProvisioner: { kind: 'hosted_signer', origin: privateOrigin, deploymentId, secretEnv: 'VERDICT_PG_INTEGRATION_SIGNER' } });
  await startPublic();
}
async function delegated() {
  const agent = new Agent(); expect(await auth(agent, { serverUrl: `${origin}/mcp`, scope: 'verdict:read verdict:trade', fetchFn: localFetch })).toBe('REDIRECT');
  if (!agent.location) throw new Error('Missing OAuth authorization location'); const browser = new Browser(); const opening = await browser.fetch(agent.location.href);
  expect(opening.status).toBe(303); const url = new URL(opening.headers.get('location') ?? ''); expect(url.searchParams.get('net')).toBe('lighter-testnet');
  const transaction = url.searchParams.get('transaction') ?? ''; const accessToken = await identity();
  const review = await app({ operation: 'challenge', transaction, accessToken, walletAddress: owner.address }); if (review.kind !== 'review') throw new Error('Missing ownership review');
  let setup = await app({ operation: 'lighter_setup', transaction, accessToken, reviewId: review.reviewId, signature: await owner.signMessage({ message: review.message }) });
  if (setup.kind !== 'lighter_setup') throw new Error('Missing setup');
  if (setup.state.kind === 'funding_signature') setup = await app({ operation: 'lighter_faucet', transaction, accessToken, enrollmentId: setup.state.enrollmentId,
    revision: setup.state.revision, signature: await owner.signMessage({ message: setup.state.message }) });
  if (setup.kind !== 'lighter_setup' || setup.state.kind !== 'owner_signature') throw new Error('Missing registration');
  const registration = setup.state.registration; expect(registration.apiKeyIndex).toBeGreaterThan(4);
  const registered = await app({ operation: 'lighter_register', transaction, accessToken, enrollmentId: registration.enrollmentId,
    revision: registration.revision, signature: await owner.signMessage({ message: registration.message }) });
  if (registered.kind !== 'lighter_setup' || registered.state.kind !== 'scope_signature') throw new Error('Missing scope'); const plan: LighterScopePlan = registered.state.plan;
  const active = await app({ operation: 'lighter_activate', transaction, accessToken, enrollmentId: plan.enrollmentId, planId: plan.planId, revision: plan.revision,
    signature: await owner.signMessage({ message: plan.message }) }); expect(active).toMatchObject({ state: { kind: 'ready', connection: { kind: 'executable' } } });
  const delegation = await app({ operation: 'challenge', transaction, accessToken, walletAddress: owner.address }); if (delegation.kind !== 'review') throw new Error('Missing final client consent');
  expect(delegation.consentMethod).toBe('app_session');
  const completed = await app({ operation: 'session_consent', transaction, accessToken, reviewId: delegation.reviewId });
  if (completed.kind !== 'complete') throw new Error('Missing completion'); const callback = await browser.fetch(completed.completionUrl); const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code'); if (!code) throw new Error('Missing OAuth code');
  expect(await auth(agent, { serverUrl: `${origin}/mcp`, authorizationCode: code, fetchFn: localFetch })).toBe('AUTHORIZED'); if (!agent.saved) throw new Error('Missing resource tokens');
  const client = new Client({ name: 'private-integration', version: '1' }); clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { fetch: localFetch, requestInit: { headers: { authorization: `Bearer ${agent.saved.access_token}` } } });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); return { client, token: agent.saved.access_token, plan, browser };
}
describe.skipIf(!testDsn)('real PostgreSQL cold hosted lifecycle', () => {
beforeAll(async () => {
  if (!testDsn) throw new Error('Explicit local disposable PostgreSQL required'); const url = new URL(testDsn); const host = url.searchParams.get('host') ?? url.hostname;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.has('hostaddr') || url.searchParams.has('service')
    || !(['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.startsWith('/'))
    || !/^verdict_(?:mcp_)?test(?:_[a-z0-9_]+)?$/.test(decodeURIComponent(url.pathname.slice(1)))) throw new Error('Only local disposable verdict test databases are allowed');
  admin = postgres.create(url.toString(), 1); await admin.query(`CREATE DATABASE ${childDatabase}`); created = true;
  url.pathname = `/${childDatabase}`; childUrl = url.toString(); database = postgres.create(childUrl, 2);
  await database.query(POSTGRES_AUTHORITY_DDL); await database.query(POSTGRES_JOBS_DDL);
}, 20_000);
afterAll(async () => { try { await postgres.endAllExcept(admin); if (created) await postgres.dropDatabase(admin, childDatabase); } finally { await postgres.end(admin); } });
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  if (service && listener) { listener.removeListener('request', service.handle); await service.close(); }
  await postgres.end(publicPool);
  if (listener) { listener.closeAllConnections(); await new Promise<void>((resolve) => listener?.close(() => resolve())); }
  await stopPrivate();
  if (directory) await rm(directory, { recursive: true, force: true }); delete process.env.VERDICT_PRIVATE_INTEGRATION_RELAY; delete process.env.VERDICT_PG_INTEGRATION_SIGNER;
  child = undefined; listener = undefined; service = undefined; directory = undefined;
});
it.each(['per_order', 'policy'] as const)('runs %s through production public factory, strict private HTTP and fresh workers, then recovers after full restart', async (mode) => {
  await start(mode); const { client, token, plan, browser } = await delegated();
  const exact = prepareExecution({ legs: [{ venue: 'lighter', network: 'testnet', account: plan.scope.account, apiKeyIndex: plan.scope.apiKeyIndex,
    market: 9001, creator: 7, title: 'Fresh synthetic 15-minute contract', settlementRule: 'Inert fixture settlement; no real venue or funds.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }], policy: { maxTotalDebitUSDC: '5', maxLegDebitUSDC: '5' } });
  const pending = await client.callTool({ name: 'execution_submit', arguments: exact }); expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true);
  if (mode === 'per_order') {
    const { approvalUrl } = z.object({ approvalUrl: z.string().url() }).passthrough().parse(pending.structuredContent);
    expect(pending.structuredContent).toMatchObject({ state: 'approval_required' });
    expect((await localFetch(approvalUrl, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    const reviewed = await browser.fetch(approvalUrl); expect(reviewed.status).toBe(200);
    const html = await reviewed.text(); expect(html).toContain('Fresh synthetic 15-minute contract'); expect(html).toContain(exact.digest);
    expect((await client.callTool({ name: 'execution_status', arguments: exact })).structuredContent).toMatchObject({ state: 'approval_required' });
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''; expect(csrf).not.toBe('');
    const confirm = () => browser.fetch(approvalUrl, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'confirm' }) });
    expect((await confirm()).status).toBe(200); expect((await confirm()).status).toBe(200);
  }
  const status = await client.callTool({ name: 'execution_status', arguments: exact }); expect(status.structuredContent).toMatchObject({ state: 'complete', legs: [{ state: 'filled', filled: '10' }] });
  const repeated = await client.callTool({ name: 'execution_submit', arguments: exact }); expect(repeated.structuredContent).toMatchObject({ state: 'complete' });
  if (!listener || !service) throw new Error('Missing current fixture service');
  listener.removeListener('request', service.handle); await service.close(); await postgres.end(publicPool); await stopPrivate(); await startPrivate(mode);
  await startPublic();
  const restored = await client.callTool({ name: 'execution_status', arguments: exact }); expect(restored.structuredContent).toMatchObject({ state: 'complete', legs: [{ state: 'filled' }] });
  if (!directory) throw new Error('Missing fixture state'); const stats = JSON.parse(await readFile(join(directory, 'metrics.json'), 'utf8'));
  expect(stats).toMatchObject({ sends: 1 });
}, 60_000);
});
