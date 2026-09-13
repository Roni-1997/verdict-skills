// Live schema checks against the real Hyperliquid endpoints. Skipped unless VERDICT_LIVE=1, so the
// normal test run stays offline and deterministic. Run: VERDICT_LIVE=1 pnpm vitest run tests/live.test.ts
import { describe, expect, it } from 'vitest';
import { InfoClient, getMarket, listMarkets, orderbook, quote } from '../packages/core/src/index.js';

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
