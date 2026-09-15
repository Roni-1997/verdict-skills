// recent_trades, candles, fills, open_orders and order_status: read-only trade and order data for outcome markets,
// straight from Hyperliquid's info endpoint. Nothing here signs, prompts or needs an account; an address is public data,
// the same any explorer shows. Shapes verified live on testnet and mainnet on 2026-09-15 (tests/fixtures, dated one by
// one in README.json). This module returns plain data; tools.ts turns an empty or unknown answer into the typed error
// the faces print.
import { type InfoClient, UpstreamError } from './hl/client.js';
import { decodeOutcomeToken, type SideIndex } from './hl/encoding.js';
import type { FrontendOpenOrder, OpenOrder as RawOpenOrder, SideLetter } from './hl/schemas.js';
import type { Market } from './markets.js';

/** The intervals Hyperliquid's candleSnapshot accepts, verified live on mainnet on 2026-09-15 (2m, 10m, 6h and 1y were refused with HTTP 422). */
export const CANDLE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

/**
 * Longest lookback the kit sends: 366 days in minutes. Hyperliquid answers with about the most recent 5,000 candles of
 * the window at most (5,083 came back for 8,640 one-minute buckets requested on 2026-09-15), so a long window at a short
 * interval is cut at the old end, never padded.
 */
export const MAX_LOOKBACK_MINUTES = 366 * 24 * 60;

/** Hyperliquid's most recent fills per address, across every coin; when a response holds this many, older fills exist beyond it. */
export const USER_FILLS_WINDOW = 2_000;

/** `B` is a taker buy of the coin, `A` a taker sell. */
function actionOf(side: SideLetter): 'buy' | 'sell' {
  return side === 'B' ? 'buy' : 'sell';
}

export interface OutcomeTrade {
  /** Milliseconds since the epoch. */
  readonly time: number;
  /** Quote units (USDC) per token. */
  readonly price: number;
  /** Tokens. */
  readonly size: number;
  /** True when the taker bought this side's token (Hyperliquid side B), false when the taker sold it (A). */
  readonly isBuy: boolean;
  readonly hash: string;
  /** Hyperliquid's trade id, unique per print. */
  readonly tid: number;
}

export interface RecentTradesResult {
  readonly outcome: number;
  readonly side: SideIndex;
  readonly coin: string;
  readonly count: number;
  /** Newest first. */
  readonly trades: readonly OutcomeTrade[];
}

/**
 * The venue's most recent prints on one side of a market. The YES and NO coins print the same fills (same hash and size,
 * price p on YES and 1 - p on NO, the taker side flipped; 10 of 10 hashes shared on mainnet #12100/#12101 and on testnet
 * #104740/#104741 on 2026-09-15), so one coin is read and the other view is the arithmetic mirror, never a second list.
 */
export async function recentTrades(client: InfoClient, market: Market, side: SideIndex): Promise<RecentTradesResult> {
  const coin = market.sides[side].coin;
  const raw = await client.recentTrades(coin);
  const stray = raw.find((t) => t.coin !== coin);
  if (stray) throw new UpstreamError(`info recentTrades answered about ${stray.coin}, not ${coin} as asked`, 'schema', { coin: stray.coin });
  const trades = raw
    .map((t) => ({ time: t.time, price: Number(t.px), size: Number(t.sz), isBuy: t.side === 'B', hash: t.hash, tid: t.tid }))
    .sort((a, b) => b.time - a.time);
  return { outcome: market.outcome, side, coin, count: trades.length, trades };
}

export interface OutcomeCandle {
  /** Bucket open, milliseconds since the epoch. */
  readonly time: number;
  /** Bucket close, milliseconds since the epoch. */
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Tokens traded in the bucket. */
  readonly volume: number;
  /** Prints in the bucket. */
  readonly trades: number;
}

export interface CandlesResult {
  readonly outcome: number;
  readonly side: SideIndex;
  readonly coin: string;
  readonly interval: CandleInterval;
  /** The window sent: `endTime` is the call time, `startTime` that minus the lookback, milliseconds since the epoch. */
  readonly startTime: number;
  readonly endTime: number;
  readonly count: number;
  /** Oldest first. Empty when Hyperliquid has no candles for the coin in the window (a coin that has never traded has none). */
  readonly candles: readonly OutcomeCandle[];
}

/** Candles of one side over the last `lookbackMinutes`, oldest first. The caller has checked the interval and the lookback; `now` is injectable for tests. */
export async function candles(client: InfoClient, market: Market, side: SideIndex, interval: CandleInterval, lookbackMinutes: number, now: number = Date.now()): Promise<CandlesResult> {
  const coin = market.sides[side].coin;
  const endTime = now;
  const startTime = now - lookbackMinutes * 60_000;
  const raw = await client.candleSnapshot({ coin, interval, startTime, endTime });
  const stray = raw.find((c) => c.s !== coin || c.i !== interval);
  if (stray) throw new UpstreamError(`info candleSnapshot answered about ${stray.s} at ${stray.i}, not ${coin} at ${interval} as asked`, 'schema', { coin: stray.s, interval: stray.i });
  const list = raw.map((c) => ({ time: c.t, closeTime: c.T, open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v), trades: c.n })).sort((a, b) => a.time - b.time);
  return { outcome: market.outcome, side, coin, interval, startTime, endTime, count: list.length, candles: list };
}

export interface OutcomeFill {
  readonly outcome: number;
  readonly side: SideIndex;
  readonly coin: string;
  /** Milliseconds since the epoch. */
  readonly time: number;
  /** `buy` when this address bought the side's token, `sell` when it sold. */
  readonly action: 'buy' | 'sell';
  /** Hyperliquid's word: `Buy` or `Sell` for a trade; `Split Outcome`, `Merge Outcome`, `Negate Outcome`, `Merge Question` or `Settlement` for a lifecycle event booked as a fill. */
  readonly dir: string;
  readonly price: number;
  readonly size: number;
  /** Fee in `feeToken`; negative under a maker rebate. */
  readonly fee: number;
  readonly feeToken: string;
  /** Builder fee paid on this fill, in `feeToken`; null when the order carried no builder code. */
  readonly builderFee: number | null;
  /** True when this address was the taker. */
  readonly crossed: boolean;
  readonly oid: number;
  readonly cloid: string | null;
  readonly hash: string;
  readonly tid: number;
}

export interface FillsResult {
  readonly address: string;
  /** Fills Hyperliquid returned across every coin before the outcome filter; at USER_FILLS_WINDOW the window is full and older outcome fills may exist. */
  readonly scanned: number;
  readonly count: number;
  /** Newest first. */
  readonly fills: readonly OutcomeFill[];
}

/** The outcome-market fills of an address, newest first, out of Hyperliquid's most recent fills across every coin. */
export async function fills(client: InfoClient, address: string): Promise<FillsResult> {
  const raw = await client.userFills(address);
  const out: OutcomeFill[] = [];
  for (const f of raw) {
    if (!f.coin.startsWith('#')) continue;
    const decoded = decodeOutcomeToken(f.coin);
    if (!decoded) continue;
    out.push({
      outcome: decoded.outcome,
      side: decoded.side,
      coin: f.coin,
      time: f.time,
      action: actionOf(f.side),
      dir: f.dir,
      price: Number(f.px),
      size: Number(f.sz),
      fee: Number(f.fee),
      feeToken: f.feeToken,
      builderFee: f.builderFee === undefined ? null : Number(f.builderFee),
      crossed: f.crossed,
      oid: f.oid,
      cloid: f.cloid ?? null,
      hash: f.hash,
      tid: f.tid,
    });
  }
  out.sort((a, b) => b.time - a.time);
  return { address, scanned: raw.length, count: out.length, fills: out };
}

export interface OutcomeOrder {
  readonly outcome: number;
  readonly side: SideIndex;
  readonly coin: string;
  readonly oid: number;
  readonly cloid: string | null;
  readonly action: 'buy' | 'sell';
  /** Limit price, quote units per token. */
  readonly price: number;
  /** Tokens still resting. */
  readonly size: number;
  /** Tokens the order was placed with. */
  readonly originalSize: number;
  /** Placement time, milliseconds since the epoch. */
  readonly timestamp: number;
  /** `Limit`, `Stop Market`, ... ; null when read through the plain openOrders endpoint, which does not carry it. */
  readonly orderType: string | null;
  /** `Gtc`, `Ioc`, `Alo`; null when unknown (plain openOrders) or when the order carries none. */
  readonly tif: string | null;
  readonly reduceOnly: boolean | null;
}

export interface OpenOrdersResult {
  readonly address: string;
  /** `frontendOpenOrders` normally; `openOrders` when that endpoint answered with an HTTP error or an unexpected shape and the plain list was read instead (then orderType, tif, reduceOnly and cloid are null). */
  readonly source: 'frontendOpenOrders' | 'openOrders';
  readonly count: number;
  /** Newest first. */
  readonly orders: readonly OutcomeOrder[];
}

function fullOrder(o: FrontendOpenOrder, decoded: { outcome: number; side: SideIndex }): OutcomeOrder {
  return {
    outcome: decoded.outcome,
    side: decoded.side,
    coin: o.coin,
    oid: o.oid,
    cloid: o.cloid,
    action: actionOf(o.side),
    price: Number(o.limitPx),
    size: Number(o.sz),
    originalSize: Number(o.origSz),
    timestamp: o.timestamp,
    orderType: o.orderType,
    tif: o.tif,
    reduceOnly: o.reduceOnly,
  };
}

function plainOrder(o: RawOpenOrder, decoded: { outcome: number; side: SideIndex }): OutcomeOrder {
  return {
    outcome: decoded.outcome,
    side: decoded.side,
    coin: o.coin,
    oid: o.oid,
    cloid: null,
    action: actionOf(o.side),
    price: Number(o.limitPx),
    size: Number(o.sz),
    originalSize: Number(o.origSz),
    timestamp: o.timestamp,
    orderType: null,
    tif: null,
    reduceOnly: null,
  };
}

/** The outcome-coin entries of an order list, mapped and newest first. */
function outcomeOrders<T extends { coin: string; timestamp: number }>(raw: readonly T[], map: (o: T, decoded: { outcome: number; side: SideIndex }) => OutcomeOrder): OutcomeOrder[] {
  const out: OutcomeOrder[] = [];
  for (const o of raw) {
    if (!o.coin.startsWith('#')) continue;
    const decoded = decodeOutcomeToken(o.coin);
    if (decoded) out.push(map(o, decoded));
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Resting orders of an address on outcome markets. frontendOpenOrders first (type, time in force, client id); when it
 * answers with an HTTP error or a shape the schema refuses, the plain openOrders list is read instead and `source`
 * says so. A network failure (timeout, DNS) is not retried on the other endpoint: it would fail the same way.
 */
export async function openOrders(client: InfoClient, address: string): Promise<OpenOrdersResult> {
  try {
    const raw = await client.frontendOpenOrders(address);
    const orders = outcomeOrders(raw, fullOrder);
    return { address, source: 'frontendOpenOrders', count: orders.length, orders };
  } catch (e) {
    if (!(e instanceof UpstreamError) || e.kind === 'network') throw e;
    const raw = await client.openOrders(address);
    const orders = outcomeOrders(raw, plainOrder);
    return { address, source: 'openOrders', count: orders.length, orders };
  }
}

export interface OrderStatusResult {
  readonly address: string;
  /** The id asked for: an order id, or a client order id as `0x` + 32 hex characters. */
  readonly oid: number | string;
  /** Hyperliquid's lifecycle word: `open`, `filled`, `canceled`, `triggered`, `rejected`, `marginCanceled`, ... */
  readonly status: string;
  /** When the status was reached, milliseconds since the epoch. */
  readonly statusTimestamp: number;
  readonly order: OutcomeOrder;
}

export type OrderLookup =
  /** Hyperliquid answered `unknownOid`: the address never had this order. */
  | { readonly kind: 'unknown' }
  /** The order exists but is on a perp or spot coin, not an outcome market. */
  | { readonly kind: 'not_outcome'; readonly coin: string; readonly status: string }
  | { readonly kind: 'found'; readonly result: OrderStatusResult };

/** One order of an address by order id or client order id. */
export async function orderStatus(client: InfoClient, address: string, oid: number | string): Promise<OrderLookup> {
  const raw = await client.orderStatus(address, oid);
  if (raw.status === 'unknownOid') return { kind: 'unknown' };
  const o = raw.order.order;
  const decoded = o.coin.startsWith('#') ? decodeOutcomeToken(o.coin) : null;
  if (!decoded) return { kind: 'not_outcome', coin: o.coin, status: raw.order.status };
  return { kind: 'found', result: { address, oid, status: raw.order.status, statusTimestamp: raw.order.statusTimestamp, order: fullOrder(o, decoded) } };
}
