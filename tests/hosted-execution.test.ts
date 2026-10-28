import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  type ExecutionClient, type ExecutionConnectionOptions, type ExecutionMode,
  type ExecutionPreflight, type ExecutionProposal, type ExecutionStatus, type LocalExecutionCapabilities,
  prepareExecution, LighterBuyIntent, ConsumerLighterScope, type LighterIntentPlan,
} from '../packages/core/src/index.js';
import { HostedExecution } from '../packages/mcp/src/hosted-execution.js';
import { HostedJobs } from '../packages/mcp/src/hosted-jobs.js';
import { createHostedHandler } from '../packages/mcp/src/hosted-http.js';
import { HostedLighterIntents } from '../packages/mcp/src/hosted-intent.js';
import type { HostedRuntime } from '../packages/mcp/src/hosted-security.js';
import { HostedConfig, type HostedMutation, type Principal, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ADDRESS = 42;
const BOB_ADDRESS = 43;
const GRANT = '11111111-1111-4111-8111-111111111111';
const BOB_GRANT = '22222222-2222-4222-8222-222222222222';
const issuer = 'https://identity.example/';
function principal(subject = 'alice'): Principal {
  return { issuer, subject, scopes: [READ_SCOPE, TRADE_SCOPE], expiresAt: Date.now() + 7_200_000 };
}
function request(account = ADDRESS, validForSeconds = 3600) {
  return { validForSeconds, legs: [{ venue: 'lighter', network: 'testnet', account, apiKeyIndex: 2, creator: 7, market: 123,
    title: 'Synthetic account-linked contract', settlementRule: 'Synthetic exact oracle rule; no real market.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc',
  }], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } };
}
const quoted = (proposal: ExecutionProposal): LighterIntentPlan => ({ proposal, quote: { market: 123, side: 'yes', maxSpendUSDC: '5', shares: '10',
  limitPrice: '0.4', feeReserveUSDC: '0.1', maxDebitUSDC: '4.1', visibleSharesAtLimit: '20', observedAt: Date.now(),
  sourceTimestamp: null, depthTruncated: false, expiresAt: proposal.payload.expiresAt, note: 'Inert quote fixture; no venue calls.' } });

function pair() {
  const first = request();
  return prepareExecution({ ...first, legs: [...first.legs, {
    venue: 'hl', network: 'testnet', account: `0x${'1'.repeat(40)}`, outcome: 456,
    title: first.legs[0]?.title, settlementRule: first.legs[0]?.settlementRule,
    side: 'no', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'Ioc',
    allInFeeBpsCap: '10', builder: { address: `0x${'2'.repeat(40)}`, feeTenthsBp: 0 },
  }], settlementReview: { relationship: 'same_event_same_orientation', notes: 'Legacy synthetic cross-venue proposal for rejection testing.' } });
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
  async inspectConnection(): Promise<never> { throw new Error('Inspection is outside this gateway fixture.'); }
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
    browserClientId: 'browser-client', storage: { kind: 'local', stateDir: join(directory, 'state') }, approvalTtlSeconds: 30,
    bindings: [{ id: 'alice', subject: 'alice', enabled: true, mode: 'per_order', execution: { kind: 'local_socket', socketPath: '/operator/alice.sock' }, grantId: GRANT,
      accounts: [{ venue: 'lighter', network: 'testnet', account: ADDRESS, apiKeyIndex: 2 }, { venue: 'lighter', network: 'devnet', account: 42, apiKeyIndex: 2 }] },
    { id: 'bob', subject: 'bob', enabled: true, mode: 'policy', execution: { kind: 'local_socket', socketPath: '/operator/bob.sock' }, grantId: BOB_GRANT,
      accounts: [{ venue: 'lighter', network: 'testnet', account: BOB_ADDRESS, apiKeyIndex: 2 }] }],
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

it('refreshes only an expired unattempted owner review and deduplicates its new quote without sending either order', async () => {
  const identity = { ...principal(), authorization: { kind: 'first_party' as const, grantId: GRANT, epoch: 0 } };
  const original = prepareExecution(request()); const id = approvalId(await gateway.submit(identity, original));
  const saved = await gateway.reviewJob(identity, id);
  const prepareReview = vi.fn(async (_principal: Principal, value: unknown) => quoted(prepareExecution(request(), Date.now(), LighterBuyIntent.parse(value).intentId)));
  const quote = { prepareReview };
  await expect(gateway.refreshReview(identity, id, quote)).rejects.toMatchObject({ code: 'quote_refresh_unavailable' });
  await expect(gateway.refreshReview({ ...identity, expiresAt: Date.now() - 1 }, id, quote)).rejects.toMatchObject({ status: 401 });
  expect(prepareReview).not.toHaveBeenCalled();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(saved.expiresAt + 1);
  let replacement: ExecutionProposal | undefined;
  prepareReview.mockImplementation(async (_principal, value) => {
    replacement ??= prepareExecution(request(), Date.now(), LighterBuyIntent.parse(value).intentId);
    return quoted(replacement);
  });
  try {
    const first = await gateway.refreshReview(identity, id, quote);
    expect(await gateway.refreshReview(identity, id, quote)).toEqual(first);
    expect(prepareReview).toHaveBeenCalledWith(identity, { intentId: id, market: 123, side: 'yes', maxSpendUSDC: '5', maxSlippageBps: 0, limitPrice: '0.4' });
    expect(alice.submits).toBe(0); expect(alice.cancels).toBe(0);
    const childId = new URL(first.approvalUrl).pathname.split('/').at(-1); if (!childId) throw new Error('Missing child');
    expect((await gateway.reviewJob(identity, childId)).state).toBe('pending');
    await expect(gateway.confirm(identity, id)).rejects.toMatchObject({ code: 'approval_replaced' });
    await gateway.confirm(identity, childId); expect(alice.submits).toBe(1);
    clock.mockReturnValue((await gateway.reviewJob(identity, childId)).expiresAt + 1);
    await expect(gateway.refreshReview(identity, childId, quote)).rejects.toMatchObject({ code: 'quote_refresh_unavailable' });
  } finally { clock.mockRestore(); }
});

it('checks issuer, subject, expiry, scopes and account/key ownership before any private connection', async () => {
  const proposal = prepareExecution(request());
  const identities = [{ ...principal(), issuer: 'https://other.example/' }, principal('unlinked'),
    { ...principal(), expiresAt: Date.now() - 1 }, { ...principal(), scopes: [] }, { ...principal(), scopes: [READ_SCOPE] }];
  for (const identity of identities) await expect(gateway.submit(identity, proposal)).rejects.toBeInstanceOf(Error);
  await expect(gateway.preflight(principal('bob'), proposal)).rejects.toMatchObject({ code: 'account_mismatch' });
  await expect(gateway.prepare(principal('bob'), request())).rejects.toMatchObject({ code: 'account_mismatch' });
  const lighter = prepareExecution(request()).payload.legs[0];
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

it('rejects paired proposals in both modes before any SDK call or job', async () => {
  const proposal = pair();
  await expect(gateway.submit(principal(), proposal)).rejects.toMatchObject({ code: 'invalid_proposal' });
  expect(connections).toHaveLength(0);
  const changed = structuredClone(config); const binding = changed.bindings[0];
  if (!binding) throw new Error('Missing binding'); binding.mode = 'policy';
  const policy = new HostedExecution(changed, jobs, connect);
  await expect(policy.submit(principal(), proposal)).rejects.toMatchObject({ code: 'invalid_proposal' });
  expect(connections).toHaveLength(0);
  expect(alice.submits).toBe(0); expect(alice.preflights).toBe(0);
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
  await expect(reconfigured.status(principal(), proposal)).rejects.toMatchObject({ code: 'binding_changed' });
  expect(connections).toHaveLength(before); expect(alice.submits).toBe(0);
});

it.each(['attempted', 'observed'] as const)('reads an %s order after same-account policy renewal without reusing its old approval', async state => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  if (state === 'attempted') alice.submitError = new Error('lost response');
  await gateway.confirm(principal(), id);
  expect(jobs.get(id)?.state).toBe(state);
  await gateway.cancel(principal(), { proposal, leg: 0 });
  const originalHash = jobs.get(id)?.bindingHash;
  const changed = structuredClone(config); const binding = changed.bindings[0];
  if (!binding) throw new Error('Missing binding');
  binding.grantId = BOB_GRANT; binding.grantHash = 'b'.repeat(64);
  alice.authority = { ...alice.authority, grantId: BOB_GRANT, grantHash: binding.grantHash };
  const renewed = new HostedExecution(changed, jobs, connect);
  expect(await renewed.status(principal(), proposal)).toMatchObject({ state: 'complete', digest: proposal.digest });
  expect(alice.statuses).toBe(1); expect(alice.submits).toBe(1); expect(alice.cancels).toBe(0); expect(alice.preflights).toBe(1);
  expect(jobs.get(id)?.bindingHash).toBe(originalHash);
  await expect(renewed.submit(principal(), proposal)).rejects.toMatchObject({ code: 'binding_changed' });
  await expect(renewed.reviewJob(principal(), id)).rejects.toMatchObject({ code: 'binding_changed' });
  await expect(renewed.confirm(principal(), id)).rejects.toMatchObject({ code: 'binding_changed' });
  await expect(renewed.cancel(principal(), { proposal, leg: 0 })).rejects.toMatchObject({ code: 'binding_changed' });
  expect(alice.submits).toBe(1); expect(alice.cancels).toBe(0);
});

it('keeps renewed historical status restricted to the current owner, account and key', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  await gateway.confirm(principal(), id);
  const changed = structuredClone(config); const binding = changed.bindings[0]; const other = changed.bindings[1];
  if (!binding || !other) throw new Error('Missing binding');
  binding.grantId = BOB_GRANT;
  alice.authority = { ...alice.authority, grantId: BOB_GRANT };
  const renewed = new HostedExecution(changed, jobs, connect); const before = connections.length;
  const wrongOwner = new HostedExecution({ ...changed, bindings: [{ ...other, accounts: structuredClone(binding.accounts) }] }, jobs, connect);
  await expect(wrongOwner.status(principal('bob'), proposal)).rejects.toMatchObject({ code: 'order_not_found' });
  await expect(renewed.status({ ...principal(), expiresAt: Date.now() - 1 }, proposal)).rejects.toMatchObject({ status: 401 });
  for (const field of ['account', 'apiKeyIndex', 'enabled'] as const) {
    const invalid = structuredClone(changed); const row = invalid.bindings[0];
    if (!row) throw new Error('Missing binding');
    if (field === 'enabled') row.enabled = false;
    else row.accounts = [{ venue: 'lighter', network: 'testnet', account: field === 'account' ? ADDRESS + 2 : ADDRESS, apiKeyIndex: field === 'apiKeyIndex' ? 3 : 2 }];
    await expect(new HostedExecution(invalid, jobs, connect).status(principal(), proposal)).rejects.toMatchObject({ code: field === 'enabled' ? 'account_not_linked' : 'account_mismatch' });
  }
  expect(connections).toHaveLength(before); expect(alice.statuses).toBe(0); expect(alice.submits).toBe(1);
});

it('does not return or persist a historical observation if its current connection changes during status', async () => {
  const proposal = prepareExecution(request()); const id = approvalId(await gateway.submit(principal(), proposal));
  alice.submitError = new Error('lost response'); await gateway.confirm(principal(), id);
  const configured = config.bindings[0]; if (!configured) throw new Error('Missing binding');
  let binding = { ...configured, grantId: BOB_GRANT };
  alice.authority = { ...alice.authority, grantId: BOB_GRANT };
  const runtime: HostedRuntime = {
    auth: { metadata: () => ({ resource: `${config.publicOrigin}/mcp`, authorization_servers: [issuer], scopes_supported: [READ_SCOPE], bearer_methods_supported: ['header'] }),
      challenge: () => 'Bearer', authenticate: () => { throw new Error('No HTTP authentication in this fixture'); },
      login: () => { throw new Error('No login expected'); }, callback: () => { throw new Error('No callback expected'); }, readSession: () => null },
    binding: subject => subject === binding.subject ? binding : null,
    assertActive: () => {}, assertJobActive: () => {}, status: async () => null,
  };
  vi.spyOn(alice, 'status').mockImplementation(async saved => {
    binding = { ...binding, enabled: false };
    return alice.result(saved);
  });
  const renewed = new HostedExecution(config, jobs, connect, runtime);
  expect(await renewed.status(principal(), proposal)).toMatchObject({ state: 'delivery_unknown', automaticRetry: false });
  expect(jobs.get(id)?.state).toBe('attempted'); expect(alice.submits).toBe(1); expect(alice.cancels).toBe(0);
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

it('rejects former single-venue inputs and research network conflicts before broker effects', async () => {
  const legacyLeg = pair().payload.legs[1];
  if (!legacyLeg) throw new Error('Missing legacy fixture');
  const legacy = prepareExecution({ ...request(), legs: [legacyLeg] });
  for (const operation of ['review', 'preflight', 'submit'] as const) {
    await expect(gateway[operation](principal(), legacy)).rejects.toMatchObject({ code: 'invalid_proposal' });
  }
  await expect(gateway.prepare(principal(), { ...request(), legs: [legacyLeg] })).rejects.toMatchObject({ code: 'invalid_proposal' });
  const changed = { ...config, lighter: { network: 'devnet' as const, creators: [7] } };
  const mismatched = new HostedExecution(changed, jobs, connect);
  await expect(mismatched.prepare(principal(), request())).rejects.toMatchObject({ code: 'invalid_proposal' });
  await expect(mismatched.submit(principal(), prepareExecution(request()))).rejects.toMatchObject({ code: 'invalid_proposal' });
  expect(connections).toHaveLength(0); expect(alice.submits).toBe(0);
});

it('blocks a previously saved legacy browser approval before durable claim or SDK submission', async () => {
  const legacyLeg = pair().payload.legs[1];
  if (legacyLeg?.venue !== 'hl') throw new Error('Missing legacy fixture');
  const changed = structuredClone(config); const binding = changed.bindings[0];
  if (!binding) throw new Error('Missing binding');
  binding.accounts.push({ venue: 'hl', network: legacyLeg.network, account: legacyLeg.account });
  const scoped = new HostedExecution(changed, jobs, connect);
  const baseline = jobs.get(approvalId(await scoped.submit(principal(), prepareExecution(request()))));
  if (!baseline) throw new Error('Missing scoped job');
  const legacy = prepareExecution({ ...request(), legs: [legacyLeg] });
  const saved = jobs.getOrCreate({ owner: baseline.owner, bindingHash: baseline.bindingHash, purpose: 'submit',
    proposal: legacy, leg: null, authorization: null, expiresAt: Date.now() + 30_000 });
  const claim = vi.spyOn(jobs, 'claim');
  await expect(scoped.confirm(principal(), saved.id)).rejects.toMatchObject({ code: 'invalid_proposal' });
  expect(claim).not.toHaveBeenCalled(); expect(alice.submits).toBe(0);
  expect(jobs.get(saved.id)?.state).toBe('pending');
});

it('runs quote expiry → refresh → one new review → confirmation through real HTTP without repeating sign-in or dispatch', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const origin = `http://127.0.0.1:${address.port}`;
  const configured = config.bindings[0]; if (!configured) throw new Error('Missing binding');
  const binding = { ...configured, execution: { kind: 'hosted_signer' as const, profileId: GRANT }, accounts: [{ venue: 'lighter' as const, network: 'testnet' as const, account: 42, apiKeyIndex: 5 }] };
  const current = HostedConfig.parse({ ...config, publicOrigin: origin, allowInsecureLocalhost: true, bindings: [binding] });
  const identity = { ...principal(), authorization: { kind: 'first_party' as const, grantId: GRANT, epoch: 0 } };
  const csrf = 'a'.repeat(64);
  const runtime: HostedRuntime = {
    auth: { metadata: () => ({ resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: [READ_SCOPE, TRADE_SCOPE], bearer_methods_supported: ['header'] }),
      challenge: () => 'Bearer', authenticate: () => { throw new Error('No model authentication in this browser-only fixture'); },
      login: () => { throw new Error('Existing review must not restart sign-in'); }, callback: () => { throw new Error('No callback expected'); },
      readSession: cookie => cookie === 'review-fixture=1' ? { principal: identity, csrf, expiresAt: identity.expiresAt } : null },
    binding: subject => subject === identity.subject ? binding : null, assertActive: () => {}, assertJobActive: () => {}, status: async () => null,
  };
  const original = prepareExecution({ ...request(), legs: request().legs.map(leg => ({ ...leg, apiKeyIndex: 5 })) });
  const seed = new HostedExecution(current, jobs, undefined, runtime, async () => alice);
  const id = approvalId(await seed.submit(identity, original)); const saved = await seed.reviewJob(identity, id);
  const target = binding.accounts[0]; if (!target) throw new Error('Missing account');
  const scope = ConsumerLighterScope.parse({ kind: 'consumer_lighter', version: 1, ownerWallet: `0x${'1'.repeat(40)}`, network: 'testnet', account: 42,
    apiKeyIndex: 5, creators: [7], mode: 'per_order', maxOrderDebitUSDC: '5', origin, enrollmentId: GRANT, epoch: 0 });
  const intents = new HostedLighterIntents(jobs, { context: async () => ({ account: target, bindingHash: saved.bindingHash, scope,
    authorityExpiresAt: alice.authority.expiresAt, authorityRisk: 'active', accountReady: true }), prepare: async ({ intent }) => {
      const proposal = prepareExecution({ ...request(), policy: { maxTotalDebitUSDC: intent.maxSpendUSDC, maxLegDebitUSDC: intent.maxSpendUSDC }, legs: original.payload.legs }, Date.now(), intent.intentId);
      return { proposal, quote: { market: 123, side: 'yes', maxSpendUSDC: '5', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', maxDebitUSDC: '4.1',
        visibleSharesAtLimit: '20', observedAt: Date.now(), sourceTimestamp: null, depthTruncated: false, expiresAt: proposal.payload.expiresAt, note: 'Inert HTTP fixture.' } };
    } });
  const handler = await createHostedHandler(current, runtime, { jobs, remoteConnect: async () => alice, intents });
  server.on('request', handler.handle);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(saved.expiresAt + 1);
  const get = (url: string) => fetch(url, { headers: { cookie: 'review-fixture=1' }, redirect: 'manual' });
  const decide = (url: string, decision: string, token = csrf) => fetch(url, { method: 'POST', redirect: 'manual',
    headers: { cookie: 'review-fixture=1', origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, decision }) });
  try {
    const path = `${origin}/review/${id}`;
    const expired = await (await get(path)).text(); expect(expired).toContain('Quote expired'); expect(expired).not.toContain('value="confirm"');
    expect((await decide(path, 'refresh', 'wrong')).status).toBe(403);
    const staleConfirm = await decide(path, 'confirm'); expect(staleConfirm.status).toBe(200); expect(await staleConfirm.text()).toContain('Refresh quote');
    const first = await decide(path, 'refresh'); expect(first.status).toBe(303);
    const child = first.headers.get('location'); if (!child) throw new Error('Missing fresh review');
    expect(child).not.toBe(path); expect((await decide(path, 'refresh')).headers.get('location')).toBe(child);
    expect((await get(path)).headers.get('location')).toBe(child);
    expect(alice.submits).toBe(0); expect(alice.cancels).toBe(0);
    const updated = await seed.status(identity, original);
    expect(updated).toMatchObject({ state: 'review_updated', digest: original.digest, approvalUrl: child, automaticRetry: false });
    if (updated.state !== 'review_updated') throw new Error('Agent lost the refreshed review');
    expect(await seed.status(identity, updated.proposal)).toMatchObject({ state: 'approval_required' });
    const fresh = await get(child); expect(fresh.status).toBe(200); expect(await fresh.text()).toContain('Confirm this order');
    expect((await decide(child, 'confirm')).status).toBe(200); expect(alice.submits).toBe(1);
    expect(await (await get(child)).text()).toContain('Trade complete');
    expect((await decide(path, 'refresh')).headers.get('location')).toBe(child); expect(alice.submits).toBe(1);
    jobs.close();
    const recovered = new HostedExecution(current, openJobs(), undefined, runtime, async () => alice);
    const tracked = await recovered.status(identity, original);
    if (tracked.state !== 'review_updated') throw new Error('Refreshed review was lost across restart');
    expect(await recovered.status(identity, tracked.proposal)).toMatchObject({ state: 'complete' });
    expect(alice.submits).toBe(1);
  } finally {
    clock.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await handler.close();
  }
});

it('archives an expired cached quote as inert history so an interrupted refresh can continue without a send', async () => {
  const identity = { ...principal(), authorization: { kind: 'first_party' as const, grantId: GRANT, epoch: 0 } };
  const original = prepareExecution(request()); const id = approvalId(await gateway.submit(identity, original));
  const clock = vi.spyOn(Date, 'now').mockReturnValue((await gateway.reviewJob(identity, id)).expiresAt + 1);
  try {
    const cached = prepareExecution(request(42, 30), Date.now() - 60_000, id);
    const count = alice.preflights;
    const refreshed = await gateway.refreshReview(identity, id, { prepareReview: async () => quoted(cached) });
    const child = new URL(refreshed.approvalUrl).pathname.split('/').at(-1); if (!child) throw new Error('Missing history');
    expect((await gateway.reviewJob(identity, child)).expiresAt).toBeLessThan(Date.now());
    await expect(gateway.confirm(identity, child)).rejects.toMatchObject({ code: 'proposal_expired' });
    expect(alice.submits).toBe(0); expect(alice.preflights).toBe(count);
  } finally { clock.mockRestore(); }
});
