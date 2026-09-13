// compare_market, fair_value, find_hedges and opportunities: thin, typed calls into the Verdict
// app's cross-venue engine (packages/engine, pinned; see UPSTREAM.json). The engine fetches
// Polymarket, Kalshi and Deribit itself; this module builds its snapshot from Hyperliquid, runs
// it, and validates what comes back with Zod so callers get typed results and every
// low-confidence match carries a caveat instead of a bare number. Read only; no account, no LLM.
import {
  ENGINE_UPSTREAM,
  deribitImpliedProb,
  findHedgeCandidates,
  normalizeVerdictSnapshot,
  runOpportunity,
  runResearch,
  scoreResolutionEquivalence,
} from '@verdict/engine';
import { z } from 'zod';
import type { InfoClient } from './hl/client.js';
import { type Catalog, type Market, marketsFromCatalog } from './markets.js';
import { buildSnapshot, type EngineSnapshot } from './snapshot.js';
import { MarketSummary, summarize } from './summary.js';

export interface EngineOptions {
  /** Budget for the engine's venue fetches (Polymarket, Kalshi, Deribit). Default 20 s. */
  readonly timeoutMs?: number;
  /** opportunities: read books for this many of the venue's most-traded live markets; the rest price off asset contexts. Default 40. */
  readonly maxBooks?: number;
}

const Prob = z.number().finite();
const Confidence = z.enum(['low', 'medium', 'high']);
const RawRecord = z.record(z.string(), z.unknown());

// What the engine returns: read leniently (passthrough) and only the fields the tools use.
const ExternalRef = z
  .object({
    venue: z.string(),
    id: z.string().nullable().optional(),
    rawId: z.unknown().optional(),
    title: z.string(),
    yesMid: Prob.nullable(),
    yesBid: Prob.nullable().optional(),
    yesAsk: Prob.nullable().optional(),
    spread: Prob.nullable(),
    depthUsd: z.number().nullable(),
    volumeUsd: z.number().nullable(),
    expiry: z.string().nullable(),
    url: z.string().nullable(),
    equivalenceHint: z.string(),
    matchedBaseTitle: z.string().nullable(),
    mismatchNote: z.string().nullable(),
    normalizedDelta: z.number().nullable(),
    equivalenceReasons: z.array(z.string()),
  })
  .passthrough();
type ExternalRef = z.infer<typeof ExternalRef>;

const TradeCall = z.object({ label: z.string(), reason: z.string() });

const MispricingCard = z
  .object({
    type: z.literal('mispricing'),
    id: z.string(),
    comparisonMethod: z.enum(['ladder_interpolation', 'maturity_adjusted_digital']).optional(),
    baseMarket: RawRecord,
    comps: z.array(RawRecord).min(1),
    verdictProb: Prob.nullable(),
    fairProb: Prob.nullable(),
    normalizedDelta: z.number().nullable(),
    adjustedDelta: z.number().nullable(),
    equivalenceConfidence: Confidence,
    caveats: z.array(z.string()),
    evidence: z.array(z.string()),
    /** Present on exact-twin cards only; model-based cards are reviews, never tickets. */
    tradeCall: TradeCall.optional(),
    interpolated: z
      .object({ venue: z.string(), atStrike: z.number(), atPrice: Prob, lowerStrike: z.number(), lowerPrice: Prob, upperStrike: z.number(), upperPrice: Prob, expiryDeltaDays: z.number() })
      .passthrough()
      .optional(),
    maturityAdjusted: z
      .object({ venue: z.string(), rawPrice: Prob, adjustedPrice: Prob, shift: z.number(), iv: z.number(), spot: z.number(), strike: z.number(), offsetHours: z.number(), compExpiry: z.string().nullable(), baseExpiry: z.string().nullable() })
      .passthrough()
      .optional(),
  })
  .passthrough();
type MispricingCard = z.infer<typeof MispricingCard>;

const HedgeLeg = z.object({ venue: z.string(), symbol: z.string(), kind: z.string(), direction: z.enum(['short', 'long', 'none']), mid: z.number().nullable(), rationale: z.string(), limitations: z.array(z.string()) }).passthrough();
const StrategyCard = z
  .object({
    id: z.string(),
    tradeCall: TradeCall,
    actionState: z.string(),
    evidence: z.array(z.string()),
    hedgeLegs: z.array(HedgeLeg),
    marketLegs: z.array(z.object({ rawId: z.unknown(), title: z.string(), mid: Prob.nullable(), spread: Prob.nullable(), depthUsd: z.number().nullable(), volumeUsd: z.number().nullable() }).passthrough()).min(1),
  })
  .passthrough();

const OptionsImplied = z.object({ prob: Prob.nullable(), iv: z.number(), strikeUsed: z.number(), spot: z.number(), offsetHours: z.number(), marketProb: Prob.nullable() }).passthrough();

const ResearchResult = z
  .object({
    summary: z.string(),
    cards: z.array(z.unknown()),
    externalMarkets: z.array(ExternalRef).default([]),
    dataStatus: z.record(z.string(), z.string()),
    errors: z.record(z.string(), z.unknown()).default({}),
    evidence: z.array(z.string()),
    optionsImplied: OptionsImplied.optional(),
    route: z.string(),
    generatedAt: z.string(),
  })
  .passthrough();

/** The engine's normalized view of a Verdict market (normalizeVerdictOutcome), the fields the tools read. */
const NormalizedBase = z
  .object({
    id: z.string(),
    title: z.string(),
    yesMid: Prob.nullable(),
    yesBid: Prob.nullable(),
    yesAsk: Prob.nullable(),
    spread: Prob.nullable(),
    depthUsd: z.number().nullable(),
    volumeUsd: z.number().nullable(),
    expiry: z.string().nullable(),
    underlying: z.string().nullable(),
    direction: z.enum(['above', 'below', 'range']).nullable(),
    strike: z.number().nullable(),
    rulesText: z.string().nullable(),
  })
  .passthrough();
type NormalizedBase = z.infer<typeof NormalizedBase>;

// Tool outputs.
export const EngineInfo = z.object({ repo: z.string(), commit: z.string(), route: z.string().nullable(), generatedAt: z.string() });

export const ComparatorLeg = z.object({ id: z.string(), title: z.string(), url: z.string().nullable(), yesMid: Prob.nullable(), strike: z.number().nullable(), expiry: z.string().nullable() });

export const Comparator = z
  .object({
    venue: z.enum(['polymarket', 'kalshi']),
    /** exact_twin: same contract, gap is comparable. ladder_interpolation / maturity_adjusted_digital: model-based. reference: closest market, not comparable. */
    method: z.enum(['exact_twin', 'ladder_interpolation', 'maturity_adjusted_digital', 'reference']),
    /** The engine's resolution-equivalence confidence. */
    confidence: Confidence,
    /** The engine's resolution-equivalence reasons (scoreResolutionEquivalence) for the comparator market. */
    reasons: z.array(z.string()).min(1),
    caveats: z.array(z.string()),
    /** Always set when confidence is low; explains why the gap is not reported. */
    caveat: z.string().nullable(),
    title: z.string(),
    url: z.string().nullable(),
    /** The comparator's YES probability at the Verdict contract (raw mid for a twin or reference, model price otherwise). */
    fairProb: Prob.nullable(),
    yesBid: Prob.nullable(),
    yesAsk: Prob.nullable(),
    spread: Prob.nullable(),
    depthUsd: z.number().nullable(),
    volumeUsd: z.number().nullable(),
    expiry: z.string().nullable(),
    /** Verdict YES minus comparator YES, only when the engine deems the pair comparable; null otherwise. */
    gap: z.number().nullable(),
    /** Gap net of both spreads (and the model band for model-based methods), where the engine provides it. */
    spreadAdjustedGap: z.number().nullable(),
    /** Present for the maturity-adjusted method: the comparator repriced from its settlement time to Verdict's. */
    expiryAdjusted: z.object({ rawProb: Prob, adjustedProb: Prob, shift: z.number(), offsetHours: z.number(), iv: z.number(), spot: z.number(), compExpiry: z.string().nullable() }).nullable(),
    mismatchNote: z.string().nullable(),
    tradeCall: TradeCall.nullable(),
    legs: z.array(ComparatorLeg).min(1),
    /** One-line reading; a low-confidence match is always described, never reduced to a number. */
    line: z.string(),
  })
  .superRefine((c, ctx) => {
    if (c.confidence === 'low' && (c.caveat === null || c.gap !== null || c.spreadAdjustedGap !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a low-confidence comparator must carry a caveat and no price gap' });
    }
  });
export type Comparator = z.infer<typeof Comparator>;

export const VerdictSide = z.object({
  title: z.string(),
  yesMid: Prob.nullable(),
  yesBid: Prob.nullable(),
  yesAsk: Prob.nullable(),
  spread: Prob.nullable(),
  depthUsd: z.number().nullable(),
  volumeUsd: z.number().nullable(),
  priceSource: z.enum(['book', 'ctx']).nullable(),
  underlying: z.string().nullable(),
  direction: z.enum(['above', 'below', 'range']).nullable(),
  strike: z.number().nullable(),
  expiry: z.string().nullable(),
});

export const CompareMarketResult = z.object({
  market: MarketSummary,
  verdict: VerdictSide,
  comparators: z.object({ polymarket: Comparator.nullable(), kalshi: Comparator.nullable() }),
  /** Deribit options-implied reference when the market is a BTC/ETH/SOL price binary; null otherwise. */
  optionsImplied: OptionsImplied.nullable(),
  dataStatus: z.object({ polymarket: z.string(), kalshi: z.string() }),
  errors: z.record(z.string(), z.string()),
  summary: z.string(),
  lines: z.array(z.string()),
  evidence: z.array(z.string()),
  engine: EngineInfo,
});
export type CompareMarketResult = z.infer<typeof CompareMarketResult>;

export const FairValueResult = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    market: MarketSummary,
    source: z.literal('deribit'),
    model: z.literal('black_scholes_digital'),
    underlying: z.enum(['BTC', 'ETH', 'SOL']),
    direction: z.enum(['above', 'below']),
    strike: z.number(),
    expiry: z.string(),
    marketProb: Prob.nullable(),
    impliedProb: Prob,
    /** marketProb minus impliedProb; positive means Verdict prices YES above the option-implied level. */
    gap: z.number().nullable(),
    iv: z.number(),
    strikeUsed: z.number(),
    spot: z.number(),
    optionsExpiryOffsetHours: z.number(),
    caveats: z.array(z.string()),
    evidence: z.string(),
    engine: EngineInfo,
  }),
  z.object({
    available: z.literal(false),
    market: MarketSummary,
    reason: z.enum(['not_price_market', 'unsupported_underlying', 'missing_expiry', 'no_options_chain_near_expiry', 'upstream_unavailable']),
    detail: z.string(),
    engine: EngineInfo,
  }),
]);
export type FairValueResult = z.infer<typeof FairValueResult>;

export const HedgeCandidateResult = z.object({
  symbol: z.string(),
  kind: z.enum(['perp', 'spot']),
  mid: z.number().nullable(),
  fundingRate: z.number().nullable(),
  openInterestUsd: z.number().nullable(),
  available: z.boolean(),
  reason: z.string(),
});

export const FindHedgesResult = z.object({
  market: MarketSummary,
  underlying: z.string().nullable(),
  hedgeable: z.boolean(),
  candidates: z.array(HedgeCandidateResult),
  /** The engine's hedge leg for holding YES; NO is the opposite direction. */
  leg: z.object({ symbol: z.string(), kind: z.string(), directionForYes: z.enum(['short', 'long', 'none']), directionForNo: z.enum(['short', 'long', 'none']), mid: z.number().nullable(), rationale: z.string(), limitations: z.array(z.string()) }).nullable(),
  note: z.string(),
  engine: EngineInfo,
});
export type FindHedgesResult = z.infer<typeof FindHedgesResult>;

export const OpportunityItem = z.object({
  rank: z.number().int().positive(),
  outcome: z.number().int().nonnegative(),
  venue: z.string(),
  displayName: z.string(),
  expiresAt: z.string().nullable(),
  yesMid: Prob.nullable(),
  spread: Prob.nullable(),
  depthUsd: z.number().nullable(),
  volumeUsd: z.number().nullable(),
  priceSource: z.enum(['book', 'ctx']).nullable(),
  why: z.string().nullable(),
  tradeCall: TradeCall,
  actionState: z.string(),
  crossVenue: z.string().nullable(),
  hedge: z.object({ symbol: z.string(), kind: z.string(), directionForYes: z.enum(['short', 'long', 'none']) }).nullable(),
});

export const OpportunitiesResult = z.object({
  network: z.enum(['testnet', 'mainnet']),
  venue: z.string().nullable(),
  scanned: z.number().int().nonnegative(),
  /** Markets whose YES and NO books were read (the most traded by 24h notional); the others priced off asset-context marks. */
  booksFetched: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** The engine ranks at most this many markets per scan. */
  engineMax: z.literal(8),
  items: z.array(OpportunityItem),
  comparators: z.array(Comparator),
  dataStatus: z.object({ polymarket: z.string(), kalshi: z.string() }),
  bookErrors: z.array(z.object({ coin: z.string(), message: z.string() })),
  summary: z.string(),
  evidence: z.array(z.string()),
  engine: EngineInfo,
});
export type OpportunitiesResult = z.infer<typeof OpportunitiesResult>;

export const OPPORTUNITIES_ENGINE_MAX = 8;
/** Books read per scan by default: 80 l2Book requests, well inside Hyperliquid's 1,200 weight per minute. */
export const OPPORTUNITIES_DEFAULT_BOOKS = 40;

// Helpers.
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function pct(p: number | null): string {
  return p === null ? 'n/a' : `${(p * 100).toFixed(1)}%`;
}
function pp(d: number): string {
  return `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pp`;
}
function venueLabel(v: 'polymarket' | 'kalshi'): string {
  return v === 'polymarket' ? 'Polymarket' : 'Kalshi';
}
function engineInfo(route: string | null, generatedAt: string): z.infer<typeof EngineInfo> {
  return { repo: ENGINE_UPSTREAM.repo, commit: ENGINE_UPSTREAM.commit, route, generatedAt };
}
function deadline(opts: EngineOptions): number {
  return Date.now() + (opts.timeoutMs ?? 20_000);
}
function isVenue(v: unknown): v is 'polymarket' | 'kalshi' {
  return v === 'polymarket' || v === 'kalshi';
}

function lowCaveat(reasons: readonly string[], note: string | null): string {
  return `Low-confidence match (${reasons.join(', ')})${note ? `: ${note}` : ''}. The price difference is not a comparable gap and is not reported.`;
}

/**
 * Kit-side reading aid computed from the engine's own card data, never a change to its verdict: how far the
 * comparator strike sits from Verdict's. The engine's twin gate is a fixed 0.3% of strike; on a binary with hours
 * left that offset alone can be worth several points of probability, so the note says so when both hold.
 */
export function strikeOffsetCaveat(baseStrike: number | null, compStrike: number | null, expiry: string | null, now: number): { tag: string | null; note: string | null } {
  if (baseStrike === null || compStrike === null || !(baseStrike > 0) || !(compStrike > 0)) return { tag: null, note: null };
  const offset = Math.abs(baseStrike - compStrike) / baseStrike;
  if (offset < 1e-6) return { tag: null, note: null };
  const tag = `strike_offset_${(offset * 100).toFixed(2)}pct`;
  const ms = expiry ? Date.parse(expiry) - now : Number.NaN;
  const hours = Number.isFinite(ms) ? ms / 3_600_000 : null;
  if (hours !== null && hours > 0 && hours < 24 && offset >= 0.001) {
    const diff = Math.round(Math.abs(baseStrike - compStrike) * 100) / 100;
    return {
      tag,
      note: `Strikes differ by $${diff.toLocaleString('en-US')} (${(offset * 100).toFixed(2)}%) with ${hours.toFixed(1)}h to settle; that close to expiry a strike gap alone moves fair value by several points, so part of the gap is curvature rather than disagreement. Read it next to the options-implied reference.`,
    };
  }
  return { tag, note: null };
}

function comparatorLine(venue: 'polymarket' | 'kalshi', c: Omit<Comparator, 'line'>, verdictProb: number | null): string {
  const label = venueLabel(venue);
  if (c.confidence === 'low') return `${label}: low-confidence match (${c.reasons.join(', ')}); no comparable price gap. Closest market: "${c.title}".`;
  if (c.gap !== null) {
    const adj = c.spreadAdjustedGap !== null ? `, ${pp(c.spreadAdjustedGap)} after spreads` : '';
    return `${label}: ${pct(c.fairProb)} vs Verdict ${pct(verdictProb)}, gap ${pp(c.gap)}${adj} (${c.confidence} confidence: ${c.reasons.join(', ')}; ${c.method}).`;
  }
  return `${label}: reference "${c.title}" at ${pct(c.fairProb)} (${c.confidence} confidence: ${c.reasons.join(', ')})${c.caveat ? `. ${c.caveat}` : '.'}`;
}

function legOf(m: Record<string, unknown>): z.infer<typeof ComparatorLeg> {
  return { id: str(m.id) ?? String(m.rawId ?? ''), title: str(m.title) ?? '', url: str(m.url), yesMid: num(m.yesMid), strike: num(m.strike), expiry: str(m.expiry) };
}

function comparatorFromCard(card: MispricingCard, venue: 'polymarket' | 'kalshi', verdictProb: number | null): Comparator {
  const comps = card.comps.filter((c) => c.venue === venue);
  const baseStrike = num(card.baseMarket.strike);
  const primary =
    card.comparisonMethod === 'ladder_interpolation' && baseStrike !== null
      ? [...comps].sort((a, b) => Math.abs((num(a.strike) ?? Infinity) - baseStrike) - Math.abs((num(b.strike) ?? Infinity) - baseStrike))[0]
      : comps[0];
  if (!primary) throw new Error(`engine card ${card.id} has no ${venue} comparator`);
  const method = card.comparisonMethod ?? 'exact_twin';
  const reasons = scoreResolutionEquivalence(card.baseMarket, primary).reasons;
  const confidence = card.equivalenceConfidence;
  let mismatchNote: string | null = null;
  if (card.interpolated) {
    const i = card.interpolated;
    mismatchNote = `${venueLabel(venue)} lists no market at $${Math.round(i.atStrike).toLocaleString()}; interpolated between $${Math.round(i.lowerStrike).toLocaleString()} (${pct(i.lowerPrice)}) and $${Math.round(i.upperStrike).toLocaleString()} (${pct(i.upperPrice)})${i.expiryDeltaDays > 0.25 ? `, settling ~${Math.round(i.expiryDeltaDays * 24)}h apart` : ''}`;
  } else if (card.maturityAdjusted) {
    const m = card.maturityAdjusted;
    mismatchNote = `same strike, settles ${Math.round(Math.abs(m.offsetHours))}h ${m.offsetHours > 0 ? 'later' : 'earlier'} than Verdict; repriced with a Black-Scholes digital at iv ${m.iv.toFixed(1)}%`;
  }
  const low = confidence === 'low';
  const offset = method === 'exact_twin' ? strikeOffsetCaveat(baseStrike, num(primary.strike), str(card.baseMarket.expiry), Date.now()) : { tag: null, note: null };
  const caveat = low ? lowCaveat(reasons, mismatchNote) : method !== 'exact_twin' ? `Model-based comparator (${method}): a relative-value read, not a locked arbitrage; it carries vol and settlement risk.` : offset.note;
  const body: Omit<Comparator, 'line'> = {
    venue,
    method,
    confidence,
    reasons,
    caveats: offset.tag ? [...card.caveats, offset.tag] : card.caveats,
    caveat,
    title: str(primary.title) ?? '',
    url: str(primary.url),
    fairProb: card.fairProb,
    yesBid: num(primary.yesBid),
    yesAsk: num(primary.yesAsk),
    spread: num(primary.spread),
    depthUsd: num(primary.depthUsd),
    volumeUsd: num(primary.volumeUsd),
    expiry: str(primary.expiry),
    gap: low ? null : card.normalizedDelta,
    spreadAdjustedGap: low ? null : card.adjustedDelta,
    expiryAdjusted: card.maturityAdjusted
      ? { rawProb: card.maturityAdjusted.rawPrice, adjustedProb: card.maturityAdjusted.adjustedPrice, shift: card.maturityAdjusted.shift, offsetHours: card.maturityAdjusted.offsetHours, iv: card.maturityAdjusted.iv, spot: card.maturityAdjusted.spot, compExpiry: card.maturityAdjusted.compExpiry }
      : null,
    mismatchNote,
    tradeCall: card.tradeCall ?? null,
    legs: comps.map(legOf),
  };
  return Comparator.parse({ ...body, line: comparatorLine(venue, body, verdictProb) });
}

function comparatorFromReference(ref: ExternalRef, venue: 'polymarket' | 'kalshi', verdictProb: number | null): Comparator {
  const hint = Confidence.safeParse(ref.equivalenceHint);
  const confidence = hint.success ? hint.data : 'low';
  const reasons = ref.equivalenceReasons.length ? ref.equivalenceReasons : ['unscored'];
  const low = confidence === 'low';
  const caveat = low
    ? lowCaveat(reasons, ref.mismatchNote)
    : confidence === 'medium'
      ? `Reference only${ref.mismatchNote ? ` (${ref.mismatchNote})` : ''}: the closest listed market, not the same contract; its price is context, not a comparable gap.`
      : null;
  const body: Omit<Comparator, 'line'> = {
    venue,
    method: 'reference',
    confidence,
    reasons,
    caveats: ref.mismatchNote ? ['reference_not_tradable_twin', ref.mismatchNote] : ['reference_not_tradable_twin'],
    caveat,
    title: ref.title,
    url: ref.url,
    fairProb: ref.yesMid,
    yesBid: ref.yesBid ?? null,
    yesAsk: ref.yesAsk ?? null,
    spread: ref.spread,
    depthUsd: ref.depthUsd,
    volumeUsd: ref.volumeUsd,
    expiry: ref.expiry,
    gap: low ? null : ref.normalizedDelta,
    spreadAdjustedGap: null,
    expiryAdjusted: null,
    mismatchNote: ref.mismatchNote,
    tradeCall: null,
    legs: [legOf(ref as Record<string, unknown>)],
  };
  return Comparator.parse({ ...body, line: comparatorLine(venue, body, verdictProb) });
}

/** Engine output is upstream data: a mispricing card that no longer matches the expected shape is an error, never a silent drop. */
function mispricingCards(cards: readonly unknown[]): MispricingCard[] {
  const out: MispricingCard[] = [];
  for (const c of cards) {
    if (typeof c !== 'object' || c === null || (c as { type?: unknown }).type !== 'mispricing') continue;
    const parsed = MispricingCard.safeParse(c);
    if (!parsed.success) throw new Error(`engine mispricing card did not match the expected shape: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    out.push(parsed.data);
  }
  return out;
}

function bestComparator(venue: 'polymarket' | 'kalshi', cards: readonly MispricingCard[], refs: readonly ExternalRef[], verdictProb: number | null): Comparator | null {
  const card = cards.find((c) => c.comps[0]?.venue === venue);
  if (card) return comparatorFromCard(card, venue, verdictProb);
  const ref = refs.find((r) => r.venue === venue);
  return ref ? comparatorFromReference(ref, venue, verdictProb) : null;
}

function normalizedBase(snap: EngineSnapshot, outcome: number): NormalizedBase {
  const found = normalizeVerdictSnapshot(snap).find((m) => m.rawId === outcome);
  if (!found) throw new Error(`engine did not normalize outcome ${outcome}`);
  return NormalizedBase.parse(found);
}

function verdictSide(base: NormalizedBase, snap: EngineSnapshot): z.infer<typeof VerdictSide> {
  const o = snap.outcomes.find((x) => x.outcome === base.rawId);
  return {
    title: base.title,
    yesMid: base.yesMid,
    yesBid: base.yesBid,
    yesAsk: base.yesAsk,
    spread: base.spread,
    depthUsd: base.depthUsd,
    volumeUsd: base.volumeUsd,
    priceSource: o?.midSource ?? null,
    underlying: base.underlying,
    direction: base.direction,
    strike: base.strike,
    expiry: base.expiry,
  };
}

function isExpired(m: Market, now: number): boolean {
  return m.expiresAt !== null && Date.parse(m.expiresAt) <= now;
}

// Tools.
export async function compareMarket(client: InfoClient, catalog: Catalog, market: Market, opts: EngineOptions = {}): Promise<CompareMarketResult> {
  const snap = await buildSnapshot(client, catalog, [market]);
  const base = normalizedBase(snap, market.outcome);
  const query = [base.title, base.underlying].filter((x): x is string => typeof x === 'string' && x !== '').join(' ');
  const raw = await runResearch({ query, mode: 'cross_venue_scanner', snap, activeMarketId: base.id, deadlineAt: deadline(opts) });
  const res = ResearchResult.parse(raw);
  const cards = mispricingCards(res.cards);
  const comparators = {
    polymarket: bestComparator('polymarket', cards, res.externalMarkets, base.yesMid),
    kalshi: bestComparator('kalshi', cards, res.externalMarkets, base.yesMid),
  };
  const lines = [
    comparators.polymarket?.line ?? 'Polymarket: no comparable market found.',
    comparators.kalshi?.line ?? 'Kalshi: no comparable market found.',
  ];
  if (res.optionsImplied) {
    const oi = res.optionsImplied;
    lines.push(`Deribit options-implied: ${pct(oi.prob)} (iv ${oi.iv.toFixed(1)}%, nearest expiry ${oi.offsetHours >= 0 ? '+' : ''}${oi.offsetHours}h from settle); reference only, not a tradable comparator.`);
  }
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.errors)) errors[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return CompareMarketResult.parse({
    market: summarize(market),
    verdict: verdictSide(base, snap),
    comparators,
    optionsImplied: res.optionsImplied ?? null,
    dataStatus: { polymarket: res.dataStatus.polymarket ?? 'unavailable', kalshi: res.dataStatus.kalshi ?? 'unavailable' },
    errors,
    summary: `${market.displayName}: Verdict YES ${pct(base.yesMid)}. ${lines.join(' ')}`,
    lines,
    evidence: res.evidence,
    engine: engineInfo(res.route, res.generatedAt),
  });
}

export async function fairValue(client: InfoClient, catalog: Catalog, market: Market, opts: EngineOptions = {}): Promise<FairValueResult> {
  const snap = await buildSnapshot(client, catalog, [market]);
  const base = normalizedBase(snap, market.outcome);
  const summary = summarize(market);
  const generatedAt = new Date().toISOString();
  const unavailable = (reason: Extract<FairValueResult, { available: false }>['reason'], detail: string): FairValueResult =>
    FairValueResult.parse({ available: false, market: summary, reason, detail, engine: engineInfo(null, generatedAt) });
  if ((base.direction !== 'above' && base.direction !== 'below') || base.strike === null || !(base.strike > 0)) {
    return unavailable('not_price_market', 'Option-implied fair value needs a directional price binary (above or below a strike); this market has no strike or direction the engine recognises.');
  }
  const underlying = z.enum(['BTC', 'ETH', 'SOL']).safeParse(base.underlying);
  if (!underlying.success) return unavailable('unsupported_underlying', `Deribit lists options for BTC, ETH and SOL only; this market is on ${base.underlying ?? 'an unknown underlying'}.`);
  if (!base.expiry) return unavailable('missing_expiry', 'The market has no parseable expiry, so no options expiry can be matched.');
  let ref: Awaited<ReturnType<typeof deribitImpliedProb>>;
  try {
    ref = await deribitImpliedProb(base, deadline(opts));
  } catch (e) {
    return unavailable('upstream_unavailable', `Deribit request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ref || ref.prob === null) {
    return unavailable('no_options_chain_near_expiry', `Deribit has no ${underlying.data} option expiry within 3 days of ${base.expiry}, or no priced calls on the nearest chain.`);
  }
  const gap = base.yesMid === null ? null : base.yesMid - ref.prob;
  return FairValueResult.parse({
    available: true,
    market: summary,
    source: 'deribit',
    model: 'black_scholes_digital',
    underlying: underlying.data,
    direction: base.direction,
    strike: base.strike,
    expiry: base.expiry,
    marketProb: base.yesMid,
    impliedProb: ref.prob,
    gap,
    iv: ref.iv,
    strikeUsed: ref.strikeUsed,
    spot: ref.spot,
    optionsExpiryOffsetHours: ref.offsetHours,
    caveats: [
      'reference_only_not_tradable_comparator',
      'deribit_options_settle_0800_utc',
      `nearest_options_expiry_${ref.offsetHours >= 0 ? '+' : ''}${ref.offsetHours}h_from_market_settle`,
      ...(Math.abs(ref.strikeUsed - base.strike) / base.strike > 0.005 ? [`nearest_listed_strike_${Math.round(ref.strikeUsed)}_not_${Math.round(base.strike)}`] : []),
    ],
    evidence: `Options-implied reference (${underlying.data} options chain): P(${underlying.data} ${base.direction} $${Math.round(base.strike).toLocaleString()} at settle) = ${pct(ref.prob)} (iv ${ref.iv.toFixed(1)}%, nearest options expiry ${ref.offsetHours >= 0 ? '+' : ''}${ref.offsetHours}h vs market settle${base.yesMid !== null ? `; market YES ${pct(base.yesMid)}` : ''}). Derivatives reference only, not a tradable comparator.`,
    engine: engineInfo(null, generatedAt),
  });
}

export async function findHedges(client: InfoClient, catalog: Catalog, market: Market, opts: EngineOptions = {}): Promise<FindHedgesResult> {
  const snap = await buildSnapshot(client, catalog, [market], { coinMids: true });
  const base = normalizedBase(snap, market.outcome);
  const candidates = findHedgeCandidates(base, snap).map((c) => HedgeCandidateResult.parse(c));
  const raw = await runResearch({ query: base.title, mode: 'hedgeability', snap, activeMarketId: base.id, deadlineAt: deadline(opts) });
  const res = ResearchResult.parse(raw);
  const card = res.cards.map((c) => StrategyCard.safeParse(c)).flatMap((p) => (p.success ? [p.data] : []))[0];
  const hedge = card?.hedgeLegs[0];
  const flip = (d: 'short' | 'long' | 'none'): 'short' | 'long' | 'none' => (d === 'short' ? 'long' : d === 'long' ? 'short' : 'none');
  return FindHedgesResult.parse({
    market: summarize(market),
    underlying: base.underlying,
    hedgeable: candidates.some((c) => c.available),
    candidates,
    leg: hedge
      ? { symbol: hedge.symbol, kind: hedge.kind, directionForYes: hedge.direction, directionForNo: flip(hedge.direction), mid: hedge.mid, rationale: hedge.rationale, limitations: hedge.limitations }
      : null,
    note: 'A Hyperliquid perp or spot hedge offsets the underlying price move only; the outcome token still settles on its own rule and can go to zero.',
    engine: engineInfo(res.route, res.generatedAt),
  });
}

export async function opportunities(client: InfoClient, catalog: Catalog, venue: string | null, limit: number, opts: EngineOptions = {}): Promise<OpportunitiesResult> {
  const now = Date.now();
  const markets = marketsFromCatalog(catalog, venue ? { venue } : {}).filter((m) => !isExpired(m, now));
  const snap = await buildSnapshot(client, catalog, markets, { coinMids: true, onBookError: 'skip', maxBooks: opts.maxBooks ?? OPPORTUNITIES_DEFAULT_BOOKS });
  const raw = await runOpportunity({ query: '', snap, deadlineAt: deadline(opts) });
  const res = ResearchResult.parse(raw);
  const cards = res.cards.map((c) => StrategyCard.safeParse(c)).flatMap((p) => (p.success ? [p.data] : []));
  const bases = normalizeVerdictSnapshot(snap).map((m) => NormalizedBase.parse(m));
  const byOutcome = new Map(markets.map((m) => [m.outcome, m] as const));
  const items = cards.slice(0, limit).map((card, i) => {
    const leg = card.marketLegs[0];
    const outcome = num(leg?.rawId);
    const m = outcome !== null ? byOutcome.get(outcome) : undefined;
    if (!leg || outcome === null || !m) throw new Error(`engine card ${card.id} does not map to a scanned market`);
    const snapOutcome = snap.outcomes.find((o) => o.outcome === outcome);
    const why = card.evidence.find((e) => e.startsWith('Why this ranks: '));
    const cross = card.evidence.find((e) => e.startsWith('Cross-venue: '));
    const hedge = card.hedgeLegs[0];
    return {
      rank: i + 1,
      outcome,
      venue: m.venue,
      displayName: m.displayName,
      expiresAt: m.expiresAt,
      yesMid: leg.mid,
      spread: leg.spread,
      depthUsd: leg.depthUsd,
      volumeUsd: leg.volumeUsd,
      priceSource: snapOutcome?.midSource ?? null,
      why: why ? why.slice('Why this ranks: '.length) : null,
      tradeCall: card.tradeCall,
      actionState: card.actionState,
      crossVenue: cross ? cross.slice('Cross-venue: '.length) : null,
      hedge: hedge && hedge.direction !== 'none' ? { symbol: hedge.symbol, kind: hedge.kind, directionForYes: hedge.direction } : null,
    };
  });
  const comparators = res.externalMarkets.flatMap((ref) => {
    if (!isVenue(ref.venue)) return [];
    const base = bases.find((b) => b.title === ref.matchedBaseTitle);
    return [comparatorFromReference(ref, ref.venue, base?.yesMid ?? null)];
  });
  return OpportunitiesResult.parse({
    network: client.config.network,
    venue,
    scanned: markets.length,
    booksFetched: snap.booksFetched,
    count: items.length,
    limit,
    engineMax: OPPORTUNITIES_ENGINE_MAX,
    items,
    comparators,
    dataStatus: { polymarket: res.dataStatus.polymarket ?? 'unavailable', kalshi: res.dataStatus.kalshi ?? 'unavailable' },
    bookErrors: snap.bookErrors,
    summary: res.summary,
    evidence: res.evidence,
    engine: engineInfo(res.route, res.generatedAt),
  });
}
