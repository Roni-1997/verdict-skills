// Zod validation of the venue payloads the engine fetches for itself. The pinned engine
// (packages/engine) reads Polymarket, Kalshi, Deribit and OddPool through the global fetch and
// treats each body as an untyped record with defensive coercion; GOAL.md requires every upstream
// response to be schema-typed, so the kit runs each engine call under a validating fetch: for
// those four hosts the body is parsed leniently (every field the engine reads is typed, unknown
// fields pass through untouched) before the engine sees it, and a body that does not match is
// rejected as an UpstreamError before any number from it can flow downstream. Everything else,
// Hyperliquid included, passes through unchanged (InfoClient validates Hyperliquid itself).
import { z } from 'zod';
import { UpstreamError } from './hl/client.js';

/** The engine coerces numbers with Number(); the venues send them as numbers or decimal strings. */
const NumLike = z.union([z.number(), z.string()]).nullable().optional();
const StrOpt = z.string().nullable().optional();
const IdLike = z.union([z.string(), z.number()]).nullable().optional();
/** Polymarket serialises arrays as JSON strings on some endpoints (outcomes, outcomePrices, clobTokenIds). */
const JsonArrayLike = z.union([z.string(), z.array(z.unknown())]).nullable().optional();

export const PolymarketMarket = z
  .object({
    id: IdLike,
    conditionId: StrOpt,
    slug: StrOpt,
    question: StrOpt,
    groupItemTitle: StrOpt,
    description: StrOpt,
    outcomes: JsonArrayLike,
    outcomePrices: JsonArrayLike,
    bestBid: NumLike,
    bestAsk: NumLike,
    spread: NumLike,
    lastTradePrice: NumLike,
    volume: NumLike,
    volumeNum: NumLike,
    volumeClob: NumLike,
    liquidity: NumLike,
    liquidityNum: NumLike,
    liquidityClob: NumLike,
    endDate: StrOpt,
    active: z.boolean().nullable().optional(),
    closed: z.boolean().nullable().optional(),
    tags: z.array(z.unknown()).nullable().optional(),
    events: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  })
  .passthrough();

export const PolymarketEvent = z
  .object({
    id: IdLike,
    title: StrOpt,
    slug: StrOpt,
    description: StrOpt,
    endDate: StrOpt,
    tags: z.array(z.unknown()).nullable().optional(),
    markets: z.array(PolymarketMarket).nullable().optional(),
  })
  .passthrough();

/** gamma /events: an array of events (the engine also accepts `{ events: [...] }`). */
export const PolymarketEventsResponse = z.union([z.array(PolymarketEvent), z.object({ events: z.array(PolymarketEvent) }).passthrough()]);
/** gamma /markets: an array of markets (or `{ markets: [...] }`). */
export const PolymarketMarketsResponse = z.union([z.array(PolymarketMarket), z.object({ markets: z.array(PolymarketMarket) }).passthrough()]);

export const KalshiMarket = z
  .object({
    ticker: StrOpt,
    event_ticker: StrOpt,
    series_ticker: StrOpt,
    title: StrOpt,
    subtitle: StrOpt,
    yes_sub_title: StrOpt,
    status: StrOpt,
    yes_bid: NumLike,
    yes_ask: NumLike,
    yes_bid_dollars: NumLike,
    yes_ask_dollars: NumLike,
    last_price: NumLike,
    last_price_dollars: NumLike,
    yes_bid_size_fp: NumLike,
    yes_ask_size_fp: NumLike,
    floor_strike: NumLike,
    cap_strike: NumLike,
    strike_type: StrOpt,
    volume: NumLike,
    volume_24h: NumLike,
    volume_fp: NumLike,
    volume_24h_fp: NumLike,
    liquidity: NumLike,
    liquidity_dollars: NumLike,
    close_time: StrOpt,
    expiration_time: StrOpt,
    rules_primary: StrOpt,
    rules_secondary: StrOpt,
    settlement_source: StrOpt,
  })
  .passthrough();

export const KalshiEvent = z
  .object({
    event_ticker: StrOpt,
    series_ticker: StrOpt,
    title: StrOpt,
    category: StrOpt,
    close_time: StrOpt,
    markets: z.array(KalshiMarket).nullable().optional(),
  })
  .passthrough();

/** trade-api/v2/events: `{ events: [...] }` (the engine also accepts a bare array). */
export const KalshiEventsResponse = z.union([z.object({ events: z.array(KalshiEvent) }).passthrough(), z.array(KalshiEvent)]);
/** trade-api/v2/markets: `{ markets: [...] }` (or a bare array). */
export const KalshiMarketsResponse = z.union([z.object({ markets: z.array(KalshiMarket) }).passthrough(), z.array(KalshiMarket)]);

export const DeribitBookSummary = z
  .object({
    instrument_name: z.string(),
    mark_iv: z.number().nullable().optional(),
    underlying_price: z.number().nullable().optional(),
    mark_price: z.number().nullable().optional(),
  })
  .passthrough();

/** JSON-RPC envelope of get_book_summary_by_currency; an RPC error carries `error` instead of `result`, which the engine reads as an empty chain. */
export const DeribitResponse = z.union([
  z.object({ jsonrpc: z.string().optional(), result: z.array(DeribitBookSummary) }).passthrough(),
  z.object({ jsonrpc: z.string().optional(), error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough() }).passthrough(),
]);

export const OddpoolMarket = z
  .object({
    exchange: StrOpt,
    market_id: IdLike,
    ticker: StrOpt,
    condition_id: StrOpt,
    id: IdLike,
    slug: StrOpt,
    event_id: IdLike,
    event_title: StrOpt,
    series_id: IdLike,
    title: StrOpt,
    question: StrOpt,
    market_question: StrOpt,
    subtitle: StrOpt,
    yes_bid: NumLike,
    yes_ask: NumLike,
    best_yes_bid: NumLike,
    best_yes_ask: NumLike,
    last_yes_price: NumLike,
    yes_price: NumLike,
    last_price: NumLike,
    price: NumLike,
    spread: NumLike,
    volume: NumLike,
    liquidity: NumLike,
    close_time: StrOpt,
    expiration_time: StrOpt,
    end_time: StrOpt,
  })
  .passthrough();

export const OddpoolEvent = z
  .object({
    event_id: IdLike,
    title: StrOpt,
    exchange: StrOpt,
    series_id: IdLike,
    category: StrOpt,
  })
  .passthrough();

/** OddPool search endpoints return bare arrays; the engine ignores anything else. */
export const OddpoolMarketsResponse = z.array(OddpoolMarket);
export const OddpoolEventsResponse = z.array(OddpoolEvent);

export type VenueName = 'polymarket' | 'kalshi' | 'deribit' | 'oddpool';

/** The schema for a venue URL the engine fetches, or null for any other URL (passed through untouched). */
export function venueSchemaFor(url: URL): { venue: VenueName; schema: z.ZodTypeAny } | null {
  switch (url.hostname) {
    case 'gamma-api.polymarket.com':
      return { venue: 'polymarket', schema: url.pathname.startsWith('/events') ? PolymarketEventsResponse : PolymarketMarketsResponse };
    case 'external-api.kalshi.com':
      return { venue: 'kalshi', schema: url.pathname.endsWith('/events') ? KalshiEventsResponse : KalshiMarketsResponse };
    case 'www.deribit.com':
      return { venue: 'deribit', schema: DeribitResponse };
    case 'api.oddpool.com':
      return { venue: 'oddpool', schema: /\/search\/(markets|events\/[^/]+\/markets)$/.test(url.pathname) ? OddpoolMarketsResponse : OddpoolEventsResponse };
    default:
      return null;
  }
}

/** Validate one venue body; throws UpstreamError('schema') when it does not match. Returns the body unchanged. */
export function validateVenueResponse(url: URL, body: unknown): unknown {
  const target = venueSchemaFor(url);
  if (!target) return body;
  const parsed = target.schema.safeParse(body);
  if (!parsed.success) {
    throw new UpstreamError(`${target.venue} response from ${url.hostname}${url.pathname} did not match the expected shape`, 'schema', parsed.error.issues);
  }
  return body;
}

function urlOf(input: string | URL | Request): URL | null {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  } catch {
    return null;
  }
}

/**
 * A fetch that validates venue bodies before returning them. The original text is returned, not a re-serialised
 * copy, so validation never changes what the engine reads; non-2xx responses and non-venue URLs pass through.
 */
export function validatingFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    const url = urlOf(input);
    if (!url || !res.ok || venueSchemaFor(url) === null) return res;
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: hand the body back as is so the engine's own res.json() fails the way it does today.
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    validateVenueResponse(url, body);
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

let depth = 0;
let installed: { original: typeof fetch; wrapper: typeof fetch } | null = null;

/**
 * Run an engine call with the global fetch replaced by a validating wrapper over the fetch that was current when
 * the outermost call started. The engine reads `fetch` off the global at call time and offers no injection point,
 * so this is the only seam. Concurrent calls share one installation (reference counted); the global is restored
 * when the last one finishes, and left alone if something else replaced it in the meantime.
 */
export async function withValidatedVenueFetch<T>(fn: () => Promise<T>): Promise<T> {
  if (depth === 0) {
    const original = globalThis.fetch;
    const wrapper = validatingFetch(original);
    installed = { original, wrapper };
    globalThis.fetch = wrapper;
  }
  depth += 1;
  try {
    return await fn();
  } finally {
    depth -= 1;
    if (depth === 0 && installed) {
      if (globalThis.fetch === installed.wrapper) globalThis.fetch = installed.original;
      installed = null;
    }
  }
}
