// The cross-venue engine in the kit: pinned copy, snapshot adapter, and the four tools over it,
// all against recorded fixtures with the clock frozen at the recording time and no network.
import { spawnSync } from 'node:child_process';
import { cpSync, appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENGINE_UPSTREAM, type MaturityAdjustResult, buildMaturityAdjustedCard, normalizeVerdictSnapshot } from '@verdict/engine';
import {
  Comparator,
  CompareMarketResult,
  FairValueResult,
  FindHedgesResult,
  HL_MARK_TAG,
  InfoClient,
  type KitConfig,
  OpportunitiesResult,
  UNPRICED_TAG_PREFIX,
  VOL_FLIP_TAG,
  buildSnapshot,
  comparatorFromEngineCard,
  createTools,
  hlSchemas,
  loadCatalog,
  marketFromCatalog,
  priceFromBook,
  strikeOffsetCaveat,
} from '../packages/core/src/index.js';
import { runCli } from '../packages/cli/src/index.js';
import { createServer } from '../packages/mcp/src/server.js';
import { fixtureFetch, recordedAt } from './helpers/fixture-fetch.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}

const log: string[] = [];
const fetchAll = fixtureFetch({ log });

/** The recorded fixtures with the asset contexts of some coins overwritten, e.g. to make a never-traded coin look traded. */
function patchedCtxFetch(coins: readonly string[], patch: Record<string, string>): typeof fetch {
  const inner = fixtureFetch();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
    if (body.type !== 'spotMetaAndAssetCtxs') return res;
    const [meta, ctxs] = (await res.json()) as [unknown, { coin: string }[]];
    const patched = ctxs.map((c) => (coins.includes(c.coin) ? { ...c, ...patch } : c));
    return new Response(JSON.stringify([meta, patched]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const client = new InfoClient({ network: 'mainnet', fetch: fetchAll });
const config: KitConfig = { network: 'mainnet', venue: 'out', builder: null };
const tools = createTools(config, client, { engine: { timeoutMs: 5_000 } });

beforeAll(() => {
  // The engine reads the global fetch and the clock: freeze both to the recording.
  vi.stubGlobal('fetch', fetchAll);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(recordedAt());
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('engine pin', () => {
  it('the local copies are the pinned upstream files (offline drift check)', () => {
    const r = spawnSync(process.execPath, ['scripts/check-engine-drift.mjs', '--offline'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('engine drift: none');
  });
  it('a modified copy fails the drift check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'engine-drift-'));
    cpSync(join(ROOT, 'packages/engine/UPSTREAM.json'), join(tmp, 'packages/engine/UPSTREAM.json'));
    cpSync(join(ROOT, 'packages/engine/src'), join(tmp, 'packages/engine/src'), { recursive: true });
    appendFileSync(join(tmp, 'packages/engine/src/research-core.ts'), '\n// drift\n');
    const r = spawnSync(process.execPath, ['scripts/check-engine-drift.mjs', '--offline', '--root', tmp], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
  });
  it('the generated provenance constant matches UPSTREAM.json', () => {
    const upstream = JSON.parse(readFileSync(join(ROOT, 'packages/engine/UPSTREAM.json'), 'utf8')) as { repo: string; commit: string; files: { sha256: string }[] };
    expect(ENGINE_UPSTREAM.repo).toBe(upstream.repo);
    expect(ENGINE_UPSTREAM.commit).toBe(upstream.commit);
    expect(ENGINE_UPSTREAM.files.map((f) => f.sha256)).toEqual(upstream.files.map((f) => f.sha256));
  });
});

describe('snapshot adapter', () => {
  it('builds what normalizeVerdictSnapshot reads for a price binary, with mids from the books', async () => {
    const catalog = await loadCatalog(client);
    const m = must(marketFromCatalog(catalog, 1210), 'market 1210');
    const snap = await buildSnapshot(client, catalog, [m]);
    const o = must(snap.outcomes[0], 'outcome');
    expect(o.yesCoin).toBe('#12100');
    expect(o.noCoin).toBe('#12101');
    expect(must(o.books.yes, 'yes book').bid).toBeCloseTo(0.0191, 6);
    expect(must(o.books.yes, 'yes book').ask).toBeCloseTo(0.0251, 6);
    expect(o.mid).toBeCloseTo(0.0221, 6);
    expect(o.midSource).toBe('book');
    expect(o.parsed.class).toBe('priceBinary');
    expect(o.parsed.underlying).toBe('BTC');
    expect(o.parsed.targetPriceNum).toBe(100000);
    expect(o.parsed.expiryMs).toBe(Date.UTC(2026, 9, 1));
    expect(o.description).toContain('TWAP');
    expect(Number(must(snap.assetCtxByCoin['#12100'], 'ctx').dayNtlVlm)).toBeGreaterThan(0);
    expect(snap.standalone).toHaveLength(1);
    expect(snap.questions).toHaveLength(0);

    const base = must(normalizeVerdictSnapshot(snap)[0], 'normalized base') as Record<string, unknown>;
    expect(base.venue).toBe('verdict');
    expect(base.rawId).toBe(1210);
    expect(base.underlying).toBe('BTC');
    expect(base.direction).toBe('above');
    expect(base.strike).toBe(100000);
    expect(base.expiry).toBe('2026-10-01T00:00:00.000Z');
    expect(base.yesMid as number).toBeCloseTo(0.0221, 6);
    expect(base.title).toBe('BTC closes above $100,000');
    expect(base.volumeUsd as number).toBeGreaterThan(0);
  });
  it('groups question children under their question with clean labels and rules', async () => {
    const catalog = await loadCatalog(client);
    const markets = [1472, 1473].map((id) => must(marketFromCatalog(catalog, id), `market ${id}`));
    const snap = await buildSnapshot(client, catalog, markets);
    expect(snap.standalone).toHaveLength(0);
    const q = must(snap.questions[0], 'question');
    expect(q.name).toContain('Premier League');
    expect(q.description).toContain('Tournament');
    expect(must(q.namedOutcomes[0], 'child').name).toBe('Arsenal');
    expect(must(q.fallbackOutcome, 'fallback').outcome).toBe(1472);
    const titles = normalizeVerdictSnapshot(snap).map((m) => String((m as Record<string, unknown>).title));
    expect(titles.some((t) => t.includes('Premier League') && t.endsWith('Arsenal'))).toBe(true);
    expect(titles.some((t) => t.endsWith('Other / field'))).toBe(true);
  });
  it('2899, never traded on a wall-only book: the book top is kept but nothing prices the market, least of all the 0.5 placeholder', async () => {
    const catalog = await loadCatalog(client);
    const m = must(marketFromCatalog(catalog, 2899), 'market 2899');
    const snap = await buildSnapshot(client, catalog, [m]);
    const o = must(snap.outcomes[0], 'outcome');
    const ctx = must(snap.assetCtxByCoin[o.yesCoin], 'ctx');
    expect(Number(ctx.dayNtlVlm)).toBe(0);
    expect(ctx.markPx).toBe('0.5');
    expect(must(o.books.yes, 'book').bid).toBeLessThan(0.05);
    expect(must(o.books.yes, 'book').ask).toBeGreaterThan(0.95);
    expect(o.mid).toBeNull();
    expect(o.midSource).toBeNull();
    expect(o.unpriced).toBe('never_traded_wall_book');
  });
  it('priceFromBook: a traded coin on a wide book prices off the mark; a never-traded coin only off a real quote', () => {
    const book = (bid: string | null, ask: string | null) =>
      hlSchemas.L2Book.parse({ coin: '#1', time: 0, levels: [bid ? [{ px: bid, sz: '100', n: 1 }] : [], ask ? [{ px: ask, sz: '100', n: 1 }] : []] });
    const ctx = (dayNtlVlm: string, markPx: string, midPx: string | null) => hlSchemas.SpotAssetCtx.parse({ coin: '#1', dayNtlVlm, markPx, midPx });
    const walls = book('0.00001', '0.99999');
    // Traded today: markPx is a real trade/EMA mark, so a wall book anchors to it (the ctx fallback path).
    const traded = priceFromBook(walls, ctx('512.5', '0.31', '0.5'));
    expect(traded.mid).toBeCloseTo(0.31, 9);
    expect(traded.source).toBe('ctx');
    expect(traded.unpriced).toBeNull();
    expect(must(traded.top, 'top').ask).toBeCloseTo(0.99999, 9);
    // Never traded: markPx 0.5 is Hyperliquid's placeholder, so walls or an empty book price nothing.
    const placeholder = ctx('0.0', '0.5', '0.5');
    expect(priceFromBook(walls, placeholder)).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_wall_book' });
    expect(priceFromBook(book(null, '0.99999'), placeholder)).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_wall_book' });
    expect(priceFromBook(book(null, null), ctx('0.0', '0.5', null))).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_wall_book' });
    expect(priceFromBook(null, placeholder)).toMatchObject({ top: null, mid: null, source: null, unpriced: 'never_traded_no_book' });
    expect(priceFromBook(null, ctx('0.0', '0.5', null))).toMatchObject({ mid: null, unpriced: 'never_traded_no_book' });
    // A real quote on a never-traded coin is a price: the non-wall side, a tight book's mid, or the midPx of an unread two-sided book.
    expect(priceFromBook(book('0.3', '0.99999'), ctx('0.0', '0.5', '0.649995'))).toMatchObject({ mid: 0.3, source: 'book', unpriced: null });
    const tight = priceFromBook(book('0.56', '0.58'), ctx('0.0', '0.5', '0.57'));
    expect(tight.mid).toBeCloseTo(0.57, 9);
    expect(tight).toMatchObject({ source: 'book', unpriced: null });
    expect(priceFromBook(null, ctx('0.0', '0.5', '0.57'))).toMatchObject({ mid: 0.57, source: 'ctx', unpriced: null });
    // No context and nothing on the book: no price data at all.
    expect(priceFromBook(book(null, null), undefined)).toMatchObject({ mid: null, unpriced: 'no_price_data' });
    expect(priceFromBook(null, undefined)).toMatchObject({ mid: null, unpriced: 'no_price_data' });
  });
  it('maxBooks reads books for the most-traded markets only; the rest price off asset contexts', async () => {
    const catalog = await loadCatalog(client);
    const ids = [1209, 1210, 1211, 1212, 1213];
    const markets = ids.map((id) => must(marketFromCatalog(catalog, id), `market ${id}`));
    const snap = await buildSnapshot(client, catalog, markets, { maxBooks: 2 });
    expect(snap.booksFetched).toBe(2);
    const withBooks = snap.outcomes.filter((o) => o.books.yes !== null);
    expect(withBooks).toHaveLength(2);
    const volume = (o: (typeof snap.outcomes)[number]) => Number(snap.assetCtxByCoin[o.yesCoin]?.dayNtlVlm ?? 0) + Number(snap.assetCtxByCoin[o.noCoin]?.dayNtlVlm ?? 0);
    const minWithBooks = Math.min(...withBooks.map(volume));
    for (const o of snap.outcomes.filter((o) => o.books.yes === null)) {
      expect(volume(o)).toBeLessThanOrEqual(minWithBooks);
      expect(o.midSource === 'ctx' || o.mid === null).toBe(true);
    }
    const full = await buildSnapshot(client, catalog, markets);
    expect(full.booksFetched).toBe(5);
  });
  it('fails on a missing book by default and records it when asked to skip', async () => {
    const catalog = await loadCatalog(client);
    const m = must(marketFromCatalog(catalog, 1474), 'market 1474 (no recorded book)');
    await expect(buildSnapshot(client, catalog, [m])).rejects.toMatchObject({ name: 'UpstreamError' });
    const snap = await buildSnapshot(client, catalog, [m], { onBookError: 'skip' });
    expect(snap.bookErrors).toHaveLength(2);
    expect(must(snap.outcomes[0], 'outcome').books.yes).toBeNull();
  });
});

describe('compare_market', () => {
  it('1210: the Kalshi ladder is a low-confidence reference with reasons and a caveat, never a bare gap', async () => {
    const r = await tools.compare_market({ outcome: 1210 });
    expect(CompareMarketResult.safeParse(r).success).toBe(true);
    expect(r.verdict.yesMid).toBeCloseTo(0.0221, 6);
    expect(r.verdict.priceSource).toBe('book');
    expect(r.verdict.strike).toBe(100000);
    const k = must(r.comparators.kalshi, 'kalshi comparator');
    expect(k.method).toBe('reference');
    expect(k.confidence).toBe('low');
    expect(k.reasons.length).toBeGreaterThan(0);
    expect(k.reasons.some((x) => /strike_mismatch|expiry_mismatch|title_similarity/.test(x))).toBe(true);
    expect(k.caveat).toContain('Low-confidence');
    expect(k.gap).toBeNull();
    expect(k.spreadAdjustedGap).toBeNull();
    expect(k.line).toMatch(/low-confidence/);
    expect(k.line).not.toMatch(/gap [+-]?\d/);
    expect(k.fairProb).toBeGreaterThan(0);
    expect(r.summary).toContain('Kalshi: low-confidence match');
    expect(r.summary).toContain('Verdict YES 2.2%');
    const p = r.comparators.polymarket;
    if (p) {
      expect(p.reasons.length).toBeGreaterThan(0);
      if (p.confidence === 'low') expect(p.caveat).toBeTruthy();
    }
    expect(must(r.optionsImplied, 'options implied').prob).toBeGreaterThan(0);
    expect(r.engine.commit).toBe(ENGINE_UPSTREAM.commit);
    expect(['ok', 'partial', 'unavailable']).toContain(r.dataStatus.kalshi);
  });
  it('2899, never traded on a wall-only book: the Kalshi ladder prices the Verdict contract, but no gap is reported against the 0.5 placeholder', async () => {
    const r = await tools.compare_market({ outcome: 2899 });
    expect(CompareMarketResult.safeParse(r).success).toBe(true);
    expect(r.verdict.yesMid).toBeNull();
    expect(r.verdict.priceSource).toBeNull();
    expect(r.verdict.unpriced).toBe('never_traded_wall_book');
    expect(must(r.verdict.yesAsk, 'yes ask')).toBeGreaterThan(0.95);
    const k = must(r.comparators.kalshi, 'kalshi comparator');
    expect(['ladder_interpolation', 'maturity_adjusted_digital']).toContain(k.method);
    expect(k.confidence).toBe('medium');
    expect(k.reasons).toContain('same_underlying');
    expect(k.reasons.some((x) => x.startsWith('title_similarity_'))).toBe(true);
    expect(must(k.fairProb, 'fair prob')).toBeGreaterThan(0.4);
    expect(must(k.fairProb, 'fair prob')).toBeLessThan(0.6);
    expect(k.gap).toBeNull();
    expect(k.spreadAdjustedGap).toBeNull();
    expect(k.caveats).toContain(`${UNPRICED_TAG_PREFIX}never_traded_wall_book`);
    expect(k.caveats).toContain('verdict_book_thin');
    expect(k.caveat).toContain('Verdict has no tradable price (never traded, wall-only book)');
    expect(k.caveat).toContain('Model-based');
    expect(k.line).toContain('at the Verdict contract (medium confidence');
    expect(k.line).toContain(`; ${k.method}). Verdict has no tradable price (never traded, wall-only book); comparator shown for reference.`);
    expect(k.line).not.toMatch(/gap [+-]?\d/);
    expect(k.line).not.toMatch(/50\.0%/);
    expect(k.mismatchNote).toBeTruthy();
    if (k.method === 'ladder_interpolation') {
      expect(k.legs).toHaveLength(2);
      expect(k.expiryAdjusted).toBeNull();
    } else {
      expect(must(k.expiryAdjusted, 'expiry adjusted').offsetHours).toBeGreaterThan(0);
    }
    for (const c of [r.comparators.polymarket, r.comparators.kalshi]) {
      if (!c) continue;
      expect(c.gap).toBeNull();
      expect(c.spreadAdjustedGap).toBeNull();
      expect(c.line).not.toMatch(/gap [+-]?\d/);
    }
    expect(r.summary).toContain('Verdict has no tradable price (never traded, wall-only book)');
    expect(r.summary).not.toContain('Verdict YES');
    const fv = await tools.fair_value({ outcome: 2899 });
    if (fv.available) {
      expect(fv.marketProb).toBeNull();
      expect(fv.gap).toBeNull();
      expect(fv.caveats).toContain(`${UNPRICED_TAG_PREFIX}never_traded_wall_book`);
    }
  });
  it('2899 with a traded context: the Verdict price is the HL mark and the line, caveat and summary say so; the low-rated edge has no after-spreads gap', async () => {
    const traded = createTools(config, new InfoClient({ network: 'mainnet', fetch: patchedCtxFetch(['#28990', '#28991'], { dayNtlVlm: '512.5' }) }), { engine: { timeoutMs: 5_000 } });
    const r = await traded.compare_market({ outcome: 2899 });
    expect(CompareMarketResult.safeParse(r).success).toBe(true);
    expect(r.verdict.yesMid).toBeCloseTo(0.5, 9);
    expect(r.verdict.priceSource).toBe('ctx');
    expect(r.verdict.unpriced).toBeNull();
    const k = must(r.comparators.kalshi, 'kalshi comparator');
    expect(k.confidence).toBe('medium');
    expect(k.edgeConfidence).toBe('low');
    expect(must(k.gap, 'gap')).toBeCloseTo(must(r.verdict.yesMid, 'verdict mid') - must(k.fairProb, 'fair prob'), 9);
    expect(k.spreadAdjustedGap).toBeNull();
    expect(k.caveats).toContain(HL_MARK_TAG);
    expect(k.caveat).toContain('Verdict price is the HL mark; no two-sided book');
    expect(k.caveat).toContain('rates this edge low-confidence');
    expect(k.line).toContain('vs Verdict 50.0% (Verdict price is the HL mark; no two-sided book), gap ');
    expect(k.line).toContain(', no edge after spreads (the engine rates the edge low-confidence) (medium confidence');
    expect(k.line).not.toMatch(/pp after spreads/);
    expect(r.summary).toContain('Verdict YES 50.0% (Verdict price is the HL mark; no two-sided book)');
  });
  it('a low-confidence comparator cannot carry a gap; a low-rated edge cannot carry an after-spreads gap (schema invariants)', () => {
    const base = { venue: 'kalshi', method: 'reference', confidence: 'low', edgeConfidence: null, reasons: ['strike_mismatch'], caveats: [], caveat: 'x', title: 't', url: null, fairProb: 0.5, yesBid: null, yesAsk: null, spread: null, depthUsd: null, volumeUsd: null, expiry: null, spreadAdjustedGap: null, expiryAdjusted: null, mismatchNote: null, tradeCall: null, legs: [{ id: 'a', title: 't', url: null, yesMid: 0.5, strike: null, expiry: null }], line: 'l' };
    expect(Comparator.safeParse({ ...base, gap: null }).success).toBe(true);
    expect(Comparator.safeParse({ ...base, gap: 0.1 }).success).toBe(false);
    expect(Comparator.safeParse({ ...base, caveat: null, gap: null }).success).toBe(false);
    const medium = { ...base, confidence: 'medium', method: 'maturity_adjusted_digital', gap: 0.1 };
    expect(Comparator.safeParse({ ...medium, edgeConfidence: 'medium', spreadAdjustedGap: 0.04 }).success).toBe(true);
    expect(Comparator.safeParse({ ...medium, edgeConfidence: 'low', spreadAdjustedGap: 0.04 }).success).toBe(false);
    expect(Comparator.safeParse({ ...medium, edgeConfidence: 'low', spreadAdjustedGap: null }).success).toBe(true);
    expect(Comparator.safeParse({ ...medium, edgeConfidence: 'medium', caveats: [VOL_FLIP_TAG], spreadAdjustedGap: 0.04 }).success).toBe(false);
    expect(Comparator.safeParse({ ...medium, edgeConfidence: 'medium', caveats: [`${UNPRICED_TAG_PREFIX}never_traded_wall_book`], spreadAdjustedGap: null }).success).toBe(false);
    expect(Comparator.safeParse({ ...medium, edgeConfidence: 'medium', caveats: [`${UNPRICED_TAG_PREFIX}never_traded_wall_book`], gap: null, spreadAdjustedGap: null }).success).toBe(true);
  });
});

describe('edge confidence read from the engine card, not from the hardcoded equivalence confidence', () => {
  const base = {
    id: 'verdict:1',
    venue: 'verdict',
    rawId: 1,
    title: 'BTC above $77,250 on Sep 18',
    yesMid: 0.52,
    yesBid: 0.51,
    yesAsk: 0.53,
    spread: 0.02,
    depthUsd: 500,
    volumeUsd: 1000,
    expiry: '2026-09-18T06:00:00.000Z',
    underlying: 'BTC',
    direction: 'above',
    strike: 77250,
    category: 'crypto',
    derivativeKind: 'settlement',
    rulesText: 'Settles on the Pyth BTC/USD price at 06:00 UTC.',
  };
  const comp = { ...base, id: 'kalshi:KXBTCD-26SEP1817-T77250', venue: 'kalshi', rawId: 'KXBTCD-26SEP1817-T77250', yesMid: 0.5, yesBid: 0.49, yesAsk: 0.51, expiry: '2026-09-18T17:00:00.000Z', url: null };
  const adj = (rawLo: number, rawHi: number): MaturityAdjustResult => ({
    pComp: 0.5,
    pAdj: 0.53,
    pAdjLo: rawLo,
    pAdjHi: rawHi,
    rawAdj: 0.53,
    rawLo,
    rawHi,
    volSensitivity: 0.03,
    shift: 0.03,
    sigma: 0.45,
    spot: 77000,
    strike: 77250,
    strikeOffsetPct: 0,
    tteBaseDays: 4.35,
    tteCompDays: 4.8,
    offsetHours: 11,
  });
  const verdict = { yesMid: 0.52, priceSource: 'book' as const, unpriced: null };
  it('a maturity bridge whose edge flips under the vol stress reports the gap but never an after-spreads number', () => {
    const card = buildMaturityAdjustedCard(base, comp, adj(0.5, 0.56));
    expect(card.caveats).toContain(VOL_FLIP_TAG);
    expect(card.confidence).toBe('low');
    expect(card.equivalenceConfidence).toBe('medium');
    const c = comparatorFromEngineCard(card, 'kalshi', verdict);
    expect(c.method).toBe('maturity_adjusted_digital');
    expect(c.confidence).toBe('medium');
    expect(c.edgeConfidence).toBe('low');
    expect(must(c.gap, 'gap')).toBeCloseTo(-0.01, 9);
    expect(c.spreadAdjustedGap).toBeNull();
    expect(c.caveats).toContain(VOL_FLIP_TAG);
    expect(c.caveat).toContain('Model edge flips sign under a +/-20% vol stress; the engine treats this as no edge');
    expect(c.line).toContain('gap -1.0pp, no edge after spreads (flips under vol stress) (medium confidence');
    expect(c.line).not.toMatch(/pp after spreads/);
    expect(must(c.expiryAdjusted, 'expiry adjusted').offsetHours).toBe(11);
  });
  it('a sign-stable bridge whose gap clears the spreads and the model band keeps its after-spreads number', () => {
    const card = buildMaturityAdjustedCard({ ...base, yesMid: 0.65, yesBid: 0.64, yesAsk: 0.66 }, comp, adj(0.5, 0.56));
    expect(card.caveats).not.toContain(VOL_FLIP_TAG);
    expect(card.confidence).toBe('medium');
    const c = comparatorFromEngineCard(card, 'kalshi', { ...verdict, yesMid: 0.65 });
    expect(c.edgeConfidence).toBe('medium');
    expect(must(c.gap, 'gap')).toBeCloseTo(0.12, 9);
    expect(must(c.spreadAdjustedGap, 'after spreads')).toBeCloseTo(0.06, 9);
    expect(c.line).toContain('gap +12.0pp, +6.0pp after spreads (medium confidence');
    expect(c.caveat).not.toContain('no edge');
    expect(c.caveat).toContain('Model-based comparator');
  });
  it('a Verdict price from the HL mark is labelled on the line and in the caveats even when the edge holds', () => {
    const card = buildMaturityAdjustedCard({ ...base, yesMid: 0.65, yesBid: 0.64, yesAsk: 0.66 }, comp, adj(0.5, 0.56));
    const c = comparatorFromEngineCard(card, 'kalshi', { yesMid: 0.65, priceSource: 'ctx', unpriced: null });
    expect(c.caveats).toContain(HL_MARK_TAG);
    expect(c.line).toContain('vs Verdict 65.0% (Verdict price is the HL mark; no two-sided book), gap +12.0pp, +6.0pp after spreads');
    expect(c.caveat).toContain('Verdict price is the HL mark; no two-sided book');
  });
});

describe('strike offset caveat (kit-side reading aid on exact twins)', () => {
  it('flags a near-expiry strike gap, tags any offset, and stays silent for identical strikes', () => {
    const now = Date.UTC(2026, 8, 13, 22, 0);
    const near = strikeOffsetCaveat(77251, 77100, '2026-09-13T23:00:00.000Z', now);
    expect(near.tag).toBe('strike_offset_0.20pct');
    expect(near.note).toContain('1.0h to settle');
    expect(near.note).toContain('$151');
    expect(strikeOffsetCaveat(77251, 77251, '2026-09-13T23:00:00.000Z', now)).toEqual({ tag: null, note: null });
    const far = strikeOffsetCaveat(100000, 99500, '2026-10-01T00:00:00.000Z', now);
    expect(far.tag).toBe('strike_offset_0.50pct');
    expect(far.note).toBeNull();
    expect(strikeOffsetCaveat(100000, 99999.99, '2026-10-01T00:00:00.000Z', now)).toEqual({ tag: null, note: null });
    expect(strikeOffsetCaveat(null, 5, null, now)).toEqual({ tag: null, note: null });
  });
});

describe('fair_value', () => {
  it('returns the Deribit-implied probability for the BTC market', async () => {
    const r = await tools.fair_value({ outcome: 1210 });
    expect(FairValueResult.safeParse(r).success).toBe(true);
    if (!r.available) throw new Error(`expected available, got ${r.reason}: ${r.detail}`);
    expect(r.underlying).toBe('BTC');
    expect(r.direction).toBe('above');
    expect(r.strike).toBe(100000);
    expect(r.impliedProb).toBeGreaterThan(0);
    expect(r.impliedProb).toBeLessThan(1);
    expect(r.iv).toBeGreaterThan(0);
    expect(r.spot).toBeGreaterThan(0);
    expect(Math.abs(r.optionsExpiryOffsetHours)).toBeLessThanOrEqual(72);
    expect(r.gap).toBeCloseTo(must(r.marketProb, 'market prob') - r.impliedProb, 12);
    expect(r.caveats).toContain('reference_only_not_tradable_comparator');
    expect(r.evidence).toContain('not a tradable comparator');
  });
  it('returns a typed not-available result for markets without a directional strike', async () => {
    const sports = await tools.fair_value({ outcome: 1473 });
    expect(sports.available).toBe(false);
    if (!sports.available) expect(sports.reason).toBe('not_price_market');
    const touch = await tools.fair_value({ outcome: 1209 });
    expect(touch.available).toBe(false);
    if (!touch.available) expect(touch.reason).toBe('not_price_market');
  });
});

describe('find_hedges', () => {
  it('maps the BTC market to perp and spot hedges with a live reference mid and a short-for-YES leg', async () => {
    const r = await tools.find_hedges({ outcome: 1210 });
    expect(FindHedgesResult.safeParse(r).success).toBe(true);
    expect(r.hedgeable).toBe(true);
    expect(r.candidates.map((c) => c.kind)).toEqual(['perp', 'spot']);
    expect(must(r.candidates[0], 'perp').symbol).toBe('BTC');
    expect(must(r.candidates[0], 'perp').available).toBe(true);
    expect(must(r.candidates[0], 'perp').mid).toBeGreaterThan(1000);
    const leg = must(r.leg, 'hedge leg');
    expect(leg.symbol).toBe('BTC');
    expect(leg.directionForYes).toBe('short');
    expect(leg.directionForNo).toBe('long');
    expect(leg.limitations.length).toBeGreaterThan(0);
  });
  it('a sports market has no mapped hedge', async () => {
    const r = await tools.find_hedges({ outcome: 1473 });
    expect(r.hedgeable).toBe(false);
    expect(must(r.candidates[0], 'candidate').available).toBe(false);
    expect(r.leg?.directionForYes ?? 'none').toBe('none');
  });
});

describe('opportunities', () => {
  const subsetFetch = fixtureFetch({ outcomes: [1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1251, 1472, 1473] });
  const subsetTools = createTools(config, new InfoClient({ network: 'mainnet', fetch: subsetFetch }), { engine: { timeoutMs: 5_000 } });
  it('ranks the venue markets by tradeable quality with a reason per row', async () => {
    const r = await subsetTools.opportunities({ limit: 3 });
    expect(OpportunitiesResult.safeParse(r).success).toBe(true);
    expect(r.venue).toBe('out');
    expect(r.scanned).toBe(11);
    expect(r.booksFetched).toBe(11);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(3);
    expect(r.items.map((i) => i.rank)).toEqual(r.items.map((_, i) => i + 1));
    for (const item of r.items) {
      expect(item.why).toMatch(/spread|depth|YES/);
      expect(item.tradeCall.label.length).toBeGreaterThan(0);
      expect(item.venue).toBe('out');
    }
    expect(r.bookErrors).toHaveLength(0);
    for (const c of r.comparators) if (c.confidence === 'low') expect(c.caveat).toBeTruthy();
  });
  it('caps book reads at maxBooks and says so in the result', async () => {
    const capped = createTools(config, new InfoClient({ network: 'mainnet', fetch: subsetFetch }), { engine: { timeoutMs: 5_000, maxBooks: 3 } });
    const r = await capped.opportunities({ limit: 2 });
    expect(r.scanned).toBe(11);
    expect(r.booksFetched).toBe(3);
    expect(r.items.length).toBeGreaterThan(0);
  });
  it('rejects a limit above the engine maximum', async () => {
    await expect(subsetTools.opportunities({ limit: 9 })).rejects.toMatchObject({ name: 'ToolError', code: 'bad_input' });
  });
});

describe('faces over the engine tools', () => {
  it('CLI compare prints the typed result with the summary line', async () => {
    const r = await runCli(['compare', '1210'], config, tools);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { summary: string; comparators: { kalshi: { confidence: string; gap: number | null } | null } };
    expect(out.summary).toContain('low-confidence match');
    expect(out.comparators.kalshi?.gap).toBeNull();
  });
  it('CLI hedges, fair-value and opportunities run and validate --limit', async () => {
    expect((await runCli(['hedges', '1210'], config, tools)).exitCode).toBe(0);
    expect((await runCli(['fair-value', '1473'], config, tools)).exitCode).toBe(0);
    expect((await runCli(['opportunities', '--limit', 'x'], config, tools)).exitCode).toBe(1);
    expect((await runCli(['opportunities', '--limit', '9'], config, tools)).exitCode).toBe(1);
  });
  it('MCP exposes the four engine tools as read-only and returns structured comparators', async () => {
    const server = createServer(config, tools);
    const mcp = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), mcp.connect(b)]);
    const { tools: listed } = await mcp.listTools();
    const byName = new Map(listed.map((t) => [t.name, t]));
    for (const name of ['compare_market', 'fair_value', 'find_hedges', 'opportunities']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    const res = await mcp.callTool({ name: 'compare_market', arguments: { outcome: 1210 } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { comparators: { kalshi: { confidence: string } | null } };
    expect(structured.comparators.kalshi?.confidence).toBe('low');
  });
});

describe('hard rules', () => {
  it('nothing in these tools touches an exchange endpoint or a venue trading API', () => {
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) {
      expect(entry).not.toMatch(/\/exchange\b/);
      expect(entry).not.toMatch(/clob\.polymarket\.com|trading-api\.kalshi|\/orders\b/);
      if (!/hyperliquid/.test(entry)) expect(entry.startsWith('GET ')).toBe(true);
    }
  });
});
