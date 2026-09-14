// Verdict AI Strategies research core.
// Deterministic first: normalize live markets, score equivalence, and return structured cards.
//
// Strict-typed ES module (plan 03-12). The dual-runtime fork this file used to carry —
// reading the playbooks classic-script export global in the browser, `require`-ing the
// playbooks CommonJS file in Node — is the simplification AGENTS.md invariant #5
// anticipated: it collapses to one import below.
import { ROUTES, getPlaybook, routeFromMode as playbooksRouteFromMode, type RouteId } from './playbooks.js';

// Third-party venue payloads (Polymarket/Kalshi/Oddpool/Deribit raw rows), the internal
// normalized market objects, and the research "cards" this file builds are all read
// defensively throughout (optional chaining, safeNum/clamp/probNum coercion) rather than
// narrowed field-by-field — that is this module's actual design, not an accident of the
// original untyped file. Modeling every venue's format-du-jour and every card variant
// (strategy/setup/risk/mispricing/interpolated/maturity-adjusted) as its own interface
// would fork the type system to match, without adding safety the defensive reads don't
// already provide. `Raw` is the one alias that trade-off is declared under.
type Raw = Record<string, any>;

const VENUES = {
  VERDICT: 'verdict',
  HYPERLIQUID: 'hyperliquid',
  POLYMARKET: 'polymarket',
  KALSHI: 'kalshi',
} as const;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'will', 'this', 'that', 'market', 'markets', 'outcome', 'outcomes',
  'yes', 'no', 'above', 'below', 'close', 'settle', 'settlement', 'champion', 'winner', 'vs', 'versus',
  'compare', 'scan', 'find', 'build', 'strategy', 'strategies', 'setup', 'trade', 'hedge', 'mispricing', 'kalshi',
  'polymarket', 'verdict', 'hyperliquid', 'what', 'can', 'around', 'event', 'events',
]);

const HEDGE_SYMBOLS = ['BTC', 'ETH', 'HYPE', 'SOL'];

function nowIso(): string { return new Date().toISOString(); }
function safeNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v: unknown, lo: number, hi: number): number | null {
  const n = safeNum(v);
  if (n == null) return null;
  return Math.max(lo, Math.min(hi, n));
}
function probNum(v: unknown): number | null {
  const n = safeNum(v);
  if (n == null) return null;
  if (n > 1 && n <= 100) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}
function parseJsonMaybe(v: unknown, fallback: unknown): unknown {
  if (Array.isArray(v) || (v && typeof v === 'object')) return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
function stripTags(s: unknown): string {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s: unknown): string[] {
  const clean = stripTags(s).toLowerCase().replace(/[^a-z0-9$]+/g, ' ');
  return clean.split(/\s+/).filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}
function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs.filter(Boolean)));
}
function firstDefined(...args: unknown[]): unknown {
  for (const v of args) if (v !== null && v !== undefined && v !== '') return v;
  return null;
}
function jaccard(a: string[], b: string[]): number {
  const aa = new Set(a);
  const bb = new Set(b);
  if (!aa.size || !bb.size) return 0;
  let inter = 0;
  for (const x of aa) if (bb.has(x)) inter += 1;
  return inter / (aa.size + bb.size - inter);
}
function textSimilarity(a: unknown, b: unknown): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const jac = jaccard(ta, tb);
  const aa = stripTags(a).toLowerCase();
  const bb = stripTags(b).toLowerCase();
  const contains = aa && bb && (aa.includes(bb) || bb.includes(aa)) ? 0.25 : 0;
  return Math.min(1, jac + contains);
}
function fmtCents(v: unknown): string {
  const n = safeNum(v);
  return n == null ? '—' : (n * 100).toFixed(1) + '%';
}
function fmtUsd(v: unknown): string {
  const n = safeNum(v);
  if (n == null) return '—';
  if (Math.abs(n) >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + n.toFixed(0);
}
function cleanTitle(s: unknown, maxLen?: number): string {
  const t = stripTags(s || '').replace(/\s+/g, ' ').trim();
  if (!maxLen || t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).trim() + '…';
}

function expiryFromParsed(parsed: Raw | null | undefined): string | null {
  return parsed && parsed.expiryMs ? new Date(parsed.expiryMs).toISOString() : null;
}
function questionTitle(q: Raw | null | undefined): string {
  const p = (q && q.parsed) || {};
  if (p.class === 'priceBucket' && p.underlying) return `${p.underlying} settlement range`;
  return (q && q.name) || 'Outcome market';
}
function outcomeTitle(o: Raw | null | undefined): string {
  const p = (o && o.parsed) || {};
  if (p.class === 'priceBinary' && p.underlying && p.targetPriceNum != null) {
    return `${p.underlying} closes above $${(+p.targetPriceNum).toLocaleString()}`;
  }
  if (o && o.bucketLabel) return `${o.name || 'Outcome'} · ${o.bucketLabel}`;
  return (o && o.name) || 'Outcome market';
}
function outcomeLabel(o: Raw | null | undefined): string {
  if (!o) return 'Outcome';
  if (o.bucketLabel) return o.bucketLabel;
  if (/fallback/i.test(o.name || '')) return 'Other / field';
  // Prefer the leg's own name ("Below 4.3%", "San Antonio") — the side spec is usually
  // just "Yes" and was collapsing every leg of a question to the same label.
  if (o.name && !/recurring|named outcome/i.test(o.name)) return o.name;
  const side = o.sideSpecs && o.sideSpecs[0] && o.sideSpecs[0].name;
  return side || o.name || 'Outcome';
}
function sideBook(o: Raw | null | undefined, side: unknown): Raw {
  return (o && o.books && o.books[String(side || 'yes').toLowerCase()]) || {};
}
function topDepthUsd(book: Raw | null | undefined): number | null {
  if (!book) return null;
  const bid = safeNum(book.bid), ask = safeNum(book.ask);
  const bidSz = safeNum(book.bidSz), askSz = safeNum(book.askSz);
  const vals: number[] = [];
  if (bid != null && bidSz != null) vals.push(bid * bidSz);
  if (ask != null && askSz != null) vals.push(ask * askSz);
  if (!vals.length) return null;
  return Math.min(...vals);
}
function computeSpread(market: Raw | null | undefined): number | null {
  if (!market) return null;
  const b = safeNum(market.yesBid);
  const a = safeNum(market.yesAsk);
  if (b == null || a == null || a < b) return null;
  return a - b;
}
function normalizeProbability(market: Raw | null | undefined): number | null {
  if (!market) return null;
  if (safeNum(market.yesMid) != null) return clamp(market.yesMid, 0, 1);
  const b = safeNum(market.yesBid);
  const a = safeNum(market.yesAsk);
  // A positive ask is required — bid=0/ask=0 is an empty book, not a 0% probability.
  if (b != null && a != null && a > 0 && a >= b) {
    // One-sided wall guard (mirrors live-hl robustOutcomeMid): on a WIDE book where one side is
    // pinned to a 0/1 boundary, the (bid+ask)/2 midpoint is a phantom (a 0.999 "wall" ask over a
    // real 0.03 bid prints ~0.51). Trust the non-wall side rather than the fabricated midpoint.
    const WALL_SPREAD = 0.10, WALL_BAND = 0.05;
    if (a - b >= WALL_SPREAD) {
      if (a >= 1 - WALL_BAND && b < 1 - WALL_BAND) return clamp(b, 0, 1); // ask is the wall → bid
      if (b <= WALL_BAND && a > WALL_BAND) return clamp(a, 0, 1);          // bid is the wall → ask
    }
    return clamp((b + a) / 2, 0, 1);
  }
  if (a != null && a > 0) return clamp(a, 0, 1);
  if (b != null && b > 0) return clamp(b, 0, 1);
  return null;
}
function hl24hVolume(assetCtxByCoin: Raw | null | undefined, coins: unknown[]): number | null {
  let total = 0;
  let found = false;
  for (const coin of coins || []) {
    const ctx = assetCtxByCoin && assetCtxByCoin[coin as string];
    const v = ctx && safeNum(ctx.dayNtlVlm);
    if (v == null) continue;
    total += v;
    found = true;
  }
  return found ? total : null;
}
function inferCategory(title: unknown, parsed: Raw | null | undefined): string {
  const hay = `${title || ''} ${(parsed && parsed.class) || ''}`.toLowerCase();
  if ((parsed && parsed.underlying) || /\bbtc\b|\beth\b|\bhype\b|\bsol\b|bitcoin|ethereum/.test(hay)) return 'crypto';
  if (/fed|fomc|cpi|inflation|rate|election|politic|president|senate|congress/.test(hay)) return 'macro_politics';
  if (/world cup|fifa|nba|nfl|game|champion|championship|soccer|football|sports/.test(hay)) return 'sports';
  return 'event';
}
function inferUnderlying(title: unknown, parsed: Raw | null | undefined): string | null {
  if (parsed && parsed.underlying) return parsed.underlying;
  const hay = String(title || '').toUpperCase();
  for (const s of HEDGE_SYMBOLS) {
    const re = new RegExp(`\\b${s}\\b|${s === 'BTC' ? 'BITCOIN' : s === 'ETH' ? 'ETHEREUM' : s}`, 'i');
    if (re.test(hay)) return s;
  }
  return null;
}
interface OutcomeShape {
  direction: 'above' | 'below' | 'range' | null;
  strike: number | null;
  lowerStrike: number | null;
  upperStrike: number | null;
}
function outcomeShape(outcome: Raw | null | undefined, parent: Raw | null | undefined): OutcomeShape {
  const p = (outcome && outcome.parsed) || {};
  const pp = (parent && parent.parsed) || {};
  if (p.class === 'priceBinary' && safeNum(p.targetPriceNum) != null) {
    return { direction: 'above', strike: safeNum(p.targetPriceNum), lowerStrike: null, upperStrike: null };
  }
  if (pp.class === 'priceBucket') {
    const lo = safeNum(outcome && outcome.bucketLo);
    const hi = safeNum(outcome && outcome.bucketHi);
    if (lo == null && hi != null) return { direction: 'below', strike: hi, lowerStrike: null, upperStrike: hi };
    if (lo != null && hi == null) return { direction: 'above', strike: lo, lowerStrike: lo, upperStrike: null };
    if (lo != null && hi != null) return { direction: 'range', strike: null, lowerStrike: lo, upperStrike: hi };
  }
  return { direction: null, strike: null, lowerStrike: null, upperStrike: null };
}
function parsePriceNumber(raw: unknown): number | null {
  const s = String(raw || '').replace(/[$,\s]/g, '').toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return null;
  let n = +m[1]!;
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k') n *= 1000;
  if (m[2] === 'm') n *= 1000000;
  return n;
}
interface PriceShape {
  // 'range' only ever gets assigned by normalizeKalshiMarket's structured floor+cap
  // override below — inferPriceShapeFromText's own text parser never produces it.
  direction: 'above' | 'below' | 'range' | null;
  strike: number | null;
  lowerStrike: number | null;
  upperStrike: number | null;
  derivativeKind: string | null;
}
function inferPriceShapeFromText(title: unknown, raw: Raw | null | undefined): PriceShape {
  const hay = `${title || ''} ${(raw && raw.event_title) || ''} ${(raw && raw.title) || ''} ${(raw && raw.question) || ''}`.replace(/\s+/g, ' ').trim();
  const lower = hay.toLowerCase();
  const out: PriceShape = { direction: null, strike: null, lowerStrike: null, upperStrike: null, derivativeKind: null };
  if (/\b(up or down|up\/down|updown|price up in next|price down in next)\b/.test(lower)) out.derivativeKind = 'updown';
  else if (/\b(purchasing power index|truflation|index)\b/.test(lower)) out.derivativeKind = 'index';
  else if (/\b(hit|reach|reaches|dip to|touch|all time high|ath|how high|get in 20\d{2})\b/.test(lower)) out.derivativeKind = 'touch';
  else if (/\b(close|closes|settle|settles|settlement|at 11:59|at 12:00|at 4pm| at \d{1,2}(?::\d{2})?\s*(am|pm)|on [a-z]+ \d{1,2})\b/.test(lower)) out.derivativeKind = 'settlement';

  let m = /\b(?:above|over|greater than|at least)\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)/i.exec(hay);
  if (m) {
    out.direction = 'above';
    out.strike = parsePriceNumber(m[1]);
    out.lowerStrike = out.strike;
  }
  if (!m) {
    m = /\b(?:below|under|less than)\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)/i.exec(hay);
    if (m) {
      out.direction = 'below';
      out.strike = parsePriceNumber(m[1]);
      out.upperStrike = out.strike;
    }
  }
  if (!m) {
    m = /\b(?:hit|reach|reaches)\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)/i.exec(hay);
    if (m) {
      out.direction = 'above';
      out.strike = parsePriceNumber(m[1]);
      out.lowerStrike = out.strike;
      out.derivativeKind = out.derivativeKind || 'touch';
    }
  }
  if (!m) {
    m = /\b(?:dip to|drop to)\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)/i.exec(hay);
    if (m) {
      out.direction = 'below';
      out.strike = parsePriceNumber(m[1]);
      out.upperStrike = out.strike;
      out.derivativeKind = out.derivativeKind || 'touch';
    }
  }
  // Trailing-direction phrasing ("$65,000 or above", "$60k or below") — Kalshi/oddpool
  // and some Polymarket titles put the strike before the comparator, which the
  // word-first patterns above miss. Backstop only when nothing was parsed yet.
  if (out.strike == null && out.lowerStrike == null && out.upperStrike == null) {
    let mt = /\$?\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)\s+or\s+(?:above|higher|over|more|greater)\b/i.exec(hay);
    if (mt) { out.direction = 'above'; out.strike = parsePriceNumber(mt[1]); out.lowerStrike = out.strike; }
    else {
      mt = /\$?\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)\s+or\s+(?:below|lower|under|less)\b/i.exec(hay);
      if (mt) { out.direction = 'below'; out.strike = parsePriceNumber(mt[1]); out.upperStrike = out.strike; }
    }
  }
  if (!out.derivativeKind && out.direction && out.strike != null) out.derivativeKind = 'settlement';
  return out;
}
function strikeDistancePct(a: unknown, b: unknown): number | null {
  const aa = safeNum(a);
  const bb = safeNum(b);
  if (aa == null || bb == null || aa <= 0 || bb <= 0) return null;
  return Math.abs(aa - bb) / ((aa + bb) / 2);
}
function tagText(tags: Raw[] | null | undefined): string {
  return (tags || []).map(t => [t.label, t.slug].filter(Boolean).join(' ')).join(' ');
}
function polymarketRawText(raw: Raw | null | undefined): string {
  if (!raw) return '';
  const eventLike: Raw[] = ([] as Raw[])
    .concat(raw.events || [])
    .concat(raw.event ? [raw.event] : [])
    .concat(raw._event ? [raw._event] : []);
  return [
    raw.question,
    raw.title,
    raw.subtitle,
    raw.sub_title,
    raw.yes_sub_title,
    raw.slug,
    raw.ticker,
    raw.event_ticker,
    raw.series_ticker,
    raw.description,
    raw.rules_primary,
    raw.rules_secondary,
    raw.groupItemTitle,
    tagText(raw.tags),
    tagText(raw.eventTags),
    ...eventLike.map(e => [e.title, e.sub_title, e.slug, e.event_ticker, e.series_ticker, e.category, e.description, tagText(e.tags)].filter(Boolean).join(' ')),
  ].filter(Boolean).join(' ');
}
function marketStrongText(market: Raw | null | undefined, raw?: Raw | null): string {
  const r = raw || (market && market.raw) || market || {};
  const eventLike: Raw[] = ([] as Raw[])
    .concat(r.events || [])
    .concat(r.event ? [r.event] : [])
    .concat(r._event ? [r._event] : []);
  return [
    market && market.title,
    market && market.eventTitle,
    market && market.outcomeLabel,
    r.question,
    r.title,
    r.subtitle,
    r.sub_title,
    r.yes_sub_title,
    r.no_sub_title,
    r.slug,
    r.ticker,
    r.event_ticker,
    r.series_ticker,
    r.groupItemTitle,
    ...eventLike.map(e => [e.title, e.sub_title, e.slug, e.event_ticker, e.series_ticker].filter(Boolean).join(' ')),
  ].filter(Boolean).join(' ');
}
function polymarketHasTag(raw: Raw | null | undefined, slug: unknown): boolean {
  const want = String(slug || '').toLowerCase();
  const tags: Raw[] = ([] as Raw[])
    .concat((raw && raw.tags) || [])
    .concat((raw && raw.eventTags) || [])
    .concat(...(((raw && raw.events) || []).map((e: Raw) => e.tags || [])));
  return tags.some((t) => String(t.slug || t.label || '').toLowerCase() === want);
}
interface QueryIntent {
  symbols: string[];
  crypto: boolean;
  sports: boolean;
  macroPolitics: boolean;
}
function queryIntent(query: unknown): QueryIntent {
  const q = String(query || '').toLowerCase();
  const symbols: string[] = [];
  // Word-anchored: bare 'sol'/'eth'/'oi' otherwise match inside ordinary words
  // ('console', 'whether', 'going') and falsely flag crypto intent — which routed a
  // World Cup question into a denied/empty crypto scan.
  if (/\b(btc|bitcoin)\b/.test(q)) symbols.push('bitcoin');
  if (/\b(eth|ethereum)\b/.test(q)) symbols.push('ethereum');
  if (/\b(hype|hyperliquid)\b/.test(q)) symbols.push('hyperliquid');
  if (/\b(sol|solana)\b/.test(q)) symbols.push('solana');
  return {
    symbols: uniq(symbols),
    crypto: /\b(crypto|perps?|funding|liquidation|open interest|btc|bitcoin|eth|ethereum|hype|hyperliquid|sol|solana)\b/.test(q),
    sports: /\b(sports?|world cup|fifa|nba|nfl|game|champion|champions|championship|soccer|football|basketball)\b/.test(q),
    macroPolitics: /\b(macro|politic\w*|election\w*|fed|fomc|cpi|inflation|rate|rates|gdp|recession)\b/.test(q),
  };
}
function intentRegex(term: string): RegExp | null {
  if (term === 'bitcoin') return /\b(bitcoin|btc)\b/i;
  if (term === 'ethereum') return /\b(ethereum|eth)\b/i;
  if (term === 'hyperliquid') return /\b(hyperliquid|hype)\b/i;
  if (term === 'solana') return /\b(solana|sol)\b/i;
  if (term === 'crypto') return /\b(crypto|cryptocurrency|bitcoin|btc|ethereum|eth|hyperliquid|hype|solana|sol|token|airdrop|dex|defi|blockchain)\b/i;
  return null;
}
function marketMatchesIntent(market: Raw | null | undefined, query: unknown, searchTerm: unknown): boolean {
  const raw = (market && market.raw) || market || {};
  const strongHay = marketStrongText(market, raw);
  const hay = [
    market && market.title,
    market && market.category,
    market && market.underlying,
    market && market.rulesText,
    polymarketRawText(raw),
  ].filter(Boolean).join(' ');
  // CROSS-CATEGORY override: when this market was pulled by a SPORTS or MACRO search term, the
  // query's crypto symbols must not reject it — a mixed "bitcoin world cup" discovery query
  // otherwise lets the BTC symbol filter discard the World Cup markets the 'world cup' search
  // deliberately fetched (the exact "no Polymarket comparator" bug on a crypto+sports scan).
  // Crypto/same-category terms do NOT override here, so a BTC-symbol query still rejects a
  // generic ETH crypto market (that distinction is enforced by a test).
  const term = String(searchTerm || '').toLowerCase();
  if (/world cup|fifa|soccer|football/.test(term)) return market!.category === 'sports' || /world cup|fifa/i.test(hay);
  if (/\bnba\b|basketball/.test(term)) return market!.category === 'sports' || /\bnba\b|basketball/i.test(hay);
  if (/\bfed\b|fomc|cpi|inflation|interest rate|rate (cut|hike|decision)/.test(term)) return market!.category === 'macro_politics' || /fed|fomc|cpi|inflation|interest rate/i.test(hay);

  const intent = queryIntent(query);
  if (intent.symbols.length) {
    return intent.symbols.some(s => (intentRegex(s) || /$a/).test(strongHay));
  }
  if (term) {
    if (term === 'crypto' && polymarketHasTag(raw, 'crypto')) return true;
    const re = intentRegex(term);
    if (re) return re.test(hay);
  }
  if (intent.crypto) return market!.category === 'crypto' || !!market!.underlying || polymarketHasTag(raw, 'crypto') || (intentRegex('crypto') || /$a/).test(hay);
  if (intent.sports) return market!.category === 'sports';
  if (intent.macroPolitics) return market!.category === 'macro_politics';
  return true;
}
function filterMarketsByIntent(markets: Raw[] | null | undefined, query: unknown): Raw[] {
  const intent = queryIntent(query);
  if (!intent.crypto && !intent.sports && !intent.macroPolitics && !intent.symbols.length) return markets || [];
  const scoped = (markets || []).filter(m => marketMatchesIntent(m, query, null));
  return scoped.length ? scoped : [];
}
function normalizeVerdictOutcome(outcome: Raw | null | undefined, ctx: { assetCtxByCoin?: Raw; parentQuestion?: Raw | null } | null): Raw {
  const assetCtxByCoin = (ctx && ctx.assetCtxByCoin) || {};
  const parent = (ctx && ctx.parentQuestion) || null;
  const yes = sideBook(outcome, 'yes');
  const no = sideBook(outcome, 'no');
  const title = parent ? `${questionTitle(parent)} · ${outcomeLabel(outcome)}` : outcomeTitle(outcome);
  const yesBid = safeNum(yes.bid);
  const yesAsk = safeNum(yes.ask);
  const noBid = safeNum(no.bid);
  const noAsk = safeNum(no.ask);
  const yesMid = safeNum(outcome && outcome.mid) != null
    ? clamp(outcome!.mid, 0, 1)
    : (yesBid != null && yesAsk != null ? clamp((yesBid + yesAsk) / 2, 0, 1) : null);
  const spread = yesBid != null && yesAsk != null && yesAsk >= yesBid ? yesAsk - yesBid : null;
  const depthUsd = topDepthUsd(yes);
  const volumeUsd = hl24hVolume(assetCtxByCoin, [outcome && outcome.yesCoin, outcome && outcome.noCoin]);
  const expiry = expiryFromParsed(outcome && outcome.parsed) || expiryFromParsed(parent && parent.parsed);
  const rules = parent && parent.description ? parent.description : outcome && outcome.description;
  const category = inferCategory(title, outcome && outcome.parsed);
  const underlying = inferUnderlying(title, outcome && outcome.parsed);
  const shape = outcomeShape(outcome, parent);
  const w = (globalThis as unknown as Raw).window;
  const root: Raw = w !== undefined ? w : (globalThis as unknown as Raw);
  return {
    venue: VENUES.VERDICT,
    id: `verdict:${outcome && outcome.outcome}`,
    rawId: outcome && outcome.outcome,
    groupId: parent ? `question:${parent.question}` : null,
    eventId: parent ? `question:${parent.question}` : `outcome:${outcome && outcome.outcome}`,
    eventTitle: parent ? questionTitle(parent) : outcomeTitle(outcome),
    title,
    outcomeLabel: outcomeLabel(outcome),
    yesMid,
    noMid: yesMid == null ? null : 1 - yesMid,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    spread,
    depthUsd,
    volumeUsd,
    expiry,
    resolutionSource: category === 'sports' ? 'Official result' : category === 'crypto' ? 'Hyperliquid / oracle-settled outcome metadata' : 'Market rules',
    rulesText: rules || null,
    url: root && root.VDLive && root.VDLive.hlAppUrl && outcome ? root.VDLive.hlAppUrl(outcome.outcome, 0) : null,
    updatedAt: nowIso(),
    category,
    underlying,
    direction: shape.direction,
    strike: shape.strike,
    lowerStrike: shape.lowerStrike,
    upperStrike: shape.upperStrike,
    derivativeKind: shape.direction ? 'settlement' : null,
    raw: outcome || null,
  };
}
function normalizeVerdictSnapshot(snap: Raw | null | undefined): Raw[] {
  if (!snap) return [];
  const out: Raw[] = [];
  const assetCtxByCoin = snap.assetCtxByCoin || {};
  const childIds = new Set<unknown>();
  for (const q of snap.questions || []) {
    for (const o of q.namedOutcomes || []) {
      childIds.add(o.outcome);
      out.push(normalizeVerdictOutcome(o, { parentQuestion: q, assetCtxByCoin }));
    }
    if (q.fallbackOutcome) {
      childIds.add(q.fallbackOutcome.outcome);
      out.push(normalizeVerdictOutcome(q.fallbackOutcome, { parentQuestion: q, assetCtxByCoin }));
    }
  }
  const standalone = (snap.standalone && snap.standalone.length ? snap.standalone : (snap.outcomes || []).filter((o: Raw) => !childIds.has(o.outcome)));
  for (const o of standalone) out.push(normalizeVerdictOutcome(o, { assetCtxByCoin }));
  return out;
}

// Canonical venue web URLs. Polymarket per-MARKET slugs 404 — only the EVENT page
// resolves. Kalshi per-market TICKERS aren't web paths — the lowercased series page is
// the stable public URL. These produce real, clickable links (the old ones were dead).
function polymarketWebUrl(eventSlug: unknown): string | null {
  const s = String(eventSlug || '').trim();
  return /^[a-z0-9-]{3,}$/i.test(s) ? `https://polymarket.com/event/${s}` : null;
}
function kalshiWebUrl(seriesTicker: unknown): string | null {
  const s = String(seriesTicker || '').trim();
  return /^[a-z0-9]{2,}$/i.test(s) ? `https://kalshi.com/markets/${s.toLowerCase()}` : null;
}
function normalizePolymarketMarket(m: Raw): Raw {
  const outcomes = parseJsonMaybe(m.outcomes, []);
  const prices = parseJsonMaybe(m.outcomePrices || m.outcome_prices, []);
  const primaryEvent = (m.events && m.events[0]) || m.event || m._event || null;
  const eventTitle = (primaryEvent && (primaryEvent.title || primaryEvent.slug)) || null;
  const baseTitle = m.question || m.title || m.slug || eventTitle || 'Polymarket market';
  const title = m.groupItemTitle && !String(baseTitle).toLowerCase().includes(String(m.groupItemTitle).toLowerCase())
    ? `${baseTitle} · ${m.groupItemTitle}`
    : baseTitle;
  const category = polymarketHasTag(m, 'crypto') ? 'crypto' : inferCategory(`${title} ${eventTitle || ''}`, null);
  const eventSlug = (primaryEvent && primaryEvent.slug) || m.eventSlug || m.event_slug || null;
  const marketSlug = m.slug || null;
  const urlSlug = eventSlug || marketSlug;
  let yesIdx = Array.isArray(outcomes) ? outcomes.findIndex((x: unknown) => String(x).toLowerCase() === 'yes') : -1;
  if (yesIdx < 0) yesIdx = 0;
  const bestBid = clamp(m.bestBid, 0, 1);
  const bestAsk = clamp(m.bestAsk, 0, 1);
  // Positive ask required (bestAsk 0 = empty book). Fall back to the venue's last
  // outcomePrices rather than a fabricated 0; a genuinely listed market is never exactly 0.
  const quotedMid = bestBid != null && bestAsk != null && bestAsk > 0 && bestAsk >= bestBid ? (bestBid + bestAsk) / 2 : null;
  const pxMid = clamp(Array.isArray(prices) ? prices[yesIdx] : undefined, 0, 1);
  const yesMid = quotedMid != null ? quotedMid : (pxMid != null && pxMid > 0 ? pxMid : null);
  const liquidity = safeNum(m.liquidityClob != null ? m.liquidityClob : m.liquidityNum != null ? m.liquidityNum : m.liquidity);
  const shape = inferPriceShapeFromText(`${title} ${eventTitle || ''}`, m);
  return {
    venue: VENUES.POLYMARKET,
    id: `polymarket:${m.conditionId || m.id || m.slug}`,
    rawId: m.conditionId || m.id || m.slug,
    eventId: (primaryEvent && (primaryEvent.id || primaryEvent.slug || primaryEvent.ticker)) || m.eventId || m.event_id || null,
    eventTitle,
    eventSlug,
    title,
    yesMid,
    noMid: yesMid == null ? null : 1 - yesMid,
    yesBid: bestBid,
    yesAsk: bestAsk,
    spread: bestBid != null && bestAsk != null && bestAsk >= bestBid ? bestAsk - bestBid : safeNum(m.spread),
    depthUsd: liquidity,
    volumeUsd: safeNum(m.volumeClob != null ? m.volumeClob : m.volumeNum != null ? m.volumeNum : m.volume),
    expiry: m.endDate || m.end_date || (primaryEvent && (primaryEvent.endDate || primaryEvent.end_date)) || null,
    resolutionSource: m.resolutionSource || (primaryEvent && primaryEvent.resolutionSource) || null,
    rulesText: m.description || m.rules || (primaryEvent && primaryEvent.description) || null,
    url: polymarketWebUrl(eventSlug) || polymarketWebUrl(urlSlug),
    updatedAt: nowIso(),
    category,
    underlying: inferUnderlying(`${title} ${eventTitle || ''}`, null),
    direction: shape.direction,
    strike: shape.strike,
    lowerStrike: shape.lowerStrike,
    upperStrike: shape.upperStrike,
    derivativeKind: shape.derivativeKind,
    raw: m,
  };
}
function kalshiPrice(m: Raw, field: string): number | null {
  const dollars = safeNum(m[`${field}_dollars`]);
  if (dollars != null) return clamp(dollars, 0, 1);
  const cents = safeNum(m[field]);
  if (cents != null) return clamp(cents / 100, 0, 1);
  return null;
}
function oddpoolMonthIndex(s: unknown): number | null {
  const map: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const k = String(s || '').slice(0, 3).toLowerCase();
  return map[k] != null ? map[k]! : null;
}
// Oddpool puts the settlement date only in the event slug/title (e.g.
// "bitcoin-above-on-june-9-2026" or "...-june-8-2026-5pm-et"), never as a
// per-market timestamp. Without an expiry, strictComparatorFailure hard-fails
// every comparator before scoring, so derive it from the available text.
function oddpoolDateFromText(...sources: unknown[]): string | null {
  for (const src of sources) {
    const text = String(src || '').toLowerCase();
    if (!text) continue;
    const m = text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]+(\d{1,2})[\s,-]+(\d{4})(?:[\s-]+(\d{1,2})\s*(am|pm)\s*-?\s*et)?/);
    if (!m) continue;
    const mo = oddpoolMonthIndex(m[1]);
    const day = +m[2]!;
    const year = +m[3]!;
    if (mo == null || !day || !year) continue;
    let hour = 12; // default to midday UTC when only a date is given
    if (m[4]) {
      hour = +m[4];
      if (m[5] === 'pm' && hour < 12) hour += 12;
      if (m[5] === 'am' && hour === 12) hour = 0;
      hour += 4; // ET -> UTC (approx EDT; precise to within the day-level match gate)
    }
    const ms = Date.UTC(year, mo, day, hour, 0, 0);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}
function normalizeOddpoolMarket(m: Raw): Raw | null {
  const exchange = String((m && m.exchange) || '').toLowerCase();
  const venue = exchange === 'polymarket' ? VENUES.POLYMARKET : exchange === 'kalshi' ? VENUES.KALSHI : exchange;
  // `venue` is a plain string (it can fall through to the raw `exchange` text for an
  // unrecognized venue) — widen the literal-typed membership array rather than narrow
  // `venue`, since an unrecognized exchange is exactly the case this check must catch.
  if (!([VENUES.POLYMARKET, VENUES.KALSHI] as string[]).includes(venue)) return null;
  const rawId = m.market_id || m.ticker || m.condition_id || m.conditionId || m.id || m.slug;
  const eventId = m.event_id || m.event_ticker || null;
  const eventTitle = m.event_title || m.title || null;
  const question = m.question || m.market_question || m.subtitle || m.title || 'Prediction market';
  const title = eventTitle && question && !String(question).toLowerCase().includes(String(eventTitle).toLowerCase())
    ? `${eventTitle} · ${question}`
    : question || eventTitle || 'Prediction market';
  const yesBid = probNum(firstDefined(m.yes_bid, m.best_yes_bid, m.bestBid, m.bid));
  const yesAsk = probNum(firstDefined(m.yes_ask, m.best_yes_ask, m.bestAsk, m.ask));
  const last = probNum(firstDefined(m.last_yes_price, m.yes_price, m.last_price, m.price));
  // A real two-sided quote needs a POSITIVE ask — bid=0/ask=0 is an empty book, not a
  // 0% probability. An empty book must yield null (no price signal), never a fake 0 that
  // gets read as a "0% chance" and fabricates a ~100% cross-venue gap.
  const yesMid = (yesBid != null && yesAsk != null && yesAsk > 0 && yesAsk >= yesBid)
    ? (yesBid + yesAsk) / 2
    : (last != null && last > 0 ? last : null);
  const spreadRaw = probNum(firstDefined(m.spread, m.yes_spread));
  const expiry = m.close_time || m.expiration_time || m.end_time || m.endDate || m.settled_at
    || oddpoolDateFromText(m.event_id, m.event_title, eventTitle, title) || null;
  const shape = inferPriceShapeFromText(title, m);
  return {
    venue,
    id: `${venue}:${rawId}`,
    rawId,
    eventId,
    eventTitle,
    eventTicker: m.event_ticker || eventId,
    seriesTicker: m.series_id || m.series_ticker || null,
    title,
    yesMid,
    noMid: yesMid == null ? null : 1 - yesMid,
    yesBid,
    yesAsk,
    spread: yesBid != null && yesAsk != null && yesAsk >= yesBid ? yesAsk - yesBid : spreadRaw,
    depthUsd: safeNum(m.liquidity != null ? m.liquidity : m.total_liquidity),
    volumeUsd: safeNum(m.volume != null ? m.volume : m.total_volume),
    expiry,
    resolutionSource: m.resolution_source || m.settlement_source || null,
    rulesText: [m.rules, m.description, eventTitle].filter(Boolean).join('\n') || null,
    url: venue === VENUES.POLYMARKET
      ? polymarketWebUrl(m.event_slug || m.series_id || m.slug)
      : venue === VENUES.KALSHI
        ? kalshiWebUrl(m.series_id || m.series_ticker)
        : null,
    updatedAt: nowIso(),
    category: inferCategory(`${title} ${m.category || ''}`, null),
    underlying: inferUnderlying(`${title} ${eventTitle || ''}`, null),
    direction: shape.direction,
    strike: shape.strike,
    lowerStrike: shape.lowerStrike,
    upperStrike: shape.upperStrike,
    derivativeKind: shape.derivativeKind,
    raw: m,
  };
}
function normalizeKalshiMarket(m: Raw): Raw {
  const event = (m && (m._event || m.event)) || null;
  const yesBid = kalshiPrice(m, 'yes_bid');
  const yesAsk = kalshiPrice(m, 'yes_ask');
  const last = kalshiPrice(m, 'last_price');
  // A real two-sided quote needs a POSITIVE ask — bid=0/ask=0 is an empty book, not a
  // 0% probability. An empty book must yield null (no price signal), never a fake 0 that
  // gets read as a "0% chance" and fabricates a ~100% cross-venue gap.
  const yesMid = (yesBid != null && yesAsk != null && yesAsk > 0 && yesAsk >= yesBid)
    ? (yesBid + yesAsk) / 2
    : (last != null && last > 0 ? last : null);
  const bidSz = safeNum(m.yes_bid_size_fp);
  const askSz = safeNum(m.yes_ask_size_fp);
  const topDepth = yesBid != null && yesAsk != null && bidSz != null && askSz != null
    ? Math.min(yesBid * bidSz, yesAsk * askSz)
    : null;
  const eventTitle = (event && (event.title || event.event_ticker)) || null;
  const subtitle = m.subtitle || m.sub_title || m.yes_sub_title || '';
  const marketTitle = [m.title, subtitle].filter(Boolean).join(' · ') || m.ticker || 'Kalshi market';
  const title = eventTitle && !String(marketTitle).toLowerCase().includes(String(eventTitle).toLowerCase())
    ? `${eventTitle} · ${subtitle || m.title || m.ticker || 'Market'}`
    : marketTitle;
  const seriesTicker = m.series_ticker || (event && event.series_ticker) || null;
  const shape = inferPriceShapeFromText(title, m);
  // Kalshi's strike lives in STRUCTURED fields (floor_strike/cap_strike/strike_type) and
  // its text reads "$X or above" — which the word-first text parser misses, leaving
  // direction/strike null so every KXBTCD market hard-failed equivalence. Structured
  // fields are canonical and present on the whole ladder, so override from them.
  const kFloor = safeNum(m.floor_strike);
  const kCap = safeNum(m.cap_strike);
  const kType = String(m.strike_type || '').toLowerCase();
  if (kFloor != null || kCap != null) {
    if (kFloor != null && kCap != null) {
      shape.direction = 'range'; shape.lowerStrike = kFloor; shape.upperStrike = kCap; shape.strike = null;
    } else if (kCap != null || kType === 'less' || kType === 'less_or_equal') {
      shape.direction = 'below'; shape.strike = (kCap != null ? kCap : kFloor); shape.upperStrike = shape.strike; shape.lowerStrike = null;
    } else {
      shape.direction = 'above'; shape.strike = kFloor; shape.lowerStrike = kFloor; shape.upperStrike = null;
    }
    shape.derivativeKind = shape.derivativeKind || 'settlement';
  }
  return {
    venue: VENUES.KALSHI,
    id: `kalshi:${m.ticker || m.id}`,
    rawId: m.ticker || m.id,
    eventId: m.event_ticker || (event && event.event_ticker) || null,
    eventTitle,
    eventTicker: m.event_ticker || (event && event.event_ticker) || null,
    seriesTicker,
    title,
    yesMid: yesMid == null ? null : clamp(yesMid, 0, 1),
    noMid: yesMid == null ? null : 1 - yesMid,
    yesBid,
    yesAsk,
    spread: yesBid != null && yesAsk != null && yesAsk >= yesBid ? yesAsk - yesBid : null,
    depthUsd: topDepth != null ? topDepth : safeNum(m.liquidity_dollars != null ? m.liquidity_dollars : m.liquidity),
    volumeUsd: safeNum(m.volume_24h_fp != null ? m.volume_24h_fp : m.volume_fp != null ? m.volume_fp : m.volume || m.volume_24h),
    expiry: m.close_time || m.expiration_time || (event && event.close_time) || null,
    resolutionSource: m.settlement_source || (event && event.category) || null,
    rulesText: [m.rules_primary, m.rules_secondary, event && event.title].filter(Boolean).join('\n') || null,
    url: kalshiWebUrl(seriesTicker),
    updatedAt: nowIso(),
    category: inferCategory(title, null),
    underlying: inferUnderlying(title, null),
    direction: shape.direction,
    strike: shape.strike,
    lowerStrike: shape.lowerStrike,
    upperStrike: shape.upperStrike,
    derivativeKind: shape.derivativeKind,
    raw: m,
  };
}
// deadlineAt is an ABSOLUTE request-local deadline (undefined/0 = none), threaded
// explicitly from runResearch({ deadlineAt }) through every intermediate call down to
// this fetch — request-LOCAL by construction, so concurrent server runs can neither
// extend nor erase each other's budget (module-level state did exactly that). Every
// external fetch caps its timeout by the remaining time and refuses to start once
// expired; the browser never passes a deadline and is unaffected.
async function fetchJson(url: string, timeoutMs?: number, headers?: Record<string, string>, deadlineAt?: number): Promise<unknown> {
  const rem = deadlineAt ? deadlineAt - Date.now() : Infinity;
  if (rem <= 250) throw new Error('research_deadline_exceeded');
  if (rem !== Infinity) timeoutMs = Math.min(timeoutMs || 6000, rem);
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 6000) : null;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(headers || {}) },
      signal: ctl && ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function sameOriginApi(path: string, params: URLSearchParams): string | null {
  const w = (globalThis as unknown as Raw).window;
  const root: Raw = w !== undefined ? w : (globalThis as unknown as Raw);
  if (!root || !root.location) return null;
  return `${path}?${params.toString()}`;
}
async function fetchFirstJson(urls: (string | null)[], timeoutMs?: number, deadlineAt?: number): Promise<unknown> {
  let lastErr: unknown = null;
  for (const url of urls.filter(Boolean) as string[]) {
    try { return await fetchJson(url, timeoutMs, undefined, deadlineAt); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all_sources_unavailable');
}
function serverOddpoolKey(): string {
  // tsconfig.app.json has no `node` types (browser DOM lib only) — this file runs in both
  // the browser (via a classic script tag, until plan 03-19's cutover) and Node (server
  // API routes, Vitest), so `process` is read off `globalThis` rather than assumed global.
  const proc = (globalThis as Raw).process;
  return (proc && proc.env && proc.env.ODDPOOL_API_KEY) || '';
}
async function fetchOddpool(kind: string, params: Record<string, string> | null | undefined, timeoutMs?: number, deadlineAt?: number): Promise<unknown> {
  const p = new URLSearchParams(params || {});
  p.set('kind', kind);
  const proxied = sameOriginApi('/api/venues/oddpool', p);
  if (proxied) return await fetchJson(proxied, timeoutMs || 9000, undefined, deadlineAt);
  const key = serverOddpoolKey();
  if (!key) throw new Error('oddpool_not_configured');
  const direct = new URLSearchParams(params || {});
  let url: string;
  if (kind === 'events') url = `https://api.oddpool.com/search/events?${direct.toString()}`;
  else if (kind === 'markets') url = `https://api.oddpool.com/search/markets?${direct.toString()}`;
  else if (kind === 'series') url = `https://api.oddpool.com/search/series?${direct.toString()}`;
  else if (kind === 'recent-events') url = `https://api.oddpool.com/search/recent/events?${direct.toString()}`;
  else if (kind === 'event-markets') {
    const eventId = String((params && params.event_id) || '').trim();
    if (!eventId) throw new Error('oddpool_missing_event_id');
    url = `https://api.oddpool.com/search/events/${encodeURIComponent(eventId)}/markets`;
  } else {
    throw new Error('oddpool_invalid_kind');
  }
  return await fetchJson(url, timeoutMs || 9000, { 'X-API-Key': key }, deadlineAt);
}
function venueSearchQueries(query: unknown): string[] {
  const q = String(query || '').toLowerCase();
  const terms: string[] = [];
  if (/btc|bitcoin/.test(q)) terms.push('bitcoin', 'btc up or down', 'bitcoin up or down', 'what price will bitcoin', 'crypto');
  if (/eth|ethereum/.test(q)) terms.push('ethereum');
  if (/hype|hyperliquid/.test(q)) terms.push('hyperliquid');
  if (/sol|solana/.test(q)) terms.push('solana');
  // Sports + macro/politics, so a cross-venue scan over World Cup / Fed bases actually fetches
  // the matching Polymarket set (this maps to a pinned tag in fetchPolymarketEvents). Without
  // these, a mixed scan only extracted the crypto terms and never pulled the WC Winner markets.
  if (/world cup|fifa/.test(q)) terms.push('world cup');
  if (/\bfed\b|fomc|federal reserve|rate (cut|hike|decision)|interest rate/.test(q)) terms.push('fed');
  if (/cpi|inflation/.test(q)) terms.push('cpi');
  if (!terms.length && /crypto|perp|funding|liquidation|open interest|oi/.test(q)) terms.push('crypto');
  return terms.length ? uniq(terms) : [String(query || '').trim()].filter(Boolean);
}
function oddpoolSeriesForQuery(query: unknown, exchange: string): string[] {
  const q = String(query || '').toLowerCase();
  const xs: string[] = [];
  if (/btc|bitcoin/.test(q)) {
    if (exchange === 'kalshi') xs.push('KXBTC15M', 'KXBTCD', 'KXBTC');
    if (exchange === 'polymarket') xs.push('btc-up-or-down-15m', 'btc-up-or-down-5m');
  }
  if (/eth|ethereum/.test(q) && exchange === 'kalshi') xs.push('KXETHD');
  if (/sol|solana/.test(q) && exchange === 'kalshi') xs.push('KXSOLD');
  if (/hype|hyperliquid/.test(q) && exchange === 'kalshi') xs.push('KXHYPED');
  if (/fed|fomc|rate|rates/.test(q) && exchange === 'kalshi') xs.push('KXFEDDECISION', 'KXFED');
  if (/cpi|inflation/.test(q) && exchange === 'kalshi') xs.push('KXCPI');
  return uniq(xs);
}
function eventDiscoveryScore(event: Raw | null | undefined, query: unknown): number {
  const title = (event && (event.title || event.event_title || event.event_id)) || '';
  const vol = Math.max(0, safeNum(event && (event.total_volume != null ? event.total_volume : event.volume)) || 0);
  const liq = Math.max(0, safeNum(event && (event.total_liquidity != null ? event.total_liquidity : event.liquidity)) || 0);
  const count = Math.max(0, safeNum(event && (event.market_count != null ? event.market_count : event.n_markets)) || 0);
  return textSimilarity(query || '', title) * 8
    + Math.min(5, Math.log10(1 + vol)) * 0.8
    + Math.min(4, Math.log10(1 + liq)) * 0.7
    + Math.min(3, count) * 0.4;
}
function dedupeMarkets(markets: (Raw | null)[] | null | undefined): Raw[] {
  const seen = new Set<string>();
  return (markets || []).filter((m): m is Raw => {
    const key = `${(m && m.venue) || ''}:${(m && (m.rawId || m.id || m.title)) || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function searchOddpool(query: unknown, venues: { polymarket?: boolean; kalshi?: boolean } | null | undefined, deadlineAt?: number): Promise<Raw[]> {
  const wanted: string[] = [];
  if (!venues || venues.polymarket !== false) wanted.push('polymarket');
  if (!venues || venues.kalshi !== false) wanted.push('kalshi');
  const searches = venueSearchQueries(query);
  const out: Raw[] = [];
  await Promise.all(wanted.map(async (exchange) => {
    const events: Raw[] = [];
    const marketBatches = await Promise.all(searches.slice(0, 5).map(async (search) => {
      try {
        const data = await fetchOddpool('markets', {
          q: search,
          exchange,
          status: 'active',
          sort_by: 'volume',
          limit: '60',
          offset: '0',
        }, 9000, deadlineAt);
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    }));
    for (const rows of marketBatches) out.push(...rows);

    const eventBatches = await Promise.all(searches.slice(0, 5).map(async (search) => {
      try {
        const data = await fetchOddpool('events', {
          q: search,
          exchange,
          status: 'active',
          sort_by: 'volume',
          limit: '40',
          offset: '0',
        }, 9000, deadlineAt);
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    }));
    events.push(...eventBatches.flat());

    const seriesBatches = await Promise.all(oddpoolSeriesForQuery(query, exchange).map(async (seriesId) => {
      try {
        const data = await fetchOddpool('events', {
          series_id: seriesId,
          exchange,
          status: 'active',
          sort_by: 'newest',
          limit: '30',
          offset: '0',
        }, 9000, deadlineAt);
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    }));
    events.push(...seriesBatches.flat());

    const seenEvents = new Set<unknown>();
    const rankedEvents = events
      .filter(e => e && e.event_id && !seenEvents.has(e.event_id) && seenEvents.add(e.event_id))
      .sort((a, b) => eventDiscoveryScore(b, query) - eventDiscoveryScore(a, query))
      .slice(0, 14);
    const eventMarketBatches = await Promise.all(rankedEvents.map(async (event) => {
      try {
        const data = await fetchOddpool('event-markets', { event_id: event.event_id }, 9000, deadlineAt);
        const rows = Array.isArray(data) ? data : [];
        return rows.map((row: Raw) => ({
          ...row,
          event_id: row.event_id || event.event_id,
          event_title: row.event_title || event.title,
          series_id: row.series_id || event.series_id,
          exchange: row.exchange || event.exchange || exchange,
          category: row.category || event.category,
        }));
      } catch {
        return [];
      }
    }));
    out.push(...eventMarketBatches.flat());
  }));
  return dedupeMarkets(out
    .map(normalizeOddpoolMarket)
    .filter((m): m is Raw => !!m && !!m.rawId && !!m.title && !marketExpired(m) && marketMatchesIntent(m, query, null)));
}
function flattenPolymarketEvents(events: Raw[] | null | undefined): Raw[] {
  const out: Raw[] = [];
  for (const ev of events || []) {
    const markets = (ev && ev.markets) || [];
    const eventMeta = { ...ev };
    delete eventMeta.markets;
    for (const m of markets) {
      if (!m || m.active === false || m.closed) continue;
      out.push({
        ...m,
        events: [eventMeta],
        eventTags: ev.tags || [],
        tags: m.tags || ev.tags || [],
      });
    }
  }
  return out;
}
async function fetchPolymarketEvents(search: unknown, deadlineAt?: number): Promise<Raw[]> {
  const params = new URLSearchParams({ limit: '200', active: 'true', closed: 'false' });
  // Polymarket's free-text search param is unreliable (it often ignores the term and
  // returns generic high-volume events), so for the categories that overlap HIP-4 we
  // pin the verified tag_id instead. tag_id 102350 = 2026 FIFA World Cup, 100196 =
  // fed-rates, 21 = crypto.
  if (search === 'crypto') params.set('tag_id', '21');
  else if (/world cup|fifa/i.test(String(search))) params.set('tag_id', '102350');
  else if (/\bfed\b|fomc/i.test(String(search))) params.set('tag_id', '100196');
  else if (search) params.set('search', String(search).slice(0, 120));
  const data = await fetchFirstJson([
    sameOriginApi('/api/venues/polymarket-events', params),
    `https://gamma-api.polymarket.com/events?${params.toString()}`,
  ], 6500, deadlineAt) as Raw;
  const arr = Array.isArray(data) ? data : (data && data.events) || [];
  return flattenPolymarketEvents(arr);
}
async function searchPolymarket(query: unknown, deadlineAt?: number): Promise<Raw[]> {
  const params = new URLSearchParams({ limit: '60', active: 'true', closed: 'false' });
  const searches = venueSearchQueries(query);
  const oddpool = await searchOddpool(query, { polymarket: true, kalshi: false }, deadlineAt).catch(() => [] as Raw[]);
  const batches = await Promise.all(searches.map(async (search) => {
    const raw: Raw[] = [];
    try { raw.push(...await fetchPolymarketEvents(search, deadlineAt)); } catch {}
    const p = new URLSearchParams(params);
    if (search) p.set('search', search.slice(0, 120));
    try {
      const data = await fetchFirstJson([
        sameOriginApi('/api/venues/polymarket', p),
        `https://gamma-api.polymarket.com/markets?${p.toString()}`,
      ], 6500, deadlineAt) as Raw;
      raw.push(...(Array.isArray(data) ? data : (data && data.markets) || []));
    } catch {}
    return raw
      .map(normalizePolymarketMarket)
      .filter(m => m.rawId && m.title && !marketExpired(m) && marketMatchesIntent(m, query, search));
  }));
  return dedupeMarkets(oddpool.concat(batches.flat()));
}
function kalshiSeriesForQuery(query: unknown): string[] {
  const q = String(query || '').toLowerCase();
  const series: string[] = [];
  if (/btc|bitcoin/.test(q)) series.push('KXBTCD', 'KXBTC');
  if (/eth|ethereum/.test(q)) series.push('KXETHD');
  if (/sol|solana/.test(q)) series.push('KXSOLD');
  if (/hype|hyperliquid/.test(q)) series.push('KXHYPED');
  if (/world cup|fifa|world-cup/.test(q)) series.push('KXMENWORLDCUP');
  if (/nba|basketball|game/.test(q)) series.push('KXNBAGAME');
  if (/cpi|inflation/.test(q)) series.push('KXCPI');
  if (/fed|fomc|rate|rates/.test(q)) series.push('KXFEDDECISION', 'KXFED');
  if (/macro/.test(q)) series.push('KXCPI', 'KXFEDDECISION', 'KXFED');
  if (/sports/.test(q)) series.push('KXNBAGAME');
  return uniq(series);
}
function flattenKalshiEvents(events: Raw[] | null | undefined): Raw[] {
  const out: Raw[] = [];
  for (const ev of events || []) {
    const markets = (ev && ev.markets) || [];
    const eventMeta = { ...ev };
    delete eventMeta.markets;
    for (const m of markets) {
      // Kalshi reports live nested markets as status 'active' (sometimes 'open'); only
      // terminal states should be dropped. A naive `!== 'open'` filter zeroed out the
      // entire KXBTCD ladder — the intended BTC comparator. Blocklist + null-safe.
      if (!m) continue;
      const mStatus = m.status ? String(m.status).toLowerCase() : '';
      if (['closed', 'settled', 'finalized', 'determined', 'inactive'].includes(mStatus)) continue;
      out.push({
        ...m,
        _event: eventMeta,
        event_ticker: m.event_ticker || ev.event_ticker,
        series_ticker: m.series_ticker || ev.series_ticker,
      });
    }
  }
  return out;
}
async function fetchKalshiSeriesEvents(seriesTicker: unknown, deadlineAt?: number): Promise<Raw[]> {
  const params = new URLSearchParams({
    limit: '100',
    status: 'open',
    with_nested_markets: 'true',
    series_ticker: String(seriesTicker || '').slice(0, 40),
  });
  const data = await fetchFirstJson([
    sameOriginApi('/api/venues/kalshi-events', params),
    `https://external-api.kalshi.com/trade-api/v2/events?${params.toString()}`,
  ], 7500, deadlineAt) as Raw;
  const arr = Array.isArray(data) ? data : (data && data.events) || [];
  return flattenKalshiEvents(arr);
}
async function searchKalshi(query: unknown, deadlineAt?: number): Promise<Raw[]> {
  const params = new URLSearchParams({ limit: '100', status: 'open' });
  const searches = venueSearchQueries(query);
  const series = kalshiSeriesForQuery(query);
  const oddpool = await searchOddpool(query, { polymarket: false, kalshi: true }, deadlineAt).catch(() => [] as Raw[]);
  const eventBatches = await Promise.all(series.map(async (s) => {
    try { return await fetchKalshiSeriesEvents(s, deadlineAt); }
    catch { return []; }
  }));
  const eventMarkets = eventBatches.flat()
    .map(normalizeKalshiMarket)
    .filter(m => m.rawId && m.title && !marketExpired(m) && marketMatchesIntent(m, query, null));
  const batches = await Promise.all(searches.map(async (search) => {
    const p = new URLSearchParams(params);
    if (search) p.set('search', search.slice(0, 120));
    try {
      const data = await fetchFirstJson([
        sameOriginApi('/api/venues/kalshi', p),
        `https://external-api.kalshi.com/trade-api/v2/markets?${p.toString()}`,
      ], 6500, deadlineAt) as Raw;
      const arr = Array.isArray(data) ? data : (data && data.markets) || [];
      return arr
        .map(normalizeKalshiMarket)
        .filter((m: Raw) => m.rawId && m.title && !marketExpired(m) && marketMatchesIntent(m, query, search));
    } catch {
      return [];
    }
  }));
  return dedupeMarkets(oddpool.concat(eventMarkets, batches.flat()));
}
function expiryDeltaDays(a: unknown, b: unknown): number | null {
  if (!a || !b) return null;
  const aa = Date.parse(a as string);
  const bb = Date.parse(b as string);
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return null;
  return Math.abs(aa - bb) / (24 * 60 * 60 * 1000);
}
function marketExpired(market: Raw | null | undefined): boolean {
  if (!market || !market.expiry) return false;
  const expiryMs = Date.parse(market.expiry);
  if (!Number.isFinite(expiryMs)) return false;
  return expiryMs < Date.now() - 60 * 1000;
}
function usableExternalMarket(market: Raw | null | undefined): boolean {
  if (!market || marketExpired(market)) return false;
  if (normalizeProbability(market) == null) return false;
  const spread = computeSpread(market);
  const depth = safeNum(market.depthUsd);
  const volume = safeNum(market.volumeUsd);
  // Dead book: no depth, no volume, AND no positive two-sided quote — it carries no real
  // price signal whatever mid was computed, so it must never become a comparator (this is
  // the root of the fabricated 99% / 47¢ phantom edges).
  const yesAskNum = safeNum(market.yesAsk);
  const hasQuote = safeNum(market.yesBid) != null && yesAskNum != null && yesAskNum > 0;
  // Venue REPORTS zero depth AND zero traded volume → dead book, ignore any placeholder
  // quote (a Kalshi rung can show bid>0/ask=1.00 with nothing actually resting).
  if (depth != null && depth <= 0 && volume != null && volume <= 0) return false;
  // Unknown liquidity (nulls) with no real two-sided quote → also unusable.
  if ((depth == null || depth <= 0) && (volume == null || volume <= 0) && !hasQuote) return false;
  if (spread != null && spread >= 0.5) return false;
  if ((depth != null && depth <= 0) && (volume != null && volume <= 0) && spread != null && spread >= 0.25) return false;
  return true;
}
function strictComparatorFailure(a: Raw | null | undefined, b: Raw | null | undefined): string | null {
  if (!a || !b) return 'missing_market';
  if (a.underlying && b.underlying !== a.underlying) return 'underlying_mismatch';
  const baseKind = a.derivativeKind || (a.direction && a.strike != null ? 'settlement' : null);
  const compKind = b.derivativeKind || null;
  const baseIsPrice = !!(a.underlying && baseKind && (a.direction || a.lowerStrike != null || a.upperStrike != null));
  if (!baseIsPrice) {
    // Resolution-scope guard for non-price (sports/narrative) bases: a head-to-head MATCH
    // ("Spain vs Cape Verde") and an outright TOURNAMENT-WINNER ("Spain to win the World
    // Cup") are different questions even when they share a team name — never match them.
    const isMatch = (m: Raw | null | undefined) => /\s+vs\.?\s+|\bv\.\b/i.test(String((m && m.title) || ''));
    const isOutright = (m: Raw | null | undefined) => /\b(to win|winner|win the|champion)\b/i.test(String((m && m.title) || ''));
    if (isMatch(a) !== isMatch(b)) return 'resolution_scope_mismatch';
    if (isOutright(a) && isMatch(b)) return 'resolution_scope_mismatch';
    return null;
  }
  if (!compKind) return 'external_contract_type_missing';
  if (baseKind !== compKind) return 'contract_type_mismatch';
  if (a.direction && !b.direction) return 'external_direction_missing';
  if (a.direction && b.direction && a.direction !== b.direction) return 'direction_mismatch';

  if (a.direction === 'range') {
    const lo = strikeDistancePct(a.lowerStrike, b.lowerStrike);
    const hi = strikeDistancePct(a.upperStrike, b.upperStrike);
    if (lo == null || hi == null) return 'range_bounds_missing';
    if (lo > 0.015 || hi > 0.015) return 'range_bounds_mismatch';
  } else if (a.strike != null) {
    const diff = strikeDistancePct(a.strike, b.strike);
    if (diff == null) return 'external_strike_missing';
    if (diff > 0.025) return 'strike_mismatch';
  }

  if (a.expiry) {
    const days = expiryDeltaDays(a.expiry, b.expiry);
    if (days == null) return 'external_expiry_missing';
    if (days > 1) return 'expiry_mismatch';
  }
  return null;
}
// Two tournament-WINNER outrights for the SAME team are the same bet across venues even when
// each phrases it differently ("2026 World Cup Champion · France" ↔ "Will France win the 2026
// FIFA World Cup?") and lists a slightly different settle date. The generic title/expiry
// scorer lands them just under 'high' (the expiry-date noise costs them ~0.16), so they never
// become a comparator. Recognise the case explicitly. Excludes props/awards/group/stage bets,
// and requires the SAME team — so it can never match France-champion to a Spain market.
const OUTRIGHT_COMP_RE = /\b(world cup|fifa|champions league|euros?|copa|super bowl|nba (finals?|championship)|world series|stanley cup|premier league|la liga)\b/i;
const OUTRIGHT_WIN_RE = /\b(champion|winner|win the|to win|lift the|wins? the|be crowned)\b/i;
const OUTRIGHT_PROP_RE = /\b(fair play|golden boot|golden ball|top scorer|player of|best player|award|group [a-z]\b|reach|advance|make (it|the)|qualif|semi[- ]?final|quarter[- ]?final|round of|knockout|group stage|\bhost\b|attendance|red card|penalt|clean sheet|own goal)\b/i;
const OUTRIGHT_TEAM_ALIAS: Record<string, string> = { 'korea republic': 'south korea', usa: 'united states', turkiye: 'turkey', czechia: 'czech republic', 'congo dr': 'dr congo', 'cape verde islands': 'cape verde', 'ivory coast': 'cote divoire' };
function normTeamLabel(s: unknown): string {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function outrightWinnerTeam(m: Raw | null | undefined): string | null {
  const t = String((m && m.title) || '');
  if (!OUTRIGHT_COMP_RE.test(t) || !OUTRIGHT_WIN_RE.test(t) || OUTRIGHT_PROP_RE.test(t)) return null;
  const lab = String((m && m.outcomeLabel) || '').trim();
  let team: string | null = (lab && lab.length >= 3 && !/^(yes|no|other|field|draw|the field|tbd)$/i.test(lab)) ? lab : null;
  if (!team) {
    const mm = /\bwill\s+(.+?)\s+(?:win|lift|be crowned)\b/i.exec(t) || /[·:\-]\s*([A-Z][A-Za-z .'’-]{2,})\s*$/.exec(t);
    team = mm ? mm[1]! : null;
  }
  if (!team) return null;
  const n = normTeamLabel(team);
  return n ? (OUTRIGHT_TEAM_ALIAS[n] || n) : null;
}
function sameOutrightWinner(a: Raw | null | undefined, b: Raw | null | undefined): boolean {
  const ta = outrightWinnerTeam(a), tb = outrightWinnerTeam(b);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  return ta.length >= 5 && tb.length >= 5 && (ta.includes(tb) || tb.includes(ta));
}
interface EquivalenceResult {
  confidence: 'low' | 'medium' | 'high';
  score: number;
  reasons: string[];
}
function scoreResolutionEquivalence(a: Raw | null | undefined, b: Raw | null | undefined): EquivalenceResult {
  if (!a || !b) return { confidence: 'low', score: 0, reasons: ['missing_market'] };
  const hardFail = strictComparatorFailure(a, b);
  if (hardFail) return { confidence: 'low', score: 0, reasons: [hardFail] };
  // Same-team tournament outright across venues — the same bet; don't let differing settle
  // dates demote it below 'high' (the BTC-vs-Kalshi maturity case, for sports outrights).
  if (sameOutrightWinner(a, b)) {
    const s = textSimilarity(a.title, b.title);
    return { confidence: 'high', score: Math.max(0.8, s), reasons: [`title_similarity_${s.toFixed(2)}`, 'same_outright_winner'] };
  }
  const sim = textSimilarity(a.title, b.title);
  const days = expiryDeltaDays(a.expiry, b.expiry);
  const sameUnderlying = a.underlying && b.underlying && a.underlying === b.underlying;
  const sameCategory = a.category && b.category && a.category === b.category;
  const sameDirection = a.direction && b.direction && a.direction === b.direction;
  const directionMismatch = a.direction && b.direction && a.direction !== b.direction;
  const strikeDiff = strikeDistancePct(a.strike, b.strike);
  const hasRules = !!(a.rulesText && b.rulesText);
  const sameKind = a.derivativeKind && b.derivativeKind && a.derivativeKind === b.derivativeKind;
  let score = sim;
  const reasons = [`title_similarity_${sim.toFixed(2)}`];
  if (sameUnderlying) { score += 0.22; reasons.push('same_underlying'); }
  else if (sameCategory) { score += 0.08; reasons.push('same_category'); }
  if (sameKind) { score += 0.12; reasons.push('same_contract_type'); }
  if (sameDirection) { score += 0.14; reasons.push('same_direction'); }
  else if (directionMismatch) { score -= 0.22; reasons.push('direction_mismatch'); }
  if (strikeDiff == null) reasons.push('strike_missing');
  else if (strikeDiff <= 0.005) { score += 0.22; reasons.push('strike_exact'); }
  else if (strikeDiff <= 0.01) { score += 0.16; reasons.push('strike_close'); }
  else if (strikeDiff <= 0.025) { score += 0.06; reasons.push('strike_near'); }
  else { score -= 0.18; reasons.push('strike_mismatch'); }
  if (days == null) reasons.push('expiry_missing');
  else if (days <= 0.25) { score += 0.22; reasons.push('expiry_close'); }
  else if (days <= 1) { score += 0.08; reasons.push('expiry_near'); }
  else { score -= 0.16; reasons.push('expiry_mismatch'); }
  if (hasRules) { score += 0.08; reasons.push('rules_available'); }
  else { score -= 0.10; reasons.push('rules_missing'); }
  score = Math.max(0, Math.min(1, score));
  const confidence: EquivalenceResult['confidence'] = score >= 0.68 ? 'high' : score >= 0.42 ? 'medium' : 'low';
  return { confidence, score, reasons };
}
// Whether `comp` is the SAME tradable contract as `base` for a directional price binary —
// close enough that a YES-price difference is a real edge and not just strike/time
// curvature. For a near-dated binary even a sub-1% strike gap (or a few hours of
// settlement drift) moves the fair price more than any plausible edge: that gamma/theta
// effect is exactly what makes a "53% vs 9%" cross-venue read meaningless when the strikes
// are $62k vs $62.7k. So a tradable twin needs a near-exact strike AND settlement. The
// strict equivalence gate alone (2.5% strike / 1 day) is too loose here and would tag a
// pure-curvature gap as a high-confidence edge. Non-price (narrative) bases are governed by
// title equivalence elsewhere, so this gate passes them through unchanged.
function isTradablePriceTwin(base: Raw | null | undefined, comp: Raw | null | undefined): boolean {
  if (!base || !comp) return false;
  // A crypto/price base with NO strike is a residual "Other / field" bucket — it has no
  // defined threshold, so nothing is its tradable twin (this stopped a fabricated ~49% gap).
  if ((base.category === 'crypto' || base.underlying) && base.strike == null && base.lowerStrike == null && base.upperStrike == null) return false;
  const baseIsDirectionalPrice = !!(base.underlying && base.strike != null && base.direction && base.direction !== 'range');
  if (!baseIsDirectionalPrice) return true;
  const sd = strikeDistancePct(base.strike, comp.strike);
  if (sd == null || sd > 0.003) return false;
  if (base.expiry && comp.expiry) {
    const dd = expiryDeltaDays(base.expiry, comp.expiry);
    if (dd == null || dd > 0.25) return false;
    // Near expiry, even a few hours' settlement offset is a large fraction of remaining
    // life and moves fair value more than any edge — not a clean twin.
    const tteDays = (Date.parse(base.expiry) - Date.now()) / 864e5;
    if (Number.isFinite(tteDays) && tteDays > 0 && dd > tteDays * 0.5) return false;
  }
  return true;
}
interface MispricingResult {
  delta: number | null;
  adjustedDelta: number | null;
  caveats: string[];
}
function computeMispricing(base: Raw, comp: Raw): MispricingResult {
  const bp = normalizeProbability(base);
  const cp = normalizeProbability(comp);
  const caveats: string[] = [];
  if (bp == null || cp == null) return { delta: null, adjustedDelta: null, caveats: ['missing_normalized_price'] };
  const rawDelta = bp - cp;
  const baseSpread = computeSpread(base);
  const compSpread = computeSpread(comp);
  const spreadPenalty = ((baseSpread || 0.04) + (compSpread || 0.04)) / 2;
  if (baseSpread == null) caveats.push('base_spread_unavailable');
  if (compSpread == null) caveats.push('comp_spread_unavailable');
  if (base.depthUsd == null) caveats.push('base_depth_unavailable');
  if (comp.depthUsd == null) caveats.push('comp_depth_unavailable');
  const adjusted = Math.sign(rawDelta) * Math.max(0, Math.abs(rawDelta) - spreadPenalty);
  return { delta: rawDelta, adjustedDelta: adjusted, caveats };
}
function comparisonSortScore(base: Raw | null | undefined, item: { mp: MispricingResult; comp: Raw; eq: EquivalenceResult }): number {
  const adjusted = Math.abs(item.mp.adjustedDelta || item.mp.delta || 0);
  const strikeDiff = strikeDistancePct(base && base.strike, item.comp && item.comp.strike);
  const strikeComponent = strikeDiff == null ? 0 : Math.max(0, 1 - Math.min(1, strikeDiff / 0.05));
  // Liquidity preference: venues often list DUPLICATE markets for the same outright (a thin
  // one priced off the canonical one). Reward the deeper/more-traded comp so we surface the
  // real venue level, not a stale duplicate whose apparent gap is just an artifact — and so
  // the gap term below can't make us prefer the duplicate purely because its gap is bigger.
  const liq = safeNum(item.comp && (item.comp.volumeUsd != null ? item.comp.volumeUsd : item.comp.depthUsd));
  const liqComponent = liq != null && liq > 0 ? Math.min(1, Math.log10(1 + liq) / 6) : 0;
  return item.eq.score * 5 + strikeComponent * 2 + liqComponent * 1.5 + Math.min(0.2, adjusted);
}
interface HedgeCandidate {
  symbol: string;
  kind: 'perp' | 'spot';
  mid: number | null;
  fundingRate: number | null;
  openInterestUsd: number | null;
  available: boolean;
  reason: string;
}
function findHedgeCandidates(market: Raw | null | undefined, snap: Raw | null | undefined): HedgeCandidate[] {
  const sym = market && market.underlying;
  if (!sym || !HEDGE_SYMBOLS.includes(sym)) {
    return [{
      symbol: '—',
      kind: 'perp',
      mid: null,
      fundingRate: null,
      openInterestUsd: null,
      available: false,
      reason: 'No direct Hyperliquid spot/perp hedge mapped to this event.',
    }];
  }
  const mid = snap && snap.coinMids && safeNum(snap.coinMids[sym]);
  return [
    {
      symbol: sym,
      kind: 'perp',
      mid: mid ?? null,
      fundingRate: null,
      openInterestUsd: null,
      available: mid != null,
      reason: mid != null ? 'Live Hyperliquid reference mid available.' : 'HL reference mid unavailable in this browser session.',
    },
    {
      symbol: sym,
      kind: 'spot',
      mid: mid ?? null,
      fundingRate: null,
      openInterestUsd: null,
      available: mid != null,
      reason: mid != null ? 'Spot/perp exposure can reduce underlying price beta, but not event settlement risk.' : 'Spot reference unavailable.',
    },
  ];
}
function classifyRoute(query: unknown, mode: unknown): RouteId {
  const explicitRoute = playbooksRouteFromMode(mode);
  if (explicitRoute) return explicitRoute;
  const q = String(query || '').toLowerCase();
  // A deep dive pulls everything (book + cross-venue + options) — reuse the mispricing
  // assembly; the report shape comes from the prompt.
  if (/\bdeep (dive|research)\b|full (report|analysis|breakdown)|tell me everything/.test(q)) return ROUTES.MISPRICING;
  if (/mispric|compare|polymarket|kalshi|discrepanc|arb/.test(q)) return ROUTES.MISPRICING;
  if (/hedg|perp|spot|basis/.test(q)) return ROUTES.HEDGE;
  if (/\b(manage|review|rebalance|check) (my )?(open )?(positions?|portfolio|book)\b|\bmy (positions?|portfolio|holdings?|book)\b|\bopen positions?\b|what should i do with (my|this|these|the)|near settlement\b/.test(q)) return ROUTES.RISK;
  if (/\b(setup|trade setup|trade idea|position plan|entry|take profit|what should i trade|what to trade)\b/.test(q)) return ROUTES.SETUP;
  if (/risk|why.*not|caveat|explain/.test(q)) return ROUTES.RISK;
  if (/changed|still valid|follow/.test(q)) return ROUTES.FOLLOWUP;
  if (/best|opportun|scan|find/.test(q)) return ROUTES.OPPORTUNITY;
  return ROUTES.STRATEGY;
}
function rankMarkets(markets: Raw[], query: unknown): Raw[] {
  const q = String(query || '');
  return markets.slice().sort((a, b) => {
    const av = (a.volumeUsd || 0) / 100000;
    const bv = (b.volumeUsd || 0) / 100000;
    const ad = (a.depthUsd || 0) / 1000;
    const bd = (b.depthUsd || 0) / 1000;
    const as = textSimilarity(q, a.title);
    const bs = textSimilarity(q, b.title);
    return (bs * 10 + bv + bd) - (as * 10 + av + ad);
  });
}
function compactExternalMarket(m: Raw, extra?: Raw | null): Raw {
  return {
    venue: m.venue,
    id: m.id,
    rawId: m.rawId,
    title: m.title,
    yesMid: normalizeProbability(m),
    yesBid: m.yesBid,
    yesAsk: m.yesAsk,
    spread: computeSpread(m),
    depthUsd: m.depthUsd,
    volumeUsd: m.volumeUsd,
    expiry: m.expiry,
    url: m.url,
    equivalenceHint: (extra && extra.equivalenceHint) || 'unscored',
    matchedBaseTitle: (extra && extra.matchedBaseTitle) || null,
    mismatchNote: (extra && extra.mismatchNote) || null,
    normalizedDelta: extra && extra.normalizedDelta != null ? extra.normalizedDelta : null,
    equivalenceReasons: (extra && extra.equivalenceReasons) || [],
  };
}
function refStrikeLabel(v: unknown): string | null {
  const n = Number(v);
  return Number.isFinite(n) ? '$' + Math.round(n).toLocaleString() : null;
}
function refDateLabel(iso: unknown): string | null {
  const ms = Date.parse(iso as string);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCDate()}`;
}
// A looser score than scoreResolutionEquivalence (which hard-fails on date/strike
// mismatch). Used only to rank "loose references" — the closest related markets to
// show when there is no high-confidence comparator — and to caption how they differ.
// Loose-reference gate. Includes 'contract_type_mismatch' so a same-underlying price
// binary of a DIFFERENT kind (e.g. a Polymarket "touch $X" or a Kalshi settle-at-a-
// different-time) still surfaces as a caveated reference instead of vanishing — the
// strike/date sanity bands below keep far-off markets out. Deliberately NOT including
// 'external_contract_type_missing': that fires for strikeless narrative bets ("a country
// buys Bitcoin", "BTC ATH") which have no structural gate and would leak in as junk.
const REFERENCE_ALLOWED_FAILS = new Set<string | null>([null, 'strike_mismatch', 'expiry_mismatch', 'contract_type_mismatch']);
function referenceRelevance(base: Raw | null | undefined, comp: Raw | null | undefined): { score: number; notes: string[] } | null {
  if (!base || !comp) return null;
  // Reuse the strict gate, but treat ONLY strike/date differences as "loose". Any
  // other failure (different underlying, contract type, direction, missing fields)
  // means it is not the same kind of market, so it is not a reference at all. This
  // keeps narrative bets ("will X hold BTC", "$1m before GTA VI") and unrelated
  // markets out of the reference list.
  const fail = strictComparatorFailure(base, comp);
  if (!REFERENCE_ALLOWED_FAILS.has(fail)) return null;
  // A contract-TYPE mismatch is only a valid loose reference when the comp is itself a
  // real strike-based price market (e.g. a "touch $X" vs our "settle above $X") — its
  // strike then flows into the sanity band below. A strikeless kind (updown / 5-min
  // momentum / narrative) is NOT a comparator and must not slip through the band, which
  // is skipped when comp.strike is null.
  if (fail === 'contract_type_mismatch' && !(comp.underlying && comp.strike != null && comp.direction)) return null;
  // Price markets are gated structurally above (same underlying/type/direction).
  // Narrative markets (no strike) have no structural gate, so require a real
  // semantic title match — otherwise "June Fed rate change" pulls in "Macron out".
  // A prop / commentary market ("what will the announcers say during Sweden vs Tunisia",
  // total goals, cards, corners…) is NOT an outcome comparator for a winner/match base —
  // it just shares team names. Drop it unless the base is itself that prop.
  const PROP_RE = /\b(announc|how many|number of|total (goals|points|cards|corners)|corners?|bookings?|first (goal|scorer|to score)|man of the match|half[- ]?time|yellow card|red card|own goal|clean sheet|to score|margin)\b/i;
  if (PROP_RE.test(String(comp.title || '')) && !PROP_RE.test(String(base.title || ''))) return null;
  const baseIsPrice = !!(base.underlying && base.strike != null);
  const titleSim = textSimilarity(base.title, comp.title);
  // Strikeless macro/event bases (e.g. "June Fed rate change") rarely share enough raw
  // title cosine with a venue's differently-phrased same-event market ("Fed decision in
  // June", "Fed maintains rate"), so a flat 0.4 gate drops a real comparator. Allow when
  // both clearly reference the same macro event family.
  const macroSameEvent = !baseIsPrice && [
    /\b(fed|fomc|federal funds|federal reserve|rate (decision|change|cut|hike)|interest rate)\b/i,
    /\b(cpi|inflation)\b/i,
  ].some(re => re.test(String(base.title || '')) && re.test(String(comp.title || '')));
  if (!baseIsPrice && titleSim < 0.4 && !macroSameEvent) return null;
  const strikeDiff = strikeDistancePct(base.strike, comp.strike);
  const days = expiryDeltaDays(base.expiry, comp.expiry);
  // Sanity bands: a $1m strike or a six-months-out market is never a "close" read.
  if (base.strike != null && comp.strike != null && (strikeDiff == null || strikeDiff > 0.5)) return null;
  if (base.expiry && comp.expiry && (days == null || days > 21)) return null;
  let score = 1 - Math.min(0.6, (strikeDiff || 0)) - Math.min(0.4, (days || 0) * 0.02);
  const notes: string[] = [];
  if (strikeDiff != null && strikeDiff > 0.012) {
    const a = refStrikeLabel(comp.strike); const b = refStrikeLabel(base.strike);
    if (a && b) notes.push(`strike ${a} vs ${b}`);
  }
  if (days != null && days > 1) {
    const a = refDateLabel(comp.expiry); const b = refDateLabel(base.expiry);
    if (a && b) notes.push(`settles ${a} vs ${b}`);
  }
  return { score, notes };
}
function rankComparableExternalMarkets(baseMarkets: Raw[] | null | undefined, markets: Raw[] | null | undefined, maxCount?: number): Raw[] {
  const bestByComp = new Map<string, { comp: Raw; base: Raw; eq: EquivalenceResult; rel: { score: number; notes: string[] } }>();
  for (const comp of markets || []) {
    for (const base of baseMarkets || []) {
      const rel = referenceRelevance(base, comp);
      if (!rel) continue;
      const eq = scoreResolutionEquivalence(base, comp);
      const key = comp.id || comp.rawId || `${comp.venue}:${comp.title}`;
      const prev = bestByComp.get(key);
      const next = { comp, base, eq, rel };
      if (!prev || rel.score > prev.rel.score) bestByComp.set(key, next);
    }
  }
  // Venue-balanced selection: round-robin across venues so one source (e.g. Polymarket
  // flooded in via the aggregator) can't monopolize the top-N and crowd the other out.
  // A "compare vs Kalshi" query must actually carry Kalshi references when they exist.
  const sortedRefs = Array.from(bestByComp.values()).sort((a, b) => b.rel.score - a.rel.score);
  const byVenue = new Map<string, typeof sortedRefs>();
  for (const m of sortedRefs) {
    const v = (m.comp && m.comp.venue) || 'other';
    if (!byVenue.has(v)) byVenue.set(v, []);
    byVenue.get(v)!.push(m);
  }
  const venueLists = Array.from(byVenue.values());
  const balanced: typeof sortedRefs = [];
  const cap = maxCount || 8;
  for (let r = 0; balanced.length < cap && venueLists.some(l => l.length); r++) {
    const l = venueLists[r % venueLists.length]!;
    if (l.length) balanced.push(l.shift()!);
  }
  return balanced
    .map(m => {
      const twin = isTradablePriceTwin(m.base, m.comp);
      const tradable = m.eq.confidence === 'high' && twin;
      const mp = tradable ? computeMispricing(m.base, m.comp) : null;
      // A price binary that is structurally high-confidence but not a tradable twin (its
      // strike or settlement differs enough that the price gap is curvature, not edge) is
      // capped at 'medium' so the answer layer narrates it as a reference, never an edge.
      const baseIsDirectionalPrice = !!(m.base && m.base.underlying && m.base.strike != null && m.base.direction && m.base.direction !== 'range');
      const hint = (baseIsDirectionalPrice && m.eq.confidence === 'high' && !twin) ? 'medium' : m.eq.confidence;
      const notes = (m.rel.notes || []).slice();
      if (baseIsDirectionalPrice && !twin && !notes.length) {
        // Guarantee the gap is visible even when it falls below referenceRelevance's note
        // bands, so a downgraded match always explains why it is a reference not an edge.
        const sd = strikeDistancePct(m.base.strike, m.comp.strike);
        if (sd != null && sd > 0.003) { const a = refStrikeLabel(m.comp.strike), b = refStrikeLabel(m.base.strike); if (a && b) notes.push(`strike ${a} vs ${b}`); }
        const dd = expiryDeltaDays(m.base.expiry, m.comp.expiry);
        if (dd != null && dd > 0.25) notes.push(dd <= 1 ? `settles ~${Math.round(dd * 24)}h apart` : `settles ${refDateLabel(m.comp.expiry)} vs ${refDateLabel(m.base.expiry)}`);
      }
      return compactExternalMarket(m.comp, {
        equivalenceHint: hint,
        matchedBaseTitle: m.base && m.base.title,
        // Only a tradable twin carries a price gap. References (loose or downgraded) never
        // do, so the answer layer cannot narrate a non-comparable market as an edge.
        normalizedDelta: tradable && mp ? mp.delta : null,
        mismatchNote: notes.join(' · ') || null,
        equivalenceReasons: m.eq && m.eq.reasons,
      });
    });
}
function selectBaseMarkets(markets: Raw[], query: unknown, activeMarketId: unknown, maxCount?: number): Raw[] {
  if (activeMarketId) {
    const exact = markets.find(m => m.id === activeMarketId || String(m.rawId) === String(activeMarketId));
    if (exact) return [exact];
  }
  const scoped = filterMarketsByIntent(markets, query);
  const ranked = rankMarkets(scoped.length ? scoped : markets, query);
  return ranked.slice(0, maxCount || 8);
}
function wantsEventSuggestions(query: unknown): boolean {
  return /\b(each|every|listed|individual|all)\b.*\b(event|market|question|match|game|fixture|matchup)s?\b|\b(event[- ]by[- ]event|per event|per match|per game|for each event|for each listed)\b|\b[a-z]+ vs\.? [a-z]+\b/i.test(String(query || ''));
}
function marketActionabilityScore(market: Raw | null | undefined, query: unknown): number {
  const p = normalizeProbability(market);
  const spread = computeSpread(market);
  const depth = market && market.depthUsd;
  const vol = market && market.volumeUsd;
  let score = textSimilarity(query || '', market && market.title) * 8;
  if (p != null) score += 3;
  if (spread != null) score += Math.max(0, 3 - spread * 30);
  if (depth != null) score += Math.log10(1 + Math.max(0, depth)) * 1.2;
  if (vol != null) score += Math.log10(1 + Math.max(0, vol)) * 0.8;
  if (p != null && p > 0.03 && p < 0.97) score += 1;
  return score;
}
// Opportunity ranking: surface the most TRADEABLE markets, not the highest-volume. Weighs a tight
// spread (can you actually execute) and a live, non-degenerate prob-band hardest, and CAPS the
// depth/volume logs so a wide-spread whale cannot dominate a tight, liquid market.
function opportunityScore(market: Raw | null | undefined, query: unknown): number {
  const p = normalizeProbability(market);
  const spread = computeSpread(market);
  const depth = safeNum(market && market.depthUsd);
  const vol = safeNum(market && market.volumeUsd);
  let score = textSimilarity(query || '', market && market.title) * 6;
  if (spread != null) score += Math.max(0, 6 - spread * 80); // 6 at 0c, ~0 by 7.5c
  else score -= 2;                                            // unknown spread: can't trust execution
  if (depth != null) score += Math.min(4, Math.log10(1 + Math.max(0, depth)) * 1.0);
  if (vol != null) score += Math.min(2.5, Math.log10(1 + Math.max(0, vol)) * 0.6);
  if (p != null && p > 0.05 && p < 0.95) score += 2; else if (p != null) score -= 2;
  return score;
}
function opportunityWhy(market: Raw | null | undefined): string | null {
  const p = normalizeProbability(market);
  const spread = computeSpread(market);
  const depth = safeNum(market && market.depthUsd);
  const bits: string[] = [];
  if (spread != null) bits.push(`${fmtCents(spread)} spread`);
  if (depth != null) bits.push(`${fmtUsd(depth)} depth`);
  if (p != null) bits.push(`YES ${fmtCents(p)}`);
  return bits.join(', ') || null;
}
function selectOpportunityMarkets(markets: Raw[] | null | undefined, query: unknown, activeMarketId: unknown, maxCount?: number): Raw[] {
  if (activeMarketId) {
    const exact = (markets || []).find(m => m.id === activeMarketId || String(m.rawId) === String(activeMarketId));
    if (exact) return [exact];
  }
  // "Best setup anywhere" scans the FULL live set; a topic query narrows it via intent first.
  const scoped = filterMarketsByIntent(markets, query);
  const pool = (scoped && scoped.length) ? scoped : (markets || []);
  return pool.slice().sort((a, b) => opportunityScore(b, query) - opportunityScore(a, query)).slice(0, maxCount || 8);
}
function selectEventMarkets(markets: Raw[], query: unknown, activeMarketId: unknown, maxCount?: number): Raw[] {
  if (activeMarketId) return selectBaseMarkets(markets, query, activeMarketId, 1);
  const scoped = filterMarketsByIntent(markets, query);
  const pool = scoped.length ? scoped : markets || [];
  const groups = new Map<unknown, Raw[]>();
  for (const m of pool) {
    const key = m.eventId || m.groupId || m.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const selected: Raw[] = [];
  for (const xs of groups.values()) {
    const ranked = xs.slice().sort((a, b) => marketActionabilityScore(b, query) - marketActionabilityScore(a, query));
    if (ranked[0]) selected.push({
      market: ranked[0],
      alternatives: ranked.slice(1, 4),
      eventSize: ranked.length,
    });
  }
  return selected
    .sort((a, b) => marketActionabilityScore(b.market, query) - marketActionabilityScore(a.market, query))
    .slice(0, maxCount || 8);
}
function suggestedSideForMarket(_market: Raw | null | undefined, query: unknown): 'YES' | 'NO' {
  const q = String(query || '').toLowerCase();
  // Honor an explicit directional ask; otherwise default to YES (we hold no fair-value
  // view that would justify auto-picking the fade).
  if (/\b(buy|take|go)\s+yes\b|\byes\s+side\b/.test(q)) return 'YES';
  if (/\b(no\b|sell|short|fade|against|bet against)\b/.test(q) && !/\byes\b/.test(q)) return 'NO';
  return 'YES';
}
function executableSidePrice(market: Raw | null | undefined, side: unknown): number | null {
  if (!market) return null;
  const yes = side !== 'NO';
  if (yes && safeNum(market.yesAsk) != null) return clamp(market.yesAsk, 0, 1);
  if (!yes && safeNum(market.noAsk) != null) return clamp(market.noAsk, 0, 1);
  const p = normalizeProbability(market);
  if (p == null) return null;
  return yes ? p : clamp(1 - p, 0, 1);
}
function setupSizeGuidance(market: Raw | null | undefined): string {
  const spread = computeSpread(market);
  const depth = market && safeNum(market.depthUsd);
  if (spread == null || depth == null) return 'Starter size only until spread and visible depth are clear.';
  if (depth < 50) return `Top-of-book is only ${fmtUsd(depth)} — watch-only, not tradable for real size.`;
  if (spread > 0.12 || depth < 300) return 'Small starter only; the book is too thin to add into.';
  if (spread > 0.07 || depth < 1000) return 'Small starter size; add only if the book stays firm.';
  return 'Normal starter size; stay below visible top-of-book depth.';
}
interface ExitPlan {
  maxPay: number;
  take: number;
  reduce: number;
  entryText: string;
  manageText: string;
}
function setupExitPlan(entry: number | null, _spread: number | null): ExitPlan | string {
  if (entry == null) return 'No live entry price, so this is watch-only.';
  // Exits must scale with entry across the whole range. Take-profit is strictly ABOVE
  // entry (a multiple of price for longshots, capped near $1 for favorites); stop is a
  // proportional drawdown floored by an absolute cap so a favorite isn't stopped 40c away.
  // All bounds entry-relative with NO absolute floors that can invert: take strictly in
  // (entry, 1), stop strictly in (0, entry), maxPay strictly in (entry, take). This kills
  // "take profit near 100.4%" on favorites and "stop above entry" on deep longshots.
  const room = Math.max(0, 1 - entry);
  // Ceiling = 0.9 + 0.1*entry is PROVABLY strictly in (entry, 1) for every entry in (0,1)
  // — no upward room floor that could push it past 1.0 at entries like 0.99999 (both a
  // flat 0.999 ceiling AND a floored-room ceiling inverted there: "pay 100.0%, take 99.9%").
  const ceiling = 0.9 + 0.1 * entry;
  let take = Math.min(ceiling, Math.max(entry * 1.2, Math.min(entry * 1.5, entry + room * 0.6)));
  take = Math.max(take, Math.min(ceiling, entry + room * 0.05));
  const reduce = Math.max(entry * 0.5, Math.min(entry * 0.97, entry - Math.min(0.12, entry * 0.4)));
  const maxPay = Math.min(entry + (take - entry) * 0.4, entry + 0.03, take - (take - entry) * 0.1);
  return {
    maxPay,
    take,
    reduce,
    entryText: `Buy only if you can pay about ${fmtCents(entry)}-${fmtCents(maxPay)}.`,
    manageText: `Consider taking some off near ${fmtCents(take)} or reducing if it trades below ${fmtCents(reduce)}.`,
  };
}
function buildTradePlan(market: Raw | null | undefined, side: unknown): Raw {
  const entry = executableSidePrice(market, side);
  const spread = computeSpread(market);
  const exit = setupExitPlan(entry, spread);
  if (!exit || typeof exit !== 'object') {
    return {
      side,
      entryPrice: null,
      maxEntryPrice: null,
      reducePrice: null,
      exitPrice: null,
      takeProfitPrice: null,
      entryText: 'No live entry price, so this is watch-only.',
      exitText: 'Wait for a live executable price before setting an exit.',
      takeProfitText: 'Wait for a live executable price before setting a take-profit.',
      manageText: 'Wait for a live executable price before sizing.',
    };
  }
  return {
    side,
    entryPrice: entry,
    maxEntryPrice: exit.maxPay,
    reducePrice: exit.reduce,
    exitPrice: exit.reduce,
    takeProfitPrice: exit.take,
    entryText: exit.entryText,
    exitText: `Reduce or exit if it trades below ${fmtCents(exit.reduce)}.`,
    takeProfitText: `Take profit near ${fmtCents(exit.take)}.`,
    manageText: exit.manageText,
  };
}
function buildSetupPlan(market: Raw | null | undefined, side: unknown, tradeCall: Raw | null | undefined, hedge: HedgeCandidate | null | undefined, hedgeDirection: unknown): Raw {
  const p = normalizeProbability(market);
  const spread = computeSpread(market);
  const tradePlan = buildTradePlan(market, side);
  const entry = tradePlan.entryPrice;
  const hedgeText = hedge && hedge.available && hedgeDirection !== 'none'
    ? `${hedgeDirection} ${hedge.symbol} ${hedge.kind} can soften the price move, but the outcome still settles separately.`
    : 'No clean HL hedge is mapped; treat this as direct event exposure.';
  const whyWorks = [
    p != null ? `Live book is showing ${side} around ${fmtCents(entry != null ? entry : p)}.` : 'No live price yet.',
    spread != null && spread <= 0.07 ? `Spread is reasonable for a small ticket at ${fmtCents(spread)}.` : spread != null ? `Spread is still wide at ${fmtCents(spread)}, so be picky on entry.` : 'Spread is not visible.',
    market && market.underlying ? `${market.underlying} can be watched or hedged on Hyperliquid while the market trades.` : 'The event is simple to understand, but harder to hedge.',
  ];
  const whyFails = [
    'If the event resolves against this side, contracts can go to zero.',
    market && market.depthUsd != null ? `Visible depth is about ${fmtUsd(market.depthUsd)}, so large orders can move price.` : 'Depth is not visible, so size should stay small.',
    'Rules, timing, and final settlement source matter more as expiry gets close.',
  ];
  return {
    side,
    entryPrice: entry,
    maxEntryPrice: tradePlan.maxEntryPrice,
    takeProfitPrice: tradePlan.takeProfitPrice,
    reducePrice: tradePlan.reducePrice,
    entry: tradePlan.entryText,
    size: setupSizeGuidance(market),
    manage: tradePlan.manageText,
    hedge: hedgeText,
    whyWorks,
    whyFails,
    plainRead: (tradeCall && tradeCall.label) ? tradeCall.label : 'Review setup',
  };
}
function hedgeDirectionForMarket(market: Raw | null | undefined, side: unknown): 'short' | 'long' | 'none' {
  if (!market || !market.underlying) return 'none';
  const yes = side !== 'NO';
  if (market.direction === 'above') return yes ? 'short' : 'long';
  if (market.direction === 'below') return yes ? 'long' : 'short';
  return 'none';
}
interface TradeCall { label: string; reason: string }
function tradeCallForMarket(market: Raw | null | undefined, side: unknown): TradeCall {
  const p = normalizeProbability(market);
  const spread = computeSpread(market);
  const depth = market && market.depthUsd;
  if (p == null) return { label: 'Watch only', reason: 'No live executable price.' };
  // A near-resolved favorite (or near-zero longshot) has no tradeable upside left — paying
  // ~100c to win ~100c is zero/negative EV, so it must never be an actionable buy.
  if (p >= 0.985 || p <= 0.015) return { label: `Watch ${side}`, reason: `Live price is ${fmtCents(p)} — too little headroom left to trade.` };
  if (spread == null) return { label: `Watch ${side}`, reason: 'No clear live spread, so the shown price may be hard to trade.' };
  if (depth != null && depth < 50) return { label: 'Watch only', reason: `Visible depth is just ${fmtUsd(depth)} — too thin to trade.` };
  if (spread > 0.12) return { label: `Small ${side} only`, reason: `Spread is wide at ${fmtCents(spread)}.` };
  if (depth != null && depth < 300) return { label: `Small ${side} only`, reason: `Visible depth is thin at ${fmtUsd(depth)}.` };
  return { label: `Buy ${side}`, reason: `Live price is ${fmtCents(p)} with ${fmtCents(spread)} spread.` };
}
function tradePlanComplete(plan: Raw | null | undefined): boolean {
  return !!(plan
    && safeNum(plan.entryPrice) != null
    && safeNum(plan.reducePrice) != null
    && safeNum(plan.takeProfitPrice) != null);
}
function payoffInputsComplete(market: Raw | null | undefined, side: unknown, plan: Raw | null | undefined): boolean {
  return !!(market && side && tradePlanComplete(plan));
}
function actionableTradeState(market: Raw | null | undefined, side: unknown, tradeCall: TradeCall | null | undefined, tradePlan: Raw | null | undefined): { state: string; label: string; reason: string } {
  const p = normalizeProbability(market);
  const spread = computeSpread(market);
  if (!tradeCall || /^Watch/i.test(tradeCall.label || '')) return { state: 'research', label: 'Watch market', reason: 'watch_call' };
  if (p == null) return { state: 'research', label: 'Watch market', reason: 'missing_price' };
  if (spread == null) return { state: 'research', label: 'Watch market', reason: 'missing_spread' };
  if (!tradePlanComplete(tradePlan)) return { state: 'research', label: 'Watch market', reason: 'missing_trade_plan' };
  // Belt-and-suspenders: a plan whose levels are internally inconsistent (take not above
  // entry, or max-buy not strictly between entry and take) can never be a live ticket.
  const e = safeNum(tradePlan!.entryPrice), tp = safeNum(tradePlan!.takeProfitPrice), mp = safeNum(tradePlan!.maxEntryPrice), rd = safeNum(tradePlan!.reducePrice);
  if (!(tp != null && e != null && tp > e && (mp == null || (mp > e && mp < tp)) && (rd == null || rd < e))) {
    return { state: 'research', label: 'Watch market', reason: 'inverted_plan' };
  }
  if (!payoffInputsComplete(market, side, tradePlan)) return { state: 'research', label: 'Watch market', reason: 'missing_payoff_inputs' };
  return { state: 'ticket', label: 'Open live trade ticket', reason: 'actionable' };
}
function buildStrategyCard(market: Raw, snap: Raw | null | undefined, route: RouteId): Raw {
  const p = normalizeProbability(market);
  const side = suggestedSideForMarket(market, undefined);
  const hedgeCandidates = findHedgeCandidates(market, snap);
  const hedge = hedgeCandidates.find(h => h.available) || hedgeCandidates[0];
  const hedgeDirection = hedgeDirectionForMarket(market, side);
  const spread = computeSpread(market);
  const rulesText = market.rulesText ? cleanTitle(market.rulesText, 700) : null;
  const tradeCall = tradeCallForMarket(market, side);
  const tradePlan = buildTradePlan(market, side);
  const action = actionableTradeState(market, side, tradeCall, tradePlan);
  const risks = [
    'If this side loses, the contracts can go to zero.',
    spread == null ? 'Spread unavailable; do not assume executable mid.' : `Top-of-book YES spread is ${fmtCents(spread)}.`,
    market.depthUsd == null ? 'Visible depth unavailable; size should be treated as unknown.' : `Top visible YES depth is roughly ${fmtUsd(market.depthUsd)}.`,
    'Resolution, timing, and oracle/source wording can dominate the apparent edge.',
  ];
  if (hedge && hedge.available) risks.push('HL hedge can reduce price exposure, but it will not perfectly match the YES/NO payout.');
  else risks.push('No direct HL hedge is available from current mapped instruments.');
  return {
    type: 'strategy',
    id: `strategy:${market.id}`,
    route,
    eventId: market.eventId || market.groupId || market.id,
    eventTitle: market.eventTitle || market.title,
    title: `Strategy: ${market.title}`,
    thesis: p == null
      ? 'No clean strategy: the live market is missing a normalized executable YES price.'
      : `${tradeCall.label}: ${tradeCall.reason} Check depth, wallet size, and settlement wording before submitting.`,
    tradeCall,
    tradePlan,
    marketLegs: [{
      venue: market.venue,
      marketId: market.id,
      rawId: market.rawId,
      eventTitle: market.eventTitle || market.title,
      title: market.title,
      side,
      entryPrice: tradePlan.entryPrice,
      maxEntryPrice: tradePlan.maxEntryPrice,
      reducePrice: tradePlan.reducePrice,
      exitPrice: tradePlan.exitPrice,
      takeProfitPrice: tradePlan.takeProfitPrice,
      mid: p,
      yesBid: market.yesBid,
      yesAsk: market.yesAsk,
      noBid: market.noBid,
      noAsk: market.noAsk,
      spread,
      depthUsd: market.depthUsd,
      volumeUsd: market.volumeUsd,
      expiry: market.expiry,
      underlying: market.underlying,
      direction: market.direction,
      strike: market.strike,
      lowerStrike: market.lowerStrike,
      upperStrike: market.upperStrike,
      referencePrice: hedge && hedge.mid != null ? hedge.mid : null,
      resolutionSource: market.resolutionSource,
      rulesText,
    }],
    hedgeLegs: [{
      venue: VENUES.HYPERLIQUID,
      symbol: (hedge && hedge.symbol) || '—',
      kind: (hedge && hedge.kind) || 'perp',
      direction: hedge && hedge.available ? hedgeDirection : 'none',
      mid: hedge && hedge.mid != null ? hedge.mid : null,
      rationale: hedge && hedge.available
        ? `${market.underlying} exposure can be partially hedged with Hyperliquid ${hedge.kind}.`
        : 'No direct HL hedge is mapped for this market.',
      limitations: hedge && hedge.available
        ? ['The hedge will not perfectly match the YES/NO payout.', 'Funding, timing, and settlement price can move differently.', 'Near settlement, the outcome price can move much faster than the hedge.']
        : [(hedge && hedge.reason) || 'Hedge unavailable.'],
    }],
    scenarios: [
      { state: 'Outcome resolves true', expectedBehavior: `${side === 'YES' ? 'Market leg pays $1 per contract.' : 'NO leg loses unless paired with another structure.'}` },
      { state: 'Outcome resolves false', expectedBehavior: `${side === 'YES' ? 'YES leg expires worthless.' : 'NO leg pays $1 per contract.'}` },
      { state: 'Underlying moves before settlement', expectedBehavior: hedge && hedge.available ? `HL ${hedge.symbol} ${hedge.kind} hedge may offset part of the price move, but not the final YES/NO result.` : 'No mapped hedge; PnL remains event-directional.' },
    ],
    risks,
    evidence: [
      `${market.venue} market ${market.rawId || market.id}`,
      `YES mid ${fmtCents(p)} · spread ${fmtCents(spread)} · depth ${fmtUsd(market.depthUsd)} · 24h volume ${fmtUsd(market.volumeUsd)}`,
      `expiry ${market.expiry || 'unavailable'} · settlement ${market.resolutionSource || 'unavailable'} · updated ${market.updatedAt}`,
      hedge && hedge.available ? `HL ${hedge.symbol} ${hedge.kind} reference mid ${fmtUsd(hedge.mid)}` : 'No mapped HL hedge reference price.',
    ],
    reasonCodes: [
      p == null ? 'PRICE_UNAVAILABLE' : 'LIVE_PRICE_AVAILABLE',
      spread == null ? 'SPREAD_UNAVAILABLE' : 'SPREAD_AVAILABLE',
      hedge && hedge.available ? 'HL_HEDGE_CANDIDATE' : 'NO_DIRECT_HL_HEDGE',
      action.reason === 'actionable' ? 'ACTIONABLE_TRADE_PLAN' : `NO_TICKET_${String(action.reason || 'UNKNOWN').toUpperCase()}`,
    ],
    confidence: p != null && spread != null ? 'medium' : 'low',
    actionState: action.state,
    actionLabel: action.label,
  };
}
function buildTradingSetupCard(market: Raw, snap: Raw | null | undefined, route: RouteId): Raw {
  const base = buildStrategyCard(market, snap, route);
  const leg = (base.marketLegs && base.marketLegs[0]) || {};
  const hedge = (base.hedgeLegs && base.hedgeLegs[0]) || {};
  const setupPlan = buildSetupPlan(market, leg.side || 'YES', base.tradeCall, hedge, hedge.direction || 'none');
  return {
    ...base,
    type: 'setup',
    id: `setup:${market.id}`,
    title: `Trading setup: ${market.title}`,
    thesis: `${setupPlan.plainRead}. ${setupPlan.entry} ${setupPlan.manage}`,
    setupPlan,
    reasonCodes: uniq((base.reasonCodes || []).concat(['TRADING_SETUP'])),
    actionState: base.actionState,
    actionLabel: base.actionLabel,
  };
}
function buildRiskCard(market: Raw, snap: Raw | null | undefined, route: RouteId): Raw {
  const base = buildStrategyCard(market, snap, route);
  return {
    ...base,
    type: 'strategy',
    id: `risk:${market.id}`,
    title: `Risk review: ${market.title}`,
    thesis: 'Primary risk is not the headline probability; it is whether the market is liquid, hedgeable, and objectively resolvable under the exact rules.',
    confidence: 'medium',
    // A risk review is an explainer, never a buy ticket — force the non-actionable state
    // so the UI shows "Watch market", not "Open live trade ticket".
    action: { state: 'research', label: 'Watch market', reason: 'risk_review' },
    reasonCodes: uniq(base.reasonCodes.concat(['RISK_REVIEW'])),
  };
}
function buildEventStrategyCard(eventPick: Raw, snap: Raw | null | undefined, route: RouteId): Raw {
  const pick = (eventPick && eventPick.market) ? eventPick.market : eventPick;
  const base = buildStrategyCard(pick, snap, route);
  const alternatives = ((eventPick && eventPick.alternatives) || []).map((m: Raw) => ({
    marketId: m.id,
    rawId: m.rawId,
    title: m.title,
    outcomeLabel: m.outcomeLabel,
    yesMid: normalizeProbability(m),
    spread: computeSpread(m),
    depthUsd: m.depthUsd,
    volumeUsd: m.volumeUsd,
  }));
  return {
    ...base,
    id: `event:${base.id}`,
    title: `Event trade: ${base.eventTitle || pick.title}`,
    thesis: `${(base.tradeCall && base.tradeCall.label) || 'Review'} on ${pick.outcomeLabel || pick.title}. ${(base.tradeCall && base.tradeCall.reason) || ''}`,
    eventSuggestion: true,
    eventOutcomeCount: (eventPick && eventPick.eventSize) || 1,
    eventAlternatives: alternatives,
    reasonCodes: uniq((base.reasonCodes || []).concat(['EVENT_LEVEL_SUGGESTION'])),
  };
}
function buildMispricingCard(base: Raw, comp: Raw, eq: EquivalenceResult): Raw {
  const mp = computeMispricing(base, comp);
  const abs = mp.delta == null ? null : Math.abs(mp.delta);
  const absAdj = mp.adjustedDelta == null ? null : Math.abs(mp.adjustedDelta);
  const direction = mp.delta == null ? 'unknown' : (mp.delta > 0 ? 'Verdict richer' : 'External richer');
  const caveats = mp.caveats.slice();
  if (eq.confidence !== 'high') caveats.push('resolution_equivalence_not_high');
  if (abs != null && abs < 0.05) caveats.push('small_delta');
  const compVenue = (comp && comp.venue) || 'external';
  const verdictProb = normalizeProbability(base);
  const fairProb = normalizeProbability(comp);
  const tradeDirection = mp.delta == null ? 'review only' : (mp.delta > 0 ? 'Verdict is pricing this higher' : 'Verdict is pricing this lower');
  // Turn the deviation into a directive. The comparator is the fair-value anchor: if Verdict
  // prices YES ABOVE it the YES is rich here, so the value trade is BUY NO on Verdict; if
  // Verdict prices YES BELOW it the YES is cheap, so BUY YES. This only ever runs on the
  // high-confidence EXACT-TWIN path (same underlying/strike/settlement) — never interpolated
  // or loose — so the gap is a genuine same-contract disagreement, not strike/time curvature.
  const edgeSide: 'YES' | 'NO' | null = mp.delta == null ? null : (mp.delta > 0 ? 'NO' : 'YES');
  const entry = edgeSide ? executableSidePrice(base, edgeSide) : null;
  const spread = computeSpread(base);
  const exit = (entry != null) ? setupExitPlan(entry, spread) : null;
  const depth = safeNum(base.depthUsd);
  // Only call it a trade when the edge survives both spreads, the book is real, and the side
  // has headroom — otherwise it stays a comparison to watch (never a fabricated "trade this").
  const tradable = eq.confidence === 'high'
    && absAdj != null && absAdj >= 0.03
    && entry != null && entry > 0.02 && entry < 0.98
    && spread != null && spread <= 0.12
    && (depth == null || depth >= 50)
    && exit && typeof exit === 'object';
  const tradePlan = (tradable && exit && typeof exit === 'object') ? {
    side: edgeSide,
    entryPrice: entry,
    maxEntryPrice: exit.maxPay,
    reducePrice: exit.reduce,
    exitPrice: exit.reduce,
    takeProfitPrice: exit.take,
    entryText: exit.entryText,
    manageText: exit.manageText,
  } : null;
  const tradeCall = tradable
    ? { label: `Buy ${edgeSide} on Verdict`, reason: `Verdict YES ${fmtCents(verdictProb)} vs ${compVenue} ${fmtCents(fairProb)} — a ${fmtCents(absAdj)} gap after spreads, so ${edgeSide === 'YES' ? 'YES looks cheap here' : 'YES looks rich here'}.` }
    : { label: 'Watch comparison', reason: (absAdj != null && absAdj < 0.03) ? 'The gap is inside the spreads — no clean edge to trade.' : (eq.confidence !== 'high' ? 'Match is not exact enough to trade the gap.' : 'Book is too thin or the side has no headroom to trade the gap.') };
  return {
    type: 'mispricing',
    id: `mispricing:${base.id}:${comp.id}`,
    title: `Tradable HIP-4 market: ${base.title}`,
    baseMarket: base,
    comps: [comp],
    comparisonLabel: `Compared with ${compVenue}`,
    tradeDirection,
    verdictProb,
    fairProb,
    deviation: mp.delta,
    normalizedDelta: mp.delta,
    adjustedDelta: mp.adjustedDelta,
    edgeSide: tradable ? edgeSide : null,
    tradeCall,
    tradePlan,
    equivalenceConfidence: eq.confidence,
    caveats,
    evidence: [
      `Tradeable on Verdict/HIP-4: ${base.title} at YES ${fmtCents(verdictProb)}, spread ${fmtCents(spread)}`,
      `${comp.venue} ${comp.rawId || comp.id}: comparable chance estimate ${fmtCents(fairProb)} (fair-value anchor), spread ${fmtCents(computeSpread(comp))}`,
      `Deviation: Verdict YES ${fmtCents(verdictProb)} vs fair ${fmtCents(fairProb)} = ${fmtCents(mp.delta)} (${fmtCents(mp.adjustedDelta)} after spreads)`,
      tradable && exit && typeof exit === 'object' ? `Edge: buy ${edgeSide} at about ${fmtCents(entry)}; take some near ${fmtCents(exit.take)}, reduce below ${fmtCents(exit.reduce)}` : null,
      `Equivalence ${eq.confidence} (${eq.reasons.join(', ')})`,
    ].filter(Boolean),
    reasonCodes: uniq([
      abs != null && abs >= 0.08 ? 'YES_DELTA_GT_8C' : abs != null && abs >= 0.05 ? 'YES_DELTA_GT_5C' : 'LOW_DELTA',
      eq.confidence === 'high' ? 'HIGH_EQUIVALENCE' : eq.confidence === 'medium' ? 'MEDIUM_EQUIVALENCE' : 'LOW_EQUIVALENCE',
      mp.adjustedDelta != null && Math.abs(mp.adjustedDelta) > 0 ? 'SPREAD_ADJUSTED_DELTA_POSITIVE' : 'SPREAD_ADJUSTED_DELTA_ZERO',
      tradable ? `EDGE_BUY_${edgeSide}` : 'NO_ACTIONABLE_EDGE',
    ]),
    confidence: eq.confidence === 'high' && abs != null && abs >= 0.08 ? 'high' : eq.confidence === 'low' ? 'low' : 'medium',
    direction,
    actionState: tradable ? 'ticket' : 'research',
    actionLabel: tradable ? `Open ${edgeSide} ticket` : 'Review comparison',
  };
}
// Model-free, same-venue, same-settlement estimate of where the external book prices the
// EXACT Verdict strike: linearly interpolate between the two nearest ladder rungs that
// bracket it. This removes the strike difference (the gamma confound the twin gate guards
// against) and — by requiring a near-identical expiry relative to time-to-expiry — the
// theta/term confound too, so the residual gap is a real price disagreement on the same
// synthetic contract, not curvature. Returns null unless a clean bracket exists: one rung
// strictly below and one strictly above the strike, same underlying/direction/kind, both
// priced and liquid, monotone in strike (no inverted book), brackets not absurdly wide.
function interpolateLadderComparator(base: Raw | null | undefined, candidates: Raw[] | null | undefined, nowMs?: number): Raw | null {
  if (!base || base.strike == null || !base.direction || base.direction === 'range') return null;
  if (!base.underlying || !base.expiry) return null;
  const baseYes = normalizeProbability(base);
  if (baseYes == null) return null;
  const baseKind = base.derivativeKind || 'settlement';
  const tteDays = (Date.parse(base.expiry) - (nowMs || Date.now())) / (24 * 3600 * 1000);
  if (!(tteDays > 0)) return null;
  // The expiry offset must be small relative to the time remaining: hours for a daily,
  // up to a day for a multi-week binary. Capped so we never silently span settlements.
  const expiryTolDays = Math.min(1, Math.max(0.25, 0.15 * tteDays));
  const byVenue = new Map<string, { market: Raw; strike: number; price: number }[]>();
  for (const c of candidates || []) {
    if (!c || c.underlying !== base.underlying || c.strike == null) continue;
    if (c.direction !== base.direction) continue;
    if ((c.derivativeKind || 'settlement') !== baseKind) continue;
    const p = normalizeProbability(c);
    if (p == null) continue;
    const dd = expiryDeltaDays(base.expiry, c.expiry);
    if (dd == null || dd > expiryTolDays) continue;
    if (!byVenue.has(c.venue)) byVenue.set(c.venue, []);
    byVenue.get(c.venue)!.push({ market: c, strike: c.strike, price: p });
  }
  let best: { venue: string; atPrice: number; lo: { market: Raw; strike: number; price: number }; hi: { market: Raw; strike: number; price: number }; widthPct: number; expiryDeltaDays: number } | null = null;
  for (const [venue, rungs] of byVenue) {
    let lo: { market: Raw; strike: number; price: number } | null = null;
    let hi: { market: Raw; strike: number; price: number } | null = null;
    for (const r of rungs) {
      if (r.strike < base.strike) { if (!lo || r.strike > lo.strike) lo = r; }
      else if (r.strike > base.strike) { if (!hi || r.strike < hi.strike) hi = r; }
    }
    if (!lo || !hi) continue;
    const widthPct = (hi.strike - lo.strike) / base.strike;
    if (!(widthPct > 0) || widthPct > 0.15) continue; // too wide to interpolate reliably
    // Monotonicity: an 'above' binary's YES falls with strike, a 'below' rises. A materially
    // inverted bracket means stale/illiquid quotes — reject rather than interpolate garbage.
    const mono = base.direction === 'below' ? (hi.price - lo.price) : (lo.price - hi.price);
    if (mono < -0.03) continue;
    const t = (base.strike - lo.strike) / (hi.strike - lo.strike);
    const atPrice = clamp(lo.price + t * (hi.price - lo.price), 0, 1)!;
    const dd = Math.max(expiryDeltaDays(base.expiry, lo.market.expiry) || 0, expiryDeltaDays(base.expiry, hi.market.expiry) || 0);
    const cand = { venue, atPrice, lo, hi, widthPct, expiryDeltaDays: dd };
    if (!best || cand.widthPct < best.widthPct) best = cand; // prefer the tightest bracket
  }
  if (!best) return null;
  const delta = baseYes - best.atPrice;
  const priceSpan = Math.abs(best.lo.price - best.hi.price);
  const baseSpread = computeSpread(base);
  const loSpread = computeSpread(best.lo.market);
  const hiSpread = computeSpread(best.hi.market);
  const interpUncertainty = 0.25 * priceSpan; // conservative band for linear-interp error
  const spreadPenalty = ((baseSpread || 0.04) + (((loSpread || 0.04) + (hiSpread || 0.04)) / 2)) / 2 + interpUncertainty;
  const adjustedDelta = Math.sign(delta) * Math.max(0, Math.abs(delta) - spreadPenalty);
  const caveats = ['interpolated_between_ladder_strikes'];
  if (best.widthPct > 0.06) caveats.push('wide_bracket_strikes');
  if (best.expiryDeltaDays > 0.25) caveats.push('settlement_offset_' + Math.round(best.expiryDeltaDays * 24) + 'h');
  if (baseSpread == null || baseSpread >= 0.08) caveats.push('verdict_book_thin');
  return {
    venue: best.venue,
    atStrike: base.strike,
    atPrice: best.atPrice,
    delta,
    adjustedDelta,
    baseYes,
    lower: { strike: best.lo.strike, price: best.lo.price, market: best.lo.market },
    upper: { strike: best.hi.strike, price: best.hi.price, market: best.hi.market },
    bracketWidthPct: best.widthPct,
    expiryDeltaDays: best.expiryDeltaDays,
    caveats,
  };
}
function buildInterpolatedCard(base: Raw, interp: Raw): Raw {
  const abs = Math.abs(interp.delta);
  const dirLabel = interp.delta > 0 ? 'Verdict richer' : 'External richer';
  const venue = interp.venue;
  return {
    type: 'mispricing',
    id: `interp:${base.id}:${venue}:${Math.round(interp.atStrike)}`,
    title: `Tradable HIP-4 market: ${base.title}`,
    baseMarket: base,
    comps: [interp.lower.market, interp.upper.market],
    comparisonLabel: `${venue} ladder interpolated to your ${refStrikeLabel(interp.atStrike)} strike (same settlement)`,
    comparisonMethod: 'ladder_interpolation',
    interpolated: {
      venue,
      atStrike: interp.atStrike,
      atPrice: interp.atPrice,
      lowerStrike: interp.lower.strike,
      lowerPrice: interp.lower.price,
      upperStrike: interp.upper.strike,
      upperPrice: interp.upper.price,
      bracketWidthPct: interp.bracketWidthPct,
      expiryDeltaDays: interp.expiryDeltaDays,
    },
    tradeDirection: interp.delta > 0
      ? 'Verdict is pricing this higher than the interpolated external level'
      : 'Verdict is pricing this lower than the interpolated external level',
    verdictProb: interp.baseYes,
    fairProb: interp.atPrice,
    deviation: interp.delta,
    normalizedDelta: interp.delta,
    adjustedDelta: interp.adjustedDelta,
    equivalenceConfidence: 'medium',
    caveats: interp.caveats,
    evidence: [
      `Tradeable on Verdict/HIP-4: ${base.title} at YES ${fmtCents(interp.baseYes)}, spread ${fmtCents(computeSpread(base))}`,
      `${venue} has no market at ${refStrikeLabel(interp.atStrike)}; interpolated YES ${fmtCents(interp.atPrice)} from ${refStrikeLabel(interp.lower.strike)} (${fmtCents(interp.lower.price)}) and ${refStrikeLabel(interp.upper.strike)} (${fmtCents(interp.upper.price)}) at the same settlement`,
      `Model-free fair-value gap ${fmtCents(interp.delta)} (spread/interp-adjusted ${fmtCents(interp.adjustedDelta)})`,
    ],
    reasonCodes: uniq([
      'LADDER_INTERPOLATION',
      abs >= 0.08 ? 'YES_DELTA_GT_8C' : abs >= 0.05 ? 'YES_DELTA_GT_5C' : 'LOW_DELTA',
      'SAME_STRIKE_SYNTHETIC',
      'SAME_SETTLEMENT',
    ]),
    confidence: abs >= 0.08 ? 'medium' : 'low',
    direction: dirLabel,
    actionState: 'research',
    actionLabel: 'Review interpolated comparison',
  };
}
function marketLine(m: Raw | null | undefined): string | null {
  if (!m) return null;
  return `${m.venue}: ${cleanTitle(m.title, 90)} at YES ${fmtCents(normalizeProbability(m))}${m.spread != null ? `, spread ${fmtCents(m.spread)}` : ''}${m.depthUsd != null ? `, depth ${fmtUsd(m.depthUsd)}` : ''}`;
}
function cardLine(card: Raw | null | undefined): string | null {
  if (!card) return null;
  if (card.type === 'mispricing') {
    const comp = card.comps && card.comps[0];
    return `${cleanTitle(card.baseMarket && card.baseMarket.title, 80)} is tradeable on Verdict; ${comp ? comp.venue : 'external'} is the price check; gap ${fmtCents(card.normalizedDelta)}.`;
  }
  if (card.type === 'setup') {
    const leg = card.marketLegs && card.marketLegs[0];
    const plan = card.setupPlan || {};
    return `${cleanTitle(leg && leg.title, 80)}: ${plan.entry || `${leg && leg.side} at ${fmtCents(leg && leg.mid)}`} ${plan.manage || ''}`;
  }
  const leg = card.marketLegs && card.marketLegs[0];
  const hedge = card.hedgeLegs && card.hedgeLegs[0];
  return `${cleanTitle(leg && leg.title, 90)}: ${leg && leg.side} at ${fmtCents(leg && leg.mid)}; hedge ${hedge && hedge.direction !== 'none' ? `${hedge.direction} ${hedge.symbol} ${hedge.kind}` : 'not mapped'}.`;
}
function buildAgentReply({ query, route, summary, cards, dataStatus, externalMarkets, evidence }: { query?: unknown; route?: RouteId; summary?: unknown; cards?: Raw[]; dataStatus?: Raw; externalMarkets?: Raw[]; evidence?: string[] }): Raw {
  const hasCards = (cards || []).length > 0;
  const liveExternal = (externalMarkets || []).filter(Boolean);
  const reply: Raw = {
    title: route === ROUTES.MISPRICING
      ? hasCards ? 'I found HIP-4 markets with comparable venue checks.' : 'No clean HIP-4 cross-venue match found.'
      : route === ROUTES.SETUP
        ? 'I built a trading setup from live Verdict/HL books.'
      : 'I built this from live Verdict/HL market data.',
    paragraphs: [],
    bullets: [],
    followups: [],
  };
  if (route === ROUTES.MISPRICING) {
    const okVenues = Object.entries(dataStatus || {})
      .filter(([k, v]) => k !== 'llm' && (v === 'ok' || v === 'partial'))
      .map(([k]) => k);
    reply.paragraphs.push(okVenues.length
      ? hasCards
        ? `I pulled live ${okVenues.join(' + ')} data for: "${query || 'venue scan'}". I only promoted HIP-4 markets that had a close enough price check on Polymarket or Kalshi.`
        : `I pulled live ${okVenues.join(' + ')} data for the cross-venue scan. I only promote HIP-4 markets when the external price check matches the event, expiry, and settlement rules.`
      : 'I could not get enough live venue data to make a reliable cross-venue comparison.');
    if (hasCards) {
      reply.paragraphs.push(summary);
      reply.bullets = cards!.slice(0, 3).map(cardLine).filter(Boolean);
    } else if (liveExternal.length) {
      reply.paragraphs.push('There are live external BTC references, but no selected HIP-4 market matched them tightly enough on event, expiry, and settlement rules. Showing the usable venue reads below instead of forcing a weak price-gap claim.');
      reply.bullets = liveExternal.slice(0, 4).map(marketLine).filter(Boolean);
    } else {
      reply.paragraphs.push('No usable external comparator markets survived the stale/illiquid filter. I am not going to call a price gap from expired, zero-depth, or mismatched markets.');
    }
    reply.followups = ['Run Polymarket only', 'Run Kalshi only', 'Show low-confidence matches'];
  } else if (route === ROUTES.SETUP) {
    reply.paragraphs.push(`I scanned live Verdict/HL books for: "${query || 'trading setup'}". I only use markets that can open in the Verdict ticket for review.`);
    if (hasCards) {
      reply.paragraphs.push(summary);
      reply.bullets = cards!.slice(0, 3).map(cardLine).filter(Boolean);
    } else {
      reply.paragraphs.push('No clean setup: the required live price, spread, or market data was unavailable.');
    }
    reply.followups = ['Give setups by event', 'Check hedge risks', 'Compare this to Polymarket', 'Find more liquid setups'];
  } else {
    reply.paragraphs.push(`I scanned live Verdict/HL outcome books for: "${query || 'strategy request'}". When a matching Verdict market is live, the answer can open the trade ticket for review and submission.`);
    if (hasCards) {
      reply.paragraphs.push(summary);
      reply.bullets = cards!.slice(0, 3).map(cardLine).filter(Boolean);
    } else {
      reply.paragraphs.push('I could not build a card because the required live market data was unavailable.');
    }
    reply.followups = ['Check hedge risks', 'Compare this to Polymarket', 'Find more liquid markets'];
  }
  if (evidence && evidence.length) {
    reply.evidenceNote = evidence.slice(0, 2).join(' · ');
  }
  return reply;
}
function evaluateEvidenceGate(result: Raw | null | undefined): Raw {
  const route = (result && result.route) || ROUTES.STRATEGY;
  const playbook = getPlaybook(route);
  const gates = playbook.hardGates || {};
  const cards: Raw[] = (result && result.cards) || [];
  const dataStatus: Raw = (result && result.dataStatus) || {};
  const checks: Raw[] = [];
  const missing: string[] = [];
  function check(id: string, pass: unknown, reason?: string) {
    checks.push({ id, pass: !!pass, reason: reason || null });
    if (!pass) missing.push(id);
  }

  if (gates.verdictRequired) check('verdict_hl_markets', dataStatus.verdict === 'ok', 'Live Verdict/HL markets required.');
  if (gates.minCards) check('route_cards', cards.length >= gates.minCards, `At least ${gates.minCards} structured card required.`);
  if (gates.externalComparatorRequired) {
    const allowed = new Set(gates.allowedComparators || []);
    const hasComparatorCard = cards.some((card) => {
      const comp = card && card.comps && card.comps[0];
      return card && card.type === 'mispricing'
        && card.baseMarket && card.baseMarket.venue === VENUES.VERDICT
        && comp && allowed.has(comp.venue);
    });
    check('external_comparator', hasComparatorCard, 'HIP-4 mispricing requires a Polymarket or Kalshi comparator card.');
  }
  if (gates.noStandaloneMispricing && cards.length) {
    check('mispricing_cards_valid', cards.every((card) => {
      const comp = card && card.comps && card.comps[0];
      return card.type === 'mispricing'
        && card.baseMarket && card.baseMarket.venue === VENUES.VERDICT
        && comp && (gates.allowedComparators || []).includes(comp.venue);
    }), 'Mispricing cards must use Verdict/HIP-4 base and allowed external comparator.');
  }
  if (gates.actionableRequiresTradePlan) {
    const actionable = cards.filter(c => c && c.actionState === 'ticket');
    check('actionable_trade_plan', actionable.every(c => tradePlanComplete(c.tradePlan)), 'Ticket cards require entry, reduce/exit, and take-profit levels.');
  }
  if (gates.actionableRequiresPayoffInputs) {
    const actionable = cards.filter(c => c && c.actionState === 'ticket');
    check('actionable_payoff_inputs', actionable.every((c) => {
      const leg = c.marketLegs && c.marketLegs[0];
      return !!(leg && leg.side && safeNum(leg.entryPrice) != null);
    }), 'Ticket cards require payoff chart inputs.');
  }
  if (gates.noTradeIfMissingPrice || gates.noTradeIfMissingSpread) {
    const badTickets = cards.filter((c) => {
      if (!c || c.actionState !== 'ticket') return false;
      const leg = (c.marketLegs && c.marketLegs[0]) || {};
      return (gates.noTradeIfMissingPrice && safeNum(leg.mid) == null && normalizeProbability(leg) == null)
        || (gates.noTradeIfMissingSpread && computeSpread(leg) == null);
    });
    check('no_ticket_without_price_spread', badTickets.length === 0, 'Do not show ticket action without live price and spread.');
  }

  return {
    version: '20260607-playbooks1',
    route,
    playbook: playbook.title || route,
    requiredEvidence: playbook.requiredEvidence || [],
    outputContract: playbook.outputContract || [],
    passed: missing.length === 0,
    missing,
    checks,
  };
}
// Discovery is query-driven; derive extra terms from the BASE markets (underlying +
// settle month/day) so the date-matched external twin actually enters the candidate
// pool ("bitcoin june 11") instead of being buried under unrelated churn.
const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function discoveryTermsForBases(bases: Raw[] | null | undefined): string {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (t: string | null | undefined) => { if (t && !seen.has(t)) { seen.add(t); terms.push(t); } };
  for (const b of (bases || []).slice(0, 6)) {
    if (b && b.underlying) add(({ BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', HYPE: 'hyperliquid' } as Record<string, string>)[b.underlying] || String(b.underlying).toLowerCase());
    // Base-driven category terms so cross-venue discovery fires off WHAT HIP-4 lists,
    // not the user's phrasing — these flow into the venue series/tag maps downstream.
    const ev = `${(b && b.eventTitle) || ''} ${(b && b.title) || ''}`.toLowerCase();
    if (b && b.category === 'sports' && /world cup|fifa/.test(ev)) add('world cup');
    if (b && b.category === 'macro_politics' && /\bfed\b|fomc|rate/.test(ev)) add('fed rate');
    const t = b && b.expiry ? new Date(b.expiry) : null;
    if (t && !Number.isNaN(t.getTime())) {
      const mo = MONTHS_LONG[t.getUTCMonth()]!;
      add(mo);
      add(`${mo} ${t.getUTCDate()}`);
    }
  }
  return terms.slice(0, 8).join(' ');
}

// ── Options-implied probability (Deribit) — derivatives-grade REFERENCE for BTC
// dated binaries. Reference only: Deribit dailies settle 08:00 UTC vs HL 06:00 and
// the mechanism differs, so this never becomes a tradable comparator card.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}
interface DeribitInstrument { expiryMs: number; strike: number; type: string }
function parseDeribitInstrument(name: unknown): DeribitInstrument | null {
  const m = /^(?:BTC|ETH|SOL)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(String(name || ''));
  if (!m) return null;
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  if (!(m[2]! in months)) return null;
  return {
    expiryMs: Date.UTC(2000 + +m[3]!, months[m[2]!]!, +m[1]!, 8, 0, 0),
    strike: +m[4]!,
    type: m[5]!,
  };
}
interface DeribitRef {
  prob: number | null;
  iv: number;
  strikeUsed: number;
  spot: number;
  offsetHours: number;
}
async function deribitImpliedProb(base: Raw | null | undefined, deadlineAt?: number): Promise<DeribitRef | null> {
  const K = safeNum(base && base.strike);
  const T0 = base && base.expiry ? new Date(base.expiry).getTime() : NaN;
  const dir = base && base.direction;
  if (!(K! > 0) || !Number.isFinite(T0) || (dir !== 'above' && dir !== 'below')) return null;
  const ccy = String((base && base.underlying) || '');
  if (!['BTC', 'ETH', 'SOL'].includes(ccy)) return null;
  const params = new URLSearchParams({ currency: ccy, kind: 'option' });
  const proxied = sameOriginApi('/api/venues/deribit', params);
  const data = await fetchFirstJson([
    proxied,
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?${params.toString()}`,
  ].filter(Boolean), 9000, deadlineAt) as Raw;
  const rows: Raw[] = data && Array.isArray(data.result) ? data.result : [];
  const calls: { pi: DeribitInstrument; iv: number; underlying: number | null }[] = [];
  for (const r of rows) {
    const pi = parseDeribitInstrument(r && r.instrument_name);
    if (!pi || pi.type !== 'C') continue;
    const iv = safeNum(r.mark_iv);
    if (iv == null || !(iv > 0)) continue;
    calls.push({ pi, iv, underlying: safeNum(r.underlying_price) });
  }
  if (!calls.length) return null;
  let bestExp: number | null = null;
  let bestDelta = Infinity;
  for (const c of calls) {
    const d = Math.abs(c.pi.expiryMs - T0);
    if (d < bestDelta) { bestDelta = d; bestExp = c.pi.expiryMs; }
  }
  // A reference further than 3 days from our settle says nothing about a daily.
  if (bestDelta > 3 * 24 * 3600 * 1000) return null;
  const chain = calls.filter(c => c.pi.expiryMs === bestExp);
  let near: { pi: DeribitInstrument; iv: number; underlying: number | null } | null = null;
  let nearDist = Infinity;
  let S: number | null = null;
  for (const c of chain) {
    if (c.underlying != null && c.underlying > 0) S = c.underlying;
    const d = Math.abs(c.pi.strike - K!);
    if (d < nearDist) { nearDist = d; near = c; }
  }
  if (!near || !(S! > 0)) return null;
  const iv = near.iv / 100;
  const T = Math.max((T0 - Date.now()) / (365.25 * 24 * 3600 * 1000), 1 / 525600);
  const d2 = (Math.log(S! / K!) - 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  const pAbove = normCdf(d2);
  return {
    prob: clamp(dir === 'below' ? 1 - pAbove : pAbove, 0, 1),
    iv: near.iv,
    strikeUsed: near.pi.strike,
    spot: S!,
    offsetHours: Math.round((bestExp! - T0) / 3600000),
  };
}
async function appendDeribitEvidence(result: Raw, bases: Raw[] | null | undefined, deadlineAt?: number): Promise<void> {
  try {
    const base = (bases || []).find(b => b && ['BTC', 'ETH', 'SOL'].includes(b.underlying) && safeNum(b.strike) != null && b.expiry && (b.direction === 'above' || b.direction === 'below'));
    if (!base) return;
    const ref = await deribitImpliedProb(base, deadlineAt);
    if (!ref) return;
    const marketProb = normalizeProbability(base);
    result.optionsImplied = { ...ref, baseTitle: base.title, marketProb };
    result.evidence = (result.evidence || []).concat([
      `Options-implied reference (${base.underlying} options chain): P(${base.underlying} ${base.direction} $${Math.round(base.strike).toLocaleString()} at settle) ≈ ${(ref.prob! * 100).toFixed(1)}% (iv ${ref.iv.toFixed(1)}%, nearest options expiry ${ref.offsetHours >= 0 ? '+' : ''}${ref.offsetHours}h vs market settle${marketProb != null ? `; market YES ${(marketProb * 100).toFixed(1)}%` : ''}) — derivatives reference only, not a tradable comparator.`,
    ]);
  } catch {}
}

// Black-Scholes digital (binary) probability of finishing above K: risk-neutral P(S_T > K)
// = N(d2), r≈0. This is the same N(d2) the Deribit options-implied reference uses.
function digitalAboveProb(S: number, K: number, T: number, sigma: number): number | null {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return normCdf(d2);
}
interface MaturityAdjustResult {
  pComp: number;
  pAdj: number;
  pAdjLo: number;
  pAdjHi: number;
  rawAdj: number;
  rawLo: number;
  rawHi: number;
  volSensitivity: number;
  shift: number;
  sigma: number;
  spot: number;
  strike: number;
  strikeOffsetPct: number;
  tteBaseDays: number;
  tteCompDays: number;
  offsetHours: number;
}
// Two binaries on the SAME underlying + SAME strike + SAME direction but DIFFERENT settlement
// times are NOT a locked twin — yet they are still comparable: reprice the comparator from its
// own maturity to the base's maturity with a BS digital model, and the residual gap is a real
// cross-venue disagreement net of the term/theta effect. We move the comparator's market price
// by the model's expected change between the two maturities (an additive term-structure shift
// using an options-implied vol), rather than inverting the price (stable at any price level).
// Vol comes from the live options chain (sigma), so this is BTC/ETH/SOL only. Model-based — a
// relative-value read, never a locked arbitrage (it carries vega/settlement risk over the gap).
function maturityAdjustComparator(base: Raw | null | undefined, comp: Raw | null | undefined, sigma: number, spot: number, nowMs?: number): MaturityAdjustResult | null {
  if (!base || !comp || !base.underlying || base.underlying !== comp.underlying) return null;
  const dir = base.direction;
  if ((dir !== 'above' && dir !== 'below') || comp.direction !== dir) return null;
  const K = safeNum(base.strike), Kc = safeNum(comp.strike);
  if (!(K! > 0) || !(Kc! > 0)) return null;
  // Require a near-identical strike — a daily near ATM has extreme gamma, so even a ~1% strike
  // gap is a 15-40pt probability difference that would masquerade as a cross-venue dislocation.
  // Keep it tight; the model then corrects the small residual (below) instead of ignoring it.
  const sd = strikeDistancePct(K, Kc);
  if (sd == null || sd > 0.005) return null;
  const pComp = normalizeProbability(comp);
  if (pComp == null || !(sigma > 0) || !(spot > 0) || !base.expiry || !comp.expiry) return null;
  const now = nowMs || Date.now();
  const yr = 365.25 * 24 * 3600 * 1000;
  const Tb = (Date.parse(base.expiry) - now) / yr;
  const Tc = (Date.parse(comp.expiry) - now) / yr;
  if (!(Tb > 0) || !(Tc > 0)) return null;
  // Reprice the comparator from ITS (strike, maturity) to the BASE's (strike, maturity): the
  // shift is the model-expected change for BOTH the residual strike gap AND the settlement-time
  // gap, so a sub-0.5% strike difference is corrected, not smuggled in as a fake edge.
  const modelAtSig = (strike: number, T: number, sg: number): number | null => { const a = digitalAboveProb(spot, strike, T, sg); return a == null ? null : (dir === 'below' ? 1 - a : a); };
  const shiftAt = (sg: number): number | null => { const mb = modelAtSig(K!, Tb, sg), mc = modelAtSig(Kc!, Tc, sg); return (mb == null || mc == null) ? null : mb - mc; };
  const shift = shiftAt(sigma);
  if (shift == null) return null;
  const rawAdj = pComp + shift;
  const pAdj = clamp(rawAdj, 0.0001, 0.9999)!;
  // Vol-stress: the reprice leans on a single options-implied vol. Re-bridge at sigma*(1±20%) and
  // measure how far the adjusted price moves — a near-ATM daily is very sensitive to vol, so an
  // "edge" that exists only at one vol point is a model artifact, not a tradable disagreement.
  // Fragility is the max center-to-endpoint move, measured on the UNCLAMPED model legs so a reprice
  // that saturates the [0,1] clamp cannot hide its true vega; only the displayed prices are clamped.
  const VOL_BUMP = 0.20;
  const shiftLo = shiftAt(sigma * (1 - VOL_BUMP)), shiftHi = shiftAt(sigma * (1 + VOL_BUMP));
  const rawLo = shiftLo == null ? rawAdj : pComp + shiftLo;
  const rawHi = shiftHi == null ? rawAdj : pComp + shiftHi;
  const pAdjLo = clamp(rawLo, 0.0001, 0.9999)!;
  const pAdjHi = clamp(rawHi, 0.0001, 0.9999)!;
  const volSensitivity = Math.max(Math.abs(rawHi - rawAdj), Math.abs(rawLo - rawAdj));
  return {
    pComp, pAdj, pAdjLo, pAdjHi, rawAdj, rawLo, rawHi, volSensitivity, shift, sigma, spot, strike: Kc!, strikeOffsetPct: sd,
    tteBaseDays: Tb * 365.25, tteCompDays: Tc * 365.25,
    offsetHours: (Date.parse(comp.expiry) - Date.parse(base.expiry)) / 3600000,
  };
}
function buildMaturityAdjustedCard(base: Raw, comp: Raw, adj: MaturityAdjustResult): Raw {
  const baseYes = normalizeProbability(base)!;
  const delta = baseYes - adj.pAdj;
  const baseSpread = computeSpread(base);
  const compSpread = computeSpread(comp);
  const spreadPenalty = ((baseSpread || 0.04) + (compSpread || 0.04)) / 2;
  // The model band must clear BOTH the term-shift reliance (a bigger maturity reprice leans
  // harder on the vol assumption) AND the measured vol-sensitivity (how far the adjusted price
  // moves under a ±20% vol stress). Take the larger so a vol-fragile reprice cannot pass on a
  // thin nominal gap.
  const volSens = adj.volSensitivity != null ? adj.volSensitivity : 0;
  const modelBand = Math.min(0.08, Math.max(0.5 * Math.abs(adj.shift), volSens) + 0.01);
  const adjusted = Math.sign(delta) * Math.max(0, Math.abs(delta) - spreadPenalty - modelBand);
  // Sign-stability: the edge must keep its direction across the vol-stress range. If the gap
  // flips sign when vol moves ±20%, it is a vol artifact, not a real cross-venue disagreement.
  const deltaLo = adj.rawLo != null ? baseYes - adj.rawLo : delta;
  const deltaHi = adj.rawHi != null ? baseYes - adj.rawHi : delta;
  const signStable = Math.sign(deltaLo) === Math.sign(delta) && Math.sign(deltaHi) === Math.sign(delta);
  const tradable = Math.abs(adjusted) >= 0.03 && signStable;
  const edgeSide = delta > 0 ? 'NO' : 'YES';
  const offAbs = Math.round(Math.abs(adj.offsetHours));
  const ivPct = adj.sigma * 100;
  const volPt = Math.round(volSens * 100);
  return {
    type: 'mispricing',
    id: `matadj:${base.id}:${comp.id}`,
    title: `Tradable HIP-4 market: ${base.title}`,
    baseMarket: base,
    comps: [comp],
    comparisonLabel: `${comp.venue} repriced to your settlement via BS digital (Δt ${offAbs}h)`,
    comparisonMethod: 'maturity_adjusted_digital',
    maturityAdjusted: {
      venue: comp.venue, rawPrice: adj.pComp, adjustedPrice: adj.pAdj, shift: adj.shift,
      iv: ivPct, spot: adj.spot, strike: adj.strike, offsetHours: adj.offsetHours,
      compExpiry: comp.expiry, baseExpiry: base.expiry,
    },
    tradeDirection: delta > 0 ? 'Verdict is pricing this higher than the maturity-adjusted external level' : 'Verdict is pricing this lower than the maturity-adjusted external level',
    verdictProb: baseYes,
    fairProb: adj.pAdj,
    deviation: delta,
    normalizedDelta: delta,
    adjustedDelta: adjusted,
    attribution: { rawShift: adj.shift, residualDelta: delta, volSensitivity: volSens, signStable, volStressLow: adj.pAdjLo, volStressHigh: adj.pAdjHi },
    edgeSide: tradable ? edgeSide : null,
    equivalenceConfidence: 'medium',
    caveats: ['maturity_adjusted_via_bs_digital', `settlement_offset_${offAbs}h`, `model_iv_${ivPct.toFixed(0)}pct`, `vol_sensitivity_${volPt}pt`].concat(signStable ? [] : ['edge_flips_under_vol_stress'], ['model_dependent_not_locked_arb']),
    evidence: [
      `Tradeable on Verdict/HIP-4: ${base.title} at YES ${fmtCents(baseYes)}, spread ${fmtCents(baseSpread)}`,
      `${comp.venue}: same strike ${refStrikeLabel(adj.strike)} ${base.direction}, but settles ${offAbs}h ${adj.offsetHours > 0 ? 'later' : 'earlier'} — raw price ${fmtCents(adj.pComp)}`,
      `BS digital reprice to your settlement (iv ${ivPct.toFixed(1)}%, spot $${Math.round(adj.spot).toLocaleString()}): maturity-adjusted ${fmtCents(adj.pAdj)} (term shift ${adj.shift >= 0 ? '+' : ''}${fmtCents(adj.shift)})`,
      `Maturity-adjusted gap ${fmtCents(delta)} (${fmtCents(adjusted)} after spreads + model band) — model-based relative value, NOT locked arbitrage (carries vol/settlement risk)`,
      `Vol-stress (iv ±20%): adjusted price ${fmtCents(Math.min(adj.pAdjLo, adj.pAdjHi))}–${fmtCents(Math.max(adj.pAdjLo, adj.pAdjHi))} (±${volPt}pt); edge ${signStable ? 'holds its side' : 'FLIPS under the stress — treated as NO edge'}`,
    ],
    reasonCodes: uniq(['MATURITY_ADJUSTED_DIGITAL', 'SAME_STRIKE_DIFF_SETTLEMENT', tradable ? `EDGE_BUY_${edgeSide}` : 'NO_ACTIONABLE_EDGE']),
    confidence: (signStable && Math.abs(adjusted) >= 0.05) ? 'medium' : 'low',
    direction: delta > 0 ? 'Verdict richer' : 'External richer',
    actionState: 'research',
    actionLabel: 'Review maturity-adjusted comparison',
  };
}

async function runMispricing({ query, snap, activeMarketId, venues, deadlineAt }: { query?: unknown; snap?: Raw; activeMarketId?: unknown; venues?: { polymarket?: boolean; kalshi?: boolean }; deadlineAt?: number }): Promise<Raw> {
  const dataStatus: Raw = { verdict: 'unavailable', polymarket: 'unavailable', kalshi: 'unavailable', llm: 'unavailable' };
  const baseMarkets = normalizeVerdictSnapshot(snap);
  if (baseMarkets.length) dataStatus.verdict = 'ok';
  const selected = selectBaseMarkets(baseMarkets, query, activeMarketId, activeMarketId ? 1 : 10);
  const wantsPoly = !venues || venues.polymarket !== false;
  const wantsKalshi = !venues || venues.kalshi !== false;
  if (!wantsPoly) dataStatus.polymarket = 'skipped';
  if (!wantsKalshi) dataStatus.kalshi = 'skipped';
  const external: Raw[] = [];
  const errors: Raw = {};
  const discoveryQuery = `${query} ${discoveryTermsForBases(selected)}`.trim();
  await Promise.all([
    wantsPoly ? searchPolymarket(discoveryQuery, deadlineAt).then(ms => { external.push(...ms); dataStatus.polymarket = ms.length ? 'ok' : 'partial'; }).catch(e => { errors.polymarket = (e && e.message) || String(e); }) : null,
    wantsKalshi ? searchKalshi(discoveryQuery, deadlineAt).then(ms => { external.push(...ms); dataStatus.kalshi = ms.length ? 'ok' : 'partial'; }).catch(e => { errors.kalshi = (e && e.message) || String(e); }) : null,
  ].filter(Boolean));
  const cards: Raw[] = [];
  const usableExternal = external.filter(usableExternalMarket);
  // Honest venue status: a venue is 'ok' only if a market with a real price signal
  // survived for THIS subject — never call a venue live when only dead books came back.
  if (wantsPoly && !errors.polymarket) dataStatus.polymarket = usableExternal.some(m => m.venue === VENUES.POLYMARKET) ? 'ok' : (external.some(m => m.venue === VENUES.POLYMARKET) ? 'partial' : 'unavailable');
  if (wantsKalshi && !errors.kalshi) dataStatus.kalshi = usableExternal.some(m => m.venue === VENUES.KALSHI) ? 'ok' : (external.some(m => m.venue === VENUES.KALSHI) ? 'partial' : 'unavailable');
  const externalMarkets = rankComparableExternalMarkets(selected, usableExternal, 24);
  // Options-implied vol per crypto base (one Deribit fetch each), used to bridge a same-strike
  // comparator that settles at a DIFFERENT time — see maturityAdjustComparator.
  const cryptoBases = selected.filter(b => b && ['BTC', 'ETH', 'SOL'].includes(b.underlying) && safeNum(b.strike) != null && b.expiry && (b.direction === 'above' || b.direction === 'below'));
  const deribitRefById: Record<string, DeribitRef> = {};
  (await Promise.all(cryptoBases.map(b => deribitImpliedProb(b, deadlineAt).then((r): [string, DeribitRef | null] => [b.id, r]).catch((): [string, null] => [b.id, null]))))
    .forEach(([id, r]) => { if (r) deribitRefById[id] = r; });
  for (const base of selected) {
    const scored = usableExternal
      .map(comp => ({ comp, eq: scoreResolutionEquivalence(base, comp), mp: computeMispricing(base, comp) }))
      .filter(x => x.mp.delta != null && x.eq.confidence === 'high' && isTradablePriceTwin(base, x.comp) && x.comp && [VENUES.POLYMARKET, VENUES.KALSHI].includes(x.comp.venue))
      .sort((a, b) => {
        return comparisonSortScore(base, b) - comparisonSortScore(base, a);
      });
    let built = false;
    for (const s of scored.slice(0, 1)) {
      if (s.eq.confidence !== 'high' && !((s.comp && s.comp.underlying) && s.comp.underlying === base.underlying) && textSimilarity(base.title, s.comp.title) < 0.55) continue;
      cards.push(buildMispricingCard(base, s.comp, s.eq));
      built = true;
    }
    // No exact twin on either venue? Fall back to a model-free interpolated comparator: the
    // external book has no market at this strike, so estimate its price there from the two
    // nearest same-settlement ladder rungs. Apples-to-apples without the curvature confound.
    if (!built) {
      const interp = interpolateLadderComparator(base, usableExternal, Date.now());
      if (interp) { cards.push(buildInterpolatedCard(base, interp)); built = true; }
    }
    // Still nothing, but the only mismatch is settlement TIME (same underlying/strike/direction
    // on a different clock — e.g. Kalshi 5pm EDT vs HL 06:00 UTC)? Bridge the maturities with a
    // BS digital reprice off the options-implied vol, so a different-expiry comparator is still
    // comparable. Model-based relative value, surfaced as such — never a locked arbitrage.
    if (!built && deribitRefById[base.id]) {
      const ref = deribitRefById[base.id]!;
      if (ref.iv > 0 && ref.spot > 0) {
        let best: { comp: Raw; adj: MaturityAdjustResult; off: number; sd: number } | null = null;
        for (const comp of usableExternal) {
          if (!comp || comp.underlying !== base.underlying || comp.direction !== base.direction) continue;
          if (![VENUES.POLYMARKET, VENUES.KALSHI].includes(comp.venue)) continue;
          const adj = maturityAdjustComparator(base, comp, ref.iv / 100, ref.spot, Date.now());
          if (!adj) continue;
          const off = Math.abs(adj.offsetHours);
          const sd = adj.strikeOffsetPct != null ? adj.strikeOffsetPct : 1;
          // Prefer the comparator with the CLOSEST strike (least model correction near ATM),
          // then the one settling closest — the smaller the bridge, the less it leans on vol.
          if (!best || sd < best.sd - 1e-9 || (Math.abs(sd - best.sd) < 1e-9 && off < best.off)) best = { comp, adj, off, sd };
        }
        if (best) { cards.push(buildMaturityAdjustedCard(base, best.comp, best.adj)); built = true; }
      }
    }
  }
  // Sanity cap: a MODEL-based comparator (ladder interpolation / maturity bridge) that implies
  // a >20pt gap on a liquid binary is almost certainly a methodology artifact (mismatched
  // settlement window or a bad interpolation bracket), not a real free-money dislocation — if
  // it were real it would be arbed instantly. Drop it rather than surface a fabricated edge.
  // Exact-twin (high-equivalence) cards are untouched: a genuine gap there is a real read.
  const MODEL_GAP_CAP = 0.20;
  const modelMethod = (c: Raw) => c && (c.comparisonMethod === 'ladder_interpolation' || c.comparisonMethod === 'maturity_adjusted_digital');
  const sane = cards.filter((c) => !modelMethod(c) || Math.abs(c.normalizedDelta != null ? c.normalizedDelta : 0) <= MODEL_GAP_CAP);
  cards.length = 0;
  cards.push(...sane);
  cards.sort((a, b) => Math.abs(b.adjustedDelta || b.normalizedDelta || 0) - Math.abs(a.adjustedDelta || a.normalizedDelta || 0));
  const out: Raw = {
    summary: cards.length
      ? `Found ${cards.length} candidate price gap${cards.length === 1 ? '' : 's'} from live market data. These are not labeled as arbitrage unless the markets match very closely.`
      : externalMarkets.length
        ? `No high-confidence cross-venue match: the closest ${externalMarkets.length} Polymarket/Kalshi market${externalMarkets.length === 1 ? '' : 's'} differ on settlement date or strike, so they are shown as loose references rather than a tradable edge.`
        : 'No comparable Polymarket or Kalshi markets were found for these Verdict markets right now.',
    cards: cards.slice(0, 8),
    externalMarkets,
    baseTitles: selected.map(m => m && m.title).filter(Boolean).slice(0, 12),
    evidence: [
      `Verdict markets scanned: ${selected.length}/${baseMarkets.length}`,
      `External markets fetched: ${external.length}`,
      external.length !== usableExternal.length ? `External markets usable after stale/illiquid filter: ${usableExternal.length}` : null,
      errors.polymarket ? `Polymarket unavailable: ${errors.polymarket}` : `Polymarket status: ${dataStatus.polymarket}`,
      errors.kalshi ? `Kalshi unavailable: ${errors.kalshi}` : `Kalshi status: ${dataStatus.kalshi}`,
    ].filter(Boolean),
    dataStatus,
    errors,
    route: ROUTES.MISPRICING,
    generatedAt: nowIso(),
  };
  await appendDeribitEvidence(out, selected, deadlineAt);
  return out;
}
async function runStrategy({ query, snap, activeMarketId, route, deadlineAt }: { query?: unknown; snap?: Raw; activeMarketId?: unknown; route: RouteId; deadlineAt?: number }): Promise<Raw> {
  const dataStatus: Raw = { verdict: 'unavailable', polymarket: 'skipped', kalshi: 'skipped', llm: 'unavailable' };
  const markets = normalizeVerdictSnapshot(snap);
  if (markets.length) dataStatus.verdict = 'ok';
  const eventMode = wantsEventSuggestions(query);
  const selected = eventMode
    ? selectEventMarkets(markets, query, activeMarketId, activeMarketId ? 1 : 8)
    : selectBaseMarkets(markets, query, activeMarketId, activeMarketId ? 1 : 4);
  const cards = selected.map(item => {
    const market = (item && item.market) ? item.market : item;
    if (route === ROUTES.RISK) return buildRiskCard(market, snap, route);
    if (route === ROUTES.SETUP) return buildTradingSetupCard(market, snap, route);
    return eventMode ? buildEventStrategyCard(item, snap, route) : buildStrategyCard(market, snap, route);
  });
  const out: Raw = {
    summary: cards.length
      ? route === ROUTES.SETUP
        ? `Built ${cards.length} trading setup${cards.length === 1 ? '' : 's'} from current Verdict/HL data.`
        : eventMode
        ? `Built ${cards.length} event-by-event trade suggestion${cards.length === 1 ? '' : 's'} from current Verdict/HL data.`
        : `Built ${cards.length} live market read${cards.length === 1 ? '' : 's'} from current Verdict/HL data.`
      : 'Verdict/HL market data is unavailable, so no strategy was generated.',
    cards,
    externalMarkets: [],
    baseTitles: selected.map(item => ((item && item.market) ? item.market : item)).filter(Boolean).map(m => m.title).filter(Boolean).slice(0, 12),
    evidence: [
      `Verdict/HL markets available: ${markets.length}`,
      `Route: ${route}`,
      eventMode ? 'Event-by-event suggestions requested.' : 'Top-market suggestions requested.',
      'Trade ticket handoff available for matching Verdict markets.',
    ],
    dataStatus,
    errors: {},
    route,
    generatedAt: nowIso(),
  };
  const baseList = selected.map(item => ((item && item.market) ? item.market : item)).filter(Boolean);
  await appendDeribitEvidence(out, baseList, deadlineAt);
  return out;
}
// Proactive "find the best setup right now" — scans ALL live Verdict markets ranked by tradeable
// quality (tight spread, real depth, live prob-band), not raw volume. Read-only; reuses the same
// strategy cards + ticket handoff. No external venue fetch on this hot path (follow-on PR).
// Cross-venue edge for a scanned market: the best HIGH-confidence Polymarket/Kalshi twin and the
// signed gap. Reuses the same equivalence + mispricing gates as the mispricing route, so it never
// fabricates an edge from a non-twin. Returns a one-line string or null.
function crossVenueEdgeLine(base: Raw | null | undefined, usableExternal: Raw[] | null | undefined): string | null {
  let best: { comp: Raw; mp: MispricingResult } | null = null;
  for (const comp of usableExternal || []) {
    if (!comp || ![VENUES.POLYMARKET, VENUES.KALSHI].includes(comp.venue)) continue;
    const eq = scoreResolutionEquivalence(base, comp);
    if (eq.confidence !== 'high' || !isTradablePriceTwin(base, comp)) continue;
    const mp = computeMispricing(base!, comp);
    if (mp.delta == null) continue;
    if (!best || Math.abs(mp.delta) > Math.abs(best.mp.delta!)) best = { comp, mp };
  }
  if (!best) return null;
  const v = normalizeProbability(base), c = normalizeProbability(best.comp);
  return `Cross-venue: Verdict ${fmtCents(v)} vs ${best.comp.venue} ${fmtCents(c)} (Verdict ${best.mp.delta! > 0 ? 'richer' : 'cheaper'} by ${fmtCents(Math.abs(best.mp.delta!))})`;
}
// Best-effort: fetch Polymarket/Kalshi for the scanned subjects and annotate any scanned card that
// has a real cross-venue twin. Never throws; never blocks the scan from returning.
async function annotateOpportunityCrossVenue(selected: Raw[], cards: Raw[], query: unknown, dataStatus: Raw | null | undefined, deadlineAt?: number): Promise<Raw[]> {
  try {
    const disc = `${query} ${discoveryTermsForBases(selected)}`.trim();
    const ext: Raw[] = [];
    await Promise.all([
      searchPolymarket(disc, deadlineAt).then(ms => { ext.push(...ms); }).catch(() => {}),
      searchKalshi(disc, deadlineAt).then(ms => { ext.push(...ms); }).catch(() => {}),
    ]);
    const usable = ext.filter(usableExternalMarket);
    if (dataStatus) {
      dataStatus.polymarket = usable.some(m => m.venue === VENUES.POLYMARKET) ? 'ok' : 'unavailable';
      dataStatus.kalshi = usable.some(m => m.venue === VENUES.KALSHI) ? 'ok' : 'unavailable';
    }
    if (!usable.length) return [];
    selected.forEach((base, i) => {
      const card = cards[i];
      if (!card) return;
      const line = crossVenueEdgeLine(base, usable);
      if (line) card.evidence = [line].concat(card.evidence || []);
    });
    return rankComparableExternalMarkets(selected, usable, 10);
  } catch { return []; }
}
async function runOpportunity({ query, snap, activeMarketId, deadlineAt }: { query?: unknown; snap?: Raw; activeMarketId?: unknown; deadlineAt?: number }): Promise<Raw> {
  const route = ROUTES.OPPORTUNITY;
  const dataStatus: Raw = { verdict: 'unavailable', polymarket: 'skipped', kalshi: 'skipped', llm: 'unavailable' };
  const markets = normalizeVerdictSnapshot(snap);
  if (markets.length) dataStatus.verdict = 'ok';
  const selected = selectOpportunityMarkets(markets, query, activeMarketId, activeMarketId ? 1 : 8);
  const cards = selected.map(m => buildStrategyCard(m, snap, route)).filter(Boolean);
  cards.forEach((c, i) => {
    const w = opportunityWhy(selected[i]);
    if (w) c.evidence = [`Why this ranks: ${w}`].concat(c.evidence || []);
  });
  // Cross-venue edge: flag where a top Verdict market is mispriced vs its Polymarket/Kalshi twin.
  const externalMarkets = await annotateOpportunityCrossVenue(selected, cards, query, dataStatus, deadlineAt);
  const out: Raw = {
    summary: cards.length
      ? `Scanned ${markets.length} live Verdict markets and ranked the ${cards.length} most tradeable by spread, depth, and live odds.`
      : 'Verdict/HL market data is unavailable, so no opportunity scan was generated.',
    cards,
    externalMarkets,
    baseTitles: selected.map(m => m && m.title).filter(Boolean).slice(0, 12),
    evidence: [
      `Verdict/HL markets scanned: ${markets.length}`,
      `Route: ${route}`,
      'Ranked by tradeable quality (tight spread + depth + live prob-band), not raw volume.',
      'Trade ticket handoff available for the surfaced markets.',
    ],
    dataStatus,
    errors: {},
    route,
    generatedAt: nowIso(),
  };
  await appendDeribitEvidence(out, selected, deadlineAt);
  return out;
}
async function runResearch(req: Raw | null | undefined): Promise<Raw> {
  const query = (req && req.query) || '';
  const mode = (req && req.mode) || 'auto';
  const route = classifyRoute(query, mode);
  const deadlineAt = (req && req.deadlineAt) || 0;
  let result: Raw;
  if (route === ROUTES.MISPRICING) {
    result = await runMispricing({
      query,
      snap: req && req.snap,
      activeMarketId: req && req.activeMarketId,
      venues: req && req.venues,
      deadlineAt,
    });
  } else if (route === ROUTES.OPPORTUNITY) {
    result = await runOpportunity({
      query,
      snap: req && req.snap,
      activeMarketId: req && req.activeMarketId,
      deadlineAt,
    });
  } else {
    result = await runStrategy({
      query,
      snap: req && req.snap,
      activeMarketId: req && req.activeMarketId,
      route,
      deadlineAt,
    });
  }
  result.gate = evaluateEvidenceGate(result);
  result.reply = buildAgentReply({
    query,
    route,
    summary: result.summary,
    cards: result.cards,
    dataStatus: result.dataStatus,
    externalMarkets: result.externalMarkets,
    evidence: result.evidence,
  });
  return result;
}

export {
  VENUES,
  ROUTES,
  fmtCents,
  fmtUsd,
  normalizeProbability,
  computeSpread,
  scoreResolutionEquivalence,
  setupExitPlan,
  tradeCallForMarket,
  computeMispricing,
  buildMispricingCard,
  interpolateLadderComparator,
  digitalAboveProb,
  maturityAdjustComparator,
  buildMaturityAdjustedCard,
  findHedgeCandidates,
  getPlaybook,
  normalizeVerdictSnapshot,
  normalizePolymarketMarket,
  normalizeKalshiMarket,
  normalizeOddpoolMarket,
  searchPolymarket,
  searchKalshi,
  searchOddpool,
  deribitImpliedProb,
  classifyRoute,
  buildAgentReply,
  evaluateEvidenceGate,
  opportunityScore,
  selectOpportunityMarkets,
  crossVenueEdgeLine,
  runOpportunity,
  runResearch,
};
export type { EquivalenceResult, MispricingResult, DeribitRef, MaturityAdjustResult, HedgeCandidate, ExitPlan, TradeCall };
