// The five trade and order tools (recent_trades, candles, fills, open_orders, order_status) against the recorded testnet
// fixtures (tests/fixtures, dated one by one in README.json) through a fake fetch: happy paths, empty answers, bad input
// refused before any request, and upstream failures typed. No network, no keys.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANDLE_INTERVALS, InfoClient, MAX_LOOKBACK_MINUTES, type ToolError, UpstreamError, checkAddress, checkInterval, checkLookback, checkOid, createTools, type KitConfig } from '../packages/core/src/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

/** Public testnet addresses taken from recentTrades output on 2026-09-15 (tests/fixtures/record.py). */
const TRADER = '0xa98361b7c825e8ee9434b433d58d6126d2ccd04e';
const MAKER = '0x876fa87b4d3818f437f38f1263bee508d7672d85';
const NOBODY = '0x0000000000000000000000000000000000000001';
const FRANCE = 10474; // testnet outcome whose NO coin #104741 traded; YES coin #104740
const UNTRADED = 11351; // testnet outcome whose YES coin #113510 never traded

/** One route key per request: the type plus the coin, user or id it is about. */
function keyOf(body: Record<string, unknown>): string {
  const type = String(body.type ?? '');
  switch (type) {
    case 'recentTrades':
      return `recentTrades:${String(body.coin)}`;
    case 'candleSnapshot': {
      const req = body.req as { coin: string; interval: string };
      return `candleSnapshot:${req.coin}:${req.interval}`;
    }
    case 'userFills':
    case 'frontendOpenOrders':
    case 'openOrders':
      return `${type}:${String(body.user)}`;
    case 'orderStatus':
      return `orderStatus:${String(body.user)}:${String(body.oid)}`;
    default:
      return type;
  }
}

const HTTP = Symbol('http');
interface Failure {
  [HTTP]: number;
  text: string;
}
const httpFail = (status: number, text = ''): Failure => ({ [HTTP]: status, text });
const isFailure = (v: unknown): v is Failure => typeof v === 'object' && v !== null && HTTP in v;
/** A route whose fetch rejects, the way a DNS failure or a timeout does. */
const NETWORK_DOWN = Symbol('network');

interface Seen {
  key: string;
  body: Record<string, unknown>;
}

function fakeFetch(routes: Record<string, unknown>, seen: Seen[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const key = keyOf(body);
    seen.push({ key, body });
    if (!(key in routes)) return new Response('null', { status: 500 });
    const r = routes[key];
    if (r === NETWORK_DOWN) throw new TypeError('fetch failed');
    if (isFailure(r)) return new Response(r.text, { status: r[HTTP] });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const config: KitConfig = { network: 'testnet', venue: 'at', builder: null, apiUrl: null };

const base: Record<string, unknown> = {
  outcomeMeta: fixture('testnet_outcomeMeta'),
  outcomeTemplates: fixture('testnet_outcomeTemplates'),
  'recentTrades:#104741': fixture('testnet_recentTrades_104741'),
  'recentTrades:#104740': fixture('testnet_recentTrades_104740'),
  'recentTrades:#113510': fixture('testnet_recentTrades_113510'),
  'candleSnapshot:#104741:1h': fixture('testnet_candleSnapshot_104741_1h'),
  'candleSnapshot:#113510:1h': fixture('testnet_candleSnapshot_113510_1h'),
  [`userFills:${TRADER}`]: fixture('testnet_userFills_trader'),
  [`userFills:${NOBODY}`]: [],
  [`frontendOpenOrders:${MAKER}`]: fixture('testnet_frontendOpenOrders_maker'),
  [`frontendOpenOrders:${TRADER}`]: fixture('testnet_frontendOpenOrders_trader'),
  [`openOrders:${MAKER}`]: fixture('testnet_openOrders_maker'),
  [`orderStatus:${MAKER}:55896593277`]: fixture('testnet_orderStatus_maker_open'),
  [`orderStatus:${TRADER}:0xa638f7c5c92a6ac186872360e3086040`]: fixture('testnet_orderStatus_trader_filled'),
  [`orderStatus:${MAKER}:1`]: fixture('testnet_orderStatus_maker_unknown'),
};

function tools(overrides: Record<string, unknown> = {}, seen: Seen[] = []) {
  return createTools(config, new InfoClient({ network: 'testnet', fetch: fakeFetch({ ...base, ...overrides }, seen), retryAfterMs: 1 }));
}

const caught = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('recent_trades', () => {
  it('reads the requested side newest first and maps time, price, size, taker side, hash and trade id', async () => {
    const seen: Seen[] = [];
    const r = await tools({}, seen).recent_trades({ outcome: FRANCE, side: 'no' });
    expect(r).toMatchObject({ outcome: FRANCE, side: 1, coin: '#104741', count: 9 });
    expect(r.trades).toHaveLength(9);
    expect(r.trades[0]).toEqual({ time: 1789409230191, price: 0.7, size: 15, isBuy: true, hash: '0xf21ccaac39c7934cf39604294c8128010c00e291d4cab21f95e575fef8cb6d37', tid: 477941137467299 });
    expect(r.trades.every((t, i) => i === 0 || (r.trades[i - 1]?.time ?? 0) >= t.time)).toBe(true);
    expect(seen.map((s) => s.key)).toEqual(['outcomeMeta', 'outcomeTemplates', 'recentTrades:#104741']);
  });
  it('YES is the side read when none is given; the NO coin prints the same fills mirrored (price 1 - p, taker side flipped)', async () => {
    const seen: Seen[] = [];
    const yes = await tools({}, seen).recent_trades({ outcome: FRANCE });
    expect(yes).toMatchObject({ side: 0, coin: '#104740' });
    expect(seen.at(-1)?.body).toEqual({ type: 'recentTrades', coin: '#104740' });
    const no = await tools().recent_trades({ outcome: FRANCE, side: 1 });
    expect(yes.count).toBe(no.count);
    for (const [i, t] of yes.trades.entries()) {
      const mirror = no.trades[i];
      expect(mirror?.hash).toBe(t.hash);
      expect(mirror?.size).toBe(t.size);
      expect((mirror?.price ?? 0) + t.price).toBeCloseTo(1, 12);
      expect(mirror?.isBuy).toBe(!t.isBuy);
    }
  });
  it('a side that has not traded yet is an empty list with count 0, not an error', async () => {
    const r = await tools().recent_trades({ outcome: UNTRADED, side: 'yes' });
    expect(r).toEqual({ outcome: UNTRADED, side: 0, coin: '#113510', count: 0, trades: [] });
  });
  it('an index that is not a market is not_found before any trade request; a malformed index or side is bad_input', async () => {
    const seen: Seen[] = [];
    const t = tools({}, seen);
    expect(await caught(t.recent_trades({ outcome: 999999 }))).toMatchObject({ name: 'ToolError', code: 'not_found' });
    expect(await caught(t.recent_trades({ outcome: 1e10 }))).toMatchObject({ name: 'ToolError', code: 'bad_input' });
    expect(await caught(t.recent_trades({ outcome: FRANCE, side: 'maybe' }))).toMatchObject({ name: 'ToolError', code: 'bad_input' });
    expect(seen.some((s) => s.key.startsWith('recentTrades:'))).toBe(false);
  });
  it('an answer about another coin is an upstream schema error, never returned as the market asked for', async () => {
    const e = await caught(tools({ 'recentTrades:#104740': fixture('testnet_recentTrades_104741') }).recent_trades({ outcome: FRANCE }));
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('schema');
    expect((e as UpstreamError).message).toContain('#104741, not #104740');
  });
  it('an HTTP failure and a drifted shape are typed upstream errors', async () => {
    expect(await caught(tools({ 'recentTrades:#104741': httpFail(500, 'null') }).recent_trades({ outcome: FRANCE, side: 1 }))).toMatchObject({ name: 'UpstreamError', kind: 'http' });
    expect(await caught(tools({ 'recentTrades:#104741': [{ coin: '#104741', px: '0.7' }] }).recent_trades({ outcome: FRANCE, side: 1 }))).toMatchObject({ name: 'UpstreamError', kind: 'schema' });
  });
});

describe('candles', () => {
  const WEEK = 7 * 24 * 60;
  it('maps the hourly candles of the NO side oldest first and reports the window it sent', async () => {
    const seen: Seen[] = [];
    const before = Date.now();
    const r = await tools({}, seen).candles({ outcome: FRANCE, side: 1, interval: '1h', lookbackMinutes: WEEK });
    expect(r).toMatchObject({ outcome: FRANCE, side: 1, coin: '#104741', interval: '1h', count: 145 });
    expect(r.candles).toHaveLength(145);
    expect(r.candles[0]).toEqual({ time: 1788890400000, closeTime: 1788893999999, open: 0.7, high: 0.7, low: 0.7, close: 0.7, volume: 0, trades: 0 });
    expect(r.candles.at(-1)).toEqual({ time: 1789408800000, closeTime: 1789412399999, open: 0.7, high: 0.7, low: 0.7, close: 0.7, volume: 15, trades: 1 });
    expect(r.candles.every((c, i) => i === 0 || (r.candles[i - 1]?.time ?? 0) <= c.time)).toBe(true);
    expect(r.candles.filter((c) => c.volume > 0)).toHaveLength(7);
    expect(r.endTime - r.startTime).toBe(WEEK * 60_000);
    expect(r.endTime).toBeGreaterThanOrEqual(before);
    const req = seen.at(-1)?.body as { req: { coin: string; interval: string; startTime: number; endTime: number } };
    expect(req.req).toEqual({ coin: '#104741', interval: '1h', startTime: r.startTime, endTime: r.endTime });
  });
  it("accepts exactly Hyperliquid's interval set and refuses anything else by name, before any request", async () => {
    for (const iv of CANDLE_INTERVALS) expect(checkInterval(iv)).toBe(iv);
    expect(CANDLE_INTERVALS).toEqual(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']);
    const seen: Seen[] = [];
    const t = tools({}, seen);
    for (const bad of ['2m', '10m', '6h', '1y', '', '1H', 'hour']) {
      const e = await caught(t.candles({ outcome: FRANCE, side: 1, interval: bad, lookbackMinutes: 60 }));
      expect(e, bad).toMatchObject({ name: 'ToolError', code: 'bad_input' });
      expect((e as ToolError).message).toContain('1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M');
    }
    expect(seen).toEqual([]);
  });
  it('the lookback is an integer number of minutes from 1 to 366 days', async () => {
    expect(checkLookback(1)).toBe(1);
    expect(checkLookback(MAX_LOOKBACK_MINUTES)).toBe(MAX_LOOKBACK_MINUTES);
    expect(MAX_LOOKBACK_MINUTES).toBe(366 * 24 * 60);
    const seen: Seen[] = [];
    const t = tools({}, seen);
    for (const bad of [0, -5, 1.5, MAX_LOOKBACK_MINUTES + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await caught(t.candles({ outcome: FRANCE, side: 1, interval: '1h', lookbackMinutes: bad })), String(bad)).toMatchObject({ name: 'ToolError', code: 'bad_input' });
    }
    expect(seen).toEqual([]);
  });
  it('a side that has never traded has no candles: a typed not_found with the reason, never an invented series', async () => {
    const e = await caught(tools().candles({ outcome: UNTRADED, side: 'yes', interval: '1h', lookbackMinutes: WEEK }));
    expect(e).toMatchObject({ name: 'ToolError', code: 'not_found' });
    expect((e as ToolError).message).toContain('#113510');
    expect((e as ToolError).message).toContain('never traded');
  });
  it('an index that is not a market is not_found; a malformed index is bad_input', async () => {
    expect(await caught(tools().candles({ outcome: 999999, side: 0, interval: '1h', lookbackMinutes: 60 }))).toMatchObject({ name: 'ToolError', code: 'not_found' });
    expect(await caught(tools().candles({ outcome: -1, side: 0, interval: '1h', lookbackMinutes: 60 }))).toMatchObject({ name: 'ToolError', code: 'bad_input' });
  });
  it('a candle about another coin or interval is an upstream schema error', async () => {
    const e = await caught(tools({ 'candleSnapshot:#104741:5m': fixture('testnet_candleSnapshot_104741_1h') }).candles({ outcome: FRANCE, side: 1, interval: '5m', lookbackMinutes: 60 }));
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('schema');
    expect((e as UpstreamError).message).toContain('#104741 at 1h, not #104741 at 5m');
  });
  it('HTTP 422 (the venue refusing the request) and a drifted candle are upstream errors', async () => {
    expect(await caught(tools({ 'candleSnapshot:#104741:1h': httpFail(422, 'Failed to deserialize the JSON body into the target type') }).candles({ outcome: FRANCE, side: 1, interval: '1h', lookbackMinutes: 60 }))).toMatchObject({ name: 'UpstreamError', kind: 'http', detail: 422 });
    expect(await caught(tools({ 'candleSnapshot:#104741:1h': [{ t: 1, s: '#104741', i: '1h' }] }).candles({ outcome: FRANCE, side: 1, interval: '1h', lookbackMinutes: 60 }))).toMatchObject({ name: 'UpstreamError', kind: 'schema' });
  });
});

describe('fills', () => {
  it('keeps the outcome-coin fills of the address, newest first, with builder fee and client id when present', async () => {
    const r = await tools().fills({ address: TRADER });
    expect(r.address).toBe(TRADER);
    expect(r.scanned).toBe(328);
    expect(r.count).toBe(56);
    expect(r.fills).toHaveLength(56);
    expect(r.fills.every((f) => f.coin.startsWith('#') && f.coin === `#${10 * f.outcome + f.side}`)).toBe(true);
    expect(r.fills.every((f, i) => i === 0 || (r.fills[i - 1]?.time ?? 0) >= f.time)).toBe(true);
    expect(r.fills[0]).toEqual({
      outcome: FRANCE,
      side: 1,
      coin: '#104741',
      time: 1789409230191,
      action: 'buy',
      dir: 'Buy',
      price: 0.7,
      size: 15,
      fee: 0,
      feeToken: 'USDC',
      builderFee: null,
      crossed: true,
      oid: 60123639947,
      cloid: '0xa638f7c5c92a6ac186872360e3086040',
      hash: '0xf21ccaac39c7934cf39604294c8128010c00e291d4cab21f95e575fef8cb6d37',
      tid: 477941137467299,
    });
    expect(r.fills.filter((f) => f.builderFee !== null)).toHaveLength(4);
    expect(r.fills.filter((f) => f.cloid !== null)).toHaveLength(18);
    // Hyperliquid books mints, merges and negations on outcome coins as fills; they are carried with their word, not dropped or relabelled as trades.
    expect(new Set(r.fills.map((f) => f.dir))).toEqual(new Set(['Buy', 'Sell', 'Split Outcome', 'Merge Outcome', 'Negate Outcome', 'Merge Question']));
    expect(r.fills.filter((f) => f.dir === 'Buy').every((f) => f.action === 'buy')).toBe(true);
    expect(r.fills.filter((f) => f.dir === 'Sell').every((f) => f.action === 'sell')).toBe(true);
  });
  it('an address with no fills is an empty list', async () => {
    expect(await tools().fills({ address: NOBODY })).toEqual({ address: NOBODY, scanned: 0, count: 0, fills: [] });
  });
  it('a malformed address is bad_input before any request, and the value is not repeated in the message', async () => {
    const seen: Seen[] = [];
    const t = tools({}, seen);
    const keyLike = `0x${'ab'.repeat(32)}`;
    for (const bad of ['0x123', 'abc', '', TRADER.slice(0, 41), `${TRADER}0`, keyLike]) {
      const e = await caught(t.fills({ address: bad }));
      expect(e, bad).toMatchObject({ name: 'ToolError', code: 'bad_input' });
      if (bad !== '') expect((e as ToolError).message).not.toContain(bad);
      expect((e as ToolError).message).toContain('40 hex characters');
    }
    expect(seen).toEqual([]);
    expect(checkAddress(` ${TRADER} `)).toBe(TRADER);
  });
  it('HTTP 422 and a drifted fill are upstream errors', async () => {
    expect(await caught(tools({ [`userFills:${TRADER}`]: httpFail(422) }).fills({ address: TRADER }))).toMatchObject({ name: 'UpstreamError', kind: 'http', detail: 422 });
    expect(await caught(tools({ [`userFills:${TRADER}`]: [{ coin: '#104741', px: 'abc' }] }).fills({ address: TRADER }))).toMatchObject({ name: 'UpstreamError', kind: 'schema' });
  });
});

describe('open_orders', () => {
  it('reads frontendOpenOrders and keeps the outcome orders with type, time in force and client id', async () => {
    const r = await tools().open_orders({ address: MAKER });
    expect(r).toEqual({
      address: MAKER,
      source: 'frontendOpenOrders',
      count: 1,
      orders: [{ outcome: FRANCE, side: 0, coin: '#104740', oid: 55896593277, cloid: null, action: 'buy', price: 0.3, size: 156, originalSize: 333, timestamp: 1783065593537, orderType: 'Limit', tif: 'Gtc', reduceOnly: false }],
    });
  });
  it('an address with nothing resting is an empty list', async () => {
    expect(await tools().open_orders({ address: TRADER })).toEqual({ address: TRADER, source: 'frontendOpenOrders', count: 0, orders: [] });
  });
  it('falls back to the plain openOrders list when frontendOpenOrders answers an HTTP error or a shape the schema refuses, and says so', async () => {
    for (const broken of [httpFail(422), httpFail(500, 'null'), [{ coin: '#104740', side: 'B' }]]) {
      const seen: Seen[] = [];
      const r = await tools({ [`frontendOpenOrders:${MAKER}`]: broken }, seen).open_orders({ address: MAKER });
      expect(r.source).toBe('openOrders');
      expect(r.count).toBe(1);
      expect(r.orders[0]).toEqual({ outcome: FRANCE, side: 0, coin: '#104740', oid: 55896593277, cloid: null, action: 'buy', price: 0.3, size: 156, originalSize: 333, timestamp: 1783065593537, orderType: null, tif: null, reduceOnly: null });
      expect(seen.map((s) => s.key)).toEqual([`frontendOpenOrders:${MAKER}`, `openOrders:${MAKER}`]);
    }
  });
  it('a network failure is reported, not retried on the other endpoint; when both fail the second failure is reported', async () => {
    const seen: Seen[] = [];
    expect(await caught(tools({ [`frontendOpenOrders:${MAKER}`]: NETWORK_DOWN }, seen).open_orders({ address: MAKER }))).toMatchObject({ name: 'UpstreamError', kind: 'network' });
    expect(seen).toHaveLength(1);
    expect(await caught(tools({ [`frontendOpenOrders:${MAKER}`]: httpFail(500), [`openOrders:${MAKER}`]: httpFail(503) }).open_orders({ address: MAKER }))).toMatchObject({ name: 'UpstreamError', kind: 'http', detail: 503 });
  });
  it('a malformed address is bad_input before any request', async () => {
    const seen: Seen[] = [];
    expect(await caught(tools({}, seen).open_orders({ address: '0xnope' }))).toMatchObject({ name: 'ToolError', code: 'bad_input' });
    expect(seen).toEqual([]);
  });
});

describe('order_status', () => {
  it('an open outcome order by order id: lifecycle status, its time, and the order', async () => {
    const r = await tools().order_status({ address: MAKER, oid: 55896593277 });
    expect(r).toEqual({
      address: MAKER,
      oid: 55896593277,
      status: 'open',
      statusTimestamp: 1783065593537,
      order: { outcome: FRANCE, side: 0, coin: '#104740', oid: 55896593277, cloid: null, action: 'buy', price: 0.3, size: 333, originalSize: 333, timestamp: 1783065593537, orderType: 'Limit', tif: 'Gtc', reduceOnly: false },
    });
  });
  it('a filled order looked up by its client order id', async () => {
    const cloid = '0xa638f7c5c92a6ac186872360e3086040';
    const seen: Seen[] = [];
    const r = await tools({}, seen).order_status({ address: TRADER, oid: cloid });
    expect(seen.at(-1)?.body).toEqual({ type: 'orderStatus', user: TRADER, oid: cloid });
    expect(r).toMatchObject({ address: TRADER, oid: cloid, status: 'filled', statusTimestamp: 1789409230191 });
    expect(r.order).toEqual({ outcome: FRANCE, side: 1, coin: '#104741', oid: 60123639947, cloid, action: 'buy', price: 0.756, size: 0, originalSize: 15, timestamp: 1789409230191, orderType: 'Limit', tif: 'Ioc', reduceOnly: false });
  });
  it('an id the address never had is not_found, naming unknownOid', async () => {
    const e = await caught(tools().order_status({ address: MAKER, oid: 1 }));
    expect(e).toMatchObject({ name: 'ToolError', code: 'not_found' });
    expect((e as ToolError).message).toContain('unknownOid');
    expect((e as ToolError).message).toContain('no order 1 for');
  });
  it('an order on a perp or spot coin is not_found naming the coin: the kit reads outcome orders only', async () => {
    const open = fixture('testnet_orderStatus_maker_open') as { order: { order: { coin: string } } };
    const perp = { ...open, order: { ...open.order, order: { ...open.order.order, coin: 'BTC' } } };
    const e = await caught(tools({ [`orderStatus:${MAKER}:55896593277`]: perp }).order_status({ address: MAKER, oid: 55896593277 }));
    expect(e).toMatchObject({ name: 'ToolError', code: 'not_found' });
    expect((e as ToolError).message).toContain('is on BTC');
    expect((e as ToolError).message).toContain('not an outcome market');
  });
  it('oid must be a nonnegative integer or a 0x + 32 hex client id; the address must be an address; both before any request', async () => {
    expect(checkOid(0)).toBe(0);
    expect(checkOid(55896593277)).toBe(55896593277);
    expect(checkOid(`0x${'a'.repeat(32)}`)).toBe(`0x${'a'.repeat(32)}`);
    const seen: Seen[] = [];
    const t = tools({}, seen);
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53, 'abc', '0x12', `0x${'a'.repeat(31)}`, `0x${'a'.repeat(64)}`, '55896593277']) {
      expect(await caught(t.order_status({ address: MAKER, oid: bad })), String(bad)).toMatchObject({ name: 'ToolError', code: 'bad_input' });
    }
    expect(await caught(t.order_status({ address: 'nobody', oid: 1 }))).toMatchObject({ name: 'ToolError', code: 'bad_input' });
    expect(seen).toEqual([]);
  });
  it('HTTP 422 and a drifted answer are upstream errors', async () => {
    expect(await caught(tools({ [`orderStatus:${MAKER}:55896593277`]: httpFail(422) }).order_status({ address: MAKER, oid: 55896593277 }))).toMatchObject({ name: 'UpstreamError', kind: 'http', detail: 422 });
    expect(await caught(tools({ [`orderStatus:${MAKER}:55896593277`]: { status: 'order', order: { status: 'open' } } }).order_status({ address: MAKER, oid: 55896593277 }))).toMatchObject({ name: 'UpstreamError', kind: 'schema' });
  });
});
