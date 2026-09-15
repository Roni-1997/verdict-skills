// The tool surface every face exposes: one function per tool, plain inputs and outputs, no transport
// concerns. The CLI and the MCP server call these and nothing else.
import { approveBuilderFeePayload, buildOrder, builderStatus, type BuiltOrder, type TimeInForce } from './builder.js';
import { orderbook as readBook, quote as readQuote, type Orderbook, type Quote } from './book.js';
import { BUILDER_UNSET_MESSAGE, type KitConfig, VENUE_MESSAGE, VENUE_NAME, normalizeVenue } from './config.js';
import {
  compareMarket,
  type CompareMarketResult,
  type EngineOptions,
  fairValue,
  type FairValueResult,
  findHedges,
  type FindHedgesResult,
  OPPORTUNITIES_ENGINE_MAX,
  type OpportunitiesResult,
  opportunities as scanOpportunities,
} from './crossvenue.js';
import {
  CANDLE_INTERVALS,
  type CandleInterval,
  type CandlesResult,
  candles as readCandles,
  type FillsResult,
  fills as readFills,
  isCandleInterval,
  MAX_LOOKBACK_MINUTES,
  type OpenOrdersResult,
  openOrders as readOpenOrders,
  type OrderStatusResult,
  orderStatus as lookupOrder,
  type RecentTradesResult,
  recentTrades as readRecentTrades,
} from './data.js';
import { InfoClient } from './hl/client.js';
import { type Catalog, getMarket, listMarkets, loadCatalog, type Market, marketFromCatalog } from './markets.js';
import { networkConfig } from './network.js';
import { positions as readPositions, type OutcomePosition } from './positions.js';
import { type MarketSummary, summarize } from './summary.js';

export { summarize };
export type { MarketSummary };

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'bad_input' | 'not_configured' | 'upstream',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface Tools {
  list_markets(input: { venue?: string | undefined; includeExpired?: boolean | undefined }): Promise<{ network: string; venue: string | null; count: number; markets: MarketSummary[] }>;
  get_market(input: { outcome: number }): Promise<Market>;
  orderbook(input: { outcome: number }): Promise<Orderbook & { sideNames: [string, string] }>;
  quote(input: { outcome: number; side: SideInput; action: 'buy' | 'sell'; size: number }): Promise<Quote & { market: MarketSummary }>;
  compare_market(input: { outcome: number }): Promise<CompareMarketResult>;
  fair_value(input: { outcome: number }): Promise<FairValueResult>;
  find_hedges(input: { outcome: number }): Promise<FindHedgesResult>;
  opportunities(input: { limit?: number | undefined }): Promise<OpportunitiesResult>;
  positions(input: { address: string }): Promise<{ address: string; positions: OutcomePosition[] }>;
  recent_trades(input: { outcome: number; side?: SideInput | undefined }): Promise<RecentTradesResult>;
  candles(input: { outcome: number; side: SideInput; interval: string; lookbackMinutes: number }): Promise<CandlesResult>;
  fills(input: { address: string }): Promise<FillsResult>;
  open_orders(input: { address: string }): Promise<OpenOrdersResult>;
  order_status(input: { address: string; oid: number | string }): Promise<OrderStatusResult>;
  builder_status(input: { address: string }): Promise<{ address: string; builder: string; approvedMaxTenthsBp: number; requiredTenthsBp: number; approved: boolean; nextStep: string }>;
  approve_builder_fee_payload(input: Record<string, never>): Promise<ReturnType<typeof approveBuilderFeePayload> & { confirmation: string[] }>;
  build_order(input: { outcome: number; side: SideInput; action: 'buy' | 'sell'; price: string; size: string; tif?: TimeInForce | undefined; cloid?: `0x${string}` | undefined }): Promise<BuiltOrder>;
}

export type SideInput = 0 | 1 | 'yes' | 'no' | string;

export interface ToolOptions {
  /** Passed to the cross-venue engine tools: venue fetch budget and scan size. */
  readonly engine?: EngineOptions;
}

/**
 * Largest outcome index either mode accepts: nine digits, the API's rule (OutcomeParam in the app). Outcome coins are
 * `#<outcome><side>` and the info endpoint takes nine-digit coins at most, so a longer index can never name a market
 * and is bad input, not a market that happens to be missing.
 */
export const MAX_OUTCOME = 999_999_999;

/** Input checks shared by the embedded tools and the hosted ones (remote.ts), so both modes reject the same input with the same words before any request. */
export function checkOutcome(outcome: number): void {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > MAX_OUTCOME) throw new ToolError(`outcome must be a nonnegative integer of at most 9 digits, got ${String(outcome)}`, 'bad_input');
}

/**
 * The venue a list or scan is about: unset, blank and `all` (any case) mean every deployer (null), the API's reading
 * of its `venue` parameter; a name is checked against the API's rule so a venue the API would refuse is refused here
 * too, in both modes, with the API's words.
 */
export function checkVenue(venue: string | null | undefined): string | null {
  const v = normalizeVenue(venue);
  if (v !== null && !VENUE_NAME.test(v)) throw new ToolError(VENUE_MESSAGE, 'bad_input');
  return v;
}

/** The opportunities limit: absent means the engine maximum; anything else must be an integer from 1 to that maximum. */
export function checkLimit(limit: number | undefined): number {
  const n = limit ?? OPPORTUNITIES_ENGINE_MAX;
  if (!Number.isInteger(n) || n < 1 || n > OPPORTUNITIES_ENGINE_MAX) {
    throw new ToolError(`limit must be an integer between 1 and ${OPPORTUNITIES_ENGINE_MAX} (the engine ranks at most ${OPPORTUNITIES_ENGINE_MAX} markets per scan)`, 'bad_input');
  }
  return n;
}

/** A 20-byte hex address, the form every Hyperliquid `user` field takes. */
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A client order id: 16 bytes as `0x` + 32 hex characters, the form build_order accepts and orderStatus looks up. */
export const CLOID = /^0x[0-9a-fA-F]{32}$/;

/**
 * The address the trade and order tools read. Checked before any request (Hyperliquid answers HTTP 422 to anything
 * else, as an upstream error). The message repeats no part of the value: a key pasted where an address belongs is
 * exactly what a malformed address looks like, and the message reaches stderr and transcripts.
 */
export function checkAddress(address: string): string {
  const a = typeof address === 'string' ? address.trim() : '';
  if (!ADDRESS.test(a)) throw new ToolError(`address must be 0x followed by 40 hex characters (a 20-byte address); got a ${typeof address === 'string' ? `${address.length}-character` : typeof address} value, not repeated here`, 'bad_input');
  return a;
}

/** One of Hyperliquid's candle intervals (CANDLE_INTERVALS); anything else would be HTTP 422 upstream. */
export function checkInterval(interval: string): CandleInterval {
  if (typeof interval !== 'string' || !isCandleInterval(interval)) {
    throw new ToolError(`interval must be one of ${CANDLE_INTERVALS.join(', ')} (Hyperliquid's candle intervals), got ${JSON.stringify(String(interval).slice(0, 16))}`, 'bad_input');
  }
  return interval;
}

/** The candle lookback: an integer number of minutes from 1 to MAX_LOOKBACK_MINUTES. */
export function checkLookback(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LOOKBACK_MINUTES) {
    throw new ToolError(`lookbackMinutes must be an integer between 1 and ${MAX_LOOKBACK_MINUTES} (366 days), got ${String(minutes)}`, 'bad_input');
  }
  return minutes;
}

/** An order id (a nonnegative safe integer) or a client order id (`0x` + 32 hex characters), the two forms orderStatus looks up. */
export function checkOid(oid: number | string): number | string {
  if (typeof oid === 'number' && Number.isSafeInteger(oid) && oid >= 0) return oid;
  if (typeof oid === 'string' && CLOID.test(oid)) return oid;
  throw new ToolError(`oid must be a nonnegative integer order id, or a client order id as 0x followed by 32 hex characters, got ${JSON.stringify(String(oid).slice(0, 40))}`, 'bad_input');
}

export function resolveSide(market: Market, side: SideInput): 0 | 1 {
  if (side === 0 || side === 1) return side;
  const s = String(side).trim().toLowerCase();
  if (s === '0' || s === 'yes' || s === 'y') return 0;
  if (s === '1' || s === 'no' || s === 'n') return 1;
  const byName = market.sides.find((x) => x.name.toLowerCase() === s || x.name.toLowerCase().replace(/^template:/, '') === s);
  if (byName) return byName.index;
  throw new ToolError(`unknown side ${JSON.stringify(side)}; use yes/no, 0/1, or one of ${market.sides.map((x) => x.name).join(', ')}`, 'bad_input');
}

export function createTools(config: KitConfig, client: InfoClient = new InfoClient({ network: config.network }), options: ToolOptions = {}): Tools {
  const net = networkConfig(config.network);
  const engineOpts = options.engine ?? {};

  async function requireMarket(outcome: number): Promise<Market> {
    checkOutcome(outcome);
    const m = await getMarket(client, outcome);
    if (!m) throw new ToolError(`no outcome market with index ${outcome} on ${config.network}`, 'not_found');
    return m;
  }

  /** The engine tools need the whole catalog (questions, templates) as well as the market, so fetch it once. */
  async function requireCatalogMarket(outcome: number): Promise<{ catalog: Catalog; market: Market }> {
    checkOutcome(outcome);
    const catalog = await loadCatalog(client);
    const market = marketFromCatalog(catalog, outcome);
    if (!market) throw new ToolError(`no outcome market with index ${outcome} on ${config.network}`, 'not_found');
    return { catalog, market };
  }

  function requireBuilder() {
    if (!config.builder) throw new ToolError(BUILDER_UNSET_MESSAGE, 'not_configured');
    return config.builder;
  }

  return {
    async list_markets(input) {
      const venue = checkVenue(input.venue ?? config.venue);
      let markets = await listMarkets(client, venue === null ? {} : { venue });
      if (!input.includeExpired) {
        const now = Date.now();
        markets = markets.filter((m) => m.expiresAt === null || Date.parse(m.expiresAt) > now);
      }
      return { network: config.network, venue, count: markets.length, markets: markets.map(summarize) };
    },

    async get_market(input) {
      return requireMarket(input.outcome);
    },

    async orderbook(input) {
      const m = await requireMarket(input.outcome);
      const book = await readBook(client, m);
      return { ...book, sideNames: [m.sides[0].name, m.sides[1].name] };
    },

    async quote(input) {
      const m = await requireMarket(input.outcome);
      if (!(input.size > 0)) throw new ToolError('size must be a positive number of tokens', 'bad_input');
      const q = await readQuote(client, m, { side: resolveSide(m, input.side), action: input.action, size: input.size });
      return { ...q, market: summarize(m) };
    },

    async compare_market(input) {
      const { catalog, market } = await requireCatalogMarket(input.outcome);
      return compareMarket(client, catalog, market, engineOpts);
    },

    async fair_value(input) {
      const { catalog, market } = await requireCatalogMarket(input.outcome);
      return fairValue(client, catalog, market, engineOpts);
    },

    async find_hedges(input) {
      const { catalog, market } = await requireCatalogMarket(input.outcome);
      return findHedges(client, catalog, market, engineOpts);
    },

    async opportunities(input) {
      const limit = checkLimit(input.limit);
      const venue = checkVenue(config.venue);
      const catalog = await loadCatalog(client);
      return scanOpportunities(client, catalog, venue, limit, engineOpts);
    },

    async positions(input) {
      return { address: input.address, positions: await readPositions(client, input.address) };
    },

    async recent_trades(input) {
      const m = await requireMarket(input.outcome);
      const side = input.side === undefined ? 0 : resolveSide(m, input.side);
      return readRecentTrades(client, m, side);
    },

    async candles(input) {
      checkOutcome(input.outcome);
      const interval = checkInterval(input.interval);
      const lookback = checkLookback(input.lookbackMinutes);
      const m = await requireMarket(input.outcome);
      const side = resolveSide(m, input.side);
      const r = await readCandles(client, m, side, interval, lookback);
      if (r.count === 0) {
        throw new ToolError(
          `no candles for ${r.coin} (outcome ${m.outcome}, side ${side}) at ${interval} over the last ${lookback} minutes on ${config.network}: Hyperliquid keeps candles for an outcome coin from its first trade on, and answers an empty list for a coin that has never traded or a window before that trade`,
          'not_found',
        );
      }
      return r;
    },

    async fills(input) {
      return readFills(client, checkAddress(input.address));
    },

    async open_orders(input) {
      return readOpenOrders(client, checkAddress(input.address));
    },

    async order_status(input) {
      const address = checkAddress(input.address);
      const oid = checkOid(input.oid);
      const r = await lookupOrder(client, address, oid);
      if (r.kind === 'unknown') throw new ToolError(`no order ${String(oid)} for ${address} on ${config.network} (Hyperliquid answered unknownOid)`, 'not_found');
      if (r.kind === 'not_outcome') throw new ToolError(`order ${String(oid)} of ${address} on ${config.network} is on ${r.coin} (status ${r.status}), not an outcome market; the kit reads outcome orders only`, 'not_found');
      return r.result;
    },

    async builder_status(input) {
      const code = requireBuilder();
      const s = await builderStatus(client, input.address, code);
      return {
        address: s.user,
        builder: s.builder,
        approvedMaxTenthsBp: s.approvedMaxTenthsBp,
        requiredTenthsBp: s.requiredTenthsBp,
        approved: s.approved,
        nextStep: s.approved
          ? 'Approved. Orders built by the kit can be signed and submitted by this address.'
          : 'Not approved yet. Call approve_builder_fee_payload, show it to the user, and have the MAIN wallet sign it once.',
      };
    },

    async approve_builder_fee_payload() {
      const code = requireBuilder();
      const p = approveBuilderFeePayload(net, code);
      return {
        ...p,
        confirmation: [
          `Approve builder ${code.address} for at most ${p.action.maxFeeRate} on ${config.network}.`,
          'One-time approval, signed by the main wallet. It does not move funds and can be revoked.',
          'Show this to the user and wait for an explicit yes before signing.',
        ],
      };
    },

    async build_order(input) {
      const code = requireBuilder();
      const m = await requireMarket(input.outcome);
      const side = resolveSide(m, input.side);
      try {
        return buildOrder(
          {
            market: m,
            side,
            action: input.action,
            price: input.price,
            size: input.size,
            ...(input.tif ? { tif: input.tif } : {}),
            ...(input.cloid ? { cloid: input.cloid } : {}),
          },
          code,
        );
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e), 'bad_input');
      }
    },
  };
}

/** Tool descriptions shared by the MCP server and the skill file, so the rules are written once. */
export const TOOL_DOCS: Record<keyof Tools, { title: string; description: string; readOnly: boolean }> = {
  list_markets: {
    title: 'List Verdict markets',
    description: 'Live HIP-4 outcome markets on Verdict with the settlement rule each one resolves on. Read only. No account needed.',
    readOnly: true,
  },
  get_market: {
    title: 'Get one market',
    description: 'Everything about one outcome market: sides, coins, asset ids, settlement rule, expiry, fee scale. Read only.',
    readOnly: true,
  },
  orderbook: {
    title: 'Order book',
    description: 'The YES and NO books of a market (bids, asks, best prices, mid). Read only.',
    readOnly: true,
  },
  quote: {
    title: 'Quote a size',
    description: 'Executable price for buying or selling a number of tokens on one side, walked from the live book: average price, worst price, slippage in cents, whether the size fills. Read only.',
    readOnly: true,
  },
  compare_market: {
    title: 'Compare with Polymarket and Kalshi',
    description:
      "The same market on Polymarket and Kalshi via the Verdict app's cross-venue engine: the best comparator per venue with its price, the gap to Verdict when the contracts match (exact twin, ladder interpolation, or repriced to Verdict's settlement time), and always the engine's resolution-equivalence confidence and reasons. A low-confidence match carries a caveat and no gap. A market with no trades in the last 24h and no real quote on its book (never traded, or traded on an earlier day) has no Verdict price and no gap; a Verdict price taken from the Hyperliquid mark is labelled as such; an edge the engine rates low or that flips under vol stress carries no after-spreads gap. Includes the Deribit options-implied probability for BTC/ETH/SOL price markets. Read only; the kit never builds orders for other venues.",
    readOnly: true,
  },
  fair_value: {
    title: 'Option-implied fair value',
    description:
      'The probability implied by the Deribit options chain (Black-Scholes digital, nearest expiry and strike) for a BTC, ETH or SOL price market, next to the Verdict price, or a typed not-available result with the reason. Reference only, not a tradable comparator. Read only.',
    readOnly: true,
  },
  find_hedges: {
    title: 'Find hedges',
    description:
      'Hyperliquid perp and spot hedge candidates for the market underlying, with reference mids and the hedge direction for holding YES (NO is the opposite). A hedge offsets price exposure only; the outcome still settles separately. Read only.',
    readOnly: true,
  },
  opportunities: {
    title: 'Scan opportunities',
    description:
      "Ranks the configured venue's live markets by tradeable quality (tight spread, real depth, live probability band, not raw volume), with the engine's trade call, hedge leg and any cross-venue gap against a Polymarket or Kalshi twin. At most 8 per scan; books are read for the 40 most-traded live markets and the rest price off Hyperliquid asset contexts. A market with no Verdict price (never traded, or no trades in 24h, and no real quote on its book) is carried as unpriced: ranked after every priced market (the engine is handed every priced market and only as many unpriced ones as its slots leave free, so none can displace a priced one), with a null probability and a reason, never a placeholder price. Read only.",
    readOnly: true,
  },
  positions: {
    title: 'Positions',
    description: 'Outcome-token balances held by an address. Read only.',
    readOnly: true,
  },
  recent_trades: {
    title: 'Recent trades',
    description:
      "Hyperliquid's most recent prints on one side of a market (YES unless a side is given), newest first: time, price, size, whether the taker bought, transaction hash and trade id. The YES and NO coins print the same fills (same hash, price p on YES is 1 - p on NO, taker side flipped), so one side is read. Read only. No account needed.",
    readOnly: true,
  },
  candles: {
    title: 'Candles',
    description:
      "Open, high, low, close, volume and trade count per bucket for one side of a market over a lookback in minutes, oldest first, at one of Hyperliquid's intervals: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M. Hyperliquid keeps candles for an outcome coin from its first trade on; a coin that has never traded has none, and the tool answers not_found with that reason rather than an empty series. About the most recent 5,000 candles of a window at most. Read only.",
    readOnly: true,
  },
  fills: {
    title: 'Fills',
    description:
      "The outcome-market fills of an address, newest first, out of Hyperliquid's most recent 2,000 fills across every coin: market and side, buy or sell, price, size, fee and builder fee when the order carried a builder code, order id, client order id, transaction hash. Lifecycle events Hyperliquid books as fills (Split Outcome, Merge Outcome, Settlement and the like) are carried with their dir word. Read only. Any address can be read; no key is involved.",
    readOnly: true,
  },
  open_orders: {
    title: 'Open orders',
    description:
      'Resting orders of an address on outcome markets, newest first: market and side, buy or sell, limit price, remaining and original size, order type, time in force, client order id. Read from frontendOpenOrders; when that endpoint is unavailable the plain openOrders list is read and the result says so (type, time in force and client id are then null). Read only.',
    readOnly: true,
  },
  order_status: {
    title: 'Order status',
    description:
      "One order of an address by order id (integer) or client order id (0x + 32 hex): Hyperliquid's lifecycle status (open, filled, canceled, triggered, rejected, ...), when it was reached, and the order itself. An id the address never had, or an order on a perp or spot coin rather than an outcome market, is not_found with the reason. Read only.",
    readOnly: true,
  },
  builder_status: {
    title: 'Builder approval status',
    description: "Whether an address has approved Verdict's builder fee and at what maximum rate. Read only.",
    readOnly: true,
  },
  approve_builder_fee_payload: {
    title: 'Builder fee approval payload',
    description:
      "The one-time approval a user signs with their MAIN wallet so orders can carry Verdict's builder code. Returns unsigned typed data. Show the confirmation lines to the user and wait for an explicit yes in a new message before signing. Never sign on the user's behalf.",
    readOnly: false,
  },
  build_order: {
    title: 'Build an unsigned order',
    description:
      'An unsigned Hyperliquid order action for a Verdict market, carrying the builder code, plus the settlement rule, notional, maximum loss and fee in cents per $1,000. It signs nothing and submits nothing. Show the confirmation lines to the user and wait for an explicit yes in a new message before signing or submitting. Never fabricate the confirmation.',
    readOnly: false,
  },
};
