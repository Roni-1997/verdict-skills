import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LighterBuyIntent, planLighterBuyIntent, prepareLighterBuyIntent } from '../packages/core/src/lighter-intent.js';
import { LighterClient, LighterMarket, lighterTicks } from '../packages/core/src/lighter.js';
import { validateExecution } from '../packages/core/src/execution.js';

const NOW = 1792623100000;
const intent = { intentId: '6181c5d9-6dfa-4bf0-8bf8-746b746adea0', market: 4555, side: 'yes', maxSpendUSDC: '10' } as const;
const target = { venue: 'lighter', network: 'testnet', account: 99, apiKeyIndex: 5 } as const;
const events = JSON.parse(readFileSync(new URL('./fixtures/lighter/events.json', import.meta.url), 'utf8'));
const event = z.object({ events: z.array(z.object({ event_id: z.number(), creator_account_index: z.number(), title: z.string(), description: z.string(), order_books: z.array(z.unknown()) })) }).parse(events).events[0];
if (!event) throw new Error('missing fixture');
const market = LighterMarket.parse({ ...z.record(z.string(), z.unknown()).parse(event.order_books[0]), eventId: event.event_id,
  creator: event.creator_account_index, title: event.title, settlementRule: event.description, network: 'testnet' });
function input() {
  return { intent: LighterBuyIntent.parse(intent), target: { ...target }, limits: { creators: [market.creator], maxOrderDebitUSDC: '20' },
    snapshot: { market: { ...market }, asks: [{ price: '0.35', shares: '100' }], bids: [{ price: '0.33', shares: '100' }], requestedAt: NOW - 100, receivedAt: NOW, depthTruncated: false }, now: NOW };
}
describe('budget-based Lighter SDK planning', () => {
  it('derives exact account/market/rules and floors size under fee-inclusive spend', () => {
    const plan = planLighterBuyIntent(input()); const leg = plan.proposal.payload.legs[0];
    expect(leg).toMatchObject({ ...target, market: 4555, creator: market.creator, settlementRule: market.settlementRule,
      side: 'yes', action: 'buy', tif: 'ioc', limitPrice: '0.35', shares: '28.3687', feeReserveUSDC: '0.070922' });
    expect(plan.quote.maxDebitUSDC).toBe('9.999967');
    expect(lighterTicks(plan.quote.maxDebitUSDC, 6)).toBeLessThanOrEqual(10_000_000n);
    expect(validateExecution(plan.proposal)).toEqual(plan.proposal);
    expect(plan.quote.sourceTimestamp).toBeNull();
    expect(plan.proposal.payload.requestId).toBe(intent.intentId);
  });
  it('buys NO using complemented YES bids, with the side limit in the proposal', () => {
    const value = input(); value.intent.side = 'no';
    const plan = planLighterBuyIntent(value);
    expect(plan.proposal.payload.legs[0]).toMatchObject({ side: 'no', limitPrice: '0.67' });
    expect(lighterTicks(plan.quote.maxDebitUSDC, 6)).toBeLessThanOrEqual(10_000_000n);
  });
  it('limits quantity to visible depth and keeps conservative fees for price improvement', () => {
    const value = input(); value.snapshot.asks = [{ price: '0.7', shares: '2' }];
    const plan = planLighterBuyIntent(value);
    expect(plan.quote).toMatchObject({ shares: '2', maxDebitUSDC: '1.405', feeReserveUSDC: '0.005', visibleSharesAtLimit: '2' });
  });
  it('accepts explicit grid-aligned limits and never exceeds native order quote limits', () => {
    const value = { ...input(), intent: { ...intent, limitPrice: '0.4' } };
    value.snapshot.market.order_quote_limit = '1';
    const plan = planLighterBuyIntent(value);
    expect(plan.quote).toMatchObject({ shares: '1.6666', limitPrice: '0.4' });
    expect(() => planLighterBuyIntent({ ...value, intent: { ...value.intent, limitPrice: '0.355' } })).toThrow('between market ticks');
    expect(() => planLighterBuyIntent({ ...value, intent: { ...value.intent, limitPrice: '0.1' } })).toThrow('depth');
  });
  it('reserves enabled maker fees as well as taker fees, without account discounts', () => {
    const value = input(); value.snapshot.market.is_maker_fee_enabled = true; value.snapshot.market.maker_fee = '2.0000';
    const plan = planLighterBuyIntent(value);
    expect(lighterTicks(plan.quote.feeReserveUSDC, 6)).toBeGreaterThan(100_000n);
    expect(lighterTicks(plan.quote.maxDebitUSDC, 6)).toBeLessThanOrEqual(10_000_000n);
  });
  it.each(['market', 'network', 'creator', 'rules', 'frozen', 'inactive', 'payout', 'closing', 'stale', 'future', 'slow', 'cap', 'empty', 'fee'])(
    'rejects %s mismatch before preparing an order', (kind) => {
      const value = input();
      switch (kind) {
        case 'market': value.snapshot.market.market_id++; break;
        case 'network': value.snapshot.market.network = 'devnet'; break;
        case 'creator': value.limits.creators = [1]; break;
        case 'rules': value.snapshot.market.settlementRule = null; break;
        case 'frozen': value.snapshot.market.is_frozen = true; break;
        case 'inactive': value.snapshot.market.status = 'inactive'; break;
        case 'payout': value.snapshot.market.settlement_cap = 200; break;
        case 'closing': value.snapshot.market.end_timestamp = NOW + 34_999; break;
        case 'stale': value.now += 5001; break;
        case 'future': value.snapshot.receivedAt++; break;
        case 'slow': value.snapshot.requestedAt -= 5000; break;
        case 'cap': value.limits.maxOrderDebitUSDC = '9.999999'; break;
        case 'empty': value.snapshot.asks = []; break;
        case 'fee': value.snapshot.market.taker_fee = '100.0001'; break;
      }
      expect(() => planLighterBuyIntent(value)).toThrow();
    });
  it('rejects model-supplied account/key/creator/rules, exponent money and excess precision', () => {
    for (const extra of [{ account: 1 }, { apiKeyIndex: 4 }, { creator: 1 }, { settlementRule: 'fake' }, { maxSpendUSDC: '1e3' }, { maxSpendUSDC: '10.0000001' }]) {
      expect(LighterBuyIntent.safeParse({ ...intent, ...extra }).success).toBe(false);
    }
  });
  it('bounds validity by authority expiry and market close', () => {
    const plan = planLighterBuyIntent({ ...input(), authorityExpiresAt: NOW + 30_999 });
    expect(plan.proposal.payload.expiresAt).toBe(NOW + 30_000);
    expect(() => planLighterBuyIntent({ ...input(), authorityExpiresAt: NOW + 29_999 })).toThrow('expires too soon');
  });
  it('uses only real public GET paths and the exact configured testnet host', async () => {
    const calls: URL[] = [];
    const client = new LighterClient({ network: 'testnet', creators: [market.creator] }, { now: () => NOW, fetch: async (url, init) => {
      const path = new URL(String(url)); calls.push(path); expect(init?.method).toBe('GET');
      return new Response(JSON.stringify(path.pathname.endsWith('events') ? events : { code: 200, asks: [{ price: '0.35', remaining_base_amount: '100' }], bids: [], total_asks: 1, total_bids: 0 }));
    } });
    const result = await prepareLighterBuyIntent({ client, intent, target, limits: input().limits });
    expect(result.proposal.payload.legs[0]).toMatchObject(target);
    expect(calls.map((url) => url.pathname)).toEqual(['/api/v1/events', '/api/v1/orderBookOrders']);
    expect(calls.every((url) => url.origin === 'https://testnet.zklighter.elliot.ai')).toBe(true);
  });
});
