import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectExecution, type ExecutionProposal, prepareExecution } from '../packages/core/src/index.js';
import { createHostedHandler, readHostedConfig } from '../packages/mcp/src/hosted-http.js';
import { HostedConfig, HostedMutation, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';
import { startIssuer } from './fixtures/hosted-issuer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALICE = 42;
const BOB = 43;
const request = (account = ALICE, price = '0.4') => ({ validForSeconds: 3600, legs: [{
  venue: 'lighter', network: 'testnet', account, apiKeyIndex: 2, market: 123, creator: 7,
  title: 'Synthetic hosted integration contract', settlementRule: 'Synthetic exact rule; no live contract or funds.',
  side: 'yes', action: 'buy', shares: '10', limitPrice: price, feeReserveUSDC: '0.1', tif: 'ioc',
}], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } });
let directory: string;
let issuer: Awaited<ReturnType<typeof startIssuer>>;
let config: HostedConfig;
let connector: Awaited<ReturnType<typeof createHostedHandler>>;
let server: Server;
let origin: string;
let alice: Client;
let bob: Client;
let aliceToken: string;
const clients: Client[] = [];
const brokers: ChildProcess[] = [];
const proposals = { alice: prepareExecution(request()), bob: prepareExecution(request(BOB)) };
let aliceSocket: string;
let approval: Extract<HostedMutation, { state: 'approval_required' }>;

async function startBroker(name: string, proposal: ExecutionProposal) {
  const socketPath = join(directory, `${name}.sock`);
  const template = join(directory, `${name}.json`);
  await writeFile(template, JSON.stringify(proposal));
  const child = spawn(process.env.VERDICT_BROKER_PYTHON ?? 'python3', [join(root, 'local-runner/tests/lifecycle_fixture.py'), template, socketPath, join(directory, name)], {
    cwd: root, env: { PATH: process.env.PATH ?? '', PYTHONPATH: join(root, 'local-runner'), PYTHONDONTWRITEBYTECODE: '1', VERDICT_NODE_BINARY: process.execPath }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  brokers.push(child);
  let diagnostics = ''; let failed = false;
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
  child.on('error', () => { failed = true; });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await stat(socketPath)).isSocket()) {
        const client = await connectExecution({ expectedMode: 'policy', socketPath });
        const capabilities = await client.capabilities();
        if (capabilities.authority.mode !== 'policy') throw new Error('Fixture policy missing');
        return { socketPath, grantId: capabilities.authority.grantId, child };
      }
    } catch { /* Wait for a real broker response, not just the socket file. */ }
    if (failed || child.exitCode !== null) throw new Error(`Nonfunded broker fixture failed: ${diagnostics}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Nonfunded broker fixture did not start: ${diagnostics}`);
}
async function mcp(token: string) {
  const client = new Client({ name: 'hosted-connector-integration', version: '1' }); clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  // SDK 1.32.1's optional sessionId is incompatible with its own Transport under exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent;
}
async function remainingOrders() {
  const client = await connectExecution({ expectedMode: 'policy', socketPath: aliceSocket });
  const authority = (await client.capabilities()).authority;
  if (authority.mode !== 'policy') throw new Error('Policy fixture missing');
  return authority.remainingOrders;
}
class ReviewBrowser {
  private readonly cookies = new Map<string, string>();
  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
    for (const value of response.headers.getSetCookie()) {
      const entry = value.split(';')[0]; if (!entry) continue;
      const equals = entry.indexOf('='); const name = entry.slice(0, equals);
      if (/Max-Age=0(?:;|$)/.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, entry.slice(equals + 1));
    }
    return response;
  }
  async login(path: string, subject: string) {
    issuer.loginAs(subject);
    const start = await this.fetch(path); expect(start.status).toBe(303);
    const authorizeUrl = start.headers.get('location'); if (!authorizeUrl) throw new Error('Missing login redirect');
    expect(new URL(authorizeUrl).origin).toBe(new URL(issuer.issuer).origin);
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' }); expect(authorize.status).toBe(302);
    const callbackUrl = authorize.headers.get('location'); if (!callbackUrl) throw new Error('Missing callback redirect');
    expect(new URL(callbackUrl).origin).toBe(origin);
    const callback = await this.fetch(callbackUrl); expect(callback.status).toBe(303);
    const review = callback.headers.get('location'); if (!review) throw new Error('Missing review redirect');
    return this.fetch(review);
  }
  confirm(path: string, csrf: string, decision = 'confirm', customOrigin = origin) {
    return this.fetch(path, { method: 'POST', headers: { origin: customOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision }).toString() });
  }
}
const browser = new ReviewBrowser();
let csrf: string;

beforeAll(async () => {
  directory = await mkdtemp('/tmp/vhc-');
  issuer = await startIssuer();
  const a = await startBroker('alice', proposals.alice); aliceSocket = a.socketPath;
  const b = await startBroker('bob', proposals.bob);
  server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing connector listener');
  origin = `http://127.0.0.1:${address.port}`;
  config = HostedConfig.parse({ publicOrigin: origin, issuer: issuer.issuer, browserClientId: issuer.clientId,
    storage: { kind: 'local', stateDir: join(directory, 'hosted-state') }, allowInsecureLocalhost: true,
    bindings: [{ id: 'alice', subject: 'alice', enabled: true, mode: 'per_order', execution: { kind: 'local_socket', socketPath: a.socketPath }, grantId: a.grantId,
      accounts: [{ venue: 'lighter', network: 'testnet', account: ALICE, apiKeyIndex: 2 }] },
    { id: 'bob', subject: 'bob', enabled: true, mode: 'policy', execution: { kind: 'local_socket', socketPath: b.socketPath }, grantId: b.grantId,
      accounts: [{ venue: 'lighter', network: 'testnet', account: BOB, apiKeyIndex: 2 }] }],
  });
  connector = await createHostedHandler(config); server.on('request', connector.handle);
  aliceToken = await issuer.token('alice', [READ_SCOPE, TRADE_SCOPE], { audience: `${origin}/mcp` });
  alice = await mcp(aliceToken);
  bob = await mcp(await issuer.token('bob', [READ_SCOPE, TRADE_SCOPE], { audience: `${origin}/mcp` }));
}, 20_000);
afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  await connector?.close();
  if (issuer) await issuer.close();
  for (const child of brokers) if (child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGTERM'); await stopped;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('serves OAuth discovery, challenges invalid tokens and advertises real write tools with a review resource', async () => {
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  expect(await metadata.json()).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [issuer.issuer] });
  for (const token of [null, await issuer.token('alice', [READ_SCOPE], { audience: 'https://wrong.invalid/mcp' })]) {
    const response = await fetch(`${origin}/mcp`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp');
  }
  expect(alice.getInstructions()).toContain('Research uses Lighter testnet');
  const tools = (await alice.listTools()).tools;
  expect(tools.every((tool) => tool.name.startsWith('lighter_') || tool.name.startsWith('execution_'))).toBe(true);
  expect((await alice.listResources()).resources.map((resource) => resource.uri)).toEqual(['verdict-lighter://markets', 'ui://verdict/order-review.html']);
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['lighter_list_markets', 'execution_accounts', 'execution_capabilities', 'execution_prepare', 'execution_review', 'execution_preflight', 'execution_submit', 'execution_status', 'execution_cancel']));
  expect(tools.find((tool) => tool.name === 'execution_submit')).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, _meta: { securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE, TRADE_SCOPE] }], ui: { resourceUri: 'ui://verdict/order-review.html' } } });
  const wire = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'auth-metadata', method: 'tools/list', params: {} }) });
  expect(await wire.json()).toMatchObject({ result: { tools: expect.arrayContaining([{ ...tools.find((tool) => tool.name === 'execution_submit'), securitySchemes: [{ type: 'oauth2', scopes: [READ_SCOPE, TRADE_SCOPE] }] }]) } });
  const resource = await alice.readResource({ uri: 'ui://verdict/order-review.html' });
  expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
  expect(JSON.stringify(resource)).toContain('ui/notifications/initialized');
  expect(JSON.stringify(resource)).not.toContain('csrf');
  expect(await call(alice, 'execution_accounts')).toMatchObject({ gatewayMode: 'per_order', brokerMode: 'policy', singleLegConfirmationOnly: true });
});

it('keeps read-only access and other users away from Alice’s execution authority', async () => {
  const reader = await mcp(await issuer.token('alice', [READ_SCOPE], { audience: `${origin}/mcp` }));
  expect(await call(reader, 'execution_prepare', request())).toHaveProperty('digest');
  const denied = await reader.callTool({ name: 'execution_submit', arguments: proposals.alice });
  expect(denied.isError).toBe(true); expect(denied._meta).toHaveProperty('mcp/www_authenticate');
  expect(JSON.stringify(denied._meta)).toContain('error_description');
  const copied = await bob.callTool({ name: 'execution_status', arguments: proposals.alice });
  expect(copied.isError).toBe(true);
  expect(await remainingOrders()).toBe(20);
});

it('queues an exact browser review without sending and blocks bearer-token or cross-user confirmation', async () => {
  const result = HostedMutation.parse(await call(alice, 'execution_submit', proposals.alice));
  if (result.state !== 'approval_required') throw new Error('Missing independent browser review');
  approval = result;
  expect(HostedMutation.parse(await call(alice, 'execution_status', proposals.alice))).toEqual(approval);
  expect(await remainingOrders()).toBe(20);
  expect((await fetch(approval.approvalUrl, { headers: { authorization: `Bearer ${aliceToken}` } })).status).toBe(403);
  const other = new ReviewBrowser();
  expect((await other.login(approval.approvalUrl, 'bob')).status).toBe(404);
  const review = await browser.login(approval.approvalUrl, 'alice'); expect(review.status).toBe(200);
  expect(review.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const html = await review.text(); expect(html).toContain(proposals.alice.digest);
  const match = /name="csrf" value="([^"]+)"/.exec(html); if (!match?.[1]) throw new Error('Missing review CSRF'); csrf = match[1];
  expect(await remainingOrders()).toBe(20);
});

it('requires the signed-in exact-origin CSRF form and consumes concurrent confirmations once through SDK and broker', async () => {
  expect((await browser.confirm(approval.approvalUrl, 'invalid')).status).toBe(403);
  expect((await browser.confirm(approval.approvalUrl, csrf, 'confirm', 'https://wrong.invalid')).status).toBe(403);
  expect(await remainingOrders()).toBe(20);
  const responses = await Promise.all([browser.confirm(approval.approvalUrl, csrf), browser.confirm(approval.approvalUrl, csrf)]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await remainingOrders()).toBe(19);
  expect(await call(alice, 'execution_status', proposals.alice)).toMatchObject({ state: 'complete', digest: proposals.alice.digest });
  expect(await call(alice, 'execution_submit', proposals.alice)).toMatchObject({ state: 'complete' });
  expect(await remainingOrders()).toBe(19);
}, 15_000);

it('supports explicitly selected bounded policy submission for a separate user', async () => {
  expect(await call(bob, 'execution_accounts')).toMatchObject({ gatewayMode: 'policy', brokerMode: 'policy', singleLegConfirmationOnly: true });
  const result = await call(bob, 'execution_submit', proposals.bob);
  expect(result).toMatchObject({ state: 'complete', digest: proposals.bob.digest });
  expect(await call(bob, 'execution_status', proposals.bob)).toEqual(result);
  expect(await remainingOrders()).toBe(19);
});

it('requires a separate exact cancellation review and preserves dispatch history across gateway restart', async () => {
  const pending = HostedMutation.parse(await call(alice, 'execution_cancel', { proposal: proposals.alice, leg: 0 }));
  if (pending.state !== 'approval_required') throw new Error('Missing cancellation review');
  expect(pending.approvalUrl).not.toBe(approval.approvalUrl);
  expect(await call(alice, 'execution_status', proposals.alice)).toMatchObject({ state: 'approval_required', approvalUrl: pending.approvalUrl });
  expect((await browser.confirm(pending.approvalUrl, csrf)).status).toBe(200);
  server.off('request', connector.handle); await connector.close();
  connector = await createHostedHandler(config); server.on('request', connector.handle);
  expect((await browser.fetch(approval.approvalUrl)).status).toBe(303);
  expect(await call(alice, 'execution_submit', proposals.alice)).toMatchObject({ state: 'complete' });
  expect(await remainingOrders()).toBe(19);
}, 15_000);

it('rejects unsafe operator configuration and requires explicit hosted CLI activation', async () => {
  const path = join(directory, 'connector.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  expect(await readHostedConfig(path)).toEqual(config);
  await chmod(path, 0o644); await expect(readHostedConfig(path)).rejects.toMatchObject({ code: 'invalid_configuration' });
  expect(HostedConfig.safeParse({ ...config, publicOrigin: 'http://mcp.public.invalid' }).success).toBe(false);
  expect(HostedConfig.safeParse({ ...config, publicOrigin: 'https://mcp.public.invalid?redirect=bad' }).success).toBe(false);
  expect(HostedConfig.parse({ ...config, publicOrigin: 'https://mcp.public.invalid/' }).publicOrigin).toBe('https://mcp.public.invalid');
  const denied = spawnSync(process.execPath, [join(root, 'packages/mcp/dist/bin.js'), '--hosted-execution', '--http', '8788'], { encoding: 'utf8' });
  expect(denied.status).toBe(1); expect(denied.stderr).toContain('--connector-config');
});

it('cannot spend a replacement broker grant at the same Unix socket after capabilities succeeded', async () => {
  const first = await startBroker('replacement', proposals.alice);
  const pinned = await connectExecution({ expectedMode: 'policy', expectedGrantId: first.grantId, socketPath: first.socketPath });
  const stopped = new Promise<void>((resolve) => first.child.once('exit', () => resolve()));
  first.child.kill('SIGTERM'); await stopped;
  const replacement = await startBroker('replacement', proposals.alice);
  expect(replacement.grantId).not.toBe(first.grantId);
  expect(replacement.socketPath).toBe(first.socketPath);
  await expect(pinned.submit(proposals.alice)).rejects.toThrow('operator-pinned grant');
  const current = await connectExecution({ expectedMode: 'policy', expectedGrantId: replacement.grantId, socketPath: replacement.socketPath });
  expect((await current.capabilities()).authority).toMatchObject({ grantId: replacement.grantId, remainingOrders: 20, remainingDebitUSDC: '100.000000000000' });
}, 15_000);
