import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  approveBuilderFeePayload,
  buildMarket,
  buildOrder,
  canonicalDecimal,
  decodeOutcomeToken,
  feeTenthsBpToPercentString,
  hlSchemas,
  InfoClient,
  listMarkets,
  networkConfig,
  outcomeAssetId,
  outcomeCoin,
  outcomeTokenName,
  parseHlDateTime,
  positions,
  quoteFromBook,
  retryDelayMs,
  sideBookFrom,
  splitTemplateDescription,
} from '../packages/core/src/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const BUILDER = { address: '0x00000000000000000000000000000000000000b1' as const, feeTenthsBp: 10 };

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | undefined>;
    const type = body.type ?? '';
    const key = type === 'l2Book' ? `l2Book:${body.coin ?? ''}` : type;
    if (!(key in routes)) return new Response('null', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing from the fixture`);
  return value;
}

describe('outcome asset encoding (Hyperliquid docs, live-hl.ts)', () => {
  it('encodes outcome 1 side 0 as #10, +10, 100000010', () => {
    expect(outcomeCoin(1, 0)).toBe('#10');
    expect(outcomeTokenName(1, 0)).toBe('+10');
    expect(outcomeAssetId(1, 0)).toBe(100_000_010);
  });
  it('encodes the live mainnet BTC market 1210 to the books we observed', () => {
    expect(outcomeCoin(1210, 0)).toBe('#12100');
    expect(outcomeCoin(1210, 1)).toBe('#12101');
  });
  it('decodes tokens and coins and rejects bad sides', () => {
    expect(decodeOutcomeToken('+113510')).toEqual({ outcome: 11351, side: 0 });
    expect(decodeOutcomeToken('#12101')).toEqual({ outcome: 1210, side: 1 });
    expect(decodeOutcomeToken('+113512')).toBeNull();
    expect(decodeOutcomeToken('USDC')).toBeNull();
  });
});

describe('schemas accept the recorded fixtures', () => {
  it('outcomeMeta, outcomeTemplates, l2Book, spotClearinghouseState, maxBuilderFee', () => {
    expect(hlSchemas.OutcomeMeta.safeParse(fixture('mainnet_outcomeMeta')).success).toBe(true);
    expect(hlSchemas.OutcomeMeta.safeParse(fixture('testnet_outcomeMeta')).success).toBe(true);
    expect(hlSchemas.OutcomeTemplates.safeParse(fixture('mainnet_outcomeTemplates')).success).toBe(true);
    expect(hlSchemas.OutcomeTemplates.safeParse(fixture('testnet_outcomeTemplates')).success).toBe(true);
    expect(hlSchemas.L2Book.safeParse(fixture('mainnet_l2Book_12100')).success).toBe(true);
    expect(hlSchemas.L2Book.safeParse(fixture('testnet_l2Book_113510')).success).toBe(true);
    expect(hlSchemas.SpotClearinghouseState.safeParse(fixture('testnet_spotClearinghouseState_subdeployer')).success).toBe(true);
    expect(hlSchemas.MaxBuilderFee.safeParse(fixture('mainnet_maxBuilderFee_sample')).success).toBe(true);
  });
});

describe('markets: settlement rule text from the template', () => {
  const meta = hlSchemas.OutcomeMeta.parse(fixture('mainnet_outcomeMeta'));
  const templates = new Map(hlSchemas.OutcomeTemplates.parse(fixture('mainnet_outcomeTemplates')).map((t) => [t.id, t] as const));
  const raw = meta.outcomes.find((o) => o.outcome === 1210);
  it('substitutes keywords into the display name and the rule and strips the metadata tail', () => {
    const m = buildMarket(must(raw, 'outcome 1210'), templates);
    expect(m.templateId).toBe('binaryPrice');
    expect(m.underlying).toBe('BTC');
    expect(m.threshold).toBe('100000');
    expect(m.priceDescription).toBe('BTC-USDC mark');
    expect(m.twapSeconds).toBe(1);
    expect(m.displayName).toBe('BTC above 100000 at 20261001-0000?');
    expect(m.settlementRule).toContain('1-second TWAP of BTC-USDC mark price');
    expect(m.settlementRule).not.toContain('metadata=');
    expect(m.semanticRestriction).toContain('Hyperliquid perp');
    expect(m.expiresAt).toBe('2026-10-01T00:00:00.000Z');
    expect(m.sides[0].coin).toBe('#12100');
    expect(m.sides[1].assetId).toBe(100_012_101);
    expect(m.deployerFeeScale).toBe('1.0');
  });
  it('parses the template description into rule and metadata', () => {
    const t = must(templates.get('binaryPrice'), 'binaryPrice template');
    const { rule, metadata } = splitTemplateDescription(t.description);
    expect(rule).toContain('{perp} price is above {threshold}');
    expect(rule).toContain('{seconds}-second TWAP of {priceDescription} price');
    expect(metadata.category).toBe('price');
  });
  it('parses Hyperliquid datetimes and rejects garbage', () => {
    expect(parseHlDateTime('20260913-1830')).toBe('2026-09-13T18:30:00.000Z');
    expect(parseHlDateTime('nope')).toBeNull();
  });
  it('listMarkets filters by venue and drops question fallbacks', async () => {
    const client = new InfoClient({
      network: 'testnet',
      fetch: fakeFetch({ outcomeMeta: fixture('testnet_outcomeMeta'), outcomeTemplates: fixture('testnet_outcomeTemplates') }),
    });
    const markets = await listMarkets(client, { venue: 'at' });
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.every((m) => m.venue === 'at')).toBe(true);
    expect(markets.some((m) => m.name === 'template fallback')).toBe(false);
  });
});

describe('quotes walk the book', () => {
  const book = sideBookFrom(hlSchemas.L2Book.parse(fixture('mainnet_l2Book_12100')));
  it('reads best bid, best ask and mid', () => {
    expect(book.bestBid).toBeGreaterThan(0);
    const bid = must(book.bestBid, 'best bid'); const ask = must(book.bestAsk, 'best ask');
    expect(ask).toBeGreaterThan(bid);
    expect(book.mid).toBeCloseTo((bid + ask) / 2, 12);
  });
  it('buying a small size fills at the touch with zero slippage', () => {
    const q = quoteFromBook(book, { side: 0, action: 'buy', size: 1 });
    expect(q.complete).toBe(true);
    expect(q.averagePrice).toBe(book.bestAsk);
    expect(q.slippageCents).toBe(0);
  });
  it('buying more than the touch walks levels and reports positive slippage', () => {
    const first = must(book.asks[0], 'first ask');
    const q = quoteFromBook(book, { side: 0, action: 'buy', size: first.sz + 1 });
    expect(q.levelsUsed).toBeGreaterThanOrEqual(2);
    expect(must(q.averagePrice, 'average price')).toBeGreaterThan(first.px);
    expect(must(q.slippageCents, 'slippage')).toBeGreaterThan(0);
  });
  it('reports slippage in cents per token: 100 at 0.40 then 100 at 0.50 averages 0.45, 5 cents worse than the touch', () => {
    const synthetic = sideBookFrom({ coin: '#10', time: 0, levels: [[], [{ px: '0.40', sz: '100', n: 1 }, { px: '0.50', sz: '100', n: 1 }]] });
    const q = quoteFromBook(synthetic, { side: 0, action: 'buy', size: 200 });
    expect(q.averagePrice).toBeCloseTo(0.45, 12);
    expect(q.slippageCents).toBe(5);
    expect(q.notional).toBeCloseTo(90, 12);
  });
  it('an oversized request is reported incomplete, never invented', () => {
    const q = quoteFromBook(book, { side: 0, action: 'sell', size: 1e12 });
    expect(q.complete).toBe(false);
    expect(q.filledSize).toBeLessThan(1e12);
  });
});

describe('builder codes', () => {
  it('converts tenths of a basis point to percent strings and cents per $1,000', () => {
    expect(feeTenthsBpToPercentString(10)).toBe('0.01%');
    expect(feeTenthsBpToPercentString(1)).toBe('0.001%');
  });
  it('builds the approval payload for the main wallet with the network chain ids', () => {
    const p = approveBuilderFeePayload(networkConfig('testnet'), BUILDER, 1_700_000_000_000);
    expect(p.action.type).toBe('approveBuilderFee');
    expect(p.action.hyperliquidChain).toBe('Testnet');
    expect(p.action.signatureChainId).toBe('0x66eee');
    expect(p.typedData.domain.chainId).toBe(421614);
    expect(p.typedData.primaryType).toBe('HyperliquidTransaction:ApproveBuilderFee');
    expect(p.typedData.message.maxFeeRate).toBe('0.01%');
    expect(p.notes.join(' ')).toContain('main wallet');
  });
  it('builds an unsigned order with the builder parameter last and keys in msgpack order', () => {
    const meta = hlSchemas.OutcomeMeta.parse(fixture('mainnet_outcomeMeta'));
    const templates = new Map(hlSchemas.OutcomeTemplates.parse(fixture('mainnet_outcomeTemplates')).map((t) => [t.id, t] as const));
    const market = buildMarket(must(meta.outcomes.find((o) => o.outcome === 1210), 'outcome 1210'), templates);
    const built = buildOrder({ market, side: 0, action: 'buy', price: '0.0180', size: '250' }, BUILDER);
    const order = must(built.action.orders[0], 'order');
    expect(Object.keys(built.action)).toEqual(['type', 'orders', 'grouping', 'builder']);
    expect(Object.keys(order)).toEqual(['a', 'b', 'p', 's', 'r', 't']);
    expect(order.a).toBe(100_012_100);
    expect(order.p).toBe('0.018');
    expect(order.s).toBe('250');
    expect(built.action.builder).toEqual({ b: BUILDER.address, f: 10 });
    expect(built.summary.notional).toBeCloseTo(4.5, 9);
    expect(built.summary.builderFeeCentsPer1000).toBe(10);
    expect(built.summary.builderFeeEstimate).toBeCloseTo(4.5 * 0.0001, 12);
    expect(built.confirmation.some((l) => l.startsWith('Settles:'))).toBe(true);
    expect(built.confirmation.at(-1)).toContain('unsigned');
  });
  it('rejects prices outside (0, 1), fractional sizes and malformed decimals', () => {
    const meta = hlSchemas.OutcomeMeta.parse(fixture('mainnet_outcomeMeta'));
    const templates = new Map(hlSchemas.OutcomeTemplates.parse(fixture('mainnet_outcomeTemplates')).map((t) => [t.id, t] as const));
    const market = buildMarket(must(meta.outcomes[0], 'first outcome'), templates);
    expect(() => buildOrder({ market, side: 0, action: 'buy', price: '1.2', size: '1' }, BUILDER)).toThrow();
    expect(() => buildOrder({ market, side: 0, action: 'buy', price: '0.5', size: '1.5' }, BUILDER)).toThrow();
    expect(() => canonicalDecimal('01.5', 5)).toThrow();
    expect(canonicalDecimal('0.50000', 5)).toBe('0.5');
  });
});

describe('positions', () => {
  it('returns only outcome tokens with a positive balance', async () => {
    const client = new InfoClient({
      network: 'testnet',
      fetch: fakeFetch({ spotClearinghouseState: fixture('testnet_spotClearinghouseState_subdeployer') }),
    });
    const p = await positions(client, '0x2bd816e68b18d1dd6327266f273f0658f20467dc');
    expect(Array.isArray(p)).toBe(true);
    expect(p.every((x) => x.tokenName.startsWith('+') && x.total > 0)).toBe(true);
  });
});

describe('client turns upstream drift into typed errors', () => {
  it('rejects a book with a missing level field', async () => {
    const client = new InfoClient({ network: 'testnet', fetch: fakeFetch({ 'l2Book:#1': { coin: '#1', time: 1, levels: [[{ px: '0.5' }], []] } }) });
    await expect(client.l2Book('#1')).rejects.toMatchObject({ name: 'UpstreamError', kind: 'schema' });
  });
});

describe('client retries once on HTTP 429 (Hyperliquid: 1,200 request weight per minute per IP)', () => {
  const book = { coin: '#1', time: 1, levels: [[{ px: '0.5', sz: '1', n: 1 }], []] };
  /** A fetch that answers the given statuses in order (200 carries a valid book), recording every request body. */
  function sequence(statuses: readonly number[], headers: Record<string, string> = {}): { fetch: typeof fetch; bodies: string[] } {
    const bodies: string[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      const status = statuses[bodies.length - 1] ?? 200;
      return status === 200 ? new Response(JSON.stringify(book), { status, headers: { 'content-type': 'application/json' } }) : new Response('', { status, headers });
    }) as typeof fetch;
    return { fetch: impl, bodies };
  }
  it('a 429 followed by a 200 yields the second response after one retry of the same request', async () => {
    const f = sequence([429, 200], { 'retry-after': '0' });
    const client = new InfoClient({ network: 'testnet', fetch: f.fetch, retryAfterMs: 1 });
    const parsed = await client.l2Book('#1');
    expect(parsed.coin).toBe('#1');
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[0]).toBe(f.bodies[1]);
  });
  it('a second 429 is the caller\'s error: exactly two requests, then a typed http error', async () => {
    const f = sequence([429, 429]);
    const client = new InfoClient({ network: 'testnet', fetch: f.fetch, retryAfterMs: 1 });
    await expect(client.l2Book('#1')).rejects.toMatchObject({ name: 'UpstreamError', kind: 'http', detail: 429 });
    expect(f.bodies).toHaveLength(2);
  });
  it('other HTTP errors are not retried', async () => {
    const f = sequence([503, 200]);
    const client = new InfoClient({ network: 'testnet', fetch: f.fetch, retryAfterMs: 1 });
    await expect(client.l2Book('#1')).rejects.toMatchObject({ name: 'UpstreamError', kind: 'http', detail: 503 });
    expect(f.bodies).toHaveLength(1);
  });
  it('the backoff honours Retry-After in seconds or as a date, capped at 10 s, and falls back to the configured delay', () => {
    const now = Date.UTC(2026, 8, 13, 22, 0, 0);
    expect(retryDelayMs('2', 1_000, now)).toBe(2_000);
    expect(retryDelayMs('0', 1_000, now)).toBe(0);
    expect(retryDelayMs('120', 1_000, now)).toBe(10_000);
    expect(retryDelayMs(new Date(now + 3_000).toUTCString(), 1_000, now)).toBe(3_000);
    expect(retryDelayMs(new Date(now - 3_000).toUTCString(), 1_000, now)).toBe(0);
    expect(retryDelayMs('soon', 1_000, now)).toBe(1_000);
    expect(retryDelayMs(null, 250, now)).toBe(250);
    expect(retryDelayMs(null, 60_000, now)).toBe(10_000);
  });
});
