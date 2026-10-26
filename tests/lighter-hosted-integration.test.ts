import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request as localRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareExecution } from '../packages/core/src/index.js';
import { ConnectResponse, type ConnectRequest, type LighterScopePlan } from '../packages/mcp/src/connect-contract.js';
import { AccountServiceConfig } from '../packages/mcp/src/connect-model.js';
import { createAccountService } from '../packages/mcp/src/connect-http.js';

// Real OAuth/MCP, encrypted private provisioner and policy Broker; only HTTP routing,
// Privy-style signing issuer and venue are test fixtures. Never contacts a live venue.
const origin = 'https://mcp.local.fixture'; const appOrigin = 'https://app.local.fixture'; const subject = 'did:privy:hosted-integration';
const owner = privateKeyToAccount(generatePrivateKey()); const root = fileURLToPath(new URL('..', import.meta.url));
let directory: string | undefined; let listener: Server | undefined; let child: ChildProcess | undefined;
let service: Awaited<ReturnType<typeof createAccountService>> | undefined;
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
async function startPrivate(mode: 'per_order' | 'policy') {
  if (!directory) throw new Error('Missing private fixture directory'); const socketPath = join(directory, 'control.sock');
  child = spawn(process.env.VERDICT_BROKER_PYTHON ?? join(root, 'local-runner/.venv/bin/python'), [join(root, 'local-runner/tests/provisioner_fixture.py'), '--root', directory, '--socket', socketPath,
    '--owner', owner.address.toLowerCase(), '--origin', origin, '--mode', mode], { cwd: root, env: { PATH: process.env.PATH ?? '', PYTHONPATH: join(root, 'local-runner'),
      PYTHONDONTWRITEBYTECODE: '1', VERDICT_NODE_BINARY: process.execPath }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr?.on('data', (value: Buffer) => { diagnostics += value.toString(); });
  for (let i = 0; i < 300; i++) { try { if ((await stat(socketPath)).isSocket()) return; } catch { /* Await private socket. */ }
    if (child.exitCode !== null) throw new Error(`Private fixture exited: ${diagnostics}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error(`Private fixture timed out: ${diagnostics}`);
}
async function stopPrivate() {
  if (child && child.exitCode === null) { const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve())); child.kill('SIGTERM'); await stopped; }
  child = undefined;
}
async function start(mode: 'per_order' | 'policy') {
  directory = await mkdtemp('/tmp/vhi-'); signing = await generateKeyPair('ES256');
  listener = createServer(); await new Promise<void>((resolve) => listener?.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address'); localOrigin = `http://127.0.0.1:${address.port}`;
  const socketPath = join(directory, 'control.sock');
  await startPrivate(mode);
  process.env.VERDICT_PRIVATE_INTEGRATION_RELAY = generatePrivateKey();
  config = AccountServiceConfig.parse({ publicOrigin: origin, appOrigin, appNetwork: 'lighter-testnet', privyAppId: 'fixture-app', privyVerificationKey: await exportSPKI(signing.publicKey),
    relaySecretEnv: 'VERDICT_PRIVATE_INTEGRATION_RELAY', stateDir: join(directory, 'authority'), gatewayJobsDir: join(directory, 'jobs'), profiles: [],
    lighterProvisioner: { socketPath, brokerSocketRoot: join(directory, 'sockets') } });
  service = await createAccountService(config); listener.on('request', service.handle);
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
  const completed = await app({ operation: 'consent', transaction, accessToken, reviewId: delegation.reviewId, signature: await owner.signMessage({ message: delegation.message }) });
  if (completed.kind !== 'complete') throw new Error('Missing completion'); const callback = await browser.fetch(completed.completionUrl); const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code'); if (!code) throw new Error('Missing OAuth code');
  expect(await auth(agent, { serverUrl: `${origin}/mcp`, authorizationCode: code, fetchFn: localFetch })).toBe('AUTHORIZED'); if (!agent.saved) throw new Error('Missing resource tokens');
  const client = new Client({ name: 'private-integration', version: '1' }); clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { fetch: localFetch, requestInit: { headers: { authorization: `Bearer ${agent.saved.access_token}` } } });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]); return { client, token: agent.saved.access_token, plan };
}
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  if (service && listener) { listener.removeListener('request', service.handle); service.close(); }
  if (listener) { listener.closeAllConnections(); await new Promise<void>((resolve) => listener?.close(() => resolve())); }
  await stopPrivate();
  if (directory) await rm(directory, { recursive: true, force: true }); delete process.env.VERDICT_PRIVATE_INTEGRATION_RELAY;
  child = undefined; listener = undefined; service = undefined; directory = undefined;
});
it.each(['per_order', 'policy'] as const)('runs %s from real OAuth through the private provisioning protocol and exact SDK/broker execution once', async (mode) => {
  await start(mode); const { client, token, plan } = await delegated();
  const exact = prepareExecution({ legs: [{ venue: 'lighter', network: 'testnet', account: plan.scope.account, apiKeyIndex: plan.scope.apiKeyIndex,
    market: 9001, creator: 7, title: 'Fresh synthetic 15-minute contract', settlementRule: 'Inert fixture settlement; no real venue or funds.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }], policy: { maxTotalDebitUSDC: '5', maxLegDebitUSDC: '5' } });
  const pending = await client.callTool({ name: 'execution_submit', arguments: exact }); expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true);
  if (mode === 'per_order') {
    const { approvalUrl } = z.object({ approvalUrl: z.string().url() }).passthrough().parse(pending.structuredContent);
    expect(pending.structuredContent).toMatchObject({ state: 'approval_required' });
    expect((await localFetch(approvalUrl, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    const browser = new Browser(); const signIn = await browser.fetch(approvalUrl); const transaction = new URL(signIn.headers.get('location') ?? '').searchParams.get('transaction') ?? '';
    const accessToken = await identity(); const review = await app({ operation: 'challenge', transaction, accessToken, walletAddress: owner.address }); if (review.kind !== 'review') throw new Error('Missing independent owner login');
    const done = await app({ operation: 'consent', transaction, accessToken, reviewId: review.reviewId, signature: await owner.signMessage({ message: review.message }) }); if (done.kind !== 'complete') throw new Error('Missing independent completion');
    await browser.fetch(done.completionUrl); const html = await (await browser.fetch(approvalUrl)).text(); expect(html).toContain('Fresh synthetic 15-minute contract'); expect(html).toContain(exact.digest);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''; expect(csrf).not.toBe('');
    const confirm = () => browser.fetch(approvalUrl, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'confirm' }) });
    expect((await confirm()).status).toBe(200); expect((await confirm()).status).toBe(200);
  }
  const status = await client.callTool({ name: 'execution_status', arguments: exact }); expect(status.structuredContent).toMatchObject({ state: 'complete', legs: [{ state: 'filled', filled: '10' }] });
  const repeated = await client.callTool({ name: 'execution_submit', arguments: exact }); expect(repeated.structuredContent).toMatchObject({ state: 'complete' });
  if (!listener || !service) throw new Error('Missing current fixture service');
  listener.removeListener('request', service.handle); service.close(); await stopPrivate(); await startPrivate(mode);
  service = await createAccountService(config); listener.on('request', service.handle);
  const restored = await client.callTool({ name: 'execution_status', arguments: exact }); expect(restored.structuredContent).toMatchObject({ state: 'complete', legs: [{ state: 'filled' }] });
  if (!directory) throw new Error('Missing fixture state'); const stats = JSON.parse(await readFile(join(directory, 'metrics.json'), 'utf8'));
  expect(stats).toMatchObject({ sends: 1 });
}, 30_000);
