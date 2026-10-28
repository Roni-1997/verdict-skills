import { z } from 'zod';
import { ExecutionLinkedAccount } from './execution-client.js';
import { ExecutionProposal, prepareExecution } from './execution.js';
import { createLighterTools, LighterMarket, lighterTicks, type LighterClient } from './lighter.js';
import { ToolError } from './tools.js';

const Id = z.number().int().nonnegative().safe();
const Decimal = z.string().max(40).regex(/^\d{1,15}(?:\.\d{1,12})?$/);
const Money = z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/).pipe(z.string().refine((v) => lighterTicks(v, 6) > 0n));
export const LighterBuyIntent = z.object({
  intentId: z.string().uuid().transform((v) => v.toLowerCase()), market: Id, side: z.enum(['yes', 'no']),
  maxSpendUSDC: Money, maxSlippageBps: z.number().int().min(0).max(500).prefault(50),
  limitPrice: Decimal.optional(),
}).strict();
export type LighterBuyIntent = z.infer<typeof LighterBuyIntent>;
const Target = ExecutionLinkedAccount.options[1];
const Limits = z.object({ creators: z.array(Id).min(1).max(64), maxOrderDebitUSDC: Money }).strict();
const Epoch = z.number().int().nonnegative().safe();
const Level = z.object({ price: Decimal, shares: Decimal }).strict();
const Snapshot = z.object({ market: LighterMarket, asks: z.array(Level).max(250), bids: z.array(Level).max(250),
  requestedAt: Epoch, receivedAt: Epoch, depthTruncated: z.boolean(),
}).strict();
export const LighterIntentPlan = z.object({ proposal: ExecutionProposal,
  quote: z.object({ market: Id, side: z.enum(['yes', 'no']), maxSpendUSDC: Money,
    shares: Decimal, limitPrice: Decimal, feeReserveUSDC: Decimal, maxDebitUSDC: Decimal,
    visibleSharesAtLimit: Decimal, observedAt: Epoch, sourceTimestamp: z.null(),
    depthTruncated: z.boolean(), expiresAt: Epoch, note: z.string(),
  }).strict(),
}).strict();
export type LighterIntentPlan = z.infer<typeof LighterIntentPlan>;
const PlanInput = z.object({ intent: LighterBuyIntent, target: Target, limits: Limits, snapshot: Snapshot,
  now: Epoch, authorityExpiresAt: Epoch.optional(),
}).strict();
type PlanInput = z.input<typeof PlanInput>;
type PrepareInput = Omit<PlanInput, 'snapshot' | 'now'> & { client: LighterClient };
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const min = (a: bigint, b: bigint) => a < b ? a : b;
function decimal(value: bigint, places: number): string {
  const text = value.toString().padStart(places + 1, '0');
  return places === 0 ? text : `${text.slice(0, -places)}.${text.slice(-places)}`.replace(/\.?0+$/, '');
}
function fail(message: string): never { throw new ToolError(message, 'bad_input'); }

/** Pure planning: account identity comes from the connection, never from model-supplied market text. */
export function planLighterBuyIntent(value: PlanInput): LighterIntentPlan {
  const parsed = PlanInput.safeParse(value);
  if (!parsed.success) fail('Invalid Lighter buy intent or live snapshot (values hidden).');
  const { intent, target, limits, snapshot, now, authorityExpiresAt } = parsed.data;
  const market = snapshot.market;
  if (market.market_id !== intent.market || market.network !== target.network || !limits.creators.includes(market.creator)) fail('Market identity, network or creator is outside this connection.');
  if (snapshot.requestedAt > snapshot.receivedAt || snapshot.receivedAt > now || now - snapshot.requestedAt > 5000) fail('Lighter book read is too old or slow. Obtain a fresh snapshot.');
  const priceScale = 10n ** BigInt(market.price_decimals);
  const sizeScale = 10n ** BigInt(market.size_decimals);
  if (BigInt(market.settlement_cap) !== priceScale || market.status !== 'active' || market.is_frozen
    || now < market.start_timestamp || now >= market.end_timestamp) fail('Market is frozen, inactive, outside its trading window, or does not pay one USDC per share.');
  if (!market.title.trim() || market.title.length > 1000 || !market.settlementRule?.trim()) fail('Usable title and settlement rules are required before preparing a trade.');
  const validForSeconds = Math.floor((Math.min(now + 300_000, market.end_timestamp - 5000, authorityExpiresAt ?? Number.MAX_SAFE_INTEGER) - now) / 1000);
  if (validForSeconds < 30) fail('Market or account authority expires too soon for a new trade review.');
  const budget = lighterTicks(intent.maxSpendUSDC, 6);
  if (budget > lighterTicks(limits.maxOrderDebitUSDC, 6)) fail('Requested spend exceeds the connection’s per-order cap.');
  const levels = (intent.side === 'yes' ? snapshot.asks : snapshot.bids).map((row) => ({
    price: intent.side === 'yes' ? lighterTicks(row.price, market.price_decimals) : priceScale - lighterTicks(row.price, market.price_decimals),
    size: lighterTicks(row.shares, market.size_decimals),
  })).sort((a, b) => a.price < b.price ? -1 : a.price > b.price ? 1 : 0);
  if (levels.some((row) => row.price <= 0n || row.price >= priceScale || row.size <= 0n)) fail('Invalid visible Lighter depth.');
  const best = levels[0];
  if (!best) fail('No visible purchase liquidity for this side.');
  const limit = intent.limitPrice === undefined ? min(priceScale - 1n, best.price * BigInt(10_000 + intent.maxSlippageBps) / 10_000n) : lighterTicks(intent.limitPrice, market.price_decimals);
  if (limit <= 0n || limit >= priceScale) fail('Limit must be strictly between zero and full payout on the market tick grid.');
  const visible = levels.reduce((sum, row) => sum + (row.price <= limit ? row.size : 0n), 0n);
  if (visible === 0n) fail('No visible purchase depth within the limit price.');
  const maker = market.is_maker_fee_enabled ? lighterTicks(market.maker_fee, 4) : 0n;
  const taker = market.is_taker_fee_enabled ? lighterTicks(market.taker_fee, 4) : 0n;
  const rate = maker > taker ? maker : taker;
  if (rate > 1_000_000n) fail('Unsupported market fee coefficient.');
  // P*(1-P) <= 1/4 at every fill price, including improvement toward 0.5.
  // Fee percent is represented at 1e4, and USDC reserve at 1e6.
  const fees = (quantity: bigint) => ceil(quantity * rate, sizeScale * 4n);
  const notional = (quantity: bigint) => ceil(quantity * limit * 1_000_000n, sizeScale * priceScale);
  const cost = (quantity: bigint) => notional(quantity) + fees(quantity);
  const quoteLimit = lighterTicks(market.order_quote_limit, market.size_decimals + market.price_decimals);
  let upper = min(visible, BigInt(Number.MAX_SAFE_INTEGER));
  upper = min(upper, 1_000_000_000n * sizeScale);
  upper = min(upper, min(quoteLimit / limit, quoteLimit / (priceScale - limit)));
  let lower = 0n;
  while (lower < upper) {
    const middle = (lower + upper + 1n) / 2n;
    if (cost(middle) <= budget) lower = middle; else upper = middle - 1n;
  }
  if (lower === 0n) fail('Budget cannot purchase one size tick including fees.');
  const shares = decimal(lower, market.size_decimals);
  const limitPrice = decimal(limit, market.price_decimals);
  const feeReserveUSDC = decimal(fees(lower), 6);
  const proposal = prepareExecution({ legs: [{ ...target, market: market.market_id, creator: market.creator,
    title: market.title, settlementRule: market.settlementRule, side: intent.side, action: 'buy', shares,
    limitPrice, feeReserveUSDC, tif: 'ioc' }],
    policy: { maxTotalDebitUSDC: intent.maxSpendUSDC, maxLegDebitUSDC: intent.maxSpendUSDC, minConditionalProfitUSDC: '0' },
    settlementReview: null, validForSeconds,
  }, now, intent.intentId);
  return { proposal, quote: { market: market.market_id, side: intent.side, maxSpendUSDC: intent.maxSpendUSDC,
    shares, limitPrice, feeReserveUSDC, maxDebitUSDC: decimal(cost(lower), 6),
    visibleSharesAtLimit: decimal(visible, market.size_decimals), observedAt: snapshot.receivedAt,
    sourceTimestamp: null, depthTruncated: snapshot.depthTruncated, expiresAt: proposal.payload.expiresAt,
    note: 'Visible depth is an observed read, without a venue source timestamp. Fees reserve the maximum binary fee curve without assuming account discounts. IOC may fill partially or not at all. Approval and fresh broker preflight are still required.',
  } };
}

/** Public GETs only; the broker independently refreshes metadata/depth/fees before signing. */
export async function prepareLighterBuyIntent({ client, ...input }: PrepareInput): Promise<LighterIntentPlan> {
  const requestedAt = client.now();
  const snapshot = await createLighterTools(client).orderbook({ market: input.intent.market, limit: 250 });
  const receivedAt = client.now();
  return planLighterBuyIntent({ ...input, snapshot: { market: snapshot.market, asks: snapshot.asks, bids: snapshot.bids,
    requestedAt, receivedAt, depthTruncated: snapshot.truncated }, now: receivedAt });
}
