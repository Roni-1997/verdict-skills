// Live schema checks against the real Hyperliquid endpoints. Skipped unless VERDICT_LIVE=1, so the
// normal test run stays offline and deterministic. Run: VERDICT_LIVE=1 pnpm vitest run tests/live.test.ts
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CompareMarketResult, InfoClient, ListMarketsResult, OpportunitiesResult, ToolError, createRemoteTools, createTools, getMarket, listMarkets, loadCatalog, marketsFromCatalog, orderbook, quote } from '../packages/core/src/index.js';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}

const live = process.env.VERDICT_LIVE === '1';
const d = live ? describe : describe.skip;

d('live: testnet', () => {
  const client = new InfoClient({ network: 'testnet' });
  it('lists venue at markets with settlement rules and empty or populated books', async () => {
    const markets = await listMarkets(client, { venue: 'at' });
    expect(markets.length).toBeGreaterThan(0);
    const priced = markets.find((m) => m.templateId?.startsWith('binaryPrice'));
    expect(priced?.settlementRule).toContain('TWAP');
    const book = await orderbook(client, markets[0] as NonNullable<(typeof markets)[0]>);
    expect(book.sides).toHaveLength(2);
  }, 30_000);
});

d('live: mainnet read-only', () => {
  const client = new InfoClient({ network: 'mainnet' });
  it('reads a live deployer market and quotes one token on it', async () => {
    const markets = await listMarkets(client);
    const withVenue = markets.find((m) => m.venue && m.templateId === 'binaryPrice');
    expect(withVenue).toBeDefined();
    const m = await getMarket(client, (withVenue as NonNullable<typeof withVenue>).outcome);
    expect(m?.settlementRule).toBeTruthy();
    const q = await quote(client, m as NonNullable<typeof m>, { side: 0, action: 'buy', size: 1 });
    expect(q.requestedSize).toBe(1);
  }, 30_000);
});

d('live: cross-venue engine on mainnet', () => {
  const client = new InfoClient({ network: 'mainnet' });
  it('compare_market on a live deployer BTC market returns typed comparators with confidence and reasons', async () => {
    const catalog = await loadCatalog(client);
    const now = Date.now();
    const market = must(
      marketsFromCatalog(catalog).find((m) => m.venue && m.templateId === 'binaryPrice' && m.underlying === 'BTC' && (m.expiresAt === null || Date.parse(m.expiresAt) > now)),
      'a live deployer BTC binaryPrice market',
    );
    const tools = createTools({ network: 'mainnet', venue: market.venue, builder: null, apiUrl: null }, client);
    const r = await tools.compare_market({ outcome: market.outcome });
    expect(CompareMarketResult.safeParse(r).success).toBe(true);
    expect(r.market.outcome).toBe(market.outcome);
    expect(r.lines).toHaveLength(r.optionsImplied ? 3 : 2);
    for (const c of [r.comparators.polymarket, r.comparators.kalshi]) {
      if (!c) continue;
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(c.confidence);
      if (c.confidence === 'low') {
        expect(c.caveat).toBeTruthy();
        expect(c.gap).toBeNull();
        expect(c.line).not.toMatch(/gap [+-]?\d/);
      }
    }
  }, 90_000);
  it('the engine copies match GitHub at the pinned commit', () => {
    const r = spawnSync(process.execPath, ['scripts/check-engine-drift.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('compared against GitHub');
  }, 60_000);
});

d('live: hosted API on testnet (https://hyperverdict.xyz/api/v1, venue at)', () => {
  const API = 'https://hyperverdict.xyz/api/v1';
  const tools = createRemoteTools({ network: 'testnet', venue: 'at', builder: null, apiUrl: API }, { apiUrl: API });
  it('list_markets returns venue at markets on testnet', async () => {
    const r = await tools.list_markets({});
    expect(ListMarketsResult.safeParse(r).success).toBe(true);
    expect(r.network).toBe('testnet');
    expect(r.venue).toBe('at');
    expect(r.markets.length).toBeGreaterThan(0);
    expect(r.markets.every((m) => m.venue === 'at')).toBe(true);
  }, 30_000);
  it('compare_market on a listed market returns a typed result, and an index that is not a market a typed not_found', async () => {
    const list = await tools.list_markets({});
    const market = must(list.markets.find((m) => m.templateId?.startsWith('binaryPrice')) ?? list.markets[0], 'a testnet market');
    const r = await tools.compare_market({ outcome: market.outcome });
    expect(CompareMarketResult.safeParse(r).success).toBe(true);
    expect(r.market.outcome).toBe(market.outcome);
    for (const c of [r.comparators.polymarket, r.comparators.kalshi]) {
      if (!c) continue;
      expect(c.reasons.length).toBeGreaterThan(0);
      if (c.confidence === 'low') {
        expect(c.caveat).toBeTruthy();
        expect(c.gap).toBeNull();
      }
    }
    const e = await tools.compare_market({ outcome: 999999 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe('not_found');
  }, 60_000);
  it('opportunities with limit 2 returns items', async () => {
    const r = await tools.opportunities({ limit: 2 });
    expect(OpportunitiesResult.safeParse(r).success).toBe(true);
    expect(r.limit).toBe(2);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(2);
  }, 60_000);
  it('the production /openapi document is the pinned contract, key for key', async () => {
    const res = await fetch(`${API}/openapi`);
    expect(res.status).toBe(200);
    const live: unknown = await res.json();
    const pinned: unknown = JSON.parse(readFileSync(new URL('../packages/core/api-contract/openapi.json', import.meta.url), 'utf8'));
    expect(live).toEqual(pinned);
  }, 30_000);
});
