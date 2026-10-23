import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ExecutionClient, type ExecutionConnectionOptions, type ExecutionMode,
  type ExecutionPreflight, type ExecutionProposal, type ExecutionStatus, type LocalExecutionCapabilities,
  prepareExecution,
} from '../packages/core/src/index.js';
import { HostedExecution } from '../packages/mcp/src/hosted-execution.js';
import { HostedJobs } from '../packages/mcp/src/hosted-jobs.js';
import { HostedConfig, type HostedMutation, type Principal, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ADDRESS = `0x${'1'.repeat(40)}`;
const BOB_ADDRESS = `0x${'3'.repeat(40)}`;
const GRANT = '11111111-1111-4111-8111-111111111111';
const BOB_GRANT = '22222222-2222-4222-8222-222222222222';
const issuer = 'https://identity.example/';
function principal(subject = 'alice'): Principal {
  return { issuer, subject, scopes: [READ_SCOPE, TRADE_SCOPE], expiresAt: Date.now() + 7_200_000 };
}
function request(account = ADDRESS, validForSeconds = 3600) {
  return { validForSeconds, legs: [{ venue: 'hl', network: 'testnet', account, outcome: 123,
    title: 'Synthetic account-linked contract', settlementRule: 'Synthetic exact oracle rule; no real market.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'Ioc',
    allInFeeBpsCap: '10', builder: { address: `0x${'2'.repeat(40)}`, feeTenthsBp: 0 },
  }], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } };
}
function pair() {
  const first = request();
  return prepareExecution({ ...first, legs: [...first.legs, {
    venue: 'lighter', network: 'devnet', account: 42, apiKeyIndex: 2, creator: 7, market: 456,
    title: first.legs[0]?.title, settlementRule: first.legs[0]?.settlementRule,
    side: 'no', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc',
  }], settlementReview: { relationship: 'same_event_same_orientation', notes: 'Operator reviewed identical oracle and exact payout orientation.' } });
}
function index(value: number): 0 | 1 { if (value === 0 || value === 1) return value; throw new Error('Invalid test leg'); }
function approvalId(value: HostedMutation): string {
  if (value.state !== 'approval_required') throw new Error('Expected browser approval');
  const id = new URL(value.approvalUrl).pathname.split('/').at(-1);
  if (!id) throw new Error('Missing approval id');
  return id;
}

class FakeClient implements ExecutionClient {
  mode: ExecutionMode = 'policy';
  authority: Extract<LocalExecutionCapabilities['authority'], { mode: 'policy' }>;
  preflights = 0; submits = 0; statuses = 0; cancels = 0;
  submitError: Error | null = null;
  statusError: Error | null = null;
  cancelError: Error | null = null;
  constructor(grantId = GRANT) {
    this.authority = { mode: 'policy', grantId, grantHash: 'a'.repeat(64), expiresAt: Date.now() + 86_400_000,
      newRisk: 'active', remainingDebitUSDC: '100', remainingOrders: 100, cancelOwnOrders: true };
  }
  async capabilities(): Promise<LocalExecutionCapabilities> {
    return { kind: 'local_execution_capabilities', authority: this.authority, fundedAcceptanceVerified: false };
  }
  async preflight(proposal: ExecutionProposal): Promise<ExecutionPreflight> {
    this.preflights++;
    return { state: 'ready', digest: proposal.digest, authorization: 'none', authority: this.authority,
      legs: proposal.payload.legs.map((_, leg) => ({ leg: index(leg), inventoryShares: '0', availableUSDC: '100', feeBoundUSDC: '0.01', checkedAt: Date.now(), validUntil: Date.now() + 5000 })) };
  }
  result(proposal: ExecutionProposal): ExecutionStatus {
    return { digest: proposal.digest, state: 'complete', automaticRetry: false, note: 'Fake venue, no funded orders.',
      legs: proposal.payload.legs.map((leg, i) => ({ leg: index(i), state: 'filled', filled: leg.shares, netInventoryChange: leg.shares, settled: true })) };
  }
  async submit(proposal: ExecutionProposal): Promise<ExecutionStatus> {
    this.submits++; if (this.submitError) throw this.submitError; return this.result(proposal);
  }
  async status(proposal: ExecutionProposal): Promise<ExecutionStatus> {
    this.statuses++; if (this.statusError) throw this.statusError; return this.result(proposal);
  }
  async cancel(input: { proposal: ExecutionProposal; leg: 0 | 1 }): Promise<ExecutionStatus> {
    this.cancels++; if (this.cancelError) throw this.cancelError; return this.result(input.proposal);
  }
}

let directory: string;
let jobs: HostedJobs;
let config: HostedConfig;
let alice: FakeClient;
let bob: FakeClient;
let connections: ExecutionConnectionOptions[];
let gateway: HostedExecution;
const stores: HostedJobs[] = [];
function openJobs(): HostedJobs { const store = new HostedJobs(join(directory, 'state')); stores.push(store); return store; }
async function connect(options: ExecutionConnectionOptions): Promise<ExecutionClient> {
  connections.push(options);
  if (options.socketPath === '/operator/alice.sock') return alice;
  if (options.socketPath === '/operator/bob.sock') return bob;
  throw new Error('Unconfigured private destination');
}
beforeEach(async () => {
  directory = await mkdtemp('/tmp/verdict-hosted-gateway-'); jobs = openJobs();
  config = HostedConfig.parse({ publicOrigin: 'https://mcp.verdict.example', issuer,
    browserClientId: 'browser-client', stateDir: join(directory, 'state'), approvalTtlSeconds: 30,
    bindings: [{ id: 'alice', subject: 'alice', enabled: true, mode: 'per_order', brokerSocket: '/operator/alice.sock', grantId: GRANT,
      accounts: [{ venue: 'hl', network: 'testnet', account: ADDRESS }, { venue: 'lighter', network: 'devnet', account: 42, apiKeyIndex: 2 }] },
    { id: 'bob', subject: 'bob', enabled: true, mode: 'policy', brokerSocket: '/operator/bob.sock', grantId: BOB_GRANT,
      accounts: [{ venue: 'hl', network: 'testnet', account: BOB_ADDRESS }] }],
  });
  alice = new FakeClient(); bob = new FakeClient(BOB_GRANT); connections = [];
  gateway = new HostedExecution(config, jobs, connect);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await rm(directory, { recursive: true, force: true });
});

it('reports the honest gateway/broker modes without private configuration', async () => {
  const account = await gateway.accounts(principal());
  expect(account).toMatchObject({ gatewayMode: 'per_order', brokerMode: 'policy', singleLegConfirmationOnly: true, authority: { grantId: GRANT } });
  const data = JSON.stringify(account);
  expect(data).not.toContain('alice.sock'); expect(data).not.toContain('brokerSocket'); expect(data).not.toContain(directory);
  expect((await gateway.accounts(principal('bob'))).gatewayMode).toBe('policy');
  expect(connections).toEqual([
    { expectedMode: 'policy', expectedGrantId: GRANT, socketPath: '/operator/alice.sock' },
    { expectedMode: 'policy', expectedGrantId: BOB_GRANT, socketPath: '/operator/bob.sock' },
  ]);
});

it('checks issuer, subject, expiry, scopes and account/key ownership before any private connection', async () => {
  const proposal = prepareExecution(request());
  const identities = [{ ...principal(), issuer: 'https://other.example/' }, principal('unlinked'),
    { ...principal(), expiresAt: Date.now() - 1 }, { ...principal(), scopes: [] }, { ...principal(), scopes: [READ_SCOPE] }];
  for (const identity of identities) await expect(gateway.submit(identity, proposal)).rejects.toBeInstanceOf(Error);
  await expect(gateway.preflight(principal('bob'), proposal)).rejects.toMatchObject({ code: 'account_mismatch' });
  await expect(gateway.prepare(principal('bob'), request())).rejects.toMatchObject({ code: 'account_mismatch' });
  const lighter = pair().payload.legs[1];
  if (!lighter) throw new Error('Missing fixture leg');
  const wrongKey = prepareExecution({ ...request(), legs: [{ ...lighter, apiKeyIndex: 3 }] });
  await expect(gateway.preflight(principal(), wrongKey)).rejects.toMatchObject({ code: 'account_mismatch' });
  expect(connections).toHaveLength(0);
});

it('rejects disabled bindings, malformed proposals and extra cancellation authority before SDK', async () => {
  const changed = structuredClone(config); const binding = changed.bindings[0];
  if (!binding) throw new Error('Missing binding'); binding.enabled = false;
  await expect(new HostedExecution(changed, jobs, connect).accounts(principal())).rejects.toMatchObject({ code: 'account_not_linked' });
  const proposal = prepareExecution(request());
  await expect(gateway.submit(principal(), { ...proposal, digest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_proposal' });
  await expect(gateway.cancel(principal(), { proposal, leg: 0, approved: true })).rejects.toMatchObject({ code: 'invalid_leg' });
  await expect(gateway.cancel(principal(), { proposal, leg: 1 })).rejects.toMatchObject({ code: 'invalid_leg' });
  expect(connections).toHaveLength(0);
});

it('creates one pending single-order review after fresh preflight and sends only after confirmation', async () => {
  const proposal = await gateway.prepare(principal(), request());
  expect((await gateway.review(principal(), proposal)).digest).toBe(proposal.digest);
  const pending = await gateway.submit(principal(), proposal);
  const id = approvalId(pending);
  expect(alice.preflights).toBe(1); expect(alice.submits).toBe(0);
  expect(await gateway.submit(principal(), proposal)).toEqual(pending);
  expect(await gateway.status(principal(), proposal)).toEqual(pending);
  expect((await gateway.reviewJob(principal(), id)).proposal).toEqual(proposal);
  expect(await gateway.confirm(principal(), id)).toMatchObject({ state: 'complete', digest: proposal.digest });
  expect(alice.submits).toBe(1);
});

it('never lets one authenticated user review, confirm, cancel or observe another user request', async () => {
  const proposal = prepareExecution(request());
  const pending = await gateway.submit(principal(), proposal); const id = approvalId(pending);
  const before = connections.length;
  await expect(gateway.reviewJob(principal('bob'), id)).rejects.toMatchObject({ status: 404 });
  await expect(gateway.confirm(principal('bob'), id)).rejects.toMatchObject({ status: 404 });
  await expect(gateway.decline(principal('bob'), id)).rejects.toMatchObject({ status: 404 });
  await expect(gateway.status(principal('bob'), proposal)).rejects.toMatchObject({ code: 'account_mismatch' });
  await expect(gateway.cancel(principal('bob'), { proposal, leg: 0 })).rejects.toMatchObject({ code: 'account_mismatch' });
  expect(connections).toHaveLength(before); expect(alice.submits + bob.submits).toBe(0);
});

it('does not share mutable principal or broker state across concurrent users', async () => {
  const [a, b] = await Promise.all([gateway.submit(principal(), prepareExecution(request())), gateway.submit(principal('bob'), prepareExecution(request(BOB_ADDRESS)))]);
  expect(a.state).toBe('approval_required'); expect(b.state).toBe('complete');
  expect(alice.submits).toBe(0); expect(bob.submits).toBe(1);
});

it('rejects per-order pairs before any SDK call or job while policy mode can execute reviewed pairs', async () => {
  const proposal = pair();
  await expect(gateway.submit(principal(), proposal)).rejects.toMatchObject({ code: 'single_leg_confirmation_only' });
  expect(connections).toHaveLength(0);
  const changed = structuredClone(config); const binding = changed.bindings[0];
  if (!binding) throw new Error('Missing binding'); binding.mode = 'policy';
  const policy = new HostedExecution(changed, jobs, connect);
  expect((await policy.submit(principal(), proposal)).state).toBe('complete');
  expect(alice.submits).toBe(1); expect(alice.preflights).toBe(0);
});

it('asserts policy broker mode and the operator-pinned grant at every private connection', async () => {
  alice.authority.grantId = BOB_GRANT;
  await expect(gateway.submit(principal(), prepareExecution(request()))).rejects.toMatchObject({ code: 'broker_authority_mismatch' });
  expect(alice.submits).toBe(0);
  alice.authority.grantId = GRANT; alice.mode = 'per_order';
  await expect(gateway.accounts(principal())).rejects.toMatchObject({ code: 'broker_authority_mismatch' });
});

it('rechecks the pinned grant on confirmation and cannot send after a broker authority change', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  alice.authority.grantId = BOB_GRANT;
  expect(await gateway.confirm(principal(), id)).toMatchObject({ state: 'delivery_unknown', digest: proposal.digest, automaticRetry: false });
  expect(alice.submits).toBe(0); expect(jobs.get(id)?.state).toBe('attempted');
});

it('does not issue a fresh approval when a pending request expires', async () => {
  const identity = principal(); const proposal = prepareExecution(request());
  const pending = await gateway.submit(identity, proposal); const id = approvalId(pending);
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31_000);
  await expect(gateway.submit(identity, proposal)).rejects.toMatchObject({ code: 'approval_expired' });
  await expect(gateway.confirm(identity, id)).rejects.toMatchObject({ code: 'approval_expired' });
  expect(jobs.get(id)?.state).toBe('pending'); expect(alice.submits).toBe(0); expect(alice.preflights).toBe(1);
});

it('declining is durable and cannot be turned into a later confirmation', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  expect((await gateway.decline(principal(), id)).state).toBe('declined');
  await expect(gateway.confirm(principal(), id)).rejects.toMatchObject({ code: 'approval_declined' });
  await expect(gateway.submit(principal(), proposal)).rejects.toMatchObject({ code: 'approval_declined' });
  expect(alice.submits).toBe(0);
});

it('claims concurrent browser confirmations once and all repeats reconcile rather than resubmit', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  await Promise.all([gateway.confirm(principal(), id), gateway.confirm(principal(), id)]);
  expect(alice.submits).toBe(1); expect(alice.statuses).toBe(1);
  await gateway.submit(principal(), proposal); await gateway.confirm(principal(), id);
  expect(alice.submits).toBe(1); expect(alice.statuses).toBe(3);
});

it('post-claim failures retain attempted state and never reveal private errors or retry', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  alice.submitError = new Error('sdk-auth-token-and-private-path');
  const result = await gateway.confirm(principal(), id);
  expect(result).toEqual({ state: 'delivery_unknown', digest: proposal.digest, nextOperation: 'status', automaticRetry: false });
  expect(JSON.stringify(result)).not.toContain('sdk-auth'); expect(jobs.get(id)?.state).toBe('attempted');
  alice.submitError = null;
  expect((await gateway.submit(principal(), proposal)).state).toBe('complete');
  expect(alice.submits).toBe(1); expect(alice.statuses).toBe(1);
});

it('restarts preserve the dispatch fence and use the original proposal for reconciliation', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  alice.submitError = new Error('lost response'); await gateway.confirm(principal(), id);
  jobs.close(); stores.splice(stores.indexOf(jobs), 1); jobs = openJobs();
  const restarted = new HostedExecution(config, jobs, connect);
  expect((await restarted.submit(principal(), proposal)).state).toBe('complete');
  expect(alice.submits).toBe(1); expect(alice.statuses).toBe(1);
});

it('changing a binding cannot create a second job or reuse an old browser approval', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  const changed = structuredClone(config); const binding = changed.bindings[0];
  if (!binding) throw new Error('Missing binding'); binding.grantId = BOB_GRANT;
  const reconfigured = new HostedExecution(changed, jobs, connect); const before = connections.length;
  await expect(reconfigured.submit(principal(), proposal)).rejects.toMatchObject({ code: 'binding_changed' });
  await expect(reconfigured.confirm(principal(), id)).rejects.toMatchObject({ code: 'binding_changed' });
  expect(connections).toHaveLength(before); expect(alice.submits).toBe(0);
});

it('requires a separately attempted same-owner submit before any cancellation', async () => {
  const proposal = prepareExecution(request());
  await expect(gateway.cancel(principal(), { proposal, leg: 0 })).rejects.toMatchObject({ code: 'order_not_attempted' });
  const id = approvalId(await gateway.submit(principal(), proposal));
  await expect(gateway.cancel(principal(), { proposal, leg: 0 })).rejects.toMatchObject({ code: 'order_not_attempted' });
  expect(alice.cancels).toBe(0);
  await gateway.confirm(principal(), id);
  const cancellation = await gateway.cancel(principal(), { proposal, leg: 0 });
  expect(approvalId(cancellation)).not.toBe(id); expect(alice.cancels).toBe(0);
  expect(await gateway.status(principal(), proposal)).toEqual(cancellation);
  await gateway.confirm(principal(), id); expect(alice.cancels).toBe(0);
  await gateway.confirm(principal(), approvalId(cancellation)); expect(alice.cancels).toBe(1);
  await gateway.cancel(principal(), { proposal, leg: 0 }); expect(alice.cancels).toBe(1);
});

it('allows exact cleanup with a fresh cancellation approval after proposal and grant expiry', async () => {
  const identity = principal(); const proposal = prepareExecution(request(ADDRESS, 30));
  await gateway.confirm(identity, approvalId(await gateway.submit(identity, proposal)));
  vi.useFakeTimers(); vi.setSystemTime(proposal.payload.expiresAt + 1); alice.authority.newRisk = 'expired';
  expect((await gateway.status(identity, proposal)).state).toBe('complete');
  const cancel = await gateway.cancel(identity, { proposal, leg: 0 });
  expect(cancel.state).toBe('approval_required');
  if (cancel.state !== 'approval_required') throw new Error('Missing cleanup approval');
  expect(cancel.expiresAt).toBeGreaterThan(Date.now());
  await gateway.confirm(identity, approvalId(cancel)); expect(alice.cancels).toBe(1);
});

it('status errors remain uncertain and no unknown-order lookup enables a second send', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  alice.submitError = new Error('response lost'); await gateway.confirm(principal(), id);
  alice.statusError = new Error('unknown order lookup');
  expect((await gateway.status(principal(), proposal)).state).toBe('delivery_unknown');
  expect((await gateway.submit(principal(), proposal)).state).toBe('delivery_unknown');
  expect(alice.submits).toBe(1);
});
