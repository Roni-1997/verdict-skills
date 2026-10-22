import type { z } from 'zod';
import { orderbook as readBook, type Orderbook } from './book.js';
import { configFromEnv, type KitConfig } from './config.js';
import { InfoClient } from './hl/client.js';
import { createLighterTools, type LighterTools } from './lighter.js';
import { getMarket, type Market } from './markets.js';
import { toolsFromConfig } from './remote.js';
import { assessPair, paperPair, reconcilePair } from './strategy-analysis.js';
import { amount, PairedSnapshot, ReferenceSnapshot, SCALE, STRATEGY_INPUTS, StrategyDecimal, strategyInput, units } from './strategy-model.js';
import { ToolError, type Tools } from './tools.js';

export interface StrategyOptions {
  readonly config?: KitConfig;
  readonly hl?: Pick<Tools, 'get_market' | 'orderbook' | 'compare_market'>;
  readonly lighter?: Pick<LighterTools, 'list_markets' | 'orderbook'>;
  readonly now?: () => number;
}

function failure(error: unknown) {
  const rateLimited = error instanceof Error && /429/.test(error.message);
  if (error instanceof ToolError && error.code !== 'upstream') return { error: error.code, message: error.message, rateLimited };
  return { error: 'upstream' as const, message: rateLimited ? 'Venue rate limited this read; respect Retry-After before retrying.' : 'Venue read failed or did not match the supported schema.', rateLimited };
}
function source<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ToolError('Unsupported strategy source data or precision; no quote was manufactured', 'upstream');
  return result.data;
}
function epoch(value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value); return Number.isSafeInteger(t) && t >= 0 ? t : null;
}
function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !['the', 'will', 'and', 'or', 'on', 'at', 'to', 'of', 'in', 'by', 'up', 'down', 'yes', 'no'].includes(t)));
}
function signedUnits(value: string): bigint { return value.startsWith('-') ? -units(value.slice(1)) : units(value); }

export function createStrategyTools(options: StrategyOptions = {}) {
  const now = options.now ?? Date.now;
  const config = () => {
    try { return options.config ?? configFromEnv(); }
    catch { throw new ToolError('Invalid strategy configuration; check VERDICT_NETWORK, VERDICT_VENUE, VERDICT_API_URL and builder settings (values hidden)', 'not_configured'); }
  };
  const lighter = () => options.lighter ?? createLighterTools();
  const hlTools = () => options.hl ?? toolsFromConfig(config());

  async function hlMarket(outcome: number): Promise<Market> {
    if (options.hl || config().apiUrl) return hlTools().get_market({ outcome });
    const m = await getMarket(new InfoClient({ network: config().network }), outcome);
    if (!m) throw new ToolError('HL outcome not found on the selected network', 'not_found');
    return m;
  }
  async function captureHl(outcome: number) {
    const requestedAt = now(); const cfg = config(); const m = await hlMarket(outcome);
    const book: Orderbook = options.hl ? await options.hl.orderbook({ outcome }) : await readBook(new InfoClient({ network: cfg.network }), m);
    const receivedAt = now();
    if (m.outcome !== outcome || book.outcome !== outcome || book.sides[0].coin !== m.sides[0].coin || book.sides[1].coin !== m.sides[1].coin) throw new ToolError('HL returned mismatched market/book identities', 'upstream');
    for (const side of book.sides) {
      if (side.bestAsk !== null && side.bestBid !== null && side.bestAsk < side.bestBid) throw new ToolError('HL returned a crossed book; obtain a fresh snapshot', 'upstream');
    }
    const levels = (i: 0 | 1) => book.sides[i].asks.map((l) => ({ price: String(l.px), shares: String(l.sz) }));
    return source(PairedSnapshot.innerType().shape.hl, {
      network: cfg.network, outcome, title: m.displayName, rule: m.settlementRule, sideNames: [m.sides[0].name, m.sides[1].name],
      quoteToken: m.quoteToken, expiresAt: epoch(m.expiresAt), asks: { yes: levels(0), no: levels(1) },
      sourceAt: { yes: book.sides[0].time, no: book.sides[1].time }, clock: { requestedAt, receivedAt },
      knownBuilderBps: cfg.builder ? String(cfg.builder.feeTenthsBp / 10) : null,
    });
  }
  async function captureLighter(market: number, limit: number) {
    const requestedAt = now(); const b = await lighter().orderbook({ market, limit }); const receivedAt = now(); const m = b.market;
    if (m.market_id !== market || BigInt(m.settlement_cap) !== 10n ** BigInt(m.price_decimals)) throw new ToolError('Lighter market identity or unit payout mismatch', 'upstream');
    const yes = b.asks.map((l) => ({ price: l.price, shares: l.shares }));
    const no = b.bids.map((l) => ({ price: amount(SCALE - units(source(StrategyDecimal, l.price))), shares: l.shares }));
    return source(PairedSnapshot.innerType().shape.lighter, {
      network: m.network, market, creator: m.creator, title: m.title, rule: m.settlementRule,
      startsAt: m.start_timestamp, expiresAt: m.end_timestamp, active: m.status === 'active' && !m.is_frozen,
      asks: { yes, no }, clock: { requestedAt, receivedAt }, sourceAt: null, depthTruncated: b.truncated,
      sizeDecimals: m.size_decimals,
      takerFeePercent: m.is_taker_fee_enabled ? m.taker_fee : '0',
    });
  }
  async function snapshot(value: unknown) {
    const p = strategyInput(STRATEGY_INPUTS.snapshot, value);
    if (p.market === undefined) {
      const comparison = await hlTools().compare_market({ outcome: p.outcome });
      return source(ReferenceSnapshot, { version: 1, kind: 'reference', capturedAt: now(), network: config().network, outcome: p.outcome, comparison });
    }
    const [hl, l] = await Promise.all([captureHl(p.outcome), captureLighter(p.market, p.bookLimit)]);
    return source(PairedSnapshot, { version: 1, kind: 'paired_books', pair: { outcome: p.outcome, market: p.market }, capturedAt: now(), hl, lighter: l });
  }

  return {
    async discover_pairs(value: unknown) {
      const p = strategyInput(STRATEGY_INPUTS.discover_pairs, value);
      const [m, page] = await Promise.all([hlMarket(p.outcome), lighter().list_markets({ limit: 100, ...(p.cursor === undefined ? {} : { cursor: p.cursor }) })]);
      const wanted = tokens(`${m.displayName} ${m.underlying ?? ''}`); const expiry = epoch(m.expiresAt);
      const candidates = page.markets.map((l) => {
        const terms = tokens(`${l.title} ${l.symbol}`); const overlap = [...wanted].filter((t) => terms.has(t));
        return { market: l.market_id, creator: l.creator, network: l.network, title: l.title, rule: l.settlementRule, expiresAt: l.end_timestamp,
          match: 'unverified_candidate' as const, similarityScore: overlap.length / Math.max(1, new Set([...wanted, ...terms]).size),
          evidence: { sharedTerms: overlap, sameKnownExpiry: expiry !== null && expiry === l.end_timestamp, hlExpiryUnknown: expiry === null },
          unresolved: ['event and YES/NO orientation', 'oracle/feed and measurement window', 'boundary and void rules', 'payout/collateral equivalence'] };
      }).filter((c) => c.evidence.sharedTerms.length > 0).sort((a, b) => b.similarityScore - a.similarityScore || a.market - b.market);
      return { outcome: m.outcome, hlNetwork: config().network, hlRule: m.settlementRule, lighterNetwork: page.network,
        candidates: candidates.slice(0, p.limit), coverage: { scannedMarkets: page.markets.length, matchingCandidates: candidates.length, returnedCandidates: Math.min(candidates.length, p.limit), complete: page.complete, nextCursor: page.nextCursor, resultLimitReached: candidates.length > p.limit },
        note: 'One bounded page, ranked for research only. A shared title or expiry does not prove settlement equivalence. Follow nextCursor when present.' };
    },
    snapshot,
    async assess_pair(value: unknown) { return assessPair(value); },
    async paper_pair(value: unknown) { return paperPair(value); },
    async reconcile_pair(value: unknown) { return reconcilePair(value); },
    async scan_pairs(value: unknown) {
      const p = strategyInput(STRATEGY_INPUTS.scan_pairs, value);
      const results: ({ kind: 'assessed'; snapshot: Awaited<ReturnType<typeof snapshot>>; assessment: ReturnType<typeof assessPair> } | { kind: 'failed'; pair: typeof p.pairs[number]; failure: ReturnType<typeof failure> } | { kind: 'not_requested'; pair: typeof p.pairs[number]; reason: string })[] = [];
      let rateLimited = false;
      for (const pair of p.pairs) {
        if (rateLimited) { results.push({ kind: 'not_requested', pair, reason: 'scan_stopped_after_rate_limit' }); continue; }
        try {
          const captured = await snapshot(pair);
          results.push({ kind: 'assessed', snapshot: captured, assessment: assessPair({ snapshot: captured, at: now(), shares: p.shares, policy: p.policy, assumptions: p.assumptions }) });
        } catch (e) {
          const error = failure(e); rateLimited = error.rateLimited;
          results.push({ kind: 'failed', pair, failure: error });
        }
      }
      const ranked = results.flatMap((r) => {
        if (r.kind !== 'assessed' || r.assessment.kind !== 'conditional_plan') return [];
        const a = r.assessment; const selected = a.directions.find((d) => d.id === a.selectedDirection);
        return selected?.conditionalNetUSDC === null || selected === undefined ? [] : [{ pair: a.pair, direction: selected.id, shares: selected.plannedShares, conditionalNetUSDC: selected.conditionalNetUSDC }];
      }).sort((a, b) => { const x = signedUnits(a.conditionalNetUSDC); const y = signedUnits(b.conditionalNetUSDC); return x === y ? 0 : x > y ? -1 : 1; });
      return { kind: 'pair_scan' as const, liveReady: false as const, ranked, results, coverage: { requested: p.pairs.length, assessed: results.filter((r) => r.kind === 'assessed').length,
        failed: results.filter((r) => r.kind === 'failed').length, notRequested: results.filter((r) => r.kind === 'not_requested').length, complete: results.every((r) => r.kind === 'assessed') },
        note: 'At most eight explicit pairs, sequential capture, no polling. Ranking is conditional research, not verified arbitrage. Failed/stopped pairs remain in coverage; supporting snapshots allow offline replay.' };
    },
    async venue_health(value: unknown) {
      const p = strategyInput(STRATEGY_INPUTS.venue_health, value);
      const [hl, l] = await Promise.allSettled([captureHl(p.outcome), captureLighter(p.market, 100)]);
      return { evaluatedAt: now(), hl: hl.status === 'fulfilled' ? { reachable: true, network: hl.value.network, clock: hl.value.clock, sourceAt: hl.value.sourceAt, expiresAt: hl.value.expiresAt,
        purchaseLevels: { yes: hl.value.asks.yes.length, no: hl.value.asks.no.length }, latencyMs: hl.value.clock.receivedAt - hl.value.clock.requestedAt } : { reachable: false, failure: failure(hl.reason) },
      lighter: l.status === 'fulfilled' ? { reachable: true, network: l.value.network, clock: l.value.clock, sourceAt: null, active: l.value.active, expiresAt: l.value.expiresAt,
        purchaseLevels: { yes: l.value.asks.yes.length, no: l.value.asks.no.length }, depthTruncated: l.value.depthTruncated, latencyMs: l.value.clock.receivedAt - l.value.clock.requestedAt } : { reachable: false, failure: failure(l.reason) },
      note: 'These are independent public read probes. Reachable is not a claim of source freshness, contract equivalence, account solvency or trading eligibility.' };
    },
  };
}
export type StrategyTools = ReturnType<typeof createStrategyTools>;
