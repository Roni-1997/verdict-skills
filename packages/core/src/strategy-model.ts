import { z } from 'zod';
import { CompareMarketResult } from './crossvenue.js';
import { ToolError } from './tools.js';

export const StrategyDecimal = z.string().max(40).regex(/^\d{1,15}(?:\.\d{1,12})?$/).brand<'StrategyDecimal'>();
const Price = StrategyDecimal.refine((s) => Number(s) > 0 && Number(s) < 1, 'price must be strictly between 0 and 1');
const Epoch = z.number().int().nonnegative().safe();
const HlId = z.number().int().min(0).max(999_999_999).brand<'HlOutcome'>();
const LighterId = z.number().int().nonnegative().safe().brand<'LighterMarketId'>();
const Shares = z.string().regex(/^[1-9]\d{0,8}$/, 'use 1..999999999 whole shares');
export const StrategySide = z.enum(['yes', 'no']);
export type StrategySide = z.infer<typeof StrategySide>;
export const StrategyPair = z.object({ outcome: HlId, market: LighterId }).strict();
export type StrategyPair = z.infer<typeof StrategyPair>;
const Levels = z.array(z.object({ price: Price, shares: StrategyDecimal.refine((s) => Number(s) > 0) }).strict()).max(250).superRefine((levels, ctx) => {
  for (let i = 1; i < levels.length; i++) {
    const previous = levels[i - 1]; const level = levels[i];
    if (previous && level && units(previous.price) > units(level.price)) ctx.addIssue({ code: 'custom', message: 'purchase levels must be in ascending price order' });
  }
});
const Asks = z.object({ yes: Levels, no: Levels }).strict();
const Clock = z.object({ requestedAt: Epoch, receivedAt: Epoch }).strict().refine((c) => c.receivedAt >= c.requestedAt, 'response precedes request');

export const PairedSnapshot = z.object({
  version: z.literal(1), kind: z.literal('paired_books'), pair: StrategyPair, capturedAt: Epoch,
  hl: z.object({
    network: z.enum(['testnet', 'mainnet']), outcome: HlId, title: z.string().max(10_000), rule: z.string().max(50_000).nullable(),
    sideNames: z.array(z.string()).length(2).pipe(z.tuple([z.string(), z.string()])), quoteToken: z.string().max(80), expiresAt: Epoch.nullable(),
    asks: Asks, sourceAt: z.object({ yes: Epoch, no: Epoch }).strict(), clock: Clock, knownBuilderBps: StrategyDecimal.nullable(),
  }).strict(),
  lighter: z.object({
    network: z.enum(['devnet', 'testnet', 'mainnet']), market: LighterId, creator: z.number().int().nonnegative().safe(),
    title: z.string().max(10_000), rule: z.string().max(50_000).nullable(), startsAt: Epoch, expiresAt: Epoch,
    active: z.boolean(), asks: Asks, clock: Clock, sourceAt: z.null(), depthTruncated: z.boolean(),
    sizeDecimals: z.number().int().min(0).max(12),
    takerFeePercent: StrategyDecimal.refine((s) => Number(s) <= 100, 'fee percent exceeds supported domain'),
  }).strict(),
}).strict().superRefine((s, ctx) => {
  if (s.pair.outcome !== s.hl.outcome || s.pair.market !== s.lighter.market) ctx.addIssue({ code: 'custom', message: 'snapshot market identities do not match pair' });
  if (s.capturedAt < Math.max(s.hl.clock.receivedAt, s.lighter.clock.receivedAt)) ctx.addIssue({ code: 'custom', message: 'capture precedes responses' });
});
export type PairedSnapshot = z.infer<typeof PairedSnapshot>;
export const ReferenceSnapshot = z.object({
  version: z.literal(1), kind: z.literal('reference'), capturedAt: Epoch,
  network: z.enum(['testnet', 'mainnet']), outcome: HlId, comparison: CompareMarketResult,
}).strict().refine((s) => s.comparison.market.outcome === s.outcome, 'reference outcome identity mismatch');
export const StrategySnapshot = z.union([PairedSnapshot, ReferenceSnapshot]);
export type StrategySnapshot = z.infer<typeof StrategySnapshot>;

export const StrategyPolicy = z.object({
  maxCapitalUSDC: StrategyDecimal, maxUnhedgedLossUSDC: StrategyDecimal,
  minNetCentsPerShare: StrategyDecimal.prefault('0'),
  maxAgeMs: z.number().int().min(1).max(60_000).prefault(5000),
  maxSkewMs: z.number().int().min(0).max(60_000).prefault(2000),
}).strict();
const Assumptions = z.object({
  relationship: z.enum(['unreviewed', 'same_event_same_orientation', 'same_event_reversed_orientation']).prefault('unreviewed'),
  hlAllInTakerBpsCap: StrategyDecimal.refine((s) => Number(s) <= 10_000, 'fee cap must be <= 10000 bps').optional(),
  extraCostUSDC: StrategyDecimal.prefault('0'),
}).strict();
const AssessFields = {
  shares: Shares, policy: StrategyPolicy,
  assumptions: Assumptions.prefault({ relationship: 'unreviewed', extraCostUSDC: '0' }),
};
const Inventory = z.object({ yes: StrategyDecimal, no: StrategyDecimal }).strict();
const Inventories = z.object({ hl: Inventory, lighter: Inventory }).strict();
export const STRATEGY_INPUTS = {
  discover_pairs: z.object({ outcome: HlId, limit: z.number().int().min(1).max(50).prefault(10), cursor: z.number().int().nonnegative().safe().optional() }).strict(),
  snapshot: z.object({ outcome: HlId, market: LighterId.optional(), bookLimit: z.number().int().min(1).max(250).prefault(100) }).strict(),
  assess_pair: z.object({ snapshot: StrategySnapshot, at: Epoch, ...AssessFields }).strict(),
  scan_pairs: z.object({ pairs: z.array(StrategyPair).min(1).max(8), ...AssessFields }).strict(),
  paper_pair: z.object({ snapshot: PairedSnapshot, at: Epoch, ...AssessFields, direction: z.enum(['hl_yes', 'hl_no']), fills: z.object({ hl: StrategyDecimal, lighter: StrategyDecimal }).strict() }).strict(),
  reconcile_pair: z.object({
    pair: StrategyPair, networks: z.object({ hl: z.enum(['testnet', 'mainnet']), lighter: z.enum(['devnet', 'testnet', 'mainnet']) }).strict(),
    at: Epoch, expected: Inventories,
    observed: z.object({ hl: Inventory.extend({ observedAt: Epoch }).strict(), lighter: Inventory.extend({ observedAt: Epoch }).strict() }).strict(),
    maxAgeMs: z.number().int().min(1).max(60_000).prefault(5000),
    relationship: z.enum(['unreviewed', 'same_event_same_orientation', 'same_event_reversed_orientation']).prefault('unreviewed'),
  }).strict(),
  venue_health: z.object({ outcome: HlId, market: LighterId }).strict(),
};
export type StrategyToolName = keyof typeof STRATEGY_INPUTS;
export const STRATEGY_DOCS: Record<StrategyToolName, { command: string; description: string }> = {
  discover_pairs: { command: 'discover', description: 'Rank one page of Lighter candidates for an HL outcome. Title similarity is not settlement equivalence. Return scan coverage and cursor.' },
  snapshot: { command: 'snapshot', description: 'Capture live HL/Lighter purchase depth and rules. Omit market for the existing Polymarket/Kalshi reference comparison, never executable external orders.' },
  assess_pair: { command: 'assess', description: 'Replay a snapshot with exact decimal depth/fee calculations, whole-share capital and stranded-leg loss limits. Plans are conditional paper research, never permission to trade.' },
  scan_pairs: { command: 'scan', description: 'Assess up to eight explicit HL/Lighter pairs sequentially with fresh captures, ranked conditional economics and full failure/coverage reporting. No polling or execution.' },
  paper_pair: { command: 'paper', description: 'Recompute a paper plan and simulate independent per-venue fill caps. Report conditional payoff, stranded shares and leg-failure loss. Never actual fills or a backtest.' },
  reconcile_pair: { command: 'reconcile', description: 'Compare caller-supplied expected and observed absolute YES/NO inventory. Report discrepancies, stale evidence and conditional exposure. Does not infer trades, repair orders or calculate realized P&L.' },
  venue_health: { command: 'health', description: 'Probe HL and Lighter independently. Report network, transport latency, available depth, status and observation/source clocks. Reachable does not imply equivalent or executable.' },
};

export function strategyInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolError(`Invalid strategy input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'bad_input');
  return parsed.data;
}

export const SCALE = 10n ** 12n;
export function units(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
export function amount(value: bigint): string {
  const negative = value < 0n; const s = (negative ? -value : value).toString().padStart(13, '0');
  const fraction = s.slice(-12).replace(/0+$/, '');
  return `${negative ? '-' : ''}${s.slice(0, -12)}${fraction ? `.${fraction}` : ''}`;
}
export function ceilDivide(value: bigint, denominator: bigint): bigint { return (value + denominator - 1n) / denominator; }
