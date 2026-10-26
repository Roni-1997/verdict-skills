import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ConsumerLighterScope, prepareExecution } from '../packages/core/src/index.js';
import type { LighterIntentPlan } from '../packages/core/src/lighter-intent.js';
import type { HostedExecution } from '../packages/mcp/src/hosted-execution.js';
import { HostedLighterIntents } from '../packages/mcp/src/hosted-intent.js';
import { HostedJobs } from '../packages/mcp/src/hosted-jobs.js';
import { type Principal, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';

const NOW = 1792623100000;
const target = { venue: 'lighter', network: 'testnet', account: 99, apiKeyIndex: 5 } as const;
const intent = { intentId: '6181c5d9-6dfa-4bf0-8bf8-746b746adea0', market: 4555, side: 'yes', maxSpendUSDC: '10' } as const;
const principal: Principal = { issuer: 'https://mcp.example', subject: 'alice', scopes: [READ_SCOPE, TRADE_SCOPE], expiresAt: NOW + 60_000,
  authorization: { kind: 'first_party', grantId: 'eb15d6ce-bb72-4905-bbfd-d9e02c6d3788', epoch: 0 } };
const bindingHash = 'b'.repeat(64);
type Context = Awaited<ReturnType<HostedExecution['intentContext']>>;
function context(): Context {
  return { account: target, bindingHash, authorityExpiresAt: NOW + 1_000_000, authorityRisk: 'active', accountReady: true,
    scope: ConsumerLighterScope.parse({ kind: 'consumer_lighter', version: 1, ownerWallet: `0x${'1'.repeat(40)}`, network: 'testnet', account: 99, apiKeyIndex: 5,
      creators: [7], mode: 'per_order', maxOrderDebitUSDC: '20', origin: principal.issuer, enrollmentId: randomUUID(), epoch: 0 }) };
}
function plan(): LighterIntentPlan {
  const proposal = prepareExecution({ legs: [{ ...target, market: 4555, creator: 7, title: 'Inert SDK fixture',
    settlementRule: 'Inert fixture rule, no real funds or venue calls.', side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.025', tif: 'ioc' }],
    policy: { maxLegDebitUSDC: '10', maxTotalDebitUSDC: '10' }, validForSeconds: 120 }, NOW, intent.intentId);
  return { proposal, quote: { market: 4555, side: 'yes', maxSpendUSDC: '10', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.025', maxDebitUSDC: '4.025',
    visibleSharesAtLimit: '100', observedAt: NOW, sourceTimestamp: null, depthTruncated: false, expiresAt: proposal.payload.expiresAt, note: 'Inert fixture. No venue calls.' } };
}
const directories: string[] = []; const stores: HostedJobs[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp('/tmp/verdict-intent-'); directories.push(root);
  const open = () => { const store = new HostedJobs(join(root, 'jobs')); stores.push(store); return store; };
  let now = NOW; let preparations = 0; let calls = 0;
  let current = context();
  const deps = { now: () => now, context: async () => { calls++; return current; }, prepare: async () => { preparations++; return plan(); } };
  const store = open();
  return { store, open, deps, service: new HostedLighterIntents(store, deps), setNow: (value: number) => { now = value; },
    change: () => { current = { ...current, bindingHash: 'c'.repeat(64) }; }, risk: () => { current = { ...current, authorityRisk: 'unresolved' }; },
    path: join(root, 'jobs', 'jobs.sqlite'), preparations: () => preparations, calls: () => calls };
}
it('returns the original proposal across retries, a process restart, and fresh book changes', async () => {
  const f = await fixture(); const first = await f.service.prepare(principal, intent);
  f.setNow(NOW + 1000); expect(await f.service.prepare(principal, intent)).toEqual(first);
  f.store.close(); const restarted = new HostedLighterIntents(f.open(), f.deps);
  expect(await restarted.prepare(principal, intent)).toEqual(first); expect(f.preparations()).toBe(1);
});
it('never refreshes an expired original proposal, and conflicts on changed payload under the same UUID', async () => {
  const f = await fixture(); await f.service.prepare(principal, intent);
  for (const changed of [{ maxSpendUSDC: '11' }, { side: 'no' }, { market: 4556 }, { maxSlippageBps: 100 }]) {
    await expect(f.service.prepare(principal, { ...intent, ...changed })).rejects.toMatchObject({ code: 'intent_changed' });
  }
  f.setNow(NOW + 120_000); await expect(f.service.prepare(principal, intent)).rejects.toMatchObject({ code: 'intent_expired' });
  expect(f.preparations()).toBe(1);
});
it('requires a first-party authorization and strictly rejects account or policy fields before reads', async () => {
  const f = await fixture(); const { authorization: _, ...legacy } = principal;
  await expect(f.service.prepare(legacy, intent)).rejects.toMatchObject({ code: 'consumer_connection_required' });
  await expect(f.service.prepare(principal, { ...intent, account: 1 })).rejects.toMatchObject({ code: 'invalid_intent' });
  expect(f.calls()).toBe(0); expect(f.preparations()).toBe(0);
});
it('returns an original intent during reconciliation but blocks preparation of another order', async () => {
  const f = await fixture(); const original = await f.service.prepare(principal, intent); f.risk();
  expect(await f.service.prepare(principal, intent)).toEqual(original);
  await expect(f.service.prepare(principal, { ...intent, intentId: randomUUID() })).rejects.toMatchObject({ code: 'account_not_ready' });
  expect(f.preparations()).toBe(1);
});
it('fails closed if an initialized intent journal disappears across restart', async () => {
  const f = await fixture(); await f.service.prepare(principal, intent); f.store.close();
  const database = new DatabaseSync(f.path); database.exec('DROP TABLE lighter_intents'); database.close();
  expect(() => f.open()).toThrow('Hosted execution state is unavailable');
});
it('fences concurrent preparation and validates the binding again after public reads', async () => {
  const f = await fixture(); let finish: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const service = new HostedLighterIntents(f.store, { ...f.deps, prepare: async () => { await blocked; return plan(); } });
  const first = service.prepare(principal, intent);
  await expect(service.prepare(principal, intent)).rejects.toMatchObject({ code: 'intent_preparing' });
  finish?.(); const result = await first;
  expect(await service.prepare(principal, intent)).toEqual(result);
  const separate = await fixture();
  const changing = new HostedLighterIntents(separate.store, { ...separate.deps, prepare: async () => { separate.change(); return plan(); } });
  await expect(changing.prepare(principal, intent)).rejects.toMatchObject({ code: 'binding_changed' });
});
it('recovers a pre-return read claim after restart but never lets a stale worker replace a saved plan', async () => {
  const f = await fixture(); const authorization = principal.authorization;
  if (!authorization) throw new Error('missing fixture');
  const input = { owner: createHash('sha256').update(`${principal.issuer}\0${principal.subject}`).digest('hex'), bindingHash, authorization,
    intentId: intent.intentId, inputHash: 'a'.repeat(64) };
  const first = f.store.claimIntent({ ...input, now: NOW }); expect(first.kind).toBe('claimed');
  expect(() => f.store.claimIntent({ ...input, now: NOW + 29_999 })).toThrow();
  const second = f.store.claimIntent({ ...input, now: NOW + 30_000 });
  if (first.kind !== 'claimed' || second.kind !== 'claimed') throw new Error('missing claims');
  expect(() => f.store.saveIntent({ ...input, claimId: first.claimId, plan: plan() })).toThrow('claim changed');
  f.store.saveIntent({ ...input, claimId: second.claimId, plan: plan() });
  expect(f.store.claimIntent({ ...input, now: NOW + 900_000 })).toEqual({ kind: 'prepared', plan: plan() });
});
