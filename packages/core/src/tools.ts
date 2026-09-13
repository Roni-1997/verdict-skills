// The tool surface every face exposes: one function per tool, plain inputs and outputs, no transport
// concerns. The CLI and the MCP server call these and nothing else.
import { approveBuilderFeePayload, buildOrder, builderStatus, type BuiltOrder, type TimeInForce } from './builder.js';
import { orderbook as readBook, quote as readQuote, type Orderbook, type Quote } from './book.js';
import { BUILDER_UNSET_MESSAGE, type KitConfig } from './config.js';
import { InfoClient } from './hl/client.js';
import { getMarket, listMarkets, type Market } from './markets.js';
import { networkConfig } from './network.js';
import { positions as readPositions, type OutcomePosition } from './positions.js';

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
  positions(input: { address: string }): Promise<{ address: string; positions: OutcomePosition[] }>;
  builder_status(input: { address: string }): Promise<{ address: string; builder: string; approvedMaxTenthsBp: number; requiredTenthsBp: number; approved: boolean; nextStep: string }>;
  approve_builder_fee_payload(input: Record<string, never>): Promise<ReturnType<typeof approveBuilderFeePayload> & { confirmation: string[] }>;
  build_order(input: { outcome: number; side: SideInput; action: 'buy' | 'sell'; price: string; size: string; tif?: TimeInForce | undefined; cloid?: `0x${string}` | undefined }): Promise<BuiltOrder>;
}

export type SideInput = 0 | 1 | 'yes' | 'no' | string;

export interface MarketSummary {
  outcome: number;
  venue: string;
  displayName: string;
  templateId: string | null;
  underlying: string | null;
  threshold: string | null;
  expiresAt: string | null;
  settlementRule: string | null;
  sides: { index: 0 | 1; name: string; coin: string; assetId: number }[];
  deployerFeeScale: string | null;
}

export function summarize(m: Market): MarketSummary {
  return {
    outcome: m.outcome,
    venue: m.venue,
    displayName: m.displayName,
    templateId: m.templateId,
    underlying: m.underlying,
    threshold: m.threshold,
    expiresAt: m.expiresAt,
    settlementRule: m.settlementRule,
    sides: m.sides.map((s) => ({ index: s.index, name: s.name, coin: s.coin, assetId: s.assetId })),
    deployerFeeScale: m.deployerFeeScale,
  };
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

export function createTools(config: KitConfig, client: InfoClient = new InfoClient({ network: config.network })): Tools {
  const net = networkConfig(config.network);

  async function requireMarket(outcome: number): Promise<Market> {
    if (!Number.isInteger(outcome) || outcome < 0) throw new ToolError(`outcome must be a nonnegative integer, got ${String(outcome)}`, 'bad_input');
    const m = await getMarket(client, outcome);
    if (!m) throw new ToolError(`no outcome market with index ${outcome} on ${config.network}`, 'not_found');
    return m;
  }

  function requireBuilder() {
    if (!config.builder) throw new ToolError(BUILDER_UNSET_MESSAGE, 'not_configured');
    return config.builder;
  }

  return {
    async list_markets(input) {
      const venue = input.venue ?? config.venue ?? undefined;
      let markets = await listMarkets(client, venue ? { venue } : {});
      if (!input.includeExpired) {
        const now = Date.now();
        markets = markets.filter((m) => m.expiresAt === null || Date.parse(m.expiresAt) > now);
      }
      return { network: config.network, venue: venue ?? null, count: markets.length, markets: markets.map(summarize) };
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

    async positions(input) {
      return { address: input.address, positions: await readPositions(client, input.address) };
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
  positions: {
    title: 'Positions',
    description: 'Outcome-token balances held by an address. Read only.',
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
