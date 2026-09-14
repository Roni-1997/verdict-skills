// compare_market, fair_value, find_hedges and opportunities: thin, typed calls into the Verdict
// app's cross-venue engine (packages/engine, pinned; see UPSTREAM.json). The engine fetches
// Polymarket, Kalshi and Deribit itself; this module builds its snapshot from Hyperliquid, runs
// the engine under a validating fetch (venues.ts) so every venue body is Zod-checked before the
// engine reads it, and validates what comes back with Zod so callers get typed results and every
// low-confidence match carries a caveat instead of a bare number. Read only; no account, no LLM.
import {
  ENGINE_UPSTREAM,
  deribitImpliedProb,
  findHedgeCandidates,
  fmtCents,
  fmtUsd,
  normalizeVerdictSnapshot,
  runOpportunity,
  runResearch,
  scoreResolutionEquivalence,
} from '@verdict/engine';
import { z } from 'zod';
import type { InfoClient } from './hl/client.js';
import { type Catalog, type Market, marketsFromCatalog } from './markets.js';
import { buildSnapshot, type EngineSnapshot, UnpricedReason, restrictSnapshot, withoutUnpricedBooks } from './snapshot.js';
import { MarketSummary, summarize } from './summary.js';
import { withValidatedVenueFetch } from './venues.js';

export interface EngineOptions {
  /** Budget for the engine's venue fetches (Polymarket, Kalshi, Deribit). Default 20 s. */
  readonly timeoutMs?: number;
  /** opportunities: read books for this many of the venue's most-traded live markets; the rest price off asset contexts. Default 40. */
  readonly maxBooks?: number;
}

const Prob = z.number().finite();
const Confidence = z.enum(['low', 'medium', 'high']);
const RawRecord = z.record(z.string(), z.unknown());

// Caveat tags the kit adds next to the engine's own (Comparator.caveats).
/** Prefix of the tag set when Verdict has no tradable price; the suffix is the UnpricedReason. */
export const UNPRICED_TAG_PREFIX = 'verdict_unpriced_';
/** Set when the Verdict price is Hyperliquid's mark on a wide or one-sided book, not a two-sided book mid. */
export const HL_MARK_TAG = 'verdict_price_is_hl_mark';
/** The engine's own tag on a maturity-adjusted card whose edge changes sign under a +/-20% vol stress. */
export const VOL_FLIP_TAG = 'edge_flips_under_vol_stress';
const HL_MARK_NOTE = 'Verdict price is the HL mark; no two-sided book';

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
    /** Resolution equivalence of the pair; the engine hardcodes 'medium' on every model-based card. */
    equivalenceConfidence: Confidence,
    /** The engine's confidence in the edge itself: 'low' when the gap sits inside its model band or flips under vol stress. */
    confidence: Confidence,
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

/**
 * The engine's Deribit reference. Its marketProb is normalizeProbability(base), which averages a wall-only book to
 * the 0.5 phantom; the tools replace it with the kit's Verdict price (kitOptionsImplied) before returning it.
 */
const OptionsImplied = z.object({ prob: Prob.nullable(), iv: z.number(), strikeUsed: z.number(), spot: z.number(), offsetHours: z.number(), marketProb: Prob.nullable(), baseTitle: z.string().optional() }).passthrough();
type OptionsImplied = z.infer<typeof OptionsImplied>;

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
type ResearchResult = z.infer<typeof ResearchResult>;

/** The engine's normalized view of a Verdict market (normalizeVerdictOutcome), the fields the tools read. */
const NormalizedBase = z
  .object({
    id: z.string(),
    rawId: z.number().int(),
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
    /** The engine's resolution-equivalence confidence: whether the two contracts settle the same question. */
    confidence: Confidence,
    /**
     * The engine's confidence in the edge itself, from its card; null for a reference comparator. 'low' means the gap
     * sits inside the model band or flips sign under a +/-20% vol stress: no edge, so spreadAdjustedGap is null.
     */
    edgeConfidence: Confidence.nullable(),
    /** The engine's resolution-equivalence reasons (scoreResolutionEquivalence) for the comparator market. */
    reasons: z.array(z.string()).min(1),
    /** The engine's card caveats plus the kit's tags (strike_offset_*, verdict_unpriced_*, verdict_price_is_hl_mark). */
    caveats: z.array(z.string()),
    /** Always set when confidence is low, when Verdict has no tradable price, or when the engine rates the edge low; says what is not reported and why. */
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
    /** Verdict YES minus comparator YES, only when the engine deems the pair comparable and Verdict has a price; null otherwise. */
    gap: z.number().nullable(),
    /** Gap net of both spreads (and the model band for model-based methods), where the engine provides it and rates the edge above low. */
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
    if (c.caveats.some((t) => t.startsWith(UNPRICED_TAG_PREFIX)) && (c.caveat === null || c.gap !== null || c.spreadAdjustedGap !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a comparator against an unpriced Verdict market must carry a caveat and no price gap' });
    }
    if ((c.edgeConfidence === 'low' || c.caveats.includes(VOL_FLIP_TAG)) && (c.caveat === null || c.spreadAdjustedGap !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a low-confidence or vol-fragile edge must carry a caveat and no after-spreads gap' });
    }
  });
export type Comparator = z.infer<typeof Comparator>;

/** The Verdict price the kit reports and compares against; the snapshot decides whether a price exists (see verdictPrice). */
export const VerdictPrice = z.object({
  /** YES probability; null when Verdict has no tradable price (see unpriced), never Hyperliquid's placeholder. */
  yesMid: Prob.nullable(),
  /** 'book': robust mid of a book the kit read. 'ctx': Hyperliquid's markPx (the coin traded today; the book is wide, one-sided or unread); not an executable price. */
  priceSource: z.enum(['book', 'ctx']).nullable(),
  /**
   * Why yesMid is null: the coin has no trades in the last 24h (never traded, or traded on an earlier day) and no real
   * quote on a book the kit read; its context holds only the 0.5 placeholder or a stale mark, neither a price.
   */
  unpriced: UnpricedReason.nullable(),
});
export type VerdictPrice = z.infer<typeof VerdictPrice>;

export const VerdictSide = VerdictPrice.extend({
  title: z.string(),
  yesBid: Prob.nullable(),
  yesAsk: Prob.nullable(),
  spread: Prob.nullable(),
  depthUsd: z.number().nullable(),
  volumeUsd: z.number().nullable(),
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

export const OpportunityItem = z
  .object({
    rank: z.number().int().positive(),
    outcome: z.number().int().nonnegative(),
    venue: z.string(),
    displayName: z.string(),
    expiresAt: z.string().nullable(),
    /**
     * false when Verdict has no tradable price for the market (see unpriced): the row is carried for completeness,
     * ranks after every priced market, and nothing in it is a probability.
     */
    priced: z.boolean(),
    /** YES probability from the kit's snapshot; null when unpriced, never Hyperliquid's placeholder or a wall-book average. */
    yesMid: Prob.nullable(),
    /** Top-of-book YES spread and depth; null when unpriced (a wall-only book is not interest). */
    spread: Prob.nullable(),
    depthUsd: z.number().nullable(),
    volumeUsd: z.number().nullable(),
    priceSource: z.enum(['book', 'ctx']).nullable(),
    /** Why yesMid is null (VerdictPrice.unpriced); null when priced. */
    unpriced: UnpricedReason.nullable(),
    /** Kit-built ranking reason from the snapshot's own price, spread and depth; for an unpriced market it starts with "unpriced". */
    why: z.string(),
    tradeCall: TradeCall,
    actionState: z.string(),
    /** The engine's cross-venue edge line, only for a priced market with a high-confidence tradable twin; always null when unpriced. */
    crossVenue: z.string().nullable(),
    hedge: z.object({ symbol: z.string(), kind: z.string(), directionForYes: z.enum(['short', 'long', 'none']) }).nullable(),
  })
  .superRefine((item, ctx) => {
    if (item.priced !== (item.yesMid !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'priced must agree with yesMid' });
    if (item.priced && item.unpriced !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a priced item carries no unpriced reason' });
    if (!item.priced && (item.priceSource !== null || item.unpriced === null || item.crossVenue !== null || item.spread !== null || item.depthUsd !== null || !item.why.startsWith('unpriced'))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an unpriced item must carry its reason, an "unpriced" why, and no price source, spread, depth or cross-venue line' });
    }
  });
export type OpportunityItem = z.infer<typeof OpportunityItem>;

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
  /** How many of items are unpriced (priced: false); they always come last. */
  unpricedCount: z.number().int().nonnegative(),
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

/**
 * What the engine is handed for a scan: every priced market, and only as many unpriced ones as its selection has
 * slots left (`slots` is its per-scan maximum). The engine's selectOpportunityMarkets scores a bookless, unpriced
 * market at a flat floor, but a thin priced market far outside its 5-95% band scores lower still, so over the whole
 * snapshot it can drop a priced market for an unpriced one before the kit sees a card for either. Capping the unpriced
 * input at the free slots is what makes "an unpriced market ranks after every priced market" hold at the selection
 * stage, not only in the kit's reordering of the engine's output. Unpriced fill is taken by 24h notional then snapshot
 * order, the engine's own tie order for markets it cannot price. Books of unpriced markets are already blanked.
 */
export function opportunitiesEngineInput(snap: EngineSnapshot, slots: number): EngineSnapshot {
  const volume = (o: EngineSnapshot['outcomes'][number]) => Number(snap.assetCtxByCoin[o.yesCoin]?.dayNtlVlm ?? 0) + Number(snap.assetCtxByCoin[o.noCoin]?.dayNtlVlm ?? 0);
  const priced = snap.outcomes.filter((o) => o.mid !== null);
  const unpriced = snap.outcomes
    .filter((o) => o.mid === null)
    .sort((a, b) => volume(b) - volume(a))
    .slice(0, Math.max(0, slots - priced.length));
  return restrictSnapshot(snap, new Set([...priced, ...unpriced].map((o) => o.outcome)));
}

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

const UNPRICED_NOTE: Record<UnpricedReason, string> = {
  never_traded_wall_book: 'never traded, wall-only book',
  never_traded_no_book: 'never traded, book not read',
  stale_wall_book: 'no trades in 24h, wall-only book',
  stale_no_book: 'no trades in 24h, book not read',
  no_price_data: 'no book mid and no mark',
};
/** Why Verdict has no price to compare against, or null when it has one. */
function unpricedNote(vp: VerdictPrice): string | null {
  if (vp.yesMid !== null) return null;
  return vp.unpriced === null ? 'no Verdict price in this scan' : UNPRICED_NOTE[vp.unpriced];
}
function unpricedCaveat(note: string): string {
  return `Verdict has no tradable price (${note}); no gap is reported. The comparator's price at the Verdict contract is shown for reference.`;
}
function markCaveat(): string {
  return `${HL_MARK_NOTE}: the gap is measured against Hyperliquid's mark, not against a price that can be traded on Verdict.`;
}
function unpricedTag(vp: VerdictPrice): string {
  return `${UNPRICED_TAG_PREFIX}${vp.unpriced ?? 'no_price_data'}`;
}

/**
 * The engine's verdict on the edge itself, read from its card rather than from the resolution-equivalence confidence
 * it hardcodes to 'medium' on model-based cards: an edge that flips sign under a +/-20% vol stress, or one the card
 * rates low, is no edge, so the after-spreads gap is not reported.
 */
function edgeNote(card: MispricingCard, method: Comparator['method']): string | null {
  if (card.caveats.includes(VOL_FLIP_TAG)) return 'Model edge flips sign under a +/-20% vol stress; the engine treats this as no edge, so no after-spreads gap is reported.';
  if (card.confidence !== 'low') return null;
  const why =
    method === 'ladder_interpolation'
      ? 'the gap sits inside the ladder-interpolation band'
      : method === 'maturity_adjusted_digital'
        ? 'the gap does not clear the spreads and the model band'
        : 'the match is not exact enough to trade';
  return `The engine rates this edge low-confidence (${why}) and treats it as no edge, so no after-spreads gap is reported.`;
}

function comparatorLine(venue: 'polymarket' | 'kalshi', c: Omit<Comparator, 'line'>, vp: VerdictPrice): string {
  const label = venueLabel(venue);
  const eq = `${c.confidence} confidence: ${c.reasons.join(', ')}`;
  if (c.confidence === 'low') return `${label}: low-confidence match (${c.reasons.join(', ')}); no comparable price gap. Closest market: "${c.title}".`;
  const missing = unpricedNote(vp);
  if (missing !== null) {
    const tail = ` Verdict has no tradable price (${missing}); comparator shown for reference.`;
    if (c.method === 'reference') return `${label}: reference "${c.title}" at ${pct(c.fairProb)} (${eq}).${tail}`;
    return `${label}: ${pct(c.fairProb)} at the Verdict contract (${eq}; ${c.method}).${tail}`;
  }
  if (c.gap !== null) {
    const mark = vp.priceSource === 'ctx' ? ` (${HL_MARK_NOTE})` : '';
    const after =
      c.spreadAdjustedGap !== null
        ? `, ${pp(c.spreadAdjustedGap)} after spreads`
        : c.method === 'reference'
          ? ''
          : `, no edge after spreads (${c.caveats.includes(VOL_FLIP_TAG) ? 'flips under vol stress' : 'the engine rates the edge low-confidence'})`;
    return `${label}: ${pct(c.fairProb)} vs Verdict ${pct(vp.yesMid)}${mark}, gap ${pp(c.gap)}${after} (${eq}; ${c.method}).`;
  }
  return `${label}: reference "${c.title}" at ${pct(c.fairProb)} (${eq})${c.caveat ? `. ${c.caveat}` : '.'}`;
}

function legOf(m: Record<string, unknown>): z.infer<typeof ComparatorLeg> {
  return { id: str(m.id) ?? String(m.rawId ?? ''), title: str(m.title) ?? '', url: str(m.url), yesMid: num(m.yesMid), strike: num(m.strike), expiry: str(m.expiry) };
}

function joinNotes(notes: readonly (string | null)[]): string | null {
  const kept = notes.filter((n): n is string => n !== null);
  return kept.length ? kept.join(' ') : null;
}

function comparatorFromCard(card: MispricingCard, venue: 'polymarket' | 'kalshi', vp: VerdictPrice): Comparator {
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
  const missing = unpricedNote(vp);
  const edge = edgeNote(card, method);
  const fromMark = vp.priceSource === 'ctx';
  const offset = method === 'exact_twin' ? strikeOffsetCaveat(baseStrike, num(primary.strike), str(card.baseMarket.expiry), Date.now()) : { tag: null, note: null };
  const methodNote = method !== 'exact_twin' ? `Model-based comparator (${method}): a relative-value read, not a locked arbitrage; it carries vol and settlement risk.` : offset.note;
  const caveat = low ? lowCaveat(reasons, mismatchNote) : joinNotes([missing !== null ? unpricedCaveat(missing) : edge, fromMark ? markCaveat() : null, methodNote]);
  const caveats = [...card.caveats];
  if (offset.tag) caveats.push(offset.tag);
  if (missing !== null) caveats.push(unpricedTag(vp));
  if (fromMark) caveats.push(HL_MARK_TAG);
  const body: Omit<Comparator, 'line'> = {
    venue,
    method,
    confidence,
    edgeConfidence: card.confidence,
    reasons,
    caveats,
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
    gap: low || missing !== null ? null : card.normalizedDelta,
    spreadAdjustedGap: low || missing !== null || edge !== null ? null : card.adjustedDelta,
    expiryAdjusted: card.maturityAdjusted
      ? { rawProb: card.maturityAdjusted.rawPrice, adjustedProb: card.maturityAdjusted.adjustedPrice, shift: card.maturityAdjusted.shift, offsetHours: card.maturityAdjusted.offsetHours, iv: card.maturityAdjusted.iv, spot: card.maturityAdjusted.spot, compExpiry: card.maturityAdjusted.compExpiry }
      : null,
    mismatchNote,
    tradeCall: card.tradeCall ?? null,
    legs: comps.map(legOf),
  };
  return Comparator.parse({ ...body, line: comparatorLine(venue, body, vp) });
}

/** A Comparator from one of the engine's mispricing cards, validated first. Exported so the edge and price rules can be tested on constructed cards. */
export function comparatorFromEngineCard(card: unknown, venue: 'polymarket' | 'kalshi', verdict: VerdictPrice): Comparator {
  return comparatorFromCard(MispricingCard.parse(card), venue, VerdictPrice.parse(verdict));
}

function comparatorFromReference(ref: ExternalRef, venue: 'polymarket' | 'kalshi', vp: VerdictPrice): Comparator {
  const hint = Confidence.safeParse(ref.equivalenceHint);
  const confidence = hint.success ? hint.data : 'low';
  const reasons = ref.equivalenceReasons.length ? ref.equivalenceReasons : ['unscored'];
  const low = confidence === 'low';
  const missing = unpricedNote(vp);
  const fromMark = vp.priceSource === 'ctx';
  const referenceNote = confidence === 'medium' ? `Reference only${ref.mismatchNote ? ` (${ref.mismatchNote})` : ''}: the closest listed market, not the same contract; its price is context, not a comparable gap.` : null;
  const caveat = low ? lowCaveat(reasons, ref.mismatchNote) : joinNotes([missing !== null ? unpricedCaveat(missing) : null, fromMark ? markCaveat() : null, referenceNote]);
  const caveats = ref.mismatchNote ? ['reference_not_tradable_twin', ref.mismatchNote] : ['reference_not_tradable_twin'];
  if (missing !== null) caveats.push(unpricedTag(vp));
  if (fromMark) caveats.push(HL_MARK_TAG);
  const body: Omit<Comparator, 'line'> = {
    venue,
    method: 'reference',
    confidence,
    edgeConfidence: null,
    reasons,
    caveats,
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
    gap: low || missing !== null ? null : ref.normalizedDelta,
    spreadAdjustedGap: null,
    expiryAdjusted: null,
    mismatchNote: ref.mismatchNote,
    tradeCall: null,
    legs: [legOf(ref as Record<string, unknown>)],
  };
  return Comparator.parse({ ...body, line: comparatorLine(venue, body, vp) });
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

function bestComparator(venue: 'polymarket' | 'kalshi', cards: readonly MispricingCard[], refs: readonly ExternalRef[], vp: VerdictPrice): Comparator | null {
  const card = cards.find((c) => c.comps[0]?.venue === venue);
  if (card) return comparatorFromCard(card, venue, vp);
  const ref = refs.find((r) => r.venue === venue);
  return ref ? comparatorFromReference(ref, venue, vp) : null;
}

function normalizedBase(snap: EngineSnapshot, outcome: number): NormalizedBase {
  const found = normalizeVerdictSnapshot(snap).find((m) => m.rawId === outcome);
  if (!found) throw new Error(`engine did not normalize outcome ${outcome}`);
  return NormalizedBase.parse(found);
}

const NO_VERDICT_PRICE: VerdictPrice = { yesMid: null, priceSource: null, unpriced: null };

/**
 * The snapshot decides whether Verdict has a price. The engine's normalizeVerdictOutcome averages the top of book
 * when the snapshot carries no mid, which on a never-traded wall book (0.00001 / 0.99999) prints the same phantom
 * 0.5 as Hyperliquid's placeholder; its yesMid is therefore only trusted when the snapshot priced the market.
 */
function verdictPrice(base: NormalizedBase, snap: EngineSnapshot): VerdictPrice {
  const o = snap.outcomes.find((x) => x.outcome === base.rawId);
  if (!o) return NO_VERDICT_PRICE;
  if (o.mid === null) return { yesMid: null, priceSource: null, unpriced: o.unpriced ?? 'no_price_data' };
  return { yesMid: base.yesMid, priceSource: o.midSource, unpriced: null };
}

const OPTIONS_EVIDENCE_PREFIX = 'Options-implied reference';
/** The engine's evidence line that counts the markets it was handed; opportunities restates it with the kit's scan count. */
const SCANNED_EVIDENCE_PREFIX = 'Verdict/HL markets scanned: ';

/** The options-implied evidence line, with the kit's Verdict price (or its absence) in place of the engine's. */
function optionsEvidence(underlying: string, direction: string, strike: number, ref: { prob: number; iv: number; offsetHours: number }, vp: VerdictPrice): string {
  const market = vp.yesMid !== null ? `; market YES ${pct(vp.yesMid)}${vp.priceSource === 'ctx' ? ` (${HL_MARK_NOTE})` : ''}` : `; Verdict has no tradable price (${unpricedNote(vp) ?? ''})`;
  return `${OPTIONS_EVIDENCE_PREFIX} (${underlying} options chain): P(${underlying} ${direction} $${Math.round(strike).toLocaleString()} at settle) = ${pct(ref.prob)} (iv ${ref.iv.toFixed(1)}%, nearest options expiry ${ref.offsetHours >= 0 ? '+' : ''}${ref.offsetHours}h vs market settle${market}). Derivatives reference only, not a tradable comparator.`;
}

/**
 * The engine's optionsImplied and evidence line carry normalizeProbability(base) as the market probability, which
 * averages a wall-only book to the 0.5 phantom. Replace marketProb with the kit's Verdict price and rebuild the
 * evidence line from it (or drop the line when the base the engine used is not known).
 */
function kitOptionsImplied(res: ResearchResult, base: NormalizedBase | undefined, vp: VerdictPrice): { optionsImplied: OptionsImplied | null; evidence: string[] } {
  const evidence = res.evidence.filter((e) => !e.startsWith(OPTIONS_EVIDENCE_PREFIX));
  const oi = res.optionsImplied;
  if (!oi) return { optionsImplied: null, evidence };
  if (oi.prob !== null && base && base.underlying !== null && base.direction !== null && base.strike !== null) {
    evidence.push(optionsEvidence(base.underlying, base.direction, base.strike, { prob: oi.prob, iv: oi.iv, offsetHours: oi.offsetHours }, vp));
  }
  return { optionsImplied: { ...oi, marketProb: vp.yesMid }, evidence };
}

function verdictSide(base: NormalizedBase, snap: EngineSnapshot): z.infer<typeof VerdictSide> {
  return {
    ...verdictPrice(base, snap),
    title: base.title,
    yesBid: base.yesBid,
    yesAsk: base.yesAsk,
    spread: base.spread,
    depthUsd: base.depthUsd,
    volumeUsd: base.volumeUsd,
    underlying: base.underlying,
    direction: base.direction,
    strike: base.strike,
    expiry: base.expiry,
  };
}

function isExpired(m: Market, now: number): boolean {
  return m.expiresAt !== null && Date.parse(m.expiresAt) <= now;
}

/** The fields of a normalized Verdict base that tie the engine's title-keyed references back to an outcome. */
export interface BaseRef {
  readonly rawId: number;
  readonly title: string;
  readonly expiry: string | null;
  readonly underlying: string | null;
  readonly direction: 'above' | 'below' | 'range' | null;
  readonly strike: number | null;
}

function expiryDeltaDays(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  const aa = Date.parse(a);
  const bb = Date.parse(b);
  return Number.isFinite(aa) && Number.isFinite(bb) ? Math.abs(aa - bb) / 86_400_000 : null;
}

/**
 * The engine names the Verdict base behind each cross-venue reference by title only (matchedBaseTitle), and titles
 * collide: its outcomeTitle omits the expiry, so every same-strike daily ("BTC closes above $77,250" on Sep 14, 16 and
 * 18) shares one. Resolve to an outcome instead. Among the markets the engine ranked (in its order) that carry the
 * title, the one it matched is the one its referenceRelevance scored highest; with equal titles, hence equal strikes,
 * that score differs only by the expiry term, min(0.4, days * 0.02), and a tie keeps the first ranked. Null when no
 * ranked market carries the title.
 */
export function resolveMatchedBase<B extends BaseRef>(ref: { readonly matchedBaseTitle: string | null; readonly expiry: string | null }, ranked: readonly B[]): B | null {
  if (ref.matchedBaseTitle === null) return null;
  let best: B | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (const base of ranked) {
    if (base.title !== ref.matchedBaseTitle) continue;
    const penalty = Math.min(0.4, (expiryDeltaDays(base.expiry, ref.expiry) ?? 0) * 0.02);
    if (best === null || penalty < bestPenalty) {
      best = base;
      bestPenalty = penalty;
    }
  }
  return best;
}

const OPTIONS_UNDERLYINGS = new Set(['BTC', 'ETH', 'SOL']);

/**
 * The market the engine priced its Deribit reference off: the first ranked market that is a BTC, ETH or SOL directional
 * strike market with an expiry (appendDeribitEvidence walks the ranked list in order). The engine reports that market
 * by title only; the choice is checked against it, and a disagreement is an error, never a silent guess.
 */
export function resolveOptionsBase<B extends BaseRef>(ranked: readonly B[], baseTitle: string | undefined): B | null {
  const base = ranked.find((b) => b.underlying !== null && OPTIONS_UNDERLYINGS.has(b.underlying) && b.strike !== null && b.expiry !== null && (b.direction === 'above' || b.direction === 'below')) ?? null;
  if (baseTitle !== undefined && base === null) throw new Error(`engine priced its Deribit reference off "${baseTitle}", but no ranked market is eligible`);
  if (baseTitle !== undefined && base !== null && base.title !== baseTitle) throw new Error(`engine priced its Deribit reference off "${baseTitle}", but the first eligible ranked market is "${base.title}"`);
  return base;
}

/** The ranking reason for an opportunities row, from the kit's own price and the engine's spread and depth; never a phantom probability. */
function opportunityWhy(vp: VerdictPrice, spread: number | null, depthUsd: number | null): string {
  if (vp.yesMid === null) return `unpriced (${unpricedNote(vp) ?? 'no Verdict price in this scan'}); no Verdict price, spread or depth to rank on`;
  const bits: string[] = [];
  if (spread !== null) bits.push(`${fmtCents(spread)} spread`);
  if (depthUsd !== null) bits.push(`${fmtUsd(depthUsd)} depth`);
  bits.push(`YES ${fmtCents(vp.yesMid)}${vp.priceSource === 'ctx' ? ` (${HL_MARK_NOTE})` : ''}`);
  return bits.join(', ');
}

const CROSS_VENUE_PREFIX = 'Cross-venue: ';

// Tools.
export async function compareMarket(client: InfoClient, catalog: Catalog, market: Market, opts: EngineOptions = {}): Promise<CompareMarketResult> {
  const snap = await buildSnapshot(client, catalog, [market]);
  const base = normalizedBase(snap, market.outcome);
  const query = [base.title, base.underlying].filter((x): x is string => typeof x === 'string' && x !== '').join(' ');
  const raw = await withValidatedVenueFetch(() => runResearch({ query, mode: 'cross_venue_scanner', snap, activeMarketId: base.id, deadlineAt: deadline(opts) }));
  const res = ResearchResult.parse(raw);
  const cards = mispricingCards(res.cards);
  const vp = verdictPrice(base, snap);
  const options = kitOptionsImplied(res, base, vp);
  const comparators = {
    polymarket: bestComparator('polymarket', cards, res.externalMarkets, vp),
    kalshi: bestComparator('kalshi', cards, res.externalMarkets, vp),
  };
  const lines = [
    comparators.polymarket?.line ?? 'Polymarket: no comparable market found.',
    comparators.kalshi?.line ?? 'Kalshi: no comparable market found.',
  ];
  if (options.optionsImplied) {
    const oi = options.optionsImplied;
    lines.push(`Deribit options-implied: ${pct(oi.prob)} (iv ${oi.iv.toFixed(1)}%, nearest expiry ${oi.offsetHours >= 0 ? '+' : ''}${oi.offsetHours}h from settle); reference only, not a tradable comparator.`);
  }
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.errors)) errors[k] = typeof v === 'string' ? v : JSON.stringify(v);
  const missing = unpricedNote(vp);
  const head = missing !== null ? `Verdict has no tradable price (${missing})` : `Verdict YES ${pct(vp.yesMid)}${vp.priceSource === 'ctx' ? ` (${HL_MARK_NOTE})` : ''}`;
  return CompareMarketResult.parse({
    market: summarize(market),
    verdict: verdictSide(base, snap),
    comparators,
    optionsImplied: options.optionsImplied,
    dataStatus: { polymarket: res.dataStatus.polymarket ?? 'unavailable', kalshi: res.dataStatus.kalshi ?? 'unavailable' },
    errors,
    summary: `${market.displayName}: ${head}. ${lines.join(' ')}`,
    lines,
    evidence: options.evidence,
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
    ref = await withValidatedVenueFetch(() => deribitImpliedProb(base, deadline(opts)));
  } catch (e) {
    return unavailable('upstream_unavailable', `Deribit request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ref || ref.prob === null) {
    return unavailable('no_options_chain_near_expiry', `Deribit has no ${underlying.data} option expiry within 3 days of ${base.expiry}, or no priced calls on the nearest chain.`);
  }
  const vp = verdictPrice(base, snap);
  const gap = vp.yesMid === null ? null : vp.yesMid - ref.prob;
  return FairValueResult.parse({
    available: true,
    market: summary,
    source: 'deribit',
    model: 'black_scholes_digital',
    underlying: underlying.data,
    direction: base.direction,
    strike: base.strike,
    expiry: base.expiry,
    marketProb: vp.yesMid,
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
      ...(vp.yesMid === null ? [unpricedTag(vp)] : vp.priceSource === 'ctx' ? [HL_MARK_TAG] : []),
    ],
    evidence: optionsEvidence(underlying.data, base.direction, base.strike, { prob: ref.prob, iv: ref.iv, offsetHours: ref.offsetHours }, vp),
    engine: engineInfo(null, generatedAt),
  });
}

export async function findHedges(client: InfoClient, catalog: Catalog, market: Market, opts: EngineOptions = {}): Promise<FindHedgesResult> {
  const snap = await buildSnapshot(client, catalog, [market], { coinMids: true });
  const base = normalizedBase(snap, market.outcome);
  const candidates = findHedgeCandidates(base, snap).map((c) => HedgeCandidateResult.parse(c));
  const raw = await withValidatedVenueFetch(() => runResearch({ query: base.title, mode: 'hedgeability', snap, activeMarketId: base.id, deadlineAt: deadline(opts) }));
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
  // The engine averages any top of book it is given when the mid is null, so it never sees the book of an unpriced
  // market: with neither a book nor a mid it scores the market at its floor and prints no probability for it. And it
  // is handed no more unpriced markets than it has slots left after the priced ones (opportunitiesEngineInput), so
  // its selection can never drop a priced market for an unpriced one.
  const engineSnap = opportunitiesEngineInput(withoutUnpricedBooks(snap), OPPORTUNITIES_ENGINE_MAX);
  const raw = await withValidatedVenueFetch(() => runOpportunity({ query: '', snap: engineSnap, deadlineAt: deadline(opts) }));
  const res = ResearchResult.parse(raw);
  const cards = res.cards.map((c) => StrategyCard.safeParse(c)).flatMap((p) => (p.success ? [p.data] : []));
  const baseById = new Map(normalizeVerdictSnapshot(engineSnap).map((m) => NormalizedBase.parse(m)).map((b) => [b.rawId, b] as const));
  const byOutcome = new Map(markets.map((m) => [m.outcome, m] as const));
  // One card per market the engine ranked, in its order (runOpportunity builds the cards from its selection one to
  // one); the card's leg carries the outcome id, and everything below is tied to a market through it, never a title.
  const ranked = cards.map((card) => {
    const leg = card.marketLegs[0];
    const outcome = num(leg?.rawId);
    const base = outcome !== null ? baseById.get(outcome) : undefined;
    const market = outcome !== null ? byOutcome.get(outcome) : undefined;
    if (!leg || !base || !market) throw new Error(`engine card ${card.id} does not map to a scanned market`);
    return { card, leg, base, market, vp: verdictPrice(base, snap) };
  });
  const bases = ranked.map((r) => r.base);
  const optionsBase = res.optionsImplied ? resolveOptionsBase(bases, res.optionsImplied.baseTitle) : null;
  const options = kitOptionsImplied(res, optionsBase ?? undefined, optionsBase ? verdictPrice(optionsBase, snap) : NO_VERDICT_PRICE);
  // Priced markets first, the engine's order within each group. The engine received every priced market, so together
  // with the input cap above this makes "an unpriced market ranks after every priced market" hold end to end: a thin
  // far-out-of-band priced market that the engine scored below the bookless floor still comes before every unpriced one.
  const ordered = [...ranked.filter((r) => r.vp.yesMid !== null), ...ranked.filter((r) => r.vp.yesMid === null)];
  const items = ordered.slice(0, limit).map((r, i) => {
    const priced = r.vp.yesMid !== null;
    const spread = priced ? r.leg.spread : null;
    const depthUsd = priced ? r.leg.depthUsd : null;
    const cross = priced ? r.card.evidence.find((e) => e.startsWith(CROSS_VENUE_PREFIX)) : undefined;
    const hedge = r.card.hedgeLegs[0];
    return {
      rank: i + 1,
      outcome: r.base.rawId,
      venue: r.market.venue,
      displayName: r.market.displayName,
      expiresAt: r.market.expiresAt,
      priced,
      yesMid: r.vp.yesMid,
      spread,
      depthUsd,
      volumeUsd: r.leg.volumeUsd,
      priceSource: r.vp.priceSource,
      unpriced: r.vp.unpriced,
      why: opportunityWhy(r.vp, spread, depthUsd),
      tradeCall: r.card.tradeCall,
      actionState: r.card.actionState,
      crossVenue: cross ? cross.slice(CROSS_VENUE_PREFIX.length) : null,
      hedge: hedge && hedge.direction !== 'none' ? { symbol: hedge.symbol, kind: hedge.kind, directionForYes: hedge.direction } : null,
    };
  });
  const comparators = res.externalMarkets.flatMap((ref) => {
    if (!isVenue(ref.venue)) return [];
    const base = resolveMatchedBase(ref, bases);
    return [comparatorFromReference(ref, ref.venue, base ? verdictPrice(base, snap) : NO_VERDICT_PRICE)];
  });
  const unpricedCount = items.filter((item) => !item.priced).length;
  // The engine's sentence and evidence count the markets it was handed; the scan's count is every live market the
  // snapshot was built for (`scanned`), so the two are restated with that number, in the engine's own words.
  // Restate the engine's own summary with the scan's count by substituting into its sentence; if a pin move
  // ever rewords that sentence, the engine's text passes through untouched instead of a stale hand copy.
  const SCANNED_SUMMARY = /^Scanned (\d+) live Verdict markets and ranked the (\d+) /;
  const engineSummary =
    ranked.length > 0 && SCANNED_SUMMARY.test(res.summary)
      ? res.summary.replace(SCANNED_SUMMARY, `Scanned ${markets.length} live Verdict markets and ranked the ${ranked.length} `)
      : res.summary;
  const summary =
    unpricedCount === 0
      ? engineSummary
      : `${engineSummary} ${unpricedCount} of the ${items.length} shown ${unpricedCount === 1 ? 'has' : 'have'} no Verdict price (unpriced) and ${unpricedCount === 1 ? 'ranks' : 'rank'} last.`;
  const evidence = options.evidence.map((e) => (e.startsWith(SCANNED_EVIDENCE_PREFIX) ? `${SCANNED_EVIDENCE_PREFIX}${markets.length}` : e));
  return OpportunitiesResult.parse({
    network: client.config.network,
    venue,
    scanned: markets.length,
    booksFetched: snap.booksFetched,
    count: items.length,
    limit,
    engineMax: OPPORTUNITIES_ENGINE_MAX,
    items,
    unpricedCount,
    comparators,
    dataStatus: { polymarket: res.dataStatus.polymarket ?? 'unavailable', kalshi: res.dataStatus.kalshi ?? 'unavailable' },
    bookErrors: snap.bookErrors,
    summary,
    evidence,
    engine: engineInfo(res.route, res.generatedAt),
  });
}
