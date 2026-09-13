// The cross-venue engine in the kit: pinned copy, snapshot adapter, and the four tools over it,
// all against recorded fixtures with the clock frozen at the recording time and no network.
import { spawnSync } from 'node:child_process';
import { cpSync, appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENGINE_UPSTREAM, type MaturityAdjustResult, buildMaturityAdjustedCard, fmtCents, fmtUsd, normalizeVerdictSnapshot } from '@verdict/engine';
import {
  type BaseRef,
  Comparator,
  CompareMarketResult,
  FairValueResult,
  FindHedgesResult,
  HL_MARK_TAG,
  InfoClient,
  type KitConfig,
  OUTCOME_WALL_BAND,
  OpportunitiesResult,
  UNPRICED_TAG_PREFIX,
  UpstreamError,
  VOL_FLIP_TAG,
  buildSnapshot,
  comparatorFromEngineCard,
  createTools,
  hlSchemas,
  isPlaceholderCtx,
  isStaleCtx,
  loadCatalog,
  marketFromCatalog,
  priceFromBook,
  resolveMatchedBase,
  resolveOptionsBase,
  strikeOffsetCaveat,
  validateVenueResponse,
  validatingFetch,
  withValidatedVenueFetch,
  withoutUnpricedBooks,
} from '../packages/core/src/index.js';
import { runCli } from '../packages/cli/src/index.js';
import { createServer } from '../packages/mcp/src/server.js';
import { type FixtureFetchOptions, engineFixture, fixtureFetch, recordedAt } from './helpers/fixture-fetch.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}

/** Every request any fetch in this file makes lands here; the hard-rules test reads it. */
const log: string[] = [];
const fetchAll = fixtureFetch({ log });

/** The recorded fixtures with the asset contexts of some coins overwritten, e.g. to make a never-traded coin look traded. */
function patchedCtxFetch(coins: readonly string[], patch: Record<string, string>, opts: Omit<FixtureFetchOptions, 'log'> = {}): typeof fetch {
  const inner = fixtureFetch({ ...opts, log });
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

/**
 * A stand-in `gh` on PATH, so the drift check's GitHub leg runs without the network. 'serve' answers
 * `gh api repos/<repo>/contents/<path>?ref=<sha>` with this checkout's engine files the way GitHub does (base64 content
 * plus blob sha); the other modes fail the way gh fails.
 */
function fakeGh(mode: 'serve' | 'not_found' | 'offline' | 'unauthenticated'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const script = join(dir, 'gh.mjs');
  const bodies: Record<typeof mode, string> = {
    serve: [
      "import { readFileSync } from 'node:fs';",
      "import { createHash } from 'node:crypto';",
      "const m = /contents\\/(.+)\\?ref=/.exec(process.argv[3] ?? '');",
      `const upstream = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'packages/engine/UPSTREAM.json'))}, 'utf8'));`,
      'const f = upstream.files.find((x) => x.upstream === m?.[1]);',
      "if (!f) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }",
      `const bytes = readFileSync(${JSON.stringify(ROOT)} + f.local);`,
      "const sha = createHash('sha1').update('blob ' + bytes.length + '\\0').update(bytes).digest('hex');",
      "process.stdout.write(JSON.stringify({ encoding: 'base64', content: bytes.toString('base64'), sha }));",
    ].join('\n'),
    not_found: "process.stderr.write('gh: No commit found for the ref 0000000000000000000000000000000000000000 (HTTP 404)\\n'); process.exit(1);",
    offline: "process.stderr.write('error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com\\n'); process.exit(1);",
    unauthenticated: "process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\\n'); process.exit(4);",
  };
  writeFileSync(script, `${bodies[mode]}\n`);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return dir;
}

describe('engine pin', () => {
  /** Run the drift check with only `pathDir` on PATH (so the real gh is never reached) and CHECK_ENGINE_OFFLINE set or unset. */
  function drift(pathDir: string, offlineFlag: boolean, args: readonly string[] = []) {
    const env: Record<string, string | undefined> = { ...process.env, PATH: pathDir };
    delete env.CHECK_ENGINE_OFFLINE;
    if (offlineFlag) env.CHECK_ENGINE_OFFLINE = '1';
    return spawnSync(process.execPath, ['scripts/check-engine-drift.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env });
  }
  it('the local copies are the pinned upstream files: recorded hashes and the GitHub copies agree', () => {
    const r = drift(fakeGh('serve'), false);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('3 file(s) compared against GitHub');
    expect(r.stdout).toContain('engine drift: none');
    expect(r.stdout).not.toContain('skip');
  });
  it('a modified copy fails the drift check, against the recorded hash and against GitHub', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'engine-drift-'));
    cpSync(join(ROOT, 'packages/engine/UPSTREAM.json'), join(tmp, 'packages/engine/UPSTREAM.json'));
    cpSync(join(ROOT, 'packages/engine/src'), join(tmp, 'packages/engine/src'), { recursive: true });
    appendFileSync(join(tmp, 'packages/engine/src/research-core.ts'), '\n// drift\n');
    const r = drift(fakeGh('serve'), false, ['--root', tmp]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL  packages/engine/src/research-core.ts: local sha256');
    expect(r.stdout).toContain('differs from the GitHub copy at the pinned commit (hash mismatch; never skipped)');
    expect(r.stdout).toContain('ok    src/research/playbooks.ts@');
  });
  it('a pin GitHub cannot find (HTTP 404) fails even under CHECK_ENGINE_OFFLINE=1', () => {
    for (const flag of [false, true]) {
      const r = drift(fakeGh('not_found'), flag);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('not found on GitHub (HTTP 404)');
      expect(r.stdout).toContain('Not skippable');
      expect(r.stdout).not.toContain('skip  ');
      // Every file is reported, not just the first.
      expect(r.stdout.match(/not found on GitHub/g)).toHaveLength(3);
    }
  });
  it('gh offline or not authenticated fails by default and is skipped, saying so, only under CHECK_ENGINE_OFFLINE=1', () => {
    for (const mode of ['offline', 'unauthenticated'] as const) {
      const dir = fakeGh(mode);
      const closed = drift(dir, false);
      expect(closed.status, closed.stdout).toBe(1);
      expect(closed.stdout).toContain('FAIL  GitHub comparison could not run: gh not authenticated or offline');
      expect(closed.stdout).toContain('set CHECK_ENGINE_OFFLINE=1 to skip this leg knowingly');
      const open = drift(dir, true);
      expect(open.status, open.stdout).toBe(0);
      expect(open.stdout).toContain('skip  GitHub comparison skipped (CHECK_ENGINE_OFFLINE=1): gh not authenticated or offline');
      expect(open.stdout).toContain('engine drift: none');
      expect(open.stdout).not.toContain('compared against GitHub');
    }
  });
  it('gh not installed: the same, with the reason named', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-gh-'));
    const closed = drift(empty, false);
    expect(closed.status).toBe(1);
    expect(closed.stdout).toContain('gh is not installed');
    const open = drift(empty, true);
    expect(open.status, open.stdout).toBe(0);
    expect(open.stdout).toContain('skip  GitHub comparison skipped (CHECK_ENGINE_OFFLINE=1): gh is not installed');
  });
  it('the generated provenance constant matches UPSTREAM.json', () => {
    const upstream = JSON.parse(readFileSync(join(ROOT, 'packages/engine/UPSTREAM.json'), 'utf8')) as { repo: string; commit: string; files: { sha256: string }[] };
    expect(ENGINE_UPSTREAM.repo).toBe(upstream.repo);
    expect(ENGINE_UPSTREAM.commit).toBe(upstream.commit);
    expect(ENGINE_UPSTREAM.files.map((f) => f.sha256)).toEqual(upstream.files.map((f) => f.sha256));
  });
  it('the kit wall band mirrors the pinned hl-shape constant, so a pin move that changes it fails here', () => {
    const src = readFileSync(join(ROOT, 'packages/engine/src/hl-shape.ts'), 'utf8');
    const m = /const OUTCOME_WALL_BAND = ([0-9.]+);/.exec(src);
    expect(Number(must(m?.[1], 'OUTCOME_WALL_BAND in hl-shape.ts'))).toBe(OUTCOME_WALL_BAND);
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
  it('withoutUnpricedBooks: the engine is handed no book for an unpriced market, so it cannot average the walls to 0.5; priced books stay', async () => {
    const catalog = await loadCatalog(client);
    const markets = [1210, 2899].map((id) => must(marketFromCatalog(catalog, id), `market ${id}`));
    const snap = await buildSnapshot(client, catalog, markets);
    const engineBase = (s: typeof snap, id: number) => must(normalizeVerdictSnapshot(s).find((b) => (b as { rawId: number }).rawId === id), `base ${id}`) as Record<string, unknown>;
    // The engine's own reading of the kit snapshot: the wall book (0.00001 / 0.99999) averages to the phantom.
    expect(engineBase(snap, 2899).yesMid as number).toBeCloseTo(0.5, 9);
    const view = withoutUnpricedBooks(snap);
    expect(must(view.outcomes.find((o) => o.outcome === 2899), '2899')).toMatchObject({ books: { yes: null, no: null }, mid: null, unpriced: 'never_traded_wall_book' });
    expect(must(view.standalone.find((o) => o.outcome === 2899), '2899').books.yes).toBeNull();
    expect(must(must(view.outcomes.find((o) => o.outcome === 1210), '1210').books.yes, '1210 book').bid).toBeCloseTo(0.0191, 6);
    const b2899 = engineBase(view, 2899);
    expect(b2899.yesMid).toBeNull();
    expect(b2899.yesBid).toBeNull();
    expect(b2899.spread).toBeNull();
    expect(b2899.depthUsd).toBeNull();
    expect(engineBase(view, 1210).yesMid as number).toBeCloseTo(0.0221, 6);
    // The kit's own snapshot keeps every book it read.
    expect(must(snap.outcomes.find((o) => o.outcome === 2899), '2899').books.yes).not.toBeNull();
  });
  it('priceFromBook: a traded coin on a wide book prices off the mark; a coin with no trades today only off a real quote it read', () => {
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
    expect(priceFromBook(null, ctx('512.5', '0.31', '0.5'))).toMatchObject({ top: null, mid: 0.31, source: 'ctx', unpriced: null });
    // Never traded: markPx 0.5 is Hyperliquid's placeholder, so walls or an empty book price nothing.
    const placeholder = ctx('0.0', '0.5', '0.5');
    expect(isPlaceholderCtx(placeholder)).toBe(true);
    expect(isStaleCtx(placeholder)).toBe(false);
    expect(priceFromBook(walls, placeholder)).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_wall_book' });
    expect(priceFromBook(book(null, '0.99999'), placeholder)).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_wall_book' });
    expect(priceFromBook(book(null, null), ctx('0.0', '0.5', null))).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_wall_book' });
    expect(priceFromBook(null, placeholder)).toMatchObject({ top: null, mid: null, source: null, unpriced: 'never_traded_no_book' });
    expect(priceFromBook(null, ctx('0.0', '0.5', null))).toMatchObject({ mid: null, unpriced: 'never_traded_no_book' });
    // Traded on an earlier day but not in the last 24h (34 of 368 recorded mainnet outcome coins): markPx is a stale
    // mark and midPx the raw wall average. Before this rule the wall book priced at the 0.5 midPx labelled 'ctx'.
    const stale = ctx('0.0', '0.31', '0.5');
    expect(isStaleCtx(stale)).toBe(true);
    expect(isPlaceholderCtx(stale)).toBe(false);
    expect(priceFromBook(walls, stale)).toMatchObject({ mid: null, source: null, unpriced: 'stale_wall_book' });
    expect(priceFromBook(book(null, '0.99999'), stale)).toMatchObject({ mid: null, source: null, unpriced: 'stale_wall_book' });
    expect(priceFromBook(book('0.00001', null), stale)).toMatchObject({ mid: null, source: null, unpriced: 'stale_wall_book' });
    expect(priceFromBook(book(null, null), stale)).toMatchObject({ mid: null, source: null, unpriced: 'stale_wall_book' });
    expect(priceFromBook(null, stale)).toMatchObject({ top: null, mid: null, source: null, unpriced: 'stale_no_book' });
    expect(priceFromBook(null, ctx('0.0', '0.31', null))).toMatchObject({ mid: null, unpriced: 'stale_no_book' });
    // A real quote on a book the kit read prices a coin with no trades today: the non-wall side, or a tight book's mid.
    expect(priceFromBook(book('0.3', '0.99999'), ctx('0.0', '0.5', '0.649995'))).toMatchObject({ mid: 0.3, source: 'book', unpriced: null });
    expect(priceFromBook(book('0.00001', '0.66'), stale)).toMatchObject({ mid: 0.66, source: 'book', unpriced: null });
    const tight = priceFromBook(book('0.56', '0.58'), ctx('0.0', '0.5', '0.57'));
    expect(tight.mid).toBeCloseTo(0.57, 9);
    expect(tight).toMatchObject({ source: 'book', unpriced: null });
    // Without the book, the context's midPx is never a price: it is a raw average that hides a wall (recorded coin
    // #28940 shows midPx 0.959995 = (0.92 + 0.99999) / 2 next to markPx 0.92), so an unread book stays unpriced.
    expect(priceFromBook(null, ctx('0.0', '0.5', '0.57'))).toMatchObject({ mid: null, source: null, unpriced: 'never_traded_no_book' });
    expect(priceFromBook(null, ctx('0.0', '0.92', '0.959995'))).toMatchObject({ mid: null, source: null, unpriced: 'stale_no_book' });
    // No context: only a real quote on the book prices the coin.
    expect(priceFromBook(walls, undefined)).toMatchObject({ mid: null, source: null, unpriced: 'no_price_data' });
    expect(priceFromBook(book('0.3', null), undefined)).toMatchObject({ mid: 0.3, source: 'book', unpriced: null });
    expect(priceFromBook(book(null, null), undefined)).toMatchObject({ mid: null, unpriced: 'no_price_data' });
    expect(priceFromBook(null, undefined)).toMatchObject({ mid: null, unpriced: 'no_price_data' });
  });
  it('2899 with a stale context (markPx from an earlier day, no trades in 24h): the wall book stays unpriced and nothing prints the 0.5 midPx', async () => {
    const stale = new InfoClient({ network: 'mainnet', fetch: patchedCtxFetch(['#28990', '#28991'], { markPx: '0.31' }) });
    const catalog = await loadCatalog(stale);
    const m = must(marketFromCatalog(catalog, 2899), 'market 2899');
    const snap = await buildSnapshot(stale, catalog, [m]);
    const o = must(snap.outcomes[0], 'outcome');
    const ctx = must(snap.assetCtxByCoin[o.yesCoin], 'ctx');
    expect(ctx.dayNtlVlm).toBe('0.0');
    expect(ctx.markPx).toBe('0.31');
    expect(ctx.midPx).toBe('0.5');
    expect(o.mid).toBeNull();
    expect(o.midSource).toBeNull();
    expect(o.unpriced).toBe('stale_wall_book');
    const unread = await buildSnapshot(stale, catalog, [m], { books: false });
    expect(must(unread.outcomes[0], 'outcome')).toMatchObject({ mid: null, midSource: null, unpriced: 'stale_no_book' });
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
    // The recorded gamma events (BTC-titled, six markets each) hold nothing comparable to a $100,000 Oct 1 binary, so
    // Polymarket was read and yields no comparator; the Polymarket comparator rules are exercised on constructed cards below.
    expect(r.comparators.polymarket).toBeNull();
    expect(r.summary).toContain('Polymarket: no comparable market found.');
    expect(r.dataStatus).toEqual({ polymarket: 'ok', kalshi: 'ok' });
    expect(r.errors).toEqual({});
    expect(must(r.optionsImplied, 'options implied').prob).toBeGreaterThan(0);
    expect(r.engine.commit).toBe(ENGINE_UPSTREAM.commit);
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
    expect(r.comparators.polymarket).toBeNull();
    expect(r.summary).toContain('Verdict has no tradable price (never traded, wall-only book)');
    expect(r.summary).not.toContain('Verdict YES');
    // The engine's optionsImplied.marketProb and its evidence line average the wall book to 0.5; the kit replaces both.
    const oi = must(r.optionsImplied, 'options implied');
    expect(oi.prob).toBeGreaterThan(0);
    expect(oi.marketProb).toBeNull();
    const options = r.evidence.filter((e) => e.startsWith('Options-implied reference'));
    expect(options).toHaveLength(1);
    expect(must(options[0], 'options evidence')).toContain('Verdict has no tradable price (never traded, wall-only book)');
    expect(r.evidence.some((e) => /market YES/.test(e))).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/50\.0%/);
    // The recorded Deribit chain has a Sep 18 08:00 UTC expiry, two hours after the market settles.
    const fv = await tools.fair_value({ outcome: 2899 });
    if (!fv.available) throw new Error(`expected available, got ${fv.reason}: ${fv.detail}`);
    expect(fv.optionsExpiryOffsetHours).toBe(2);
    expect(fv.impliedProb).toBeCloseTo(must(oi.prob, 'engine prob'), 9);
    expect(fv.marketProb).toBeNull();
    expect(fv.gap).toBeNull();
    expect(fv.caveats).toContain(`${UNPRICED_TAG_PREFIX}never_traded_wall_book`);
    expect(fv.caveats).not.toContain(HL_MARK_TAG);
    expect(fv.evidence).toContain('Verdict has no tradable price (never traded, wall-only book)');
    expect(fv.evidence).not.toMatch(/market YES/);
  });
  it('2899 with a stale context: no Verdict price, no gap, no HL-mark label, and the 0.5 midPx appears nowhere', async () => {
    const stale = createTools(config, new InfoClient({ network: 'mainnet', fetch: patchedCtxFetch(['#28990', '#28991'], { markPx: '0.31' }) }), { engine: { timeoutMs: 5_000 } });
    const r = await stale.compare_market({ outcome: 2899 });
    expect(CompareMarketResult.safeParse(r).success).toBe(true);
    expect(r.verdict.yesMid).toBeNull();
    expect(r.verdict.priceSource).toBeNull();
    expect(r.verdict.unpriced).toBe('stale_wall_book');
    const k = must(r.comparators.kalshi, 'kalshi comparator');
    expect(k.gap).toBeNull();
    expect(k.spreadAdjustedGap).toBeNull();
    expect(k.caveats).toContain(`${UNPRICED_TAG_PREFIX}stale_wall_book`);
    expect(k.caveats).not.toContain(HL_MARK_TAG);
    expect(k.caveat).toContain('Verdict has no tradable price (no trades in 24h, wall-only book)');
    expect(k.line).toContain('Verdict has no tradable price (no trades in 24h, wall-only book); comparator shown for reference.');
    expect(r.summary).toContain('Verdict has no tradable price (no trades in 24h, wall-only book)');
    expect(r.summary).not.toContain('Verdict YES');
    expect(must(r.optionsImplied, 'options implied').marketProb).toBeNull();
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/50\.0%/);
    expect(json).not.toContain('HL mark');
    expect(json).not.toContain('31.0%');
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
  it('a Polymarket comparator follows the same rules (the recorded gamma events hold no twin of a fixture market, so the venue path runs on a constructed card)', () => {
    const pm = { ...comp, id: 'polymarket:0xabc', venue: 'polymarket', rawId: '0xabc', url: 'https://polymarket.com/event/btc-sep-18' };
    const card = buildMaturityAdjustedCard({ ...base, yesMid: 0.65, yesBid: 0.64, yesAsk: 0.66 }, pm, adj(0.5, 0.56));
    const priced = comparatorFromEngineCard(card, 'polymarket', { ...verdict, yesMid: 0.65 });
    expect(priced.venue).toBe('polymarket');
    expect(priced.url).toBe('https://polymarket.com/event/btc-sep-18');
    expect(priced.line).toContain('Polymarket: 53.0% vs Verdict 65.0%, gap +12.0pp, +6.0pp after spreads (medium confidence');
    expect(must(priced.legs[0], 'leg').id).toBe('polymarket:0xabc');
    expect(() => comparatorFromEngineCard(card, 'kalshi', verdict)).toThrow(/has no kalshi comparator/);
    const unpriced = comparatorFromEngineCard(card, 'polymarket', { yesMid: null, priceSource: null, unpriced: 'never_traded_wall_book' });
    expect(unpriced.gap).toBeNull();
    expect(unpriced.spreadAdjustedGap).toBeNull();
    expect(unpriced.caveats).toContain(`${UNPRICED_TAG_PREFIX}never_traded_wall_book`);
    expect(unpriced.line).toBe(`Polymarket: 53.0% at the Verdict contract (medium confidence: ${unpriced.reasons.join(', ')}; maturity_adjusted_digital). Verdict has no tradable price (never traded, wall-only book); comparator shown for reference.`);
  });
});

describe('engine references resolve to an outcome, never to the title dailies share', () => {
  const b = (rawId: number, expiry: string | null, title = 'BTC closes above $77,250'): BaseRef => ({ rawId, title, expiry, underlying: 'BTC', direction: 'above', strike: 77250 });
  const ranked = [b(2897, '2026-09-14T06:00:00.000Z'), b(2898, '2026-09-16T06:00:00.000Z'), b(2899, '2026-09-18T06:00:00.000Z'), b(1210, '2026-10-01T00:00:00.000Z', 'BTC closes above $100,000')];
  it('a cross-venue reference resolves to the same-title market whose expiry is closest, as the engine matched it', () => {
    expect(resolveMatchedBase({ matchedBaseTitle: 'BTC closes above $77,250', expiry: '2026-09-18T21:00:00Z' }, ranked)?.rawId).toBe(2899);
    expect(resolveMatchedBase({ matchedBaseTitle: 'BTC closes above $77,250', expiry: '2026-09-14T21:00:00Z' }, ranked)?.rawId).toBe(2897);
    expect(resolveMatchedBase({ matchedBaseTitle: 'BTC closes above $77,250', expiry: '2026-09-15T12:00:00Z' }, ranked)?.rawId).toBe(2898);
    // Without an expiry on the reference nothing separates the three; the engine kept the first it ranked, and so does the kit.
    expect(resolveMatchedBase({ matchedBaseTitle: 'BTC closes above $77,250', expiry: null }, ranked)?.rawId).toBe(2897);
    expect(resolveMatchedBase({ matchedBaseTitle: 'BTC closes above $77,250', expiry: '2026-09-18T21:00:00Z' }, [...ranked].reverse())?.rawId).toBe(2899);
    expect(resolveMatchedBase({ matchedBaseTitle: 'BTC closes above $100,000', expiry: null }, ranked)?.rawId).toBe(1210);
    expect(resolveMatchedBase({ matchedBaseTitle: 'ETH closes above $4,000', expiry: null }, ranked)).toBeNull();
    expect(resolveMatchedBase({ matchedBaseTitle: null, expiry: '2026-09-18T21:00:00Z' }, ranked)).toBeNull();
  });
  it('the Deribit base is the first ranked BTC/ETH/SOL strike market, checked against the title the engine reports', () => {
    expect(resolveOptionsBase(ranked, 'BTC closes above $77,250')?.rawId).toBe(2897);
    expect(resolveOptionsBase([must(ranked[3], '1210'), ...ranked.slice(0, 3)], 'BTC closes above $100,000')?.rawId).toBe(1210);
    expect(() => resolveOptionsBase(ranked, 'BTC closes above $100,000')).toThrow(/first eligible ranked market is "BTC closes above \$77,250"/);
    const sports: BaseRef = { rawId: 1473, title: 'Premier League winner · Arsenal', expiry: null, underlying: null, direction: null, strike: null };
    expect(resolveOptionsBase([sports], undefined)).toBeNull();
    expect(() => resolveOptionsBase([sports], 'BTC closes above $77,250')).toThrow(/no ranked market is eligible/);
    expect(resolveOptionsBase([sports, ...ranked], 'BTC closes above $77,250')?.rawId).toBe(2897);
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
  it('a sports market has no mapped hedge: the engine still returns a leg, with direction none on both sides and no price', async () => {
    const r = await tools.find_hedges({ outcome: 1473 });
    expect(r.hedgeable).toBe(false);
    expect(r.underlying).toBeNull();
    expect(must(r.candidates[0], 'candidate').available).toBe(false);
    const leg = must(r.leg, 'hedge leg');
    expect(leg.directionForYes).toBe('none');
    expect(leg.directionForNo).toBe('none');
    expect(leg.mid).toBeNull();
    expect(leg.rationale).toBe('No direct HL hedge is mapped for this market.');
  });
});

describe('opportunities', () => {
  const OUT_OUTCOMES = [1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1251, 1472, 1473];
  const subsetFetch = fixtureFetch({ log, outcomes: OUT_OUTCOMES });
  const subsetTools = createTools(config, new InfoClient({ network: 'mainnet', fetch: subsetFetch }), { engine: { timeoutMs: 5_000 } });
  const skewConfig: KitConfig = { ...config, venue: 'skew' };
  it('ranks the venue markets by tradeable quality with a kit-built reason per row', async () => {
    const r = await subsetTools.opportunities({ limit: 3 });
    expect(OpportunitiesResult.safeParse(r).success).toBe(true);
    expect(r.venue).toBe('out');
    expect(r.scanned).toBe(11);
    expect(r.booksFetched).toBe(11);
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.rank)).toEqual([1, 2, 3]);
    expect(r.items.map((i) => i.outcome)).toEqual([1216, 1473, 1214]);
    for (const item of r.items) {
      expect(item.priced).toBe(true);
      expect(item.unpriced).toBeNull();
      expect(item.priceSource).toBe('book');
      expect(item.why).toBe(`${fmtCents(item.spread)} spread, ${fmtUsd(item.depthUsd)} depth, YES ${fmtCents(must(item.yesMid, 'yesMid'))}`);
      expect(item.tradeCall.label.length).toBeGreaterThan(0);
      expect(item.venue).toBe('out');
    }
    expect(must(r.items[0], 'top item').why).toBe('0.0% spread, $56 depth, YES 8.9%');
    expect(r.unpricedCount).toBe(0);
    expect(r.summary).toBe('Scanned 11 live Verdict markets and ranked the 8 most tradeable by spread, depth, and live odds.');
    expect(r.bookErrors).toHaveLength(0);
    // Both venues were read; the recorded payloads hold nothing comparable to the out-venue markets.
    expect(r.dataStatus).toEqual({ polymarket: 'ok', kalshi: 'ok' });
    expect(r.comparators).toHaveLength(0);
  });
  it('caps book reads at maxBooks and says so in the result; the rest price off the HL mark, labelled', async () => {
    const capped = createTools(config, new InfoClient({ network: 'mainnet', fetch: subsetFetch }), { engine: { timeoutMs: 5_000, maxBooks: 3 } });
    const r = await capped.opportunities({ limit: 8 });
    expect(r.scanned).toBe(11);
    expect(r.booksFetched).toBe(3);
    expect(r.items).toHaveLength(8);
    expect(r.unpricedCount).toBe(0);
    const fromBook = r.items.filter((i) => i.priceSource === 'book');
    const fromMark = r.items.filter((i) => i.priceSource === 'ctx');
    expect(fromBook.length).toBeLessThanOrEqual(3);
    expect(fromMark.length).toBeGreaterThanOrEqual(5);
    for (const i of fromMark) expect(i.why).toBe(`YES ${fmtCents(must(i.yesMid, 'yesMid'))} (${'Verdict price is the HL mark; no two-sided book'})`);
  });
  it('rejects a limit above the engine maximum', async () => {
    await expect(subsetTools.opportunities({ limit: 9 })).rejects.toMatchObject({ name: 'ToolError', code: 'bad_input' });
  });
  it('an unpriced market carries no probability anywhere, is described as unpriced, and ranks after every priced market', async () => {
    // Skew venue: 2949 and 2823 traded today (HL mark); 2897, 2898 and 2899 never traded. 2899's wall-only book was
    // recorded; the other two books are not, so they are unread. Before the fix 2899 ranked first with "YES 50.0%".
    const skew = createTools(skewConfig, new InfoClient({ network: 'mainnet', fetch: fixtureFetch({ log, outcomes: [2897, 2898, 2899, 2949, 2823] }) }), { engine: { timeoutMs: 5_000 } });
    const r = await skew.opportunities({ limit: 8 });
    expect(OpportunitiesResult.safeParse(r).success).toBe(true);
    expect(r.scanned).toBe(5);
    expect(r.items).toHaveLength(5);
    const priced = r.items.filter((i) => i.priced);
    const unpriced = r.items.filter((i) => !i.priced);
    expect(priced.map((i) => i.outcome).sort()).toEqual([2823, 2949]);
    expect(unpriced.map((i) => i.outcome).sort()).toEqual([2897, 2898, 2899]);
    expect(Math.max(...priced.map((i) => i.rank))).toBeLessThan(Math.min(...unpriced.map((i) => i.rank)));
    expect(r.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
    for (const i of priced) {
      expect(i.priceSource).toBe('ctx');
      expect(i.why).toBe(`YES ${fmtCents(must(i.yesMid, 'yesMid'))} (Verdict price is the HL mark; no two-sided book)`);
    }
    const i2899 = must(r.items.find((i) => i.outcome === 2899), '2899');
    expect(i2899).toMatchObject({ priced: false, yesMid: null, priceSource: null, unpriced: 'never_traded_wall_book', spread: null, depthUsd: null, crossVenue: null });
    expect(i2899.why).toBe('unpriced (never traded, wall-only book); no Verdict price, spread or depth to rank on');
    expect(i2899.tradeCall).toEqual({ label: 'Watch only', reason: 'No live executable price.' });
    expect(must(r.items.find((i) => i.outcome === 2897), '2897').why).toBe('unpriced (never traded, book not read); no Verdict price, spread or depth to rank on');
    expect(r.unpricedCount).toBe(3);
    expect(r.summary).toBe('Scanned 5 live Verdict markets and ranked the 5 most tradeable by spread, depth, and live odds. 3 of the 5 shown have no Verdict price (unpriced) and rank last.');
    expect(r.bookErrors).toHaveLength(8);
    expect(JSON.stringify(r)).not.toMatch(/50\.0%/);
  });
  it('ties every cross-venue reference and the Deribit line to a ranked market by outcome, not by the title three dailies share', async () => {
    // The engine titles 2897, 2898 and 2899 (Sep 14, 16, 18) all "BTC closes above $77,250". Make 2898 the only priced
    // one (a traded context prices it off the HL mark at 31%) and leave 2899 on its recorded wall book.
    const f = patchedCtxFetch(['#28980', '#28981'], { dayNtlVlm: '512.5', markPx: '0.31' }, { outcomes: [2897, 2898, 2899] });
    const skew = createTools(skewConfig, new InfoClient({ network: 'mainnet', fetch: f }), { engine: { timeoutMs: 5_000 } });
    const r = await skew.opportunities({ limit: 8 });
    expect(OpportunitiesResult.safeParse(r).success).toBe(true);
    expect(r.items.map((i) => i.outcome)).toEqual([2898, 2897, 2899]);
    expect(must(r.items[0], 'top item')).toMatchObject({ outcome: 2898, priced: true, yesMid: 0.31, priceSource: 'ctx' });
    // Every Kalshi reference settles Sep 18, so the engine matched it to 2899 (the closest expiry). The comparator must
    // carry 2899's state, a read wall-only book: not 2897's unread book (the first same-title market) and not 2898's 31%.
    expect(r.comparators).toHaveLength(10);
    expect(r.comparators.filter((c) => c.confidence === 'medium')).toHaveLength(8);
    expect(r.comparators.filter((c) => c.confidence === 'low')).toHaveLength(2);
    for (const c of r.comparators) {
      expect(c.venue).toBe('kalshi');
      expect(c.expiry).toBe('2026-09-18T21:00:00Z');
      expect(c.caveats).toContain(`${UNPRICED_TAG_PREFIX}never_traded_wall_book`);
      expect(c.caveats).not.toContain(`${UNPRICED_TAG_PREFIX}never_traded_no_book`);
      expect(c.caveats).not.toContain(HL_MARK_TAG);
      expect(c.gap).toBeNull();
      expect(c.spreadAdjustedGap).toBeNull();
      expect(must(c.caveat, 'caveat').length).toBeGreaterThan(0);
      expect(c.line).not.toContain('31.0%');
      expect(c.line).not.toMatch(/gap [+-]?\d/);
    }
    for (const c of r.comparators.filter((x) => x.confidence === 'medium')) expect(c.line).toContain('Verdict has no tradable price (never traded, wall-only book); comparator shown for reference.');
    for (const c of r.comparators.filter((x) => x.confidence === 'low')) expect(c.line).toContain('low-confidence match');
    // The Deribit reference was priced off 2898, the first ranked BTC strike market; the engine names it by title only.
    const options = r.evidence.filter((e) => e.startsWith('Options-implied reference'));
    expect(options).toHaveLength(1);
    const line = must(options[0], 'options line');
    expect(line).toContain('P(BTC above $77,250 at settle) = 52.2%');
    expect(line).toContain('nearest options expiry +2h vs market settle; market YES 31.0% (Verdict price is the HL mark; no two-sided book)');
    expect(line).not.toContain('no tradable price');
    expect(JSON.stringify(r)).not.toMatch(/50\.0%/);
    expect(JSON.stringify(r.comparators)).not.toContain('book not read');
  });
});

describe('venue payloads are Zod-validated before the engine reads them', () => {
  const url = (s: string) => new URL(s);
  it('accepts the recorded Polymarket, Kalshi and Deribit payloads and passes non-venue bodies through', () => {
    expect(() => validateVenueResponse(url('https://gamma-api.polymarket.com/events?limit=200&tag_id=21'), engineFixture('polymarket_events_crypto'))).not.toThrow();
    expect(() => validateVenueResponse(url('https://gamma-api.polymarket.com/markets?limit=60'), [])).not.toThrow();
    expect(() => validateVenueResponse(url('https://external-api.kalshi.com/trade-api/v2/events?series_ticker=KXBTCD'), engineFixture('kalshi_events_KXBTCD'))).not.toThrow();
    expect(() => validateVenueResponse(url('https://external-api.kalshi.com/trade-api/v2/events?series_ticker=KXBTC'), engineFixture('kalshi_events_KXBTC'))).not.toThrow();
    expect(() => validateVenueResponse(url('https://external-api.kalshi.com/trade-api/v2/markets?limit=100'), { markets: [] })).not.toThrow();
    expect(() => validateVenueResponse(url('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'), engineFixture('deribit_btc_options'))).not.toThrow();
    expect(() => validateVenueResponse(url('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=SOL'), { jsonrpc: '2.0', error: { code: 1, message: 'x' } })).not.toThrow();
    expect(() => validateVenueResponse(url('https://api.oddpool.com/search/markets?q=btc'), [{ exchange: 'kalshi', market_id: 'a', yes_bid: '0.4' }])).not.toThrow();
    expect(() => validateVenueResponse(url('https://api.oddpool.com/search/events/abc/markets'), [])).not.toThrow();
    const hl = { anything: [1, 2, 3] };
    expect(validateVenueResponse(url('https://api.hyperliquid.xyz/info'), hl)).toBe(hl);
  });
  it('rejects a body that does not match as an UpstreamError of kind schema', () => {
    const reject = (u: string, body: unknown) => {
      let err: unknown = null;
      try {
        validateVenueResponse(url(u), body);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UpstreamError);
      expect((err as UpstreamError).kind).toBe('schema');
      expect((err as UpstreamError).message).toContain('did not match the expected shape');
    };
    reject('https://gamma-api.polymarket.com/events?tag_id=21', { foo: 1 });
    reject('https://gamma-api.polymarket.com/events?tag_id=21', [{ markets: [{ bestBid: { nested: true } }] }]);
    reject('https://gamma-api.polymarket.com/markets?limit=60', 'not json shaped');
    reject('https://external-api.kalshi.com/trade-api/v2/events?series_ticker=KXBTCD', { events: 'KXBTCD' });
    reject('https://external-api.kalshi.com/trade-api/v2/events?series_ticker=KXBTCD', { events: [{ markets: [{ yes_bid_dollars: {} }] }] });
    reject('https://external-api.kalshi.com/trade-api/v2/markets?limit=100', { markets: [{ floor_strike: [1] }] });
    reject('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC', { result: [{ instrument_name: 5 }] });
    reject('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC', { result: 'x' });
    reject('https://api.oddpool.com/search/markets?q=btc', { markets: [] });
  });
  it('the validating fetch returns the body unchanged when it matches and throws before the engine can read one that does not', async () => {
    const good = validatingFetch(fetchAll);
    const res = await good('https://external-api.kalshi.com/trade-api/v2/events?limit=100&status=open&with_nested_markets=true&series_ticker=KXBTCD');
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual(engineFixture('kalshi_events_KXBTCD'));
    const bad = validatingFetch((async () => new Response(JSON.stringify({ events: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch);
    await expect(bad('https://external-api.kalshi.com/trade-api/v2/events?series_ticker=KXBTCD')).rejects.toMatchObject({ name: 'UpstreamError', kind: 'schema' });
    const notJson = validatingFetch((async () => new Response('<html>', { status: 200 })) as typeof fetch);
    expect(await (await notJson('https://gamma-api.polymarket.com/events?tag_id=21')).text()).toBe('<html>');
    const failed = validatingFetch((async () => new Response('{}', { status: 503 })) as typeof fetch);
    expect((await failed('https://gamma-api.polymarket.com/events?tag_id=21')).status).toBe(503);
  });
  it('installs the wrapper on the global fetch for the duration of an engine call only, reference counted', async () => {
    const before = globalThis.fetch;
    await withValidatedVenueFetch(async () => {
      const outer = globalThis.fetch;
      expect(outer).not.toBe(before);
      await withValidatedVenueFetch(async () => {
        expect(globalThis.fetch).toBe(outer);
      });
      expect(globalThis.fetch).toBe(outer);
    });
    expect(globalThis.fetch).toBe(before);
    await expect(withValidatedVenueFetch(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(globalThis.fetch).toBe(before);
    await tools.compare_market({ outcome: 1210 });
    expect(globalThis.fetch).toBe(fetchAll);
  });
  it('a malformed Kalshi ladder payload never reaches the engine: 2899 loses its Kalshi ladder instead of pricing off bad data', async () => {
    const inner = fixtureFetch({ log });
    const malformed = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (u.hostname === 'external-api.kalshi.com' && u.pathname.endsWith('/events') && u.searchParams.get('series_ticker') === 'KXBTCD') {
        return new Response(JSON.stringify({ events: [{ event_ticker: 'KXBTCD-26SEP1817', markets: 'not a list' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return inner(input, init);
    }) as typeof fetch;
    vi.stubGlobal('fetch', malformed);
    try {
      const r = await tools.compare_market({ outcome: 2899 });
      expect(CompareMarketResult.safeParse(r).success).toBe(true);
      const method = r.comparators.kalshi?.method ?? 'none';
      expect(['ladder_interpolation', 'maturity_adjusted_digital']).not.toContain(method);
      expect(r.comparators.kalshi?.gap ?? null).toBeNull();
    } finally {
      vi.stubGlobal('fetch', fetchAll);
    }
    const good = await tools.compare_market({ outcome: 2899 });
    expect(['ladder_interpolation', 'maturity_adjusted_digital']).toContain(must(good.comparators.kalshi, 'kalshi comparator').method);
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
  it('every request made in this file was a Hyperliquid info POST or a venue read GET; nothing touched an exchange endpoint or a venue trading API', () => {
    // Partition by host, not by substring: the engine's Polymarket discovery query carries "search=hyperliquid".
    const isHyperliquid = (entry: string) => /^[A-Z]+ https:\/\/api\.hyperliquid(-testnet)?\.xyz\//.test(entry);
    const hyperliquid = log.filter(isHyperliquid);
    const venues = log.filter((entry) => !isHyperliquid(entry));
    expect(hyperliquid.length).toBeGreaterThan(0);
    expect(venues.length).toBeGreaterThan(0);
    for (const entry of hyperliquid) expect(entry).toMatch(/^POST https:\/\/api\.hyperliquid(-testnet)?\.xyz\/info$/);
    for (const entry of venues) expect(entry).toMatch(/^GET https:\/\/(gamma-api\.polymarket\.com|external-api\.kalshi\.com|www\.deribit\.com)\//);
    for (const entry of log) {
      expect(entry).not.toMatch(/\/exchange\b/);
      expect(entry).not.toMatch(/clob\.polymarket\.com|trading-api\.kalshi|\/orders\b/);
    }
  });
});
