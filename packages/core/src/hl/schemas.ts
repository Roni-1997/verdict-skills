// Zod schemas for every Hyperliquid info response the kit reads. Upstream drift becomes a
// typed error here, never a wrong number downstream. Shapes verified against recorded
// fixtures from testnet and mainnet on 2026-09-13 (tests/fixtures).
import { z } from 'zod';

export const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address');

const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, 'expected a nonnegative decimal string');

export const SideSpec = z.object({ name: z.string() }).passthrough();

export const OutcomeMetaOutcome = z
  .object({
    outcome: z.number().int().nonnegative(),
    name: z.string(),
    description: z.string().default(''),
    sideSpecs: z.array(SideSpec).length(2),
    quoteToken: z.string(),
    /** Absent on Hyperliquid's own (non-deployer) outcomes; a venue name on deployer markets. */
    venue: z.string().nullable().optional(),
    deployerFeeScale: DecimalString.optional(),
  })
  .passthrough();

export const OutcomeMetaDeployer = z
  .object({
    deployer: HexAddress,
    venue: z.string(),
    subDeployers: z.array(z.tuple([z.string(), z.array(HexAddress)])).optional(),
  })
  .passthrough()
  .nullable();

/** A multi-outcome question: named children plus an optional fallback ("none of the above") outcome. */
export const OutcomeMetaQuestion = z
  .object({
    question: z.number().int().nonnegative(),
    name: z.string(),
    description: z.string().default(''),
    namedOutcomes: z.array(z.number().int().nonnegative()),
    fallbackOutcome: z.number().int().nonnegative().nullable().optional(),
    settledNamedOutcomes: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const OutcomeMeta = z
  .object({
    outcomes: z.array(OutcomeMetaOutcome),
    questions: z.array(OutcomeMetaQuestion),
    deployers: z.array(OutcomeMetaDeployer),
    feeScale: z.unknown().optional(),
  })
  .passthrough();
export type OutcomeMeta = z.infer<typeof OutcomeMeta>;
export type OutcomeMetaOutcome = z.infer<typeof OutcomeMetaOutcome>;
export type OutcomeMetaQuestion = z.infer<typeof OutcomeMetaQuestion>;

export const OutcomeTemplate = z
  .object({
    id: z.string(),
    role: z.unknown(),
    name: z.string(),
    description: z.string(),
    keywords: z.array(z.tuple([z.string(), z.string()])).nullable(),
  })
  .passthrough();
export const OutcomeTemplates = z.array(OutcomeTemplate);
export type OutcomeTemplate = z.infer<typeof OutcomeTemplate>;

export const L2Level = z.object({ px: DecimalString, sz: DecimalString, n: z.number().int().nonnegative() });
export const L2Book = z.object({
  coin: z.string(),
  time: z.number(),
  levels: z.tuple([z.array(L2Level), z.array(L2Level)]),
});
export type L2Book = z.infer<typeof L2Book>;
export type L2Level = z.infer<typeof L2Level>;

/** `maxBuilderFee` returns the approved maximum in tenths of a basis point (1 = 0.001%). */
export const MaxBuilderFee = z.number().int().nonnegative();

export const SpotBalance = z
  .object({
    coin: z.string(),
    /** Absent on some outcome-token balances (seen as `o<id>` coins on testnet). */
    token: z.number().int().nonnegative().optional(),
    hold: DecimalString,
    total: DecimalString,
    entryNtl: DecimalString.optional(),
  })
  .passthrough();
export const SpotClearinghouseState = z.object({ balances: z.array(SpotBalance) }).passthrough();
export type SpotClearinghouseState = z.infer<typeof SpotClearinghouseState>;

/**
 * `spotMetaAndAssetCtxs` returns `[spotMeta, ctxs]`. Outcome coins appear in ctxs as `#<encoding>`;
 * `markPx` is Hyperliquid's robust fair value once the coin has traded today, `midPx` the raw
 * book midpoint (null on an empty book), `dayNtlVlm` the 24h notional volume.
 */
export const SpotAssetCtx = z
  .object({
    coin: z.string(),
    dayNtlVlm: DecimalString,
    markPx: DecimalString.optional(),
    midPx: DecimalString.nullable().optional(),
    prevDayPx: DecimalString.optional(),
  })
  .passthrough();
export const SpotMetaAndAssetCtxs = z.tuple([z.object({ universe: z.array(z.unknown()), tokens: z.array(z.unknown()) }).passthrough(), z.array(SpotAssetCtx)]);
export type SpotAssetCtx = z.infer<typeof SpotAssetCtx>;
export type SpotMetaAndAssetCtxs = z.infer<typeof SpotMetaAndAssetCtxs>;

/** `allMids`: coin name to mid price for every perp and spot coin, including outcome coins. */
export const AllMids = z.record(z.string(), DecimalString);
export type AllMids = z.infer<typeof AllMids>;

// Trade and order data (recent_trades, candles, fills, open_orders, order_status). Shapes verified live on testnet
// (#104741, two public traders taken from its recentTrades output) and mainnet (#12100) on 2026-09-15; the recorded
// answers are the tests/fixtures files named after each endpoint, dated one by one in README.json.

/** Signed decimal string: fees (negative under a maker rebate), PnL and positions carry a minus sign; prices and sizes do not. */
const SignedDecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');

/** Hyperliquid's side letter: `B` the taker bought (bid side), `A` the taker sold (ask side). */
export const SideLetter = z.enum(['A', 'B']);
export type SideLetter = z.infer<typeof SideLetter>;

/** `recentTrades`: the venue's most recent prints of one coin, newest first. `users` is `[buyer, seller]`. */
export const RecentTrade = z
  .object({
    coin: z.string(),
    side: SideLetter,
    px: DecimalString,
    sz: DecimalString,
    time: z.number().int().nonnegative(),
    hash: z.string(),
    tid: z.number().int().nonnegative(),
    users: z.array(z.string()).optional(),
  })
  .passthrough();
export const RecentTrades = z.array(RecentTrade);
export type RecentTrade = z.infer<typeof RecentTrade>;

/**
 * `candleSnapshot`: one candle per interval bucket, oldest first. `t` and `T` are the bucket's open and close times in
 * milliseconds, `s` the coin, `i` the interval, `o h l c` prices, `v` the volume in tokens and `n` the number of trades.
 * A never-traded outcome coin answers `[]` (HTTP 200), never an error; a coin that has traded answers a bucket for every
 * interval since its first trade, `v: "0.0"` and `n: 0` where nothing traded.
 */
export const Candle = z
  .object({
    t: z.number().int().nonnegative(),
    T: z.number().int().nonnegative(),
    s: z.string(),
    i: z.string(),
    o: DecimalString,
    c: DecimalString,
    h: DecimalString,
    l: DecimalString,
    v: DecimalString,
    n: z.number().int().nonnegative(),
  })
  .passthrough();
export const CandleSnapshot = z.array(Candle);
export type Candle = z.infer<typeof Candle>;

/**
 * `userFills`: the address's most recent fills across every coin (perps, spot and outcome coins), newest first, at most
 * 2,000. On outcome coins `dir` is `Buy` or `Sell` for a trade and a lifecycle word (`Split Outcome`, `Merge Outcome`,
 * `Negate Outcome`, `Merge Question`, `Settlement`) for a mint, merge or settlement that Hyperliquid also books as a
 * fill. `builderFee` is present only on fills whose order carried a builder code; `cloid` only when the order had one.
 */
export const UserFill = z
  .object({
    coin: z.string(),
    px: DecimalString,
    sz: DecimalString,
    side: SideLetter,
    time: z.number().int().nonnegative(),
    startPosition: SignedDecimalString,
    dir: z.string(),
    closedPnl: SignedDecimalString,
    hash: z.string(),
    oid: z.number().int().nonnegative(),
    crossed: z.boolean(),
    fee: SignedDecimalString,
    builderFee: SignedDecimalString.optional(),
    tid: z.number().int().nonnegative(),
    cloid: z.string().nullable().optional(),
    feeToken: z.string(),
    twapId: z.unknown().optional(),
  })
  .passthrough();
export const UserFills = z.array(UserFill);
export type UserFill = z.infer<typeof UserFill>;

/** `frontendOpenOrders`: every resting order of an address with its type, time in force and client id; also the `order` inside `orderStatus`. */
export const FrontendOpenOrder = z
  .object({
    coin: z.string(),
    side: SideLetter,
    limitPx: DecimalString,
    /** Remaining size; `origSz` is the size the order was placed with. */
    sz: DecimalString,
    oid: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    origSz: DecimalString,
    triggerCondition: z.string(),
    isTrigger: z.boolean(),
    triggerPx: DecimalString,
    children: z.array(z.unknown()),
    isPositionTpsl: z.boolean(),
    reduceOnly: z.boolean(),
    orderType: z.string(),
    tif: z.string().nullable(),
    cloid: z.string().nullable(),
  })
  .passthrough();
export const FrontendOpenOrders = z.array(FrontendOpenOrder);
export type FrontendOpenOrder = z.infer<typeof FrontendOpenOrder>;

/** `openOrders`: the plain form of the same list, without type, time in force or client id. Read only when frontendOpenOrders is unavailable. */
export const OpenOrder = z
  .object({
    coin: z.string(),
    side: SideLetter,
    limitPx: DecimalString,
    sz: DecimalString,
    oid: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    origSz: DecimalString,
  })
  .passthrough();
export const OpenOrders = z.array(OpenOrder);
export type OpenOrder = z.infer<typeof OpenOrder>;

/**
 * `orderStatus`: `{ status: "unknownOid" }` when the address never had that order, else the order with its lifecycle
 * status (`open`, `filled`, `canceled`, `triggered`, `rejected`, `marginCanceled` and the other words Hyperliquid
 * documents) and the time the status was reached.
 */
export const OrderStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknownOid') }).passthrough(),
  z
    .object({
      status: z.literal('order'),
      order: z.object({ order: FrontendOpenOrder, status: z.string(), statusTimestamp: z.number().int().nonnegative() }).passthrough(),
    })
    .passthrough(),
]);
export type OrderStatus = z.infer<typeof OrderStatus>;
