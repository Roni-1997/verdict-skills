import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type KitConfig, type Market, MarketSchema, type Orderbook, type SideBook } from '../packages/core/src/index.js';
import { CompareMarketResult } from '../packages/core/src/crossvenue.js';
import { LighterClient, createLighterTools } from '../packages/core/src/lighter.js';
import { createStrategyTools } from '../packages/core/src/strategy.js';
import { PairedSnapshot, STRATEGY_DOCS } from '../packages/core/src/strategy-model.js';
import { assessPair, paperPair, reconcilePair } from '../packages/core/src/strategy-analysis.js';
import { runStrategyCli } from '../packages/cli/src/strategy.js';
import { runCli } from '../packages/cli/src/index.js';
import { createStrategyServer } from '../packages/mcp/src/strategy.js';

const NOW = 1792623100000; const EXPIRY = 1792623600000; const OUTCOME = 12891; const MARKET = 4555;
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const policy = { maxCapitalUSDC: '100', maxUnhedgedLossUSDC: '100' };
const assumptions = { relationship: 'same_event_same_orientation', hlAllInTakerBpsCap: '10' };

function sideBook(coin: string, asks: [number, number][], bid = 0.4): SideBook {
  return { coin, asks: asks.map(([px, sz]) => ({ px, sz, orders: 1 })), bids: [{ px: bid, sz: 100, orders: 1 }], bestAsk: asks[0]?.[0] ?? null, bestBid: bid, mid: null, time: NOW };
}
function harness(options: { now?: () => number; hlFailure?: boolean; lighterFailure?: number; nextCursor?: number; feeTenthsBp?: number } = {}) {
  const base = MarketSchema.parse(fixture('api-v1/testnet_market_12891'));
  const market: Market = { ...base, displayName: 'BTC Up or Down', settlementRule: 'UP if the same BTC feed finishes at or above its starting price, otherwise DOWN.', expiresAt: new Date(EXPIRY).toISOString() };
  const book: Orderbook = { outcome: OUTCOME, sides: [sideBook(base.sides[0].coin, [[0.43, 5], [0.44, 5]], 0.42), sideBook(base.sides[1].coin, [[0.60, 20]], 0.56)] };
  const eventsSchema = z.object({ events: z.array(z.object({ order_books: z.array(z.object({ market_id: z.number() }).passthrough()) }).passthrough()), next_cursor: z.number().nullable() }).passthrough();
  const events = eventsSchema.parse(fixture('lighter/events'));
  if (options.nextCursor !== undefined) events.next_cursor = options.nextCursor;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const u = new URL(String(url)); calls.push(u.pathname);
    if (options.lighterFailure) return new Response('private response body', { status: options.lighterFailure });
    return new Response(JSON.stringify(u.pathname.endsWith('/events') ? events : {
      code: 200, asks: [{ price: '0.48', remaining_base_amount: '100.0000' }],
      bids: [{ price: '0.46', remaining_base_amount: '5.0000' }, { price: '0.45', remaining_base_amount: '5.0000' }], total_asks: 1, total_bids: 2,
    }));
  };
  const now = options.now ?? (() => NOW);
  const lighter = createLighterTools(new LighterClient({ network: 'mainnet', creators: [] }, { fetch: fetcher, now }));
  const hl = {
    get_market: vi.fn(async () => { if (options.hlFailure) throw new Error('private-upstream-detail'); return market; }),
    orderbook: vi.fn(async () => ({ ...book, sideNames: ['template:Yes', 'template:No'] satisfies [string, string] })),
    compare_market: vi.fn(async () => CompareMarketResult.parse(fixture('api-v1/testnet_compare_12891'))),
  };
  const config: KitConfig = { network: 'mainnet', venue: null, apiUrl: null, builder: options.feeTenthsBp === undefined ? null : { address: '0x1111111111111111111111111111111111111111', feeTenthsBp: options.feeTenthsBp } };
  return { tools: createStrategyTools({ config, hl, lighter, now }), calls, hl, market, book };
}
async function snapshot() { return PairedSnapshot.parse(await harness().tools.snapshot({ outcome: OUTCOME, market: MARKET })); }
function assess(s: unknown, overrides: Record<string, unknown> = {}) { return assessPair({ snapshot: s, at: NOW, shares: '10', policy, assumptions, ...overrides }); }
function direction(result: ReturnType<typeof assessPair>, id = 'hl_yes') {
  if (result.kind === 'reference_only') throw new Error('expected paired result');
  const d = result.directions.find((v) => v.id === id); if (!d) throw new Error('direction missing'); return d;
}

describe('strategy snapshot and discovery', () => {
  it('keeps explicit Lighter testnet in paired research without relabelling devnet', async () => {
    const s = await snapshot();
    const testnet = { ...s, hl: { ...s.hl, network: 'testnet' }, lighter: { ...s.lighter, network: 'testnet' } };
    expect(PairedSnapshot.parse(testnet).lighter.network).toBe('testnet');
    expect(assess(testnet)).toMatchObject({ networks: { hl: 'testnet', lighter: 'testnet' } });
    expect(reconcilePair({ pair: testnet.pair, networks: { hl: 'testnet', lighter: 'testnet' }, at: NOW,
      expected: { hl: { yes: '0', no: '0' }, lighter: { yes: '0', no: '0' } },
      observed: { hl: { yes: '0', no: '0', observedAt: NOW }, lighter: { yes: '0', no: '0', observedAt: NOW } },
    })).toMatchObject({ networks: { hl: 'testnet', lighter: 'testnet' } });
    expect(() => PairedSnapshot.parse({ ...testnet, lighter: { ...testnet.lighter, network: 'unknown' } })).toThrow();
  });
  it('captures actual adapter data, complements NO from bids, and retains both source clocks', async () => {
    const { tools } = harness(); const s = PairedSnapshot.parse(await tools.snapshot({ outcome: OUTCOME, market: MARKET }));
    expect(s.lighter.asks.no).toEqual([{ price: '0.54', shares: '5.0000' }, { price: '0.55', shares: '5.0000' }]);
    expect(s.hl.asks.yes).toEqual([{ price: '0.43', shares: '5' }, { price: '0.44', shares: '5' }]);
    expect(s.lighter.sourceAt).toBeNull(); expect(s.hl.sourceAt.yes).toBe(NOW);
    expect(s.hl.network).toBe('mainnet'); expect(s.lighter.network).toBe('mainnet');
  });
  it('returns ranked candidates without claiming equivalence or hiding pagination', async () => {
    const h = harness({ nextCursor: 999 }); const r = await h.tools.discover_pairs({ outcome: OUTCOME });
    expect(r.candidates[0]).toMatchObject({ market: MARKET, match: 'unverified_candidate', evidence: { sameKnownExpiry: true } });
    expect(r.coverage).toMatchObject({ scannedMarkets: 1, complete: false, nextCursor: 999 });
    expect(h.calls).toHaveLength(1); expect(h.hl.orderbook).not.toHaveBeenCalled();
  });
  it('keeps Polymarket/Kalshi comparisons reference only with no Lighter fetch', async () => {
    const h = harness(); const s = await h.tools.snapshot({ outcome: OUTCOME });
    const r = assess(s); expect(r).toMatchObject({ kind: 'reference_only', liveReady: false });
    expect(r).not.toHaveProperty('directions'); expect(h.calls).toHaveLength(0);
  });
  it('does not manufacture a zero-price quote when one source fails', async () => {
    await expect(harness({ lighterFailure: 503 }).tools.snapshot({ outcome: OUTCOME, market: MARKET })).rejects.toMatchObject({ code: 'upstream' });
  });
  it('rejects crossed and incorrectly identified HL books', async () => {
    const h = harness();
    h.hl.orderbook.mockResolvedValueOnce({ ...h.book, sides: [{ ...h.book.sides[0], asks: [{ px: 0.1, sz: 10, orders: 1 }], bestAsk: 0.1 }, h.book.sides[1]], sideNames: ['Yes', 'No'] });
    await expect(h.tools.snapshot({ outcome: OUTCOME, market: MARKET })).rejects.toThrow('crossed');
    h.hl.orderbook.mockResolvedValueOnce({ ...h.book, outcome: 12, sideNames: ['Yes', 'No'] });
    await expect(h.tools.snapshot({ outcome: OUTCOME, market: MARKET })).rejects.toThrow('identities');
  });
  it('probes both venues independently and hides raw failure details', async () => {
    const r = await harness({ hlFailure: true }).tools.venue_health({ outcome: OUTCOME, market: MARKET });
    expect(r.hl).toMatchObject({ reachable: false }); expect(r.lighter).toMatchObject({ reachable: true, sourceAt: null });
    expect(JSON.stringify(r)).not.toContain('private-upstream-detail');
  });
});

describe('paired economics and policy', () => {
  it('walks both ladders with exact per-level curved fees instead of midpoint arithmetic', async () => {
    const r = assess(await snapshot()); const d = direction(r);
    expect(r).toMatchObject({ kind: 'conditional_plan', selectedDirection: 'hl_yes', liveReady: false, settlementVerification: 'not_verified' });
    expect(d).toMatchObject({ requestedShares: '10', plannedShares: '10', grossCostUSDC: '9.8', allInCostUSDC: '9.829145', conditionalNetUSDC: '0.170855', conditionalNetCentsPerShare: '1.70855' });
    expect(d.legs.hl).toMatchObject({ notionalUSDC: '4.35', feeUSDC: '0.00435', worstPrice: '0.44' });
    expect(d.legs.lighter).toMatchObject({ notionalUSDC: '5.45', feeUSDC: '0.024795', worstPrice: '0.55' });
    expect(direction(r, 'hl_no').kind).toBe('blocked');
  });
  it('reduces to nine whole matched shares under a nine-dollar capital budget', async () => {
    const d = direction(assess(await snapshot(), { policy: { ...policy, maxCapitalUSDC: '9' } }));
    expect(d).toMatchObject({ plannedShares: '9', requestedShares: '10', reducedSize: true, allInCostUSDC: '8.83623' });
    expect(d.legs.hl.filledShares).toBe(d.legs.lighter.filledShares);
  });
  it('sizes against either independently stranded leg, not only total capital', async () => {
    const d = direction(assess(await snapshot(), { policy: { ...policy, maxUnhedgedLossUSDC: '4' } }));
    expect(d.plannedShares).toBe('7'); expect(Number(d.lighterOnlyMaxLossUSDC)).toBeLessThanOrEqual(4);
  });
  it('floors the shared depth and distinguishes requested partial quotes from paired size', async () => {
    const s = await snapshot();
    const changed = { ...s, lighter: { ...s.lighter, asks: { ...s.lighter.asks, no: [{ price: '0.54', shares: '3.9' }] } } };
    const d = direction(assess(changed)); expect(d.plannedShares).toBe('3');
    expect(d.requestedQuotes.lighter).toMatchObject({ complete: false, filledShares: '3.9' });
    expect(d.legs.hl.filledShares).toBe('3'); expect(d.legs.lighter.filledShares).toBe('3');
  });
  it('does not assume unknown fees are zero or unreviewed contracts equivalent', async () => {
    const s = await snapshot(); const noFee = direction(assess(s, { assumptions: { relationship: 'same_event_same_orientation' } }));
    expect(noFee.reasons).toContain('hl_all_in_fee_unknown'); expect(noFee.conditionalNetUSDC).toBeNull(); expect(noFee.requestedQuotes.hl.feeUSDC).toBeNull();
    const unreviewed = direction(assess(s, { assumptions: { hlAllInTakerBpsCap: '10' } }));
    expect(unreviewed.reasons).toContain('settlement_relationship_unreviewed'); expect(unreviewed.conditionalNetUSDC).toBeNull();
  });
  it('refuses a caller fee cap below the configured builder component', async () => {
    const s = await harness({ feeTenthsBp: 200 }).tools.snapshot({ outcome: OUTCOME, market: MARKET });
    expect(direction(assess(s)).reasons).toContain('hl_fee_cap_below_configured_builder_fee');
  });
  it.each([
    ['expired', { at: EXPIRY }, 'hl_expired'],
    ['stale', { at: NOW + 6000 }, 'hl_yes_source_outside_age_budget'],
    ['backdated', { at: NOW - 1 }, 'evaluation_precedes_capture'],
  ])('blocks %s evaluations', async (_name, override, reason) => {
    expect(direction(assess(await snapshot(), override)).reasons).toContain(reason);
  });
  it('blocks source skew, unknown expiry, frozen markets, foreign quote units and mixed environments', async () => {
    const original = await snapshot();
    const cases = [
      [{ ...original, hl: { ...original.hl, sourceAt: { yes: NOW - 3000, no: NOW } } }, 'book_clock_skew_exceeds_budget'],
      [{ ...original, hl: { ...original.hl, expiresAt: null } }, 'hl_expiry_unknown'],
      [{ ...original, hl: { ...original.hl, expiresAt: EXPIRY + 1 } }, 'different_expiry_or_trading_end'],
      [{ ...original, lighter: { ...original.lighter, active: false } }, 'lighter_outside_active_trading_window'],
      [{ ...original, hl: { ...original.hl, quoteToken: 'USDH' } }, 'incompatible_or_unknown_quote_currency'],
      [{ ...original, lighter: { ...original.lighter, network: 'devnet' } }, 'mixed_mainnet_and_test_networks'],
      [{ ...original, hl: { ...original.hl, sourceAt: { yes: NOW + 1, no: NOW } } }, 'hl_yes_source_in_future_at_receipt'],
    ] satisfies [unknown, string][];
    for (const [s, reason] of cases) expect(direction(assess(s)).reasons).toContain(reason);
  });
  it('detects when deeper liquidity erases an apparent touch-price edge', async () => {
    const s = await snapshot();
    const changed = { ...s, hl: { ...s.hl, asks: { ...s.hl.asks, yes: [{ price: '0.43', shares: '1' }, { price: '0.8', shares: '20' }] } } };
    const d = direction(assess(changed)); expect(d.kind).toBe('blocked'); expect(Number(d.conditionalNetUSDC)).toBeLessThan(0);
    expect(d.reasons).toContain('net_edge_below_required_threshold');
  });
  it('handles reversed orientation explicitly rather than swapping sides by title', async () => {
    const s = await snapshot(); const r = assess(s, { assumptions: { ...assumptions, relationship: 'same_event_reversed_orientation' } });
    expect(direction(r).legs.lighter.side).toBe('yes'); expect(direction(r, 'hl_no').legs.lighter.side).toBe('no');
  });
  it('honors extra costs and minimum edge without claiming profit-maximizing sizing', async () => {
    const s = await snapshot();
    expect(direction(assess(s, { policy: { ...policy, minNetCentsPerShare: '2' } })).kind).toBe('blocked');
    expect(direction(assess(s, { assumptions: { ...assumptions, extraCostUSDC: '0.2' } })).kind).toBe('blocked');
  });
  it.each(['0', '-1', '1.5', '1e3', '1000000000'])('rejects unsupported requested share size %s', async (shares) => {
    const s = await snapshot(); expect(() => assess(s, { shares })).toThrow('whole shares');
  });
  it('rejects malformed snapshot identity, unsorted depth and forged cached plan costs', async () => {
    const s = await snapshot();
    expect(() => assess({ ...s, pair: { ...s.pair, market: MARKET + 1 } })).toThrow('identities');
    expect(() => assess({ ...s, hl: { ...s.hl, asks: { ...s.hl.asks, yes: [...s.hl.asks.yes].reverse() } } })).toThrow('ascending');
    expect(() => paperPair({ snapshot: s, at: NOW, shares: '10', policy, assumptions, direction: 'hl_yes', fills: { hl: '10', lighter: '10' }, plan: { allInCostUSDC: '0' } })).toThrow();
  });
});

describe('paper fills and inventory evidence', () => {
  it.each([['10', '10', '10', '0'], ['10', '3', '3', '7'], ['10', '0', '0', '10'], ['0', '0', '0', '0']])('models HL %s and Lighter %s fill caps independently', async (hl, lighter, paired, stranded) => {
    const s = await snapshot(); const input = { snapshot: s, at: NOW, shares: '10', policy, assumptions, direction: 'hl_yes', fills: { hl, lighter } };
    const r = paperPair(input); expect(r).toEqual(paperPair(input));
    expect(r).toMatchObject({ kind: 'paper_result', paper: true, pairedShares: paired, strandedShares: { hl: stranded } });
    if (r.kind !== 'paper_result') throw new Error('expected simulation');
    expect(r.inventory.hl.yes).toBe(hl);
    if (hl === '10' && lighter === '10') expect(r.conditionalSettlement.floorPnlUSDC).toBe('0.170855');
    if (hl === '10' && lighter === '0') expect(r.conditionalSettlement.floorPnlUSDC).toBe('-4.35435');
  });
  it('caps simulated fills at planned size and rounds down to supported size lots', async () => {
    const r = paperPair({ snapshot: await snapshot(), at: NOW, shares: '10', policy, assumptions, direction: 'hl_yes', fills: { hl: '100', lighter: '3.123456' } });
    expect(r).toMatchObject({ kind: 'paper_result', fills: { hl: { filledShares: '10' }, lighter: { filledShares: '3.1234' } } });
  });
  it('refuses to simulate an economically blocked direction', async () => {
    expect(paperPair({ snapshot: await snapshot(), at: NOW, shares: '10', policy, assumptions, direction: 'hl_no', fills: { hl: '10', lighter: '10' } })).toMatchObject({ kind: 'paper_blocked' });
  });
  it('reports position differences and conditional exposure without fabricating P&L or fills', () => {
    const r = reconcilePair({ pair: { outcome: OUTCOME, market: MARKET }, networks: { hl: 'mainnet', lighter: 'mainnet' }, at: NOW,
      expected: { hl: { yes: '10', no: '0' }, lighter: { yes: '0', no: '10' } },
      observed: { hl: { yes: '10', no: '0', observedAt: NOW }, lighter: { yes: '0', no: '3', observedAt: NOW } }, relationship: 'same_event_same_orientation' });
    expect(r).toMatchObject({ reconciled: false, conditionalNetHlYesShares: '7', differences: [{ venue: 'lighter', side: 'no', observedMinusExpectedShares: '-7' }] });
    expect(r).not.toHaveProperty('realizedPnl'); expect(r).not.toHaveProperty('fills');
  });
  it('withholds exposure when observations are stale or equivalence is unreviewed', () => {
    const input = { pair: { outcome: OUTCOME, market: MARKET }, networks: { hl: 'mainnet', lighter: 'mainnet' }, at: NOW,
      expected: { hl: { yes: '10', no: '0' }, lighter: { yes: '0', no: '10' } },
      observed: { hl: { yes: '10', no: '0', observedAt: NOW - 10_000 }, lighter: { yes: '0', no: '10', observedAt: NOW } } };
    expect(reconcilePair(input)).toMatchObject({ reconciled: false, conditionalNetHlYesShares: null, reasons: ['hl_observation_outside_age_budget'] });
  });
});

describe('bounded scan and transport parity', () => {
  it('returns supporting snapshots, ranked conditional plans and honest coverage', async () => {
    const h = harness(); const r = await h.tools.scan_pairs({ pairs: [{ outcome: OUTCOME, market: MARKET }], shares: '10', policy, assumptions });
    expect(r.coverage).toEqual({ requested: 1, assessed: 1, failed: 0, notRequested: 0, complete: true });
    expect(r.ranked[0]).toMatchObject({ shares: '10', conditionalNetUSDC: '0.170855' });
    expect(r.results[0]).toHaveProperty('snapshot'); expect(h.calls).toHaveLength(2);
  });
  it('stops after a rate limit and retains unrequested coverage instead of looping', async () => {
    const h = harness({ lighterFailure: 429 }); const r = await h.tools.scan_pairs({ pairs: [{ outcome: OUTCOME, market: MARKET }, { outcome: OUTCOME, market: MARKET + 1 }], shares: '10', policy, assumptions });
    expect(r.coverage).toEqual({ requested: 2, assessed: 0, failed: 1, notRequested: 1, complete: false });
    expect(h.calls).toHaveLength(1); expect(JSON.stringify(r)).not.toContain('private response body');
  });
  it('rejects scans larger than eight pairs before any request', async () => {
    const h = harness(); await expect(h.tools.scan_pairs({ pairs: Array.from({ length: 9 }, () => ({ outcome: OUTCOME, market: MARKET })), shares: '10', policy })).rejects.toMatchObject({ code: 'bad_input' });
    expect(h.calls).toHaveLength(0); expect(h.hl.get_market).not.toHaveBeenCalled();
  });
  it('CLI calls the shared core and offline tools need no config or network', async () => {
    const s = await snapshot(); const input = { snapshot: s, at: NOW, shares: '10', policy, assumptions }; const h = harness();
    const r = await runStrategyCli(['assess', '--input', JSON.stringify(input)], h.tools);
    expect(r.exitCode).toBe(0); expect(JSON.parse(r.stdout)).toEqual(assessPair(input)); expect(h.calls).toHaveLength(0);
    expect((await runCli(['strategy', '--help'])).stdout).toContain('paper execution');
    expect((await runStrategyCli(['assess', '--input', '{bad'])).exitCode).toBe(1);
    expect((await runStrategyCli(['assess', '--input', '{}', '--file', 'unused'])).exitCode).toBe(1);
  });
  it('serves seven tools, three strategy prompts, a resource and actual calculations over MCP', async () => {
    const s = await snapshot(); const h = harness(); const server = createStrategyServer(h.tools); const client = new Client({ name: 'strategy-proof', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      const listed = await client.listTools(); expect(listed.tools.map((t) => t.name).sort()).toEqual(Object.keys(STRATEGY_DOCS).map((n) => `strategy_${n}`).sort());
      expect(listed.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
      const r = await client.callTool({ name: 'strategy_assess_pair', arguments: { snapshot: s, at: NOW, shares: '10', policy, assumptions } });
      expect(r.isError).not.toBe(true); expect(r.structuredContent).toEqual(assess(s));
      expect((await client.listPrompts()).prompts).toHaveLength(3);
      expect((await client.getPrompt({ name: 'paper_leg_failure', arguments: { outcome: String(OUTCOME), market: String(MARKET) } })).messages[0]?.content).toMatchObject({ type: 'text', text: expect.stringContaining('No orders') });
      expect((await client.readResource({ uri: 'verdict-strategy://capabilities' })).contents).toHaveLength(1);
      const bad = await client.callTool({ name: 'strategy_scan_pairs', arguments: { pairs: [], shares: '10', policy } }); expect(bad.isError).toBe(true);
      const forged = { snapshot: s, at: NOW, shares: '10', policy, assumptions, direction: 'hl_yes', fills: { hl: '10', lighter: '10' }, plan: { allInCostUSDC: '0' } };
      const rejected = await client.callTool({ name: 'strategy_paper_pair', arguments: forged });
      expect(rejected.isError).toBe(true);
      expect(() => paperPair(forged)).toThrow();
      expect((await runStrategyCli(['paper', '--input', JSON.stringify(forged)], h.tools)).exitCode).toBe(1);
      expect(h.calls).toHaveLength(0);
    } finally { await client.close(); await server.close(); }
  });
});
