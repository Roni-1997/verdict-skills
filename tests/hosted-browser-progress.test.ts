import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type ExecutionClient, type ExecutionProposal, type ExecutionStatus, prepareExecution } from '../packages/core/src/index.js';
import { HostedExecution } from '../packages/mcp/src/hosted-execution.js';
import { createHostedHandler } from '../packages/mcp/src/hosted-http.js';
import { HostedJobs } from '../packages/mcp/src/hosted-jobs.js';
import { HostedConfig, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';
import type { HostedRuntime } from '../packages/mcp/src/hosted-security.js';

const grantId = '11111111-1111-4111-8111-111111111111';
const issuer = 'https://identity.example/';
const csrf = 'a'.repeat(64);
let directory: string;
let origin: string;
let server: Server;
let handler: Awaited<ReturnType<typeof createHostedHandler>>;
let path: string;
let submits: number;
let statuses: number;
let statusState: 'unavailable' | 'pending' | 'complete';

const get = (url = path, cookie = 'owner=alice') => fetch(url, { headers: { cookie }, redirect: 'manual' });
const confirm = () => fetch(path, { method: 'POST', redirect: 'manual',
  headers: { cookie: 'owner=alice', origin, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf, decision: 'confirm' }) });

beforeEach(async () => {
  directory = await mkdtemp('/tmp/verdict-browser-progress-'); submits = 0; statuses = 0; statusState = 'unavailable';
  server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  origin = `http://127.0.0.1:${address.port}`;
  const binding = { id: 'alice', subject: 'alice', enabled: true, mode: 'per_order', grantId,
    execution: { kind: 'hosted_signer', profileId: grantId },
    accounts: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5 }] };
  const config = HostedConfig.parse({ publicOrigin: origin, issuer, browserClientId: 'fixture', allowInsecureLocalhost: true,
    storage: { kind: 'local', stateDir: join(directory, 'state') }, bindings: [binding] });
  const linked = config.bindings[0]; if (!linked) throw new Error('Missing fixture binding');
  const principal = { issuer, subject: 'alice', scopes: [READ_SCOPE, TRADE_SCOPE], expiresAt: Date.now() + 7_200_000,
    authorization: { kind: 'first_party' as const, grantId, epoch: 0 } };
  const runtime: HostedRuntime = {
    auth: { metadata: () => ({ resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: [READ_SCOPE, TRADE_SCOPE], bearer_methods_supported: ['header'] }),
      challenge: () => 'Bearer', authenticate: () => { throw new Error('No model sign-in expected'); },
      login: () => { throw new Error('Existing review must not restart setup'); }, callback: () => { throw new Error('No callback expected'); },
      readSession: cookie => ({ principal: cookie === 'owner=alice' ? principal : { ...principal, subject: 'bob' }, csrf, expiresAt: principal.expiresAt }) },
    binding: subject => subject === 'alice' ? linked : null, assertActive: () => {}, assertJobActive: () => {}, status: async () => null,
  };
  const authority = { mode: 'policy' as const, grantId, grantHash: 'a'.repeat(64), expiresAt: Date.now() + 86_400_000,
    newRisk: 'active' as const, remainingDebitUSDC: '100', remainingOrders: 100, cancelOwnOrders: true as const };
  const complete = (proposal: ExecutionProposal): ExecutionStatus => ({ state: 'complete', digest: proposal.digest,
    automaticRetry: false, note: 'Inert fixture; no venue calls.',
    legs: [{ leg: 0, state: 'filled', filled: '1', netInventoryChange: '1', settled: true }] });
  const client: ExecutionClient = { mode: 'policy',
    capabilities: async () => ({ kind: 'local_execution_capabilities', authority, fundedAcceptanceVerified: false }),
    inspectConnection: async () => { throw new Error('No setup expected'); },
    preflight: async proposal => ({ state: 'ready', digest: proposal.digest, authorization: 'none', authority,
      legs: [{ leg: 0, inventoryShares: '0', availableUSDC: '100', feeBoundUSDC: '0.01', checkedAt: Date.now(), validUntil: Date.now() + 5000 }] }),
    submit: async () => { submits++; throw new Error('Inert uncertain delivery'); },
    status: async proposal => {
      statuses++; if (statusState === 'unavailable') throw new Error('Inert status unavailable');
      return statusState === 'complete' ? complete(proposal) : { ...complete(proposal), state: 'needs_reconciliation',
        legs: [{ leg: 0, state: 'pending', filled: null, netInventoryChange: null, settled: false }] };
    },
    cancel: async () => { throw new Error('No cancellation expected'); },
  };
  const jobs = new HostedJobs(join(directory, 'state'));
  const gateway = new HostedExecution(config, jobs, undefined, runtime, async () => client);
  const proposal = prepareExecution({ validForSeconds: 3600,
    legs: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5, creator: 7, market: 123,
      title: 'Inert test market', settlementRule: 'No real market.', side: 'yes', action: 'buy', shares: '1', limitPrice: '0.4', feeReserveUSDC: '0.01', tif: 'ioc' }],
    policy: { maxTotalDebitUSDC: '1', maxLegDebitUSDC: '1' } });
  const pending = await gateway.submit(principal, proposal);
  if (pending.state !== 'approval_required') throw new Error('Missing review');
  path = pending.approvalUrl;
  handler = await createHostedHandler(config, runtime, { jobs, remoteConnect: async () => client }); server.on('request', handler.handle);
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await handler.close();
  await rm(directory, { recursive: true, force: true });
});

it('progresses an uncertain confirmation through owner-authenticated GET checks without another submit or setup', async () => {
  const review = await get(); expect(await review.text()).toContain('Confirm this order'); expect(review.headers.get('refresh')).toBeNull();
  const confirmed = await confirm(); expect(confirmed.status).toBe(200);
  expect(confirmed.headers.get('refresh')).toMatch(/^3; url=\/review\/[a-f0-9-]+\?check=1$/);
  const checking = await confirmed.text(); expect(checking).toContain('Checking your order'); expect(checking).toContain('Check status'); expect(checking).not.toContain('<form');
  const checkUrl = `${origin}${confirmed.headers.get('refresh')?.split('url=')[1]}`;
  const pending = await get(checkUrl); expect(pending.status).toBe(200); expect(await pending.text()).toContain('Checking your order'); expect(statuses).toBe(1);
  statusState = 'pending';
  const observed = await get(checkUrl); expect(observed.headers.get('refresh')).toContain('?check=2'); expect(await observed.text()).toContain('pending');
  statusState = 'complete';
  const complete = await get(checkUrl); expect(complete.status).toBe(200); expect(complete.headers.get('refresh')).toBeNull();
  expect(await complete.text()).toContain('Trade complete'); expect(statuses).toBe(3); expect(submits).toBe(1);
  const cached = await get(); expect(await cached.text()).toContain('Trade complete'); expect(statuses).toBe(3); expect(submits).toBe(1);
  const csp = complete.headers.get('content-security-policy'); expect(csp).toContain("default-src 'none'"); expect(csp).not.toContain('unsafe-inline');
});

it('pauses automatic GET checks after a bounded wait and retains an explicit status link', async () => {
  await confirm();
  const paused = await get(`${path}?check=12`); expect(paused.status).toBe(200); expect(paused.headers.get('refresh')).toBeNull();
  const html = await paused.text(); expect(html).toContain('Automatic checks have paused'); expect(html).toContain('Check status'); expect(html).not.toContain('<form');
  expect(submits).toBe(1); expect(statuses).toBe(1);
});

it('keeps progress checks behind the original owner and rejects malformed counters without a status call', async () => {
  await confirm();
  for (const query of ['check=-1', 'check=13', 'check=1&check=2', 'check=NaN']) expect((await get(`${path}?${query}`)).status).toBe(400);
  expect((await get(`${path}?check=1`, 'owner=bob')).status).toBe(403);
  expect(submits).toBe(1); expect(statuses).toBe(0);
});
