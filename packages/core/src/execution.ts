import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { amount, ceilDivide, SCALE, StrategyDecimal, units } from './strategy-model.js';
import { ToolError } from './tools.js';

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
const Money = StrategyDecimal;
const Positive = Money.refine((v) => units(v) > 0n && units(v) <= 1_000_000_000n * SCALE, 'amount must be positive and <= 1000000000');
const Price = Positive.refine((v) => units(v) < SCALE, 'price must be below 1');
const Common = {
  title: z.string().min(1).max(1000), settlementRule: z.string().min(1).max(50_000),
  side: z.enum(['yes', 'no']), action: z.enum(['buy', 'sell']), shares: Positive, limitPrice: Price,
  feeReserveUSDC: Money,
};
export const ExecutionLeg = z.discriminatedUnion('venue', [
  z.object({ ...Common, venue: z.literal('hl'), network: z.enum(['testnet', 'mainnet']), account: Address,
    outcome: z.number().int().min(0).max(999_999_999), tif: z.enum(['Ioc', 'Gtc', 'Alo']),
    builder: z.object({ address: Address, feeTenthsBp: z.number().int().min(0).max(10_000) }).strict(),
    allInFeeBpsCap: Money.refine((v) => Number(v) <= 10_000),
  }).strict(),
  z.object({ ...Common, venue: z.literal('lighter'), network: z.enum(['devnet', 'testnet', 'mainnet']),
    account: z.number().int().nonnegative().safe(), apiKeyIndex: z.number().int().min(0).max(254),
    market: z.number().int().nonnegative().safe(), creator: z.number().int().nonnegative().safe(), tif: z.enum(['ioc', 'gtc', 'post_only']),
  }).strict(),
  z.object({ ...Common, venue: z.literal('polymarket'), network: z.literal('polygon'), account: Address,
    shares: Positive.refine((v) => units(v) % (SCALE / 100n) === 0n, 'Polymarket shares must fit the pinned SDK 0.01 share grid'),
    marketId: z.string().regex(/^\d{1,20}$/),
    assetId: z.string().regex(/^\d{1,78}$/).refine((v) => BigInt(v) < 2n ** 256n),
    tif: z.enum(['FAK', 'FOK', 'GTC', 'GTD']), expiration: z.number().int().nonnegative().safe().optional(),
  }).strict(),
]);
export type ExecutionLeg = z.infer<typeof ExecutionLeg>;
const Legs = z.array(ExecutionLeg).min(1).max(2).pipe(z.union([z.tuple([ExecutionLeg]), z.tuple([ExecutionLeg, ExecutionLeg])]));
const Review = z.object({
  relationship: z.enum(['same_event_same_orientation', 'same_event_reversed_orientation']),
  notes: z.string().min(20).max(5000),
}).strict();
const Policy = z.object({ maxTotalDebitUSDC: Positive, maxLegDebitUSDC: Positive, minConditionalProfitUSDC: Money.default('0') }).strict();
export const ExecutionRequest = z.object({ legs: Legs, policy: Policy, settlementReview: Review.nullable().default(null),
  validForSeconds: z.number().int().min(30).max(3600).default(300) }).strict();
const Epoch = z.number().int().nonnegative().max(8_640_000_000_000_000);
const Payload = z.object({ version: z.literal(1), requestId: z.string().uuid(), createdAt: Epoch,
  expiresAt: Epoch, legs: Legs, policy: Policy, settlementReview: Review.nullable(),
  pairMode: z.literal('sequential_full_first'),
}).strict();
export const ExecutionProposal = z.object({ kind: z.literal('unsigned_execution_proposal'), payload: Payload, digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ExecutionProposal = z.infer<typeof ExecutionProposal>;

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ToolError('Invalid execution input; check the published schema, decimal precision and required account/market fields (values hidden)', 'bad_input');
  return r.data;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function executionDigest(payload: ExecutionProposal['payload']): string {
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}
function immediate(leg: ExecutionLeg): boolean { return leg.tif === 'Ioc' || leg.tif === 'ioc' || leg.tif === 'FAK' || leg.tif === 'FOK'; }
function debit(leg: ExecutionLeg): bigint {
  return (leg.action === 'buy' ? ceilDivide(units(leg.shares) * units(leg.limitPrice), SCALE) : 0n) + units(leg.feeReserveUSDC);
}
function check(p: ExecutionProposal['payload']): void {
  if (p.expiresAt <= p.createdAt || p.expiresAt - p.createdAt > 3_600_000) throw new ToolError('Invalid execution validity window', 'bad_input');
  let total = 0n;
  for (const leg of p.legs) {
    if (leg.venue === 'hl') {
      if (units(leg.shares) % SCALE !== 0n || leg.shares.includes('.')) throw new ToolError('HL execution requires whole shares', 'bad_input');
      if (units(leg.allInFeeBpsCap) * 10n < BigInt(leg.builder.feeTenthsBp) * SCALE) throw new ToolError('HL all-in fee cap is below the builder component', 'bad_input');
      const fee = ceilDivide(units(leg.shares) * (leg.action === 'buy' ? units(leg.limitPrice) : SCALE) * units(leg.allInFeeBpsCap), SCALE ** 2n * 10_000n);
      if (units(leg.feeReserveUSDC) < fee) throw new ToolError('HL fee reserve is below the declared all-in cap at the limit price', 'bad_input');
    }
    if (leg.venue === 'polymarket' && (leg.tif === 'GTD') !== (leg.expiration !== undefined)) throw new ToolError('Only Polymarket GTD requires an expiration', 'bad_input');
    const cost = debit(leg); total += cost;
    if (cost > units(p.policy.maxLegDebitUSDC)) throw new ToolError('Leg exceeds the approved debit limit', 'bad_input');
  }
  if (total > units(p.policy.maxTotalDebitUSDC)) throw new ToolError('Orders exceed the approved total debit limit', 'bad_input');
  if (p.legs.length === 2) {
    const [a, b] = p.legs;
    if (!p.settlementReview) throw new ToolError('Paired execution requires an explicit operator settlement review', 'bad_input');
    if (a.venue === b.venue || a.action !== 'buy' || b.action !== 'buy' || !immediate(a) || !immediate(b)) throw new ToolError('Pairs require different venues and two immediate buy orders', 'bad_input');
    if (units(a.shares) !== units(b.shares)) throw new ToolError('Paired orders require equal requested shares', 'bad_input');
    const mainnet = (l: ExecutionLeg) => l.network === 'mainnet' || l.network === 'polygon';
    if (mainnet(a) !== mainnet(b)) throw new ToolError('Do not pair mainnet with a test network', 'bad_input');
    const sameSide = a.side === b.side;
    if (sameSide !== (p.settlementReview.relationship === 'same_event_reversed_orientation')) throw new ToolError('Pair sides do not complement the reviewed orientation', 'bad_input');
    const profit = units(a.shares) - total;
    if (profit <= 0n || profit < units(p.policy.minConditionalProfitUSDC)) throw new ToolError('Worst-limit conditional payoff does not clear the required profit after fee reserves', 'bad_input');
  } else if (p.settlementReview !== null) throw new ToolError('Settlement pair review applies only to two-leg requests', 'bad_input');
}
export function prepareExecution(value: unknown, now = Date.now(), requestId: string = randomUUID()): ExecutionProposal {
  const p = parse(ExecutionRequest, value);
  const payload = parse(Payload, { version: 1, requestId, createdAt: now, expiresAt: now + p.validForSeconds * 1000, legs: p.legs, policy: p.policy, settlementReview: p.settlementReview, pairMode: 'sequential_full_first' });
  check(payload);
  return { kind: 'unsigned_execution_proposal', payload, digest: executionDigest(payload) };
}
export function validateExecution(value: unknown): ExecutionProposal {
  const p = parse(ExecutionProposal, value); check(p.payload);
  if (executionDigest(p.payload) !== p.digest) throw new ToolError('Execution proposal changed; prepare it again and obtain new confirmation', 'bad_input');
  return p;
}
export function executionConfirmation(value: unknown, environment: 'local' | 'hosted' = 'local') {
  const p = validateExecution(value);
  return { ...p, confirmation: [
    ...p.payload.legs.flatMap((l, i) => [
      `Leg ${i + 1}: ${l.venue} ${l.network}, account ${l.account}: ${l.action} ${l.shares} ${l.side.toUpperCase()} at limit ${l.limitPrice} (${l.tif}); fee reserve ${l.feeReserveUSDC} USDC. ${l.title}. Settlement: ${l.settlementRule}`,
      l.venue === 'hl' ? `HL outcome ${l.outcome}; builder ${l.builder.address}, ${l.builder.feeTenthsBp} tenths-bp; operator-declared all-in fee cap ${l.allInFeeBpsCap} bps.`
        : l.venue === 'lighter' ? `Lighter market ${l.market}, creator ${l.creator}, API key index ${l.apiKeyIndex}.`
          : `Polymarket market ${l.marketId}, asset ${l.assetId}, GTD expiration ${l.expiration ?? 'none'}.`,
    ]),
    `Maximum combined debit ${amount(p.payload.legs.reduce((sum, l) => sum + debit(l), 0n))} USDC. Proposal expires ${new Date(p.payload.expiresAt).toISOString()}.`,
    `Policy: total debit cap ${p.payload.policy.maxTotalDebitUSDC}, per-leg debit cap ${p.payload.policy.maxLegDebitUSDC}, minimum conditional profit ${p.payload.policy.minConditionalProfitUSDC} USDC.`,
    ...(p.payload.settlementReview ? [`Operator settlement hypothesis ${p.payload.settlementReview.relationship}: ${p.payload.settlementReview.notes}`] : []),
    ...(p.payload.legs.length === 2 ? ['Non-atomic sequential execution: each order needs its own separate operator approval. The second order is sent only after a confirmed complete first fill, its own approval and fresh preflight. Declining the second order, or partial, uncertain or failed fills, can leave exposed inventory. Recovery orders require separate confirmation.'] : []),
    `UNSIGNED. No account eligibility, balance, fee, contract-equivalence or fill guarantee. The ${environment === 'hosted' ? 'private hosted' : 'local'} broker rechecks venue metadata, permissions and balances before signing. Fees are reserved estimates, not venue-enforced limits.`,
    environment === 'hosted'
      ? `Digest ${p.digest}. In per-order mode only the independently signed-in review page can approve this exact order; neither the agent nor an MCP tool can approve it. Policy mode requires an explicitly selected, previously owner-approved bounded grant. Venue keys are held by the private hosted signer and are not exposed to your agent. Broker limits are application controls; Lighter API keys have broader venue powers. A digest identifies content, not authority.`
      : `Digest ${p.digest}. In per-order mode, show all lines, end the message and wait for a real new reply; each order also needs exact operator-terminal confirmation. Policy mode requires a previously approved bounded operator grant. A digest identifies content, not authority. Only the operator-owned local broker may sign.`,
  ] };
}
export function executionCapabilities() {
  return { version: 1, hostedSigning: false, localBroker: 'local-runner/verdict_broker', venues: {
    hl: { networks: ['testnet', 'mainnet'], orders: ['Ioc', 'Gtc', 'Alo'], cancel: 'client order id', signing: 'official hyperliquid-python-sdk sign_l1_action' },
    lighter: { networks: ['devnet', 'testnet', 'mainnet'], orders: ['ioc', 'gtc', 'post_only'], cancel: 'original client order index', signing: 'official lighter-sdk SignerClient' },
    polymarket: { networks: ['polygon'], orders: ['FAK', 'FOK', 'GTC', 'GTD'], cancel: 'order id', signing: 'official unified polymarket-client' },
  }, pairs: ['hl/lighter', 'hl/polymarket', 'lighter/polymarket'], pairMode: 'sequential_full_first', orderApproval: 'operator_selected', executionModes: ['per_order', 'policy'], defaultMode: 'per_order',
  note: 'Capabilities describe implemented local adapters, not proof of funded live acceptance. Private account integration needs operator credentials. Policy mode requires an existing bounded operator grant. No automated market-equivalence guarantee or blanket strategy authorization.' };
}
