// Verdict — pure HIP-4 shape helpers shared by the browser client and the server agent.
//
// Single source of truth for parsing HIP-4 outcome descriptions and deriving prices from
// l2Book snapshots. ES module — no window/DOM assumptions, no dependencies. Loaded (via a
// classic script tag until plan 03-19's cutover) before src/live/live-hl.js, which reads it
// off the classic-script export global.

export interface ParsedMarket {
  class?: string;
  underlying?: string;
  expiry?: string;
  expiryMs?: number;
  targetPrice?: string;
  targetPriceNum?: number;
  priceThresholds?: string;
  priceThresholdNums?: number[];
  perp?: string;
  threshold?: string;
  target?: string;
  time?: string;
  scheduledStart?: string;
  scheduledStartMs?: number;
  resolutionDeadline?: string;
  resolutionDeadlineMs?: number;
  [key: string]: unknown;
}

interface BookLevel { px: string; sz: string; n?: string | number }
export interface Book { levels: BookLevel[][] }
export interface TopOfBook { bid: number | null; bidSz: number | null; ask: number | null; askSz: number | null }
interface FullLevel { px: number; sz: number; n: number | null }
export interface FullLevels { bids: FullLevel[]; asks: FullLevel[] }
export interface AssetCtx { midPx?: string | null; markPx?: string; dayNtlVlm?: string }

// "class:priceBinary|underlying:BTC|expiry:20260504-0600|targetPrice:78213|period:1d"
export function parseDescription(desc: unknown): ParsedMarket {
  const out: ParsedMarket = {};
  if (typeof desc !== 'string') return out;
  for (const kv of desc.split('|')) {
    const i = kv.indexOf(':');
    if (i < 0) continue;
    out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (out.expiry) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(out.expiry);
    if (m) out.expiryMs = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  }
  if (out.targetPrice) out.targetPriceNum = +out.targetPrice;
  if (out.priceThresholds) {
    out.priceThresholdNums = out.priceThresholds.split(',').map((s) => +s).filter((n) => Number.isFinite(n));
  }
  // HIP-4 TEMPLATE deploys (permissionless; testnet today) describe markets with template
  // keywords — "perp:BTC|threshold:62788|time:20260802-0600" — instead of the recurring
  // markets' class/underlying/expiry/targetPrice. Map them onto the same fields so every
  // downstream consumer (cards, charts, tape labels, countdowns) works unchanged.
  if (out.perp && !out.underlying) out.underlying = out.perp;
  if (out.threshold != null && out.targetPriceNum == null && Number.isFinite(+out.threshold)) {
    out.targetPriceNum = +out.threshold;
  }
  // Alias the legacy string/class fields too — consumers gate rich titles on
  // `class === 'priceBinary' && targetPrice` (api/page/market.js, live-block.jsx),
  // so a threshold template without them renders generic.
  if (out.targetPrice == null && out.threshold != null && Number.isFinite(+out.threshold)) {
    out.targetPrice = out.threshold;
  }
  // priceTouch templates call the strike `target` rather than `threshold`. Normalize it
  // to the same target-price fields while retaining the raw target for resolution copy.
  if (out.targetPriceNum == null && out.target != null && Number.isFinite(+out.target)) {
    out.targetPriceNum = +out.target;
  }
  if (out.targetPrice == null && out.target != null && Number.isFinite(+out.target)) {
    out.targetPrice = out.target;
  }
  if (!out.class && out.perp && out.threshold != null) out.class = 'priceBinary';
  if (out.time && !out.expiryMs) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(out.time);
    if (m) { out.expiryMs = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!); out.expiry = out.time; }
  }
  // Sports templates separate the contest start (when trading should close) from the
  // resolution deadline (the oracle's operational backstop). Keep both, and use the
  // scheduled start as the market close shown in the UI.
  const parseUtcMinute = (value: unknown): number | null => {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(value || ''));
    return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : null;
  };
  if (out.scheduledStart) {
    const ms = parseUtcMinute(out.scheduledStart);
    if (ms != null) out.scheduledStartMs = ms;
  }
  if (out.resolutionDeadline) {
    const ms = parseUtcMinute(out.resolutionDeadline);
    if (ms != null) out.resolutionDeadlineMs = ms;
  }
  if (!out.expiryMs && out.scheduledStartMs) {
    out.expiryMs = out.scheduledStartMs;
    out.expiry = out.scheduledStart!;
  }
  return out;
}

export function bookMid(book: Book | null | undefined): number | null {
  if (!book || !book.levels) return null;
  const bids = book.levels[0] || [];
  const asks = book.levels[1] || [];
  const bid = bids[0] && +bids[0].px;
  const ask = asks[0] && +asks[0].px;
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid != null ? bid : (ask != null ? ask : null);
}
// A naive (bid+ask)/2 prints a phantom ~50% when an outcome book is one-sided — e.g. an
// illiquid longshot (Morocco to win the World Cup) whose only standing ask is a 0.999 "wall"
// parked far above a real ~0.03 bid: (0.026+0.999)/2 ≈ 0.51. HL's markPx is a robust,
// trade/EMA-based fair value immune to that, so when the top-of-book spread is too wide to
// trust the midpoint we anchor to the mark instead. Tight two-sided books use the midpoint as
// before. With no mark to anchor (never-traded coin), treat the side pinned to a 0/1 boundary
// as the wall and trust the opposite quote.
const WIDE_OUTCOME_SPREAD = 0.10; // real outcome spreads run a few cents; ≥10c ⇒ one-sided
const OUTCOME_WALL_BAND = 0.05;   // a quote within 5c of 0 or 1 on a wide book is a parked wall
export function robustOutcomeMid(top: { bid: number | null; ask: number | null } | null | undefined, mark: number | null | undefined): number | null {
  const bid = top && top.bid, ask = top && top.ask;
  const haveBid = bid != null, haveAsk = ask != null;
  // An empty book carries no signal — return null so the caller can demote to the ctx mark
  // (and keep the midSource bookkeeping that the staleness/demotion logic relies on).
  if (!haveBid && !haveAsk) return null;
  if (haveBid && haveAsk) {
    if (ask! - bid! <= WIDE_OUTCOME_SPREAD) return (bid! + ask!) / 2; // tight two-sided: trust it
    if (mark != null) return mark;                                   // wide/one-sided: anchor to mark
    if (ask! >= 1 - OUTCOME_WALL_BAND && bid! < 1 - OUTCOME_WALL_BAND) return bid; // ask is the wall
    if (bid! <= OUTCOME_WALL_BAND && ask! > OUTCOME_WALL_BAND) return ask;          // bid is the wall
    return (bid! + ask!) / 2;
  }
  // One-sided book: a lone quote pinned to a 0/1 boundary is a parked wall with no opposing
  // interest, so prefer the robust mark over echoing the wall; otherwise use the lone quote.
  const lone = haveBid ? bid! : ask!;
  if (mark != null && (lone >= 1 - OUTCOME_WALL_BAND || lone <= OUTCOME_WALL_BAND)) return mark;
  return lone;
}
// Ctx-derived outcome price (asset context from spotMetaAndAssetCtxs). markPx is HL's
// robust trade/EMA fair value; midPx is a raw (bid+ask)/2 that prints a phantom on a
// one-sided/wall book. Prefer markPx once the coin has traded today; markPx falls back to
// HL's 0.5 placeholder for never-traded coins, so for those use midPx (a real two-sided
// book) and otherwise return null rather than a phantom. Single source for the browser
// (ctxMidForOutcome) and the server AI snapshot (applyCtxMid) — they diverged once.
export function ctxOutcomeMid(ctx: AssetCtx | null | undefined): number | null {
  if (!ctx) return null;
  const traded = +(ctx.dayNtlVlm || 0) > 0;
  const m = (traded && ctx.markPx != null) ? +ctx.markPx
    : (ctx.midPx != null ? +ctx.midPx : null);
  if (m == null || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1, m));
}
export function bookTopBidAsk(book: Book | null | undefined): TopOfBook {
  if (!book || !book.levels) return { bid: null, ask: null, bidSz: null, askSz: null };
  const b = book.levels[0] && book.levels[0][0];
  const a = book.levels[1] && book.levels[1][0];
  return {
    bid: b ? +b.px : null, bidSz: b ? +b.sz : null,
    ask: a ? +a.px : null, askSz: a ? +a.sz : null,
  };
}
// Keep every level the WS sends (HL pushes up to ~20/side) — truncating at 12 made the
// ladder look like it skipped the deep end of the 0-100% range.
export function bookFullLevels(book: Book | null | undefined, depth = 50): FullLevels {
  if (!book || !book.levels) return { bids: [], asks: [] };
  const normN = (n: unknown): number | null => {
    const v = +(n as number);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  const bids = (book.levels[0] || []).slice(0, depth).map((l) => ({ px: +l.px, sz: +l.sz, n: normN(l.n) }));
  const asks = (book.levels[1] || []).slice(0, depth).map((l) => ({ px: +l.px, sz: +l.sz, n: normN(l.n) }));
  return { bids, asks };
}
