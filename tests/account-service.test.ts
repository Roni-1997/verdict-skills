import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { connectExecution, prepareExecution, type ExecutionConnectionInspection } from '../packages/core/src/index.js';
import { AccountAuthority } from '../packages/mcp/src/connect-authority.js';
import { createAccountService, readAccountServiceConfig } from '../packages/mcp/src/connect-http.js';
import { AccountServiceConfig } from '../packages/mcp/src/connect-model.js';
import { ConnectResponse, LighterScopePlan, type ConnectRequest } from '../packages/mcp/src/connect-contract.js';
import { Binding, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';
import type { LighterProvisioner } from '../packages/mcp/src/lighter-provisioner.js';

const wallet = privateKeyToAccount(generatePrivateKey());
const otherWallet = privateKeyToAccount(generatePrivateKey());
const root = fileURLToPath(new URL('..', import.meta.url));
const request = { validForSeconds: 3600, legs: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 2, creator: 7, market: 123,
  title: 'Synthetic connection integration contract', settlementRule: 'Fake settlement; no live funds or contract.',
  side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }],
  policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } };
const proposal = prepareExecution(request);
const subject = 'did:privy:alice';
const appOrigin = 'https://app.verdict.example';
const session = 'a'.repeat(64);
let directory: string; let state: string; let broker: ChildProcess; let socketPath: string;
let inspection: ExecutionConnectionInspection;
let server: Server; let origin: string; let config: AccountServiceConfig;
let authority: AccountAuthority; let service: Awaited<ReturnType<typeof createAccountService>>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let inspectOverride: ExecutionConnectionInspection | null = null;
let provisionerOverride: Pick<LighterProvisioner, 'setup' | 'preview' | 'activate' | 'binding' | 'revoke'> | undefined;
const clients: Client[] = [];

class Agent implements OAuthClientProvider {
  readonly redirectUrl = 'https://agent.example/callback';
  readonly clientMetadata = { redirect_uris: [this.redirectUrl], client_name: 'Integration agent', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  info: OAuthClientInformationMixed | undefined; saved: OAuthTokens | undefined; location: URL | undefined; verifier = '';
  clientInformation() { return this.info; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.info = value; }
  tokens() { return this.saved; }
  saveTokens(value: OAuthTokens) { this.saved = value; }
  redirectToAuthorization(url: URL) { this.location = url; }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { return this.verifier; }
  state() { return 'agent-state'; }
}
class Browser {
  cookie = '';
  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); if (this.cookie) headers.set('cookie', this.cookie);
    const response = await fetch(new URL(url, origin), { ...init, headers, redirect: 'manual' });
    for (const value of response.headers.getSetCookie()) {
      const entry = value.split(';')[0]; if (!entry) continue;
      const name = entry.split('=')[0]; const current = this.cookie.split('; ').filter((item) => item && !item.startsWith(`${name}=`));
      if (!/Max-Age=0(?:;|$)/.test(value)) current.push(entry); this.cookie = current.join('; ');
    }
    return response;
  }
}
async function identity(id = subject, audience = config.privyAppId, key = signing.privateKey) {
  return new SignJWT({ sid: 'ephemeral-test-session' }).setProtectedHeader({ alg: 'ES256' }).setIssuer('privy.io').setAudience(audience).setSubject(id).setIssuedAt().setExpirationTime('1h').sign(key);
}
async function relay(input: ConnectRequest, headers: Record<string, string> = {}) {
  return fetch(`${origin}/connect/app`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Relay ${process.env.VERDICT_CONNECT_TEST_SECRET}`, origin: appOrigin, 'x-verdict-app-session': session, ...headers }, body: JSON.stringify(input) });
}
async function result(input: ConnectRequest) {
  const response = await relay(input); const body: unknown = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return ConnectResponse.parse(body);
}
async function begin(agent = new Agent()) {
  expect(await auth(agent, { serverUrl: `${origin}/mcp`, scope: `${READ_SCOPE} ${TRADE_SCOPE}` })).toBe('REDIRECT');
  if (!agent.location) throw new Error('Missing SDK authorization URL');
  const browser = new Browser(); const start = await browser.fetch(agent.location.href); expect(start.status).toBe(303);
  const location = new URL(start.headers.get('location') ?? ''); expect(location.origin).toBe(appOrigin); expect(location.searchParams.get('net')).toBe(config.appNetwork);
  const transaction = location.searchParams.get('transaction'); if (!transaction) throw new Error('Missing transaction');
  return { agent, browser, transaction };
}
async function consent(transaction: string, token: string, signer = wallet) {
  const review = await result({ operation: 'challenge', transaction, accessToken: token, walletAddress: signer.address.toLowerCase() });
  if (review.kind !== 'review') throw new Error('Missing review');
  const signature = await signer.signMessage({ message: review.message });
  const completion = await result({ operation: 'consent', transaction, accessToken: token, reviewId: review.reviewId, signature });
  if (completion.kind !== 'complete') throw new Error('Missing receipt'); return { review, completion };
}
async function connect() {
  const flow = await begin(); const { review, completion } = await consent(flow.transaction, await identity());
  const callback = await flow.browser.fetch(completion.completionUrl); expect(callback.status).toBe(303);
  const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code'); if (!code) throw new Error('Missing code');
  expect(await auth(flow.agent, { serverUrl: `${origin}/mcp`, authorizationCode: code })).toBe('AUTHORIZED');
  if (!flow.agent.saved) throw new Error('Missing tokens'); return { ...flow, review, tokens: flow.agent.saved, code };
}
async function token(parameters: Record<string, string>) {
  return fetch(`${origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters) });
}
async function mcp(access: string) {
  const client = new Client({ name: 'product-integration', version: '1' }); clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); return client;
}
async function restart() {
  if (service) { server.removeListener('request', service.handle); await service.close(); }
  authority = await AccountAuthority.create(config, async (profile) => inspectOverride ?? (await connectExecution({ expectedMode: 'policy', expectedGrantId: profile.grantId, socketPath })).inspectConnection(), provisionerOverride);
  service = await createAccountService(config, authority); server.on('request', service.handle);
}
beforeAll(async () => {
  directory = await mkdtemp('/tmp/vca-'); signing = await generateKeyPair('ES256'); socketPath = join(directory, 'broker.sock');
  const template = join(directory, 'template.json'); await writeFile(template, JSON.stringify(proposal));
  broker = spawn(process.env.VERDICT_BROKER_PYTHON ?? 'python3', [join(root, 'local-runner/tests/lifecycle_fixture.py'), template, socketPath, join(directory, 'broker'), wallet.address.toLowerCase()],
    { cwd: root, env: { PATH: process.env.PATH ?? '', PYTHONPATH: join(root, 'local-runner'), PYTHONDONTWRITEBYTECODE: '1', VERDICT_NODE_BINARY: process.execPath }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; broker.stderr?.on('data', (value: Buffer) => { diagnostics += value.toString(); });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await stat(socketPath)).isSocket()) {
        const client = await connectExecution({ expectedMode: 'policy', socketPath }); const capability = await client.capabilities();
        if (capability.authority.mode !== 'policy') throw new Error('No grant');
        inspection = await (await connectExecution({ expectedMode: 'policy', expectedGrantId: capability.authority.grantId, socketPath })).inspectConnection(); break;
      }
    } catch { /* Wait for the actual private broker handshake. */ }
    if (broker.exitCode !== null) throw new Error(diagnostics); await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!inspection) throw new Error(`Broker not ready: ${diagnostics}`);
  server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); origin = `http://127.0.0.1:${address.port}`;
  process.env.VERDICT_CONNECT_TEST_SECRET = generatePrivateKey();
}, 20_000);
beforeEach(async () => {
  state = await mkdtemp(join(directory, 'case-')); inspectOverride = null; provisionerOverride = undefined;
  config = AccountServiceConfig.parse({ publicOrigin: origin, appOrigin, appNetwork: 'lighter-testnet', privyAppId: 'test-privy-app', privyVerificationKey: await exportSPKI(signing.publicKey),
    relaySecretEnv: 'VERDICT_CONNECT_TEST_SECRET', storage: { kind: 'local', stateDir: join(state, 'authority'), gatewayJobsDir: join(state, 'jobs') }, allowInsecureLocalhost: true,
    profiles: [{ id: 'alice-profile', enabled: true, mode: 'per_order', execution: { kind: 'local_socket', socketPath: socketPath }, grantId: inspection.authority.grantId, grantHash: inspection.authority.grantHash,
      accounts: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 2 }] }] });
  await restart();
});
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  server.removeListener('request', service.handle); await service.close();
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  if (broker && broker.exitCode === null) { const stopped = new Promise<void>((resolve) => broker.once('exit', () => resolve())); broker.kill('SIGTERM'); await stopped; }
  delete process.env.VERDICT_CONNECT_TEST_SECRET; if (directory) await rm(directory, { recursive: true, force: true });
});

it('restarts an expired request with the original SDK PKCE flow and rejects the old ownership proof', async () => {
  config = AccountServiceConfig.parse({ ...config, profiles: [] });
  await restart();
  const flow = await begin();
  const accessToken = await identity();
  const view = await result({ operation: 'view', transaction: flow.transaction });
  const oldReview = await result({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address });
  if (view.kind !== 'transaction' || !view.restartUrl || oldReview.kind !== 'review') throw new Error('Missing restart review');
  const url = new URL(view.restartUrl);
  expect(url.origin + url.pathname).toBe(origin + '/authorize');
  expect(url.searchParams.get('code_challenge')).toBe(flow.agent.location?.searchParams.get('code_challenge'));
  expect(url.searchParams.get('state')).toBe('agent-state');
  expect(view.restartUrl).not.toContain(flow.agent.verifier);
  const oldSignature = await wallet.signMessage({ message: oldReview.message });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(view.expiresAt + 1);
  try {
    expect((await relay({ operation: 'consent', transaction: flow.transaction, accessToken, reviewId: oldReview.reviewId, signature: oldSignature })).status).toBe(400);
    const restart = await flow.browser.fetch(view.restartUrl);
    expect(restart.status).toBe(303);
    const transaction = new URL(restart.headers.get('location') ?? '').searchParams.get('transaction');
    if (!transaction) throw new Error('Missing renewed transaction');
    expect(transaction).not.toBe(flow.transaction);
    expect((await relay({ operation: 'consent', transaction, accessToken, reviewId: oldReview.reviewId, signature: oldSignature })).status).toBe(400);
    const { completion } = await consent(transaction, accessToken);
    const callback = await flow.browser.fetch(completion.completionUrl);
    expect(callback.status).toBe(303);
    const returnUrl = new URL(callback.headers.get('location') ?? '');
    expect(returnUrl.searchParams.get('state')).toBe('agent-state');
    const code = returnUrl.searchParams.get('code');
    if (!code) throw new Error('Missing authorization code');
    expect(await auth(flow.agent, { serverUrl: `${origin}/mcp`, authorizationCode: code })).toBe('AUTHORIZED');
  } finally { clock.mockRestore(); }
});

it('connects through real SDK discovery, DCR, PKCE, Privy-style identity, wallet proof and the real broker inspection', async () => {
  const flow = await connect(); expect(flow.review.connection).toMatchObject({ kind: 'executable', mode: 'per_order', blockers: [], policy: { maxDebitUSDC: '100', maxOrders: 20 } });
  const client = await mcp(flow.tokens.access_token); const tools = (await client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toEqual(expect.arrayContaining(['lighter_list_markets', 'lighter_quote', 'connection_status', 'execution_submit', 'execution_cancel']));
  const accounts = await client.callTool({ name: 'execution_accounts', arguments: {} }); expect(accounts.isError).not.toBe(true);
  expect(accounts.structuredContent).toMatchObject({ gatewayMode: 'per_order', accounts: [{ venue: 'lighter', account: 42 }] });
  const disk = (await readFile(join(join(state, 'authority'), 'authority.sqlite'))).toString('latin1');
  for (const secret of [flow.tokens.access_token, flow.tokens.refresh_token ?? '', await identity()]) if (secret) expect(disk).not.toContain(secret);
  expect(JSON.stringify(accounts)).not.toContain(socketPath);
});

it('requires the original browser cookie and one-use receipt; transaction knowledge never redeems or polls identity', async () => {
  const flow = await begin(); const { completion } = await consent(flow.transaction, await identity());
  const view = await result({ operation: 'view', transaction: flow.transaction }); expect(view.kind).toBe('transaction'); expect(JSON.stringify(view)).not.toContain('did:privy'); expect(JSON.stringify(view)).not.toContain('receipt');
  expect((await fetch(completion.completionUrl, { redirect: 'manual' })).status).toBe(400);
  expect((await flow.browser.fetch(`/connect/complete?transaction=${flow.transaction}&receipt=${'a'.repeat(43)}`)).status).toBe(400);
  expect((await flow.browser.fetch(completion.completionUrl)).status).toBe(303);
  expect((await flow.browser.fetch(completion.completionUrl)).status).toBe(400);
});

it('rejects wrong Privy audience/signature, app session changes, wallet impersonation and reviewed-state changes', async () => {
  const flow = await begin(); const otherKey = await generateKeyPair('ES256');
  for (const accessToken of [await identity(subject, 'wrong-app'), await identity(subject, config.privyAppId, otherKey.privateKey)]) {
    expect((await relay({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address })).status).toBe(401);
  }
  const review = await result({ operation: 'challenge', transaction: flow.transaction, accessToken: await identity(), walletAddress: wallet.address }); if (review.kind !== 'review') throw new Error('Missing review');
  const signature = await wallet.signMessage({ message: review.message });
  expect((await relay({ operation: 'consent', transaction: flow.transaction, accessToken: await identity(), reviewId: review.reviewId, signature }, { 'x-verdict-app-session': 'b'.repeat(64) })).status).toBe(400);
  expect((await relay({ operation: 'consent', transaction: flow.transaction, accessToken: await identity('did:privy:bob'), reviewId: review.reviewId, signature })).status).toBe(400);
  expect((await relay({ operation: 'consent', transaction: flow.transaction, accessToken: await identity(), reviewId: review.reviewId, signature: await otherWallet.signMessage({ message: review.message }) })).status).toBe(400);
  inspectOverride = { ...inspection, accounts: inspection.accounts.map((row) => ({ ...row, checkedAt: Date.now(), checks: { ...row.checks, registration: 'missing' } })) };
  expect((await relay({ operation: 'consent', transaction: flow.transaction, accessToken: await identity(), reviewId: review.reviewId, signature })).status).toBe(409);
});

it('pins resource, client, redirect and S256 before one-time code exchange', async () => {
  const flow = await begin(); const { completion } = await consent(flow.transaction, await identity());
  const response = await flow.browser.fetch(completion.completionUrl); const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const base = { client_id: flow.agent.info?.client_id ?? '', grant_type: 'authorization_code', code, code_verifier: flow.agent.verifier, redirect_uri: flow.agent.redirectUrl, resource: `${origin}/mcp` };
  for (const change of [{ code_verifier: 'x'.repeat(43) }, { resource: 'https://wrong.example/mcp' }, { redirect_uri: 'https://attacker.example/callback' }, { client_id: 'unknown' }]) expect((await token({ ...base, ...change })).status).toBe(400);
  expect((await token(base)).status).toBe(200); expect((await token(base)).status).toBe(400);
  expect((await fetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${await identity()}` } })).status).toBe(401);
});

it('persists narrowed refresh scopes and commits family revocation on replay across restart', async () => {
  const flow = await connect(); const base = { client_id: flow.agent.info?.client_id ?? '', grant_type: 'refresh_token', resource: `${origin}/mcp` };
  const response = await token({ ...base, refresh_token: flow.tokens.refresh_token ?? '', scope: READ_SCOPE }); expect(response.status).toBe(200); const child = await response.json() as OAuthTokens;
  expect(child.scope).toBe(READ_SCOPE); await restart();
  expect((await token({ ...base, refresh_token: child.refresh_token ?? '', scope: `${READ_SCOPE} ${TRADE_SCOPE}` })).status).toBe(400);
  const client = await mcp(child.access_token); const denied = await client.callTool({ name: 'execution_submit', arguments: proposal }); expect(denied.isError).toBe(true);
  expect((await token({ ...base, refresh_token: flow.tokens.refresh_token ?? '' })).status).toBe(400);
  await restart(); expect((await fetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${child.access_token}` } })).status).toBe(401);
  expect((await token({ ...base, refresh_token: child.refresh_token ?? '' })).status).toBe(400);
});

it('gives unprovisioned wallets explicit research-only authority that cannot grow into trade permission', async () => {
  const flow = await begin(); const { review, completion } = await consent(flow.transaction, await identity(), otherWallet); expect(review.connection.kind).toBe('read_only');
  const callback = await flow.browser.fetch(completion.completionUrl); const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';
  await auth(flow.agent, { serverUrl: `${origin}/mcp`, authorizationCode: code }); expect(flow.agent.saved?.scope).toBe(READ_SCOPE);
  const client = await mcp(flow.agent.saved?.access_token ?? ''); const status = await client.callTool({ name: 'connection_status', arguments: {} }); expect(status.structuredContent).toMatchObject({ connection: { kind: 'read_only' } });
  expect((await client.callTool({ name: 'execution_submit', arguments: proposal })).isError).toBe(true);
});

it('requires authenticated relay, fixed app origin, private files and a unique verified owner', async () => {
  const flow = await begin(); const request: ConnectRequest = { operation: 'view', transaction: flow.transaction };
  for (const headers of [{ authorization: 'Relay invalid' }, { origin: 'https://attacker.example' }, { 'x-verdict-app-session': 'invalid' }]) expect((await relay(request, headers)).status).toBe(403);
  const path = join(state, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 }); expect((await readAccountServiceConfig(path)).appOrigin).toBe(appOrigin);
  await chmod(path, 0o644); await expect(readAccountServiceConfig(path)).rejects.toMatchObject({ code: 'invalid_configuration' });
  inspectOverride = { ...inspection, accounts: inspection.accounts.map((row) => ({ ...row, checkedAt: Date.now(), ownerWallet: null })) };
  const review = await result({ operation: 'challenge', transaction: flow.transaction, accessToken: await identity(), walletAddress: wallet.address }); expect(review).toMatchObject({ connection: { kind: 'read_only' } });
});

it('refuses a second authority writer and fails closed on a replaced durable database', async () => {
  await expect(AccountAuthority.create(config)).rejects.toMatchObject({ code: 'authority_storage' });
  const flow = await connect();
  const database = join(join(state, 'authority'), 'authority.sqlite'); await rename(database, `${database}.saved`); await writeFile(database, '', { mode: 0o600 });
  expect((await fetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${flow.tokens.access_token}` } })).status).toBe(401);
  await expect(authority.authenticate(`Bearer ${flow.tokens.access_token}`, READ_SCOPE)).rejects.toMatchObject({ code: 'invalid_token' });
});

it('enforces unique enrollment and operator revision changes without silently widening old grants', async () => {
  const flow = await connect(); const second = await begin(); const { completion } = await consent(second.transaction, await identity('did:privy:bob'));
  expect((await second.browser.fetch(completion.completionUrl)).status).toBe(400);
  const profile = config.profiles[0]; if (!profile) throw new Error('Missing profile'); config.profiles[0] = { ...profile, mode: 'policy' }; await restart();
  expect((await fetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${flow.tokens.access_token}` } })).status).toBe(401);
});

it('rejects hostile registration redirects, exact-resource changes, mismatched browser cookies and cancellation replay', async () => {
  for (const redirect of ['https://agent.example/cb#fragment', 'https://user:password@agent.example/cb', 'http://agent.example/cb', 'javascript:alert(1)']) {
    const response = await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) }); expect(response.status).toBe(400);
  }
  const flow = await begin(); if (!flow.agent.location) throw new Error('Missing location');
  const wrongResource = new URL(flow.agent.location); wrongResource.searchParams.set('resource', 'https://attacker.example/mcp');
  const rejected = await new Browser().fetch(wrongResource.href); expect(rejected.status).not.toBe(303);
  const cancel = `/connect/cancel?transaction=${flow.transaction}`; expect((await new Browser().fetch(cancel)).status).toBe(400);
  const denied = await flow.browser.fetch(cancel); expect(denied.status).toBe(303); const redirect = new URL(denied.headers.get('location') ?? '');
  expect(redirect.searchParams.get('error')).toBe('access_denied'); expect(redirect.searchParams.get('state')).toBe('agent-state'); expect(redirect.origin).toBe('https://agent.example');
  expect((await flow.browser.fetch(cancel)).status).toBe(400);
});

it('keeps client revocation available when broker readiness changes and bounds incoming relay bodies', async () => {
  await connect(); inspectOverride = { ...inspection, authority: { ...inspection.authority, newRisk: 'unresolved' } };
  const status = await result({ operation: 'status', accessToken: await identity() }); if (status.kind !== 'connections') throw new Error('Missing status');
  expect(status.connection).toMatchObject({ kind: 'read_only' }); expect(status.connections).toHaveLength(1);
  await result({ operation: 'disconnect', accessToken: await identity(), connectionId: status.connections[0]?.id ?? '' });
  const oversized = await fetch(`${origin}/connect/app`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(65_536) }) });
  expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: 'invalid_request' });
  expect(() => AccountServiceConfig.parse({ ...config, appOrigin: `${config.publicOrigin}/` })).toThrow();
});

it('supports confidential client authentication without storing its secret in plaintext', async () => {
  const response = await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://agent.example/callback'], token_endpoint_auth_method: 'client_secret_post', client_name: 'Confidential agent' }) });
  expect(response.status).toBe(201); const client = await response.json() as { client_id: string; client_secret: string };
  expect(client.client_secret).toHaveLength(64); expect((await readFile(join(join(state, 'authority'), 'authority.sqlite'))).toString('latin1')).not.toContain(client.client_secret);
  expect((await authority.clientsStore.getClient(client.client_id))?.client_secret).toBe(client.client_secret);
  await restart(); expect((await authority.clientsStore.getClient(client.client_id))?.client_secret).toBe(client.client_secret);
  const denied = await token({ client_id: client.client_id, client_secret: 'wrong', grant_type: 'refresh_token', refresh_token: 'a'.repeat(43), resource: `${origin}/mcp` });
  expect(denied.status).toBe(400); expect(await denied.json()).toMatchObject({ error: 'invalid_client' });
});

it('submits only after independent account proof and browser confirmation, and revoked jobs cannot be revived by a new same-subject connection', async () => {
  const flow = await connect(); const client = await mcp(flow.tokens.access_token);
  const pending = await client.callTool({ name: 'execution_submit', arguments: proposal }); expect(pending.isError).not.toBe(true);
  const approval = pending.structuredContent as { approvalUrl: string }; const path = new URL(approval.approvalUrl).pathname;
  const browser = new Browser(); const start = await browser.fetch(path); expect(start.status).toBe(303);
  const transaction = new URL(start.headers.get('location') ?? '').searchParams.get('transaction') ?? '';
  const { completion } = await consent(transaction, await identity()); const callback = await browser.fetch(completion.completionUrl); expect(callback.status).toBe(303);
  const page = await browser.fetch(path); const html = await page.text(); expect(page.status).toBe(200); const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''; expect(csrf).not.toBe('');
  const status = await result({ operation: 'status', accessToken: await identity() }); if (status.kind !== 'connections') throw new Error('Missing status');
  const id = status.connections[0]?.id ?? ''; await result({ operation: 'disconnect', accessToken: await identity(), connectionId: id });
  expect((await browser.fetch(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'confirm' }) })).status).not.toBe(200);
  await connect(); expect((await new Browser().fetch(path)).status).not.toBe(303);
  const brokerClient = await connectExecution({ expectedMode: 'policy', socketPath }); expect((await brokerClient.capabilities()).authority).toMatchObject({ remainingOrders: 20 });
});

it('uses the full product path to execute a nonfunded order once, preserving broker budget and status', async () => {
  const profile = config.profiles[0]; if (!profile) throw new Error('Missing profile'); config.profiles[0] = { ...profile, mode: 'policy' }; await restart();
  const flow = await connect(); const client = await mcp(flow.tokens.access_token);
  const sent = await client.callTool({ name: 'execution_submit', arguments: proposal }); expect(sent.isError, JSON.stringify(sent.content)).not.toBe(true); expect(sent.structuredContent).toMatchObject({ state: 'complete', automaticRetry: false });
  const again = await client.callTool({ name: 'execution_submit', arguments: proposal }); expect(again.structuredContent).toMatchObject({ state: 'complete' });
  const brokerClient = await connectExecution({ expectedMode: 'policy', socketPath }); expect((await brokerClient.capabilities()).authority).toMatchObject({ remainingOrders: 19 });
});

it('confirms an exact per-order request through independent product browser authentication and never repeats its send', async () => {
  const flow = await connect(); const client = await mcp(flow.tokens.access_token); const exact = prepareExecution(request);
  const pending = await client.callTool({ name: 'execution_submit', arguments: exact }); expect(pending.isError).not.toBe(true);
  const path = new URL((pending.structuredContent as { approvalUrl: string }).approvalUrl).pathname; const browser = new Browser();
  const start = await browser.fetch(path); const transaction = new URL(start.headers.get('location') ?? '').searchParams.get('transaction') ?? '';
  const { completion } = await consent(transaction, await identity()); expect((await browser.fetch(completion.completionUrl)).status).toBe(303);
  const html = await (await browser.fetch(path)).text(); const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''; expect(csrf).not.toBe('');
  const confirm = () => browser.fetch(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'confirm' }) });
  expect((await confirm()).status).toBe(200); expect((await confirm()).status).toBe(200);
  const status = await client.callTool({ name: 'execution_status', arguments: exact }); expect(status.structuredContent).toMatchObject({ state: 'complete' });
  const brokerClient = await connectExecution({ expectedMode: 'policy', socketPath }); expect((await brokerClient.capabilities()).authority).toMatchObject({ remainingOrders: 18 });
});

async function consumerFixture(mode: 'per_order' | 'policy' = 'per_order', beforePreview?: () => Promise<void>) {
  const enrollmentId = randomUUID(); const planId = randomUUID(); const revision = 'c'.repeat(64); const owner = wallet.address.toLowerCase();
  const scope = { kind: 'consumer_lighter', version: 1, ownerWallet: owner, network: 'testnet', account: 42, apiKeyIndex: 5, creators: [7], mode,
    maxOrderDebitUSDC: '10', origin, enrollmentId, epoch: 0 };
  const plan = LighterScopePlan.parse({ planId, revision, enrollmentId, ownerWallet: owner, network: 'testnet', message: `Synthetic owner-approved ${mode} scope ${planId}; no real venue.`,
    expiresAt: Date.now() + 120_000, scope, limits: { maxDebitUSDC: inspection.maxDebitUSDC, maxOrders: inspection.maxOrders,
      expiresAt: inspection.authority.expiresAt, cancelOwnOrders: inspection.authority.cancelOwnOrders } });
  const binding = Binding.parse({ id: planId, subject, enabled: true, mode, execution: { kind: 'local_socket', socketPath: socketPath },
    grantId: inspection.authority.grantId, grantHash: inspection.authority.grantHash, accounts: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5 }] });
  let registered = false; let activated = false; let prepareCalls = 0;
  const setup = () => ({ enrollmentId, revision, ownerWallet: owner, network: 'testnet' as const, account: 42, apiKeyIndex: 5, publicKey: `0x${'1'.repeat(80)}` });
  provisionerOverride = {
    async setup(input) {
      if (input.subject !== subject) throw new Error('Wrong private owner');
      if (input.operation === 'prepare') { if (input.walletAddress !== owner) throw new Error('Wrong wallet'); prepareCalls++; }
      else if (input.enrollmentId !== enrollmentId) throw new Error('Wrong enrollment');
      if (input.operation === 'register') {
        if (input.revision !== revision || (await recoverMessageAddress({ message: 'Synthetic registration; no real native transaction.', signature: input.signature as `0x${string}` })).toLowerCase() !== owner) throw new Error('Invalid private owner proof');
        registered = true;
      }
      return registered ? { ...setup(), state: 'ready' } : { ...setup(), state: 'signature_required', nonce: 0, chainId: 300, message: 'Synthetic registration; no real native transaction.', expiresAt: Date.now() + 120_000 };
    },
    async preview(id, enrollment) { if (id !== subject || enrollment !== enrollmentId) throw new Error('Wrong private owner'); await beforePreview?.(); return plan; },
    async activate(input) {
      if (input.subject !== subject || input.enrollmentId !== enrollmentId || input.planId !== planId || input.revision !== revision
        || (await recoverMessageAddress({ message: plan.message, signature: input.signature as `0x${string}` })).toLowerCase() !== owner) throw new Error('Wrong private scope proof');
      activated = true; return binding;
    },
    async binding(id) { return id === subject && activated ? binding : null; },
    async revoke() { activated = false; return { revoked: true }; },
  };
  const linked = binding.accounts[0]; if (!linked) throw new Error('Missing fixture linked account');
  inspectOverride = { ...inspection, templates: [], scope: plan.scope, accounts: [{ account: linked, ownerWallet: owner, agentAddress: null,
    checks: { registration: 'ready', builder: 'ready' }, checkedAt: Date.now(), notes: ['Inert inspection fixture; no real registration or order.'] }] };
  config = AccountServiceConfig.parse({ ...config, profiles: [], appNetwork: 'lighter-testnet', lighterProvisioner: { kind: 'local_socket', socketPath: join(state, 'control.sock'), brokerSocketRoot: directory } });
  await restart(); return { enrollmentId, plan, binding, prepareCalls: () => prepareCalls };
}

it('gives Lighter onboarding thirty minutes while each wallet proof still expires after five', async () => {
  const fixture = await consumerFixture(); const flow = await begin(); const accessToken = await identity();
  const view = await result({ operation: 'view', transaction: flow.transaction });
  const review = await result({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address });
  if (view.kind !== 'transaction' || review.kind !== 'review') throw new Error('Missing onboarding review');
  expect(view.expiresAt - Date.now()).toBeGreaterThan(29 * 60_000);
  expect(view.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  expect(review.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  const signature = await wallet.signMessage({ message: review.message });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt + 1);
  try {
    expect(await result({ operation: 'view', transaction: flow.transaction })).toMatchObject({ transaction: flow.transaction });
    expect((await relay({ operation: 'consent', transaction: flow.transaction, accessToken, reviewId: review.reviewId, signature })).status).toBe(400);
    expect((await relay({ operation: 'lighter_setup', transaction: flow.transaction, accessToken, reviewId: review.reviewId, signature })).status).toBe(400);
    expect(fixture.prepareCalls()).toBe(0);
    const fresh = await result({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address });
    if (fresh.kind !== 'review') throw new Error('Missing fresh review');
    expect(await result({ operation: 'lighter_setup', transaction: flow.transaction, accessToken, reviewId: fresh.reviewId,
      signature: await wallet.signMessage({ message: fresh.message }) })).toMatchObject({ state: { kind: 'owner_signature' } });
    clock.mockReturnValue(view.expiresAt + 1);
    expect((await relay({ operation: 'view', transaction: flow.transaction })).status).toBe(400);
  } finally { clock.mockRestore(); }
});

it('keeps research-only authorization at five minutes even when Lighter onboarding is configured', async () => {
  await consumerFixture(); const agent = new Agent();
  expect(await auth(agent, { serverUrl: `${origin}/mcp`, scope: READ_SCOPE })).toBe('REDIRECT');
  if (!agent.location) throw new Error('Missing research authorization');
  const opening = await new Browser().fetch(agent.location.href);
  const transaction = new URL(opening.headers.get('location') ?? '').searchParams.get('transaction') ?? '';
  const view = await result({ operation: 'view', transaction });
  if (view.kind !== 'transaction') throw new Error('Missing research view');
  expect(view.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
});

it('does not let an OAuth completion receipt outlive its five-minute wallet proof', async () => {
  await consumerFixture(); const flow = await begin();
  const { review, completion } = await consent(flow.transaction, await identity());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt + 1);
  try {
    expect(await result({ operation: 'view', transaction: flow.transaction })).toMatchObject({ transaction: flow.transaction });
    const rejected = await flow.browser.fetch(completion.completionUrl);
    expect(rejected.status).toBe(400); expect(rejected.headers.getSetCookie()).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('reuses the freshly signed connection browser for exact per-order review without approving the order', async () => {
  const flow = await connect(); const client = await mcp(flow.tokens.access_token); const exact = prepareExecution(request);
  const pending = await client.callTool({ name: 'execution_submit', arguments: exact });
  const path = new URL((pending.structuredContent as { approvalUrl: string }).approvalUrl).pathname;
  const review = await flow.browser.fetch(path); expect(review.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await review.text())?.[1] ?? ''; expect(csrf).not.toBe('');
  expect((await client.callTool({ name: 'execution_status', arguments: exact })).structuredContent).toMatchObject({ state: 'approval_required' });
  expect((await flow.browser.fetch(path, { headers: { authorization: `Bearer ${flow.tokens.access_token}` } })).status).toBe(403);
  expect((await new Browser().fetch(path)).status).toBe(303);
  const other = await connect();
  expect((await other.browser.fetch(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, decision: 'confirm' }) })).status).toBe(403);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000 + 1);
  try { expect(await authority.readSession(flow.browser.cookie)).toBeNull(); } finally { clock.mockRestore(); }
});

it.each(['per_order', 'policy'] as const)('self-service %s enrollment binds owner proofs, stored scope and original OAuth client without model-selected accounts', async (mode) => {
  const fixture = await consumerFixture(mode); const flow = await begin(); const accessToken = await identity();
  const review = await result({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address });
  if (review.kind !== 'review') throw new Error('Missing owner review'); expect(review.connection.kind).toBe('read_only');
  const proof = await wallet.signMessage({ message: review.message });
  const setupRequest = { operation: 'lighter_setup', transaction: flow.transaction, accessToken, reviewId: review.reviewId, signature: proof } as const;
  expect((await relay({ ...setupRequest, signature: await otherWallet.signMessage({ message: review.message }) })).status).toBe(400);
  expect(fixture.prepareCalls()).toBe(0);
  const setup = await result(setupRequest); expect(setup).toMatchObject({ kind: 'lighter_setup', state: { kind: 'owner_signature' } });
  expect((await relay({ operation: 'lighter_status', transaction: flow.transaction, accessToken: await identity('did:privy:bob') })).status).toBe(400);
  expect((await relay({ operation: 'lighter_status', transaction: flow.transaction, accessToken }, { 'x-verdict-app-session': 'b'.repeat(64) })).status).toBe(400);
  if (setup.kind !== 'lighter_setup' || setup.state.kind !== 'owner_signature') throw new Error('Missing registration');
  const registration = setup.state.registration;
  const scoped = await result({ operation: 'lighter_register', transaction: flow.transaction, accessToken, enrollmentId: registration.enrollmentId,
    revision: registration.revision, signature: await wallet.signMessage({ message: registration.message }) });
  if (scoped.kind !== 'lighter_setup' || scoped.state.kind !== 'scope_signature') throw new Error('Missing scope');
  const plan = scoped.state.plan;
  expect(plan.scope).toMatchObject({ mode, account: 42, apiKeyIndex: 5, origin });
  expect((await relay({ operation: 'lighter_activate', transaction: flow.transaction, accessToken, enrollmentId: plan.enrollmentId,
    planId: randomUUID(), revision: plan.revision, signature: await wallet.signMessage({ message: plan.message }) })).status).toBe(400);
  const activated = await result({ operation: 'lighter_activate', transaction: flow.transaction, accessToken, enrollmentId: plan.enrollmentId,
    planId: plan.planId, revision: plan.revision, signature: await wallet.signMessage({ message: plan.message }) });
  expect(activated).toMatchObject({ state: { kind: 'ready', connection: { kind: 'executable', mode, policy: { scope: { kind: 'consumer_lighter' }, templates: [] } } } });
  const { completion } = await consent(flow.transaction, accessToken); const callback = await flow.browser.fetch(completion.completionUrl);
  const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code'); if (!code) throw new Error('Missing native OAuth code');
  expect(await auth(flow.agent, { serverUrl: `${origin}/mcp`, authorizationCode: code })).toBe('AUTHORIZED');
  expect(flow.agent.saved?.scope).toContain(TRADE_SCOPE);
  await restart(); expect(await authority.binding(subject)).toEqual(fixture.binding);
  const status = await result({ operation: 'status', accessToken }); expect(status).toMatchObject({ connection: { kind: 'executable', mode } });
  if (status.kind !== 'connections' || !flow.agent.saved) throw new Error('Missing current connection');
  await result({ operation: 'disconnect', accessToken, connectionId: status.connections[0]?.id ?? '' });
  await expect(authority.authenticate(`Bearer ${flow.agent.saved.access_token}`, READ_SCOPE)).rejects.toMatchObject({ code: 'invalid_token' });
});

it('does not let an independently signed-in same-subject client approve another connection’s order', async () => {
  const original = await connect(); const originalClient = await mcp(original.tokens.access_token); const first = prepareExecution(request);
  const requested = await originalClient.callTool({ name: 'execution_submit', arguments: first });
  const firstPath = new URL((requested.structuredContent as { approvalUrl: string }).approvalUrl).pathname;
  const other = await connect(); const otherClient = await mcp(other.tokens.access_token); const second = prepareExecution(request);
  const secondPending = await otherClient.callTool({ name: 'execution_submit', arguments: second });
  const secondPath = new URL((secondPending.structuredContent as { approvalUrl: string }).approvalUrl).pathname;
  const browser = new Browser(); const start = await browser.fetch(secondPath); const transaction = new URL(start.headers.get('location') ?? '').searchParams.get('transaction') ?? '';
  const { completion } = await consent(transaction, await identity()); await browser.fetch(completion.completionUrl);
  const html = await (await browser.fetch(secondPath)).text(); const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const before = await (await connectExecution({ expectedMode: 'policy', socketPath })).capabilities();
  const denied = await browser.fetch(firstPath, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'confirm' }) });
  expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: 'review_connection_required' });
  expect((await (await connectExecution({ expectedMode: 'policy', socketPath })).capabilities()).authority).toEqual(before.authority);
});

it('does not overwrite a newer browser review with a stale private scope preview response', async () => {
  let entered = () => {}; let release = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  await consumerFixture('per_order', async () => { entered(); await gate; });
  const flow = await begin(); const accessToken = await identity();
  const review = await result({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address });
  if (review.kind !== 'review') throw new Error('Missing owner review');
  const setup = await result({ operation: 'lighter_setup', transaction: flow.transaction, accessToken, reviewId: review.reviewId, signature: await wallet.signMessage({ message: review.message }) });
  if (setup.kind !== 'lighter_setup' || setup.state.kind !== 'owner_signature') throw new Error('Missing registration');
  const registration = setup.state.registration;
  const pending = relay({ operation: 'lighter_register', transaction: flow.transaction, accessToken, enrollmentId: registration.enrollmentId,
    revision: registration.revision, signature: await wallet.signMessage({ message: registration.message }) });
  await started;
  const newer = await result({ operation: 'challenge', transaction: flow.transaction, accessToken, walletAddress: wallet.address });
  if (newer.kind !== 'review') throw new Error('Missing updated review');
  expect(newer.reviewId).not.toBe(review.reviewId); release(); expect((await pending).status).toBe(400);
  expect(await result({ operation: 'lighter_status', transaction: flow.transaction, accessToken })).toMatchObject({ state: { kind: 'scope_signature' } });
});
