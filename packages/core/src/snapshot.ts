// Engine snapshot adapter. The cross-venue engine (packages/engine, the Verdict app's
// research-core.ts) reads a live-state snapshot the app assembles from outcomeMeta, the outcome
// books and spotMetaAndAssetCtxs (src/live/live-hl.ts, applyOutcomeMeta). This module builds
// the same object from InfoClient calls, using the app's own shape helpers (hl-shape.ts, also
// pinned in packages/engine) so descriptions parse and books read exactly as they do on
// hyperverdict.xyz. The mid rule is stricter than the app's (priceFromBook): a coin with no
// trades in the last 24h is priced only off a real quote on a book the kit read, never off the
// asset context's midPx or a stale mark. Read only; nothing here needs an account.
import { type AssetCtx, bookTopBidAsk, parseDescription as parseHlDescription, robustOutcomeMid, type TopOfBook } from '@verdict/engine';
import { z } from 'zod';
import type { InfoClient } from './hl/client.js';
import type { L2Book, OutcomeMetaQuestion, SpotAssetCtx } from './hl/schemas.js';
import { type Catalog, type Market, parseDescription, splitTemplateDescription, substituteKeywords, templateIdOf } from './markets.js';

/** Underlyings the engine can map to a Hyperliquid perp or spot hedge (research-core HEDGE_SYMBOLS). */
export const HEDGE_SYMBOLS = ['BTC', 'ETH', 'HYPE', 'SOL'] as const;

const Num = z.number().finite();

/**
 * Why a market carries no price. A coin with zero 24h notional has no trade signal today, so only a real quote on
 * a book the kit read can price it: `never_traded_*` when Hyperliquid's asset context holds the 0.5 placeholder
 * mark (the coin has never traded), `stale_*` when it holds a mark from an earlier day (the coin traded before but
 * not in the last 24h; that mark is not a current price). `*_wall_book`: the book was read and is empty or holds
 * only parked walls (a bid within 5c of 0, an ask within 5c of 1). `*_no_book`: the book was not read; the
 * context's midPx is a raw (bid+ask)/2 that prints a phantom on a wall or one-sided book, so it is not used.
 * `no_price_data`: neither a book mid nor a mark exists for the coin.
 */
export const UnpricedReason = z.enum(['never_traded_wall_book', 'never_traded_no_book', 'stale_wall_book', 'stale_no_book', 'no_price_data']);
export type UnpricedReason = z.infer<typeof UnpricedReason>;

export const EngineTopOfBook = z.object({ bid: Num.nullable(), bidSz: Num.nullable(), ask: Num.nullable(), askSz: Num.nullable() });

/** hl-shape ParsedMarket: description keywords plus the derived class/underlying/strike/expiry fields the engine reads. */
export const EngineParsed = z
  .object({
    class: z.string().optional(),
    underlying: z.string().optional(),
    expiry: z.string().optional(),
    expiryMs: Num.optional(),
    targetPrice: z.string().optional(),
    targetPriceNum: Num.optional(),
    priceThresholds: z.string().optional(),
    priceThresholdNums: z.array(Num).optional(),
  })
  .catchall(z.unknown());

export const EngineOutcome = z.object({
  outcome: z.number().int().nonnegative(),
  /** Display name; for price binaries the engine derives its own title from `parsed`. */
  name: z.string(),
  rawName: z.string(),
  /** Settlement rule text when the template is known, otherwise the raw onchain description. The engine reads it as rules. */
  description: z.string(),
  venue: z.string().nullable(),
  parsed: EngineParsed,
  sideSpecs: z.array(z.object({ name: z.string() })),
  yesLabel: z.string(),
  noLabel: z.string(),
  yesCoin: z.string(),
  noCoin: z.string(),
  yesAssetId: z.number().int(),
  noAssetId: z.number().int(),
  books: z.object({ yes: EngineTopOfBook.nullable(), no: EngineTopOfBook.nullable() }),
  /** YES probability: robust book mid, else Hyperliquid's mark for a coin that traded in the last 24h; null when nothing prices the market. */
  mid: Num.nullable(),
  /** 'book': from the book the kit read. 'ctx': Hyperliquid's markPx (the coin traded today; the book is wide, one-sided or unread). */
  midSource: z.enum(['book', 'ctx']).nullable(),
  /** Why mid is null, when it is; always null when mid is a number. */
  unpriced: UnpricedReason.nullable(),
  bucketLabel: z.string().optional(),
  bucketIdx: z.number().int().optional(),
  bucketLo: Num.nullable().optional(),
  bucketHi: Num.nullable().optional(),
  parentQuestion: z.number().int().optional(),
  templateId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  settlementRule: z.string().nullable(),
});
export type EngineOutcome = z.infer<typeof EngineOutcome>;

export const EngineQuestion = z.object({
  question: z.number().int().nonnegative(),
  name: z.string(),
  rawName: z.string(),
  description: z.string(),
  parsed: EngineParsed,
  namedOutcomes: z.array(EngineOutcome),
  fallbackOutcome: EngineOutcome.nullable(),
  venue: z.string().nullable(),
});
export type EngineQuestion = z.infer<typeof EngineQuestion>;

export const EngineAssetCtx = z.object({ coin: z.string(), dayNtlVlm: z.string(), markPx: z.string().optional(), midPx: z.string().nullable().optional() });

export const EngineSnapshot = z.object({
  network: z.enum(['testnet', 'mainnet']),
  generatedAt: z.string(),
  outcomes: z.array(EngineOutcome),
  standalone: z.array(EngineOutcome),
  questions: z.array(EngineQuestion),
  /** Underlying reference mids, e.g. { BTC: 77335.5 }; the engine reads them for hedge candidates. */
  coinMids: z.record(z.string(), Num),
  /** Asset contexts keyed by outcome coin (`#<encoding>`); the engine reads dayNtlVlm for 24h volume. */
  assetCtxByCoin: z.record(z.string(), EngineAssetCtx),
  bookErrors: z.array(z.object({ coin: z.string(), message: z.string() })),
  /** Markets whose books were requested (all of them unless maxBooks applied). */
  booksFetched: z.number().int().nonnegative(),
});
export type EngineSnapshot = z.infer<typeof EngineSnapshot>;

export interface SnapshotOptions {
  /** Fetch the YES and NO books of every market. Default true; without books only asset-context marks price the markets. */
  readonly books?: boolean;
  /**
   * Fetch books only for this many markets, the most traded by Hyperliquid 24h notional (asset contexts); the rest
   * price off their asset-context mark. Default: every market. Two l2Book requests (weight 2 each) per market.
   */
  readonly maxBooks?: number;
  /** Fetch allMids for the underlying reference prices hedges need. Default false. */
  readonly coinMids?: boolean;
  /** Parallel book requests. Default 8. */
  readonly concurrency?: number;
  /** What to do when one book cannot be read: fail the snapshot (default) or leave that book null and record the error. */
  readonly onBookError?: 'throw' | 'skip';
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

/** The hl-shape AssetCtx view of a validated spot context (exact optional keys, no explicit undefined). */
function toHlCtx(ctx: SpotAssetCtx): AssetCtx & { coin: string } {
  return {
    coin: ctx.coin,
    dayNtlVlm: ctx.dayNtlVlm,
    ...(ctx.markPx !== undefined ? { markPx: ctx.markPx } : {}),
    ...(ctx.midPx !== undefined ? { midPx: ctx.midPx } : {}),
  };
}

/** The coin traded in the last 24h (positive dayNtlVlm), so Hyperliquid's markPx is a current trade/EMA fair value. */
export function tradedToday(ctx: SpotAssetCtx | undefined): boolean {
  return ctx !== undefined && Number(ctx.dayNtlVlm) > 0;
}

/** Hyperliquid's context for a coin that has never traded: zero 24h notional and the 0.5 placeholder mark, which is not a price. */
export function isPlaceholderCtx(ctx: SpotAssetCtx | undefined): boolean {
  return ctx !== undefined && Number(ctx.dayNtlVlm) === 0 && Number(ctx.markPx) === 0.5;
}

/**
 * Hyperliquid's context for a coin that traded on an earlier day but not in the last 24h: zero 24h notional and a
 * markPx that is not the placeholder. That mark is the last fair value from when it traded, not a current price.
 */
export function isStaleCtx(ctx: SpotAssetCtx | undefined): boolean {
  return ctx !== undefined && Number(ctx.dayNtlVlm) === 0 && ctx.markPx !== undefined && Number(ctx.markPx) !== 0.5;
}

/** Hyperliquid's markPx as a probability, only for a coin that traded today; the context's midPx is never a mark. */
function currentMark(ctx: SpotAssetCtx | undefined): number | null {
  if (ctx === undefined || !tradedToday(ctx) || ctx.markPx === undefined) return null;
  const m = Number(ctx.markPx);
  return Number.isFinite(m) ? Math.max(0, Math.min(1, m)) : null;
}

/**
 * Mirrors hl-shape's unexported OUTCOME_WALL_BAND: on an outcome book a quote within 5c of 0 or 1 is a parked wall,
 * not interest. The engine tests read the constant out of the pinned hl-shape.ts and fail if a pin move changes it.
 */
export const OUTCOME_WALL_BAND = 0.05;
function hasRealQuote(top: TopOfBook): boolean {
  return (top.bid !== null && top.bid > OUTCOME_WALL_BAND) || (top.ask !== null && top.ask < 1 - OUTCOME_WALL_BAND);
}

/** Why a coin with no trades today and no real quote is unpriced: never traded, or traded on an earlier day. */
function untradedReason(ctx: SpotAssetCtx | undefined, kind: 'wall_book' | 'no_book'): UnpricedReason {
  if (ctx === undefined || tradedToday(ctx)) return 'no_price_data';
  return isStaleCtx(ctx) ? `stale_${kind}` : `never_traded_${kind}`;
}

export interface PriceFromBook {
  top: z.infer<typeof EngineTopOfBook> | null;
  mid: number | null;
  /** 'ctx' only when mid is Hyperliquid's markPx for a coin that traded today; never the context's midPx. */
  source: 'book' | 'ctx' | null;
  /** Set exactly when mid is null. */
  unpriced: UnpricedReason | null;
}

/**
 * Top of book plus the mid the kit reports for this coin.
 *
 * A coin that traded in the last 24h prices the way the app does: robust book mid, anchored to Hyperliquid's markPx
 * when the book is wide or one-sided, and the mark alone when the book is empty or unread (source 'ctx').
 *
 * A coin with zero 24h notional has no trade signal today, and its context carries nothing usable as a mark:
 * markPx is the 0.5 placeholder (never traded) or a fair value from an earlier day (stale), and midPx is a raw
 * (bid+ask)/2 that prints 0.5 over a wall-only book and a phantom over any one-sided one. The app's ctxOutcomeMid
 * returns that midPx and robustOutcomeMid anchors a wide book to it, so a wall book comes out at 50% either way.
 * Most deployer markets sit in one of these states. The kit therefore prices such a coin only off a real quote
 * (outside the 5c wall bands) on a book it read; otherwise the market is unpriced with the reason recorded.
 */
export function priceFromBook(book: L2Book | null, ctx: SpotAssetCtx | undefined): PriceFromBook {
  const mark = currentMark(ctx);
  if (!book) {
    if (mark !== null) return { top: null, mid: mark, source: 'ctx', unpriced: null };
    return { top: null, mid: null, source: null, unpriced: untradedReason(ctx, 'no_book') };
  }
  const top = bookTopBidAsk(book);
  if (mark === null) {
    // No current mark to anchor to: only a real quote prices the market. Without this guard robustOutcomeMid
    // returns the bid wall of a wall-only book (0.00001) as if it were interest.
    if (!hasRealQuote(top)) return { top, mid: null, source: null, unpriced: untradedReason(ctx, 'wall_book') };
    const fromQuotes = robustOutcomeMid(top, null);
    return fromQuotes == null ? { top, mid: null, source: null, unpriced: untradedReason(ctx, 'wall_book') } : { top, mid: fromQuotes, source: 'book', unpriced: null };
  }
  const mid = robustOutcomeMid(top, mark);
  if (mid == null) return { top, mid: mark, source: 'ctx', unpriced: null };
  const tightTwoSided = top.bid != null && top.ask != null && top.ask - top.bid <= 0.1;
  const fromBook = tightTwoSided || mid !== mark;
  return { top, mid, source: fromBook ? 'book' : 'ctx', unpriced: null };
}

/**
 * The snapshot as the ranking engine may read it: the books of unpriced outcomes removed. The engine's
 * normalizeVerdictOutcome averages whatever top of book it is given when mid is null, so a wall-only book
 * (0.00001 / 0.99999) would print the 0.5 phantom, earn opportunityScore's in-band probability bonus and be described
 * as "YES 50.0%". With neither a book nor a mid the engine has nothing to price the market with: it scores it at the
 * floor and prints no probability. Priced outcomes keep their books; the kit's own snapshot keeps every book.
 */
export function withoutUnpricedBooks(snap: EngineSnapshot): EngineSnapshot {
  const blank = (o: EngineOutcome): EngineOutcome => (o.mid === null ? { ...o, books: { yes: null, no: null } } : o);
  return {
    ...snap,
    outcomes: snap.outcomes.map(blank),
    standalone: snap.standalone.map(blank),
    questions: snap.questions.map((q) => ({ ...q, namedOutcomes: q.namedOutcomes.map(blank), fallbackOutcome: q.fallbackOutcome ? blank(q.fallbackOutcome) : null })),
  };
}

function questionDisplay(q: OutcomeMetaQuestion, catalog: Catalog): { name: string; description: string } {
  const templateId = templateIdOf(q.name);
  const template = templateId ? catalog.templates.get(templateId) : undefined;
  if (!template) return { name: q.name, description: q.description };
  const keywords = parseDescription(q.description);
  return {
    name: substituteKeywords(template.name, keywords),
    description: substituteKeywords(splitTemplateDescription(template.description).rule, keywords),
  };
}

export async function buildSnapshot(client: InfoClient, catalog: Catalog, markets: readonly Market[], opts: SnapshotOptions = {}): Promise<EngineSnapshot> {
  const wantBooks = opts.books ?? true;
  const concurrency = opts.concurrency ?? 8;
  const onBookError = opts.onBookError ?? 'throw';
  const coins = markets.flatMap((m) => [m.sides[0].coin, m.sides[1].coin]);
  const coinSet = new Set(coins);

  const [, ctxs] = await client.spotMetaAndAssetCtxs();
  const ctxByCoin = new Map<string, SpotAssetCtx>();
  for (const c of ctxs) if (coinSet.has(c.coin)) ctxByCoin.set(c.coin, c);

  // Books are the expensive part (two requests per market), so a scan can restrict them to the markets that
  // actually trade: rank by 24h notional of both coins and keep the top maxBooks.
  let bookMarkets: readonly Market[] = wantBooks ? markets : [];
  if (wantBooks && opts.maxBooks !== undefined && opts.maxBooks < markets.length) {
    const volume = (m: Market) => Number(ctxByCoin.get(m.sides[0].coin)?.dayNtlVlm ?? 0) + Number(ctxByCoin.get(m.sides[1].coin)?.dayNtlVlm ?? 0);
    bookMarkets = [...markets].sort((a, b) => volume(b) - volume(a)).slice(0, Math.max(0, opts.maxBooks));
  }
  const bookCoins = bookMarkets.flatMap((m) => [m.sides[0].coin, m.sides[1].coin]);

  const bookErrors: { coin: string; message: string }[] = [];
  const bookByCoin = new Map<string, L2Book>();
  if (bookCoins.length) {
    const results = await mapConcurrent(bookCoins, concurrency, async (coin) => {
      try {
        return { coin, book: await client.l2Book(coin) };
      } catch (e) {
        if (onBookError === 'throw') throw e;
        bookErrors.push({ coin, message: e instanceof Error ? e.message : String(e) });
        return { coin, book: null };
      }
    });
    for (const r of results) if (r.book) bookByCoin.set(r.coin, r.book);
  }

  const coinMids: Record<string, number> = {};
  if (opts.coinMids) {
    const mids = await client.allMids();
    const wanted = new Set<string>([...HEDGE_SYMBOLS, ...markets.map((m) => m.underlying).filter((u): u is string => u !== null)]);
    for (const sym of wanted) {
      const v = mids[sym];
      if (v !== undefined) coinMids[sym] = Number(v);
    }
  }

  const outcomes: EngineOutcome[] = markets.map((m) => {
    const yesCoin = m.sides[0].coin;
    const noCoin = m.sides[1].coin;
    const yes = priceFromBook(bookByCoin.get(yesCoin) ?? null, ctxByCoin.get(yesCoin));
    const no = priceFromBook(bookByCoin.get(noCoin) ?? null, ctxByCoin.get(noCoin));
    return {
      outcome: m.outcome,
      name: m.displayName,
      rawName: m.name,
      description: m.settlementRule ?? m.description,
      venue: m.venue || null,
      parsed: parseHlDescription(m.description),
      sideSpecs: m.sides.map((s) => ({ name: s.name })),
      yesLabel: m.sides[0].name,
      noLabel: m.sides[1].name,
      yesCoin,
      noCoin,
      yesAssetId: m.sides[0].assetId,
      noAssetId: m.sides[1].assetId,
      books: { yes: yes.top, no: no.top },
      mid: yes.mid,
      midSource: yes.source,
      unpriced: yes.unpriced,
      templateId: m.templateId,
      expiresAt: m.expiresAt,
      settlementRule: m.settlementRule,
    };
  });
  const byOutcome = new Map(outcomes.map((o) => [o.outcome, o] as const));

  const questions: EngineQuestion[] = [];
  const childIds = new Set<number>();
  for (const q of catalog.meta.questions) {
    const named = q.namedOutcomes.map((id) => byOutcome.get(id) ?? null);
    const fallback = q.fallbackOutcome != null ? (byOutcome.get(q.fallbackOutcome) ?? null) : null;
    if (!named.some((o) => o !== null) && !fallback) continue;
    const parsed = parseHlDescription(q.description);
    const thresholds = parsed.class === 'priceBucket' ? parsed.priceThresholdNums : undefined;
    const members: EngineOutcome[] = [];
    named.forEach((o, i) => {
      if (!o) return;
      let member: EngineOutcome = { ...o, parentQuestion: q.question };
      if (thresholds) {
        const lo = i === 0 ? null : (thresholds[i - 1] ?? null);
        const hi = i < thresholds.length ? (thresholds[i] ?? null) : null;
        if (lo != null || hi != null) {
          const label = lo == null ? `< $${(hi as number).toLocaleString()}` : hi == null ? `> $${lo.toLocaleString()}` : `$${lo.toLocaleString()} - $${hi.toLocaleString()}`;
          member = { ...member, bucketLabel: label, bucketIdx: i, bucketLo: lo, bucketHi: hi };
        }
      }
      members.push(member);
      childIds.add(member.outcome);
    });
    const fb = fallback ? { ...fallback, parentQuestion: q.question } : null;
    if (fb) childIds.add(fb.outcome);
    const display = questionDisplay(q, catalog);
    questions.push({
      question: q.question,
      name: display.name,
      rawName: q.name,
      description: display.description,
      parsed,
      namedOutcomes: members,
      fallbackOutcome: fb,
      venue: members.find((o) => o.venue)?.venue ?? fb?.venue ?? null,
    });
  }

  const assetCtxByCoin: Record<string, z.infer<typeof EngineAssetCtx>> = {};
  for (const [coin, ctx] of ctxByCoin) assetCtxByCoin[coin] = EngineAssetCtx.parse(toHlCtx(ctx));

  return EngineSnapshot.parse({
    network: client.config.network,
    generatedAt: new Date().toISOString(),
    outcomes,
    standalone: outcomes.filter((o) => !childIds.has(o.outcome)),
    questions,
    coinMids,
    assetCtxByCoin,
    bookErrors,
    booksFetched: bookMarkets.length,
  });
}
