import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LighterClient, createLighterTools, lighterConfigFromEnv, lighterTicks } from '../packages/core/src/lighter.js';
import { runLighterCli } from '../packages/cli/src/lighter.js';
import { runCli } from '../packages/cli/src/index.js';
import { createLighterServer } from '../packages/mcp/src/lighter.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/lighter/${name}.json`, import.meta.url), 'utf8'));
const NOW = 1792623100000;
const MARKET = 4555;
function harness(overrides: Record<string, unknown> = {}, creators: number[] = [761897], now = NOW) {
  const calls: URL[] = [];
  const routes: Record<string, unknown> = { events: fixture('events'), orderBookOrders: fixture('book'), recentTrades: fixture('trades'), account: fixture('account'), feeTiers: fixture('tiers'), ...overrides };
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
    const u = new URL(String(url)); calls.push(u);
    return new Response(JSON.stringify(routes[u.pathname.split('/').at(-1) ?? '']), { status: 200 });
  });
  const client = new LighterClient({ network: 'mainnet', creators }, { fetch: fetcher, now: () => now });
  return { tools: createLighterTools(client), calls, fetcher };
}
const order = { market: MARKET, side: 'yes', action: 'buy', price: '0.35', size: '10', clientOrderIndex: 1234 };

describe('Lighter binary outcomes using public response fixtures', () => {
  it('defaults to devnet with no creators enabled for orders, independently of Hyperliquid', () => {
    expect(lighterConfigFromEnv({ VERDICT_NETWORK: 'mainnet' })).toEqual({ network: 'devnet', creators: [] });
    expect(() => lighterConfigFromEnv({ LIGHTER_NETWORK: 'testnet' })).toThrow('LIGHTER_NETWORK');
    expect(() => lighterConfigFromEnv({ LIGHTER_CREATORS: 'secret-value' })).toThrow('value hidden');
    expect(lighterConfigFromEnv({ LIGHTER_CREATORS: '9, 1' }).creators).toEqual([9, 1]);
  });
  it('reads real market rules, precision, fee flags and a single complete page', async () => {
    const { tools, calls } = harness();
    const result = await tools.list_markets({ limit: 100 });
    expect(result.markets[0]).toMatchObject({ market_id: MARKET, creator: 761897, taker_fee: '1.0000', price_decimals: 2, size_decimals: 4 });
    expect(result.markets[0]?.settlementRule).toContain('chainlink');
    expect(result).toMatchObject({ network: 'mainnet', nextCursor: null, complete: true });
    expect(calls[0]?.searchParams.get('active')).toBe('true');
  });
  it('reports pagination without pretending a capped page is the whole catalog', async () => {
    const page = { code: 200, events: [], next_cursor: 123 };
    const { tools, calls } = harness({ events: page });
    expect(await tools.list_markets({ cursor: 456 })).toMatchObject({ nextCursor: 123, complete: false });
    expect(calls[0]?.searchParams.get('cursor')).toBe('456');
  });
  it('does a fresh market_ids lookup and never substitutes another outcome', async () => {
    const { tools, calls } = harness();
    await expect(tools.get_market({ market: 123 })).rejects.toMatchObject({ code: 'not_found' });
    expect(calls[0]?.searchParams.get('market_ids')).toBe('123');
  });
  it('aggregates equal prices, computes midpoint from real best quotes and preserves large raw order ids by omitting them', async () => {
    const { tools } = harness();
    const b = await tools.orderbook({ market: MARKET });
    expect(b).toMatchObject({ midpoint: '0.340', spread: '0.02', truncated: false });
    expect(b.asks.find((l) => l.price === '0.39')?.shares).toBe('160.0000');
    expect(b.bids[0]).toEqual({ price: '0.33', shares: '756.0000' });
    expect(JSON.stringify(b)).not.toContain('order_index');
  });
  it('does not manufacture midpoint, spread or a quote from an empty book', async () => {
    const { tools } = harness({ orderBookOrders: { code: 200, asks: [], bids: [], total_asks: 0, total_bids: 0 } });
    expect(await tools.orderbook({ market: MARKET })).toMatchObject({ midpoint: null, spread: null });
    expect(await tools.quote({ market: MARKET, side: 'yes', action: 'buy', size: '10' })).toMatchObject({ complete: false, averagePrice: null, worstPrice: null, filledShares: '0.0000', maxFeeUSDC: '0.000000' });
  });
  it('quotes a YES buy from asks and a NO buy from complemented bids with the same fee curve', async () => {
    const { tools } = harness();
    expect(await tools.quote({ market: MARKET, side: 'yes', action: 'buy', size: '10' })).toMatchObject({ complete: true, notionalUSDC: '3.500000', averagePrice: 0.35, maxFeeUSDC: '0.022750' });
    expect(await tools.quote({ market: MARKET, side: 'no', action: 'buy', size: '10' })).toMatchObject({ complete: true, notionalUSDC: '6.700000', averagePrice: 0.67, maxFeeUSDC: '0.022110' });
    expect(await tools.quote({ market: MARKET, side: 'no', action: 'sell', size: '10' })).toMatchObject({ averagePrice: 0.65, maxFeeUSDC: '0.022750' });
  });
  it('reports partial liquidity and charges the estimate only on filled shares', async () => {
    const { tools } = harness();
    const q = await tools.quote({ market: MARKET, side: 'yes', action: 'buy', size: '999999' });
    expect(q.complete).toBe(false);
    expect(Number(q.filledShares)).toBeLessThan(999999);
    expect(Number(q.notionalUSDC)).toBeGreaterThan(0);
  });
  it('rejects malformed inputs, prices between ticks and extra signing fields', async () => {
    const { tools } = harness();
    await expect(tools.build_order({ ...order, price: '0.355' })).rejects.toThrow('between market ticks');
    await expect(tools.build_order({ ...order, size: '1e3' })).rejects.toMatchObject({ code: 'bad_input' });
    await expect(tools.build_order({ ...order, privateKey: 'do-not-echo' })).rejects.not.toThrow('do-not-echo');
    await expect(tools.build_order({ ...order, reduceOnly: true })).rejects.toMatchObject({ code: 'bad_input' });
    expect(lighterTicks('0.35000', 2)).toBe(35n);
  });
  it.each([
    ['yes', 'buy', false, 35], ['yes', 'sell', true, 35], ['no', 'buy', true, 65], ['no', 'sell', false, 65],
  ])('maps %s %s to the correct single-book side', async (side, action, isAsk, price) => {
    const { tools } = harness();
    const p = await tools.build_order({ ...order, side, action });
    expect(p).toMatchObject({ unsigned: true, chainId: 304, sdkMethod: 'create_order', sdkArgs: { market_index: MARKET, price, base_amount: 100000, is_ask: isAsk, order_type: 0, time_in_force: 1, reduce_only: false } });
    expect(p.confirmation.join(' ')).toContain('opposite');
    expect(p.sdkArgs).not.toHaveProperty('nonce');
    expect(p.sdkArgs).not.toHaveProperty('builder');
  });
  it('checks resting minimums but permits IOC dust and sets IOC expiry', async () => {
    const { tools } = harness();
    await expect(tools.build_order({ ...order, size: '1' })).rejects.toThrow('minimum');
    expect(await tools.build_order({ ...order, size: '1', tif: 'ioc' })).toMatchObject({ sdkArgs: { time_in_force: 0, order_expiry: 0 } });
    await expect(tools.build_order({ ...order, size: '9999999999' })).rejects.toThrow('order_quote_limit');
  });
  it('refuses unsigned orders without explicit creator configuration', async () => {
    const { tools } = harness({}, []);
    expect((await tools.list_markets({})).markets).toHaveLength(1);
    await expect(tools.build_order(order)).rejects.toMatchObject({ code: 'not_configured' });
  });
  it('refuses orders after the trading window while permitting unsigned cancellation', async () => {
    const { tools } = harness({}, [761897], NOW + 86_400_000);
    await expect(tools.build_order(order)).rejects.toThrow('trading window');
    expect(await tools.build_cancel({ market: MARKET, clientOrderIndex: 1234 })).toMatchObject({ unsigned: true, sdkArgs: { market_index: MARKET, order_index: 1234 } });
    await expect(tools.build_cancel({ market: MARKET, clientOrderIndex: Number('291045125918836608') })).rejects.toMatchObject({ code: 'bad_input' });
  });
  it('rejects frozen and not-yet-open markets using fresh metadata on every preparation', async () => {
    const raw = fixture('events');
    const schema = z.object({ events: z.array(z.object({ order_books: z.array(z.object({ is_frozen: z.boolean(), start_timestamp: z.number() }).passthrough()) }).passthrough()) }).passthrough();
    const page = schema.parse(raw);
    const book = page.events[0]?.order_books[0];
    if (!book) throw new Error('fixture has no market');
    book.is_frozen = true;
    await expect(harness({ events: page }).tools.build_order(order)).rejects.toThrow('frozen');
    book.is_frozen = false; book.start_timestamp = NOW + 60_000;
    await expect(harness({ events: page }).tools.build_order(order)).rejects.toThrow('trading window');
  });
  it('honors disabled fee flags and rejects crossed snapshots', async () => {
    const schema = z.object({ events: z.array(z.object({ order_books: z.array(z.object({ is_taker_fee_enabled: z.boolean() }).passthrough()) }).passthrough()) }).passthrough();
    const page = schema.parse(fixture('events'));
    const book = page.events[0]?.order_books[0];
    if (!book) throw new Error('fixture has no market');
    book.is_taker_fee_enabled = false;
    expect(await harness({ events: page }).tools.quote({ market: MARKET, side: 'yes', action: 'buy', size: '10' })).toMatchObject({ maxFeeUSDC: '0.000000' });
    const crossed = { code: 200, total_asks: 1, total_bids: 1, asks: [{ price: '0.30', remaining_base_amount: '10' }], bids: [{ price: '0.40', remaining_base_amount: '10' }] };
    await expect(harness({ orderBookOrders: crossed }).tools.orderbook({ market: MARKET })).rejects.toThrow('crossed');
  });
  it('rejects invalid venue schemas instead of assuming an empty market or zero fees', async () => {
    const { tools } = harness({ events: { code: 200, events: [{ event_id: MARKET }] } });
    await expect(tools.list_markets({})).rejects.toMatchObject({ code: 'upstream' });
  });
  it('reads current binary fee tiers without requiring a nonexistent code field', async () => {
    const { tools, calls } = harness();
    const fees = await tools.fee_schedule({});
    if (!fees.available) throw new Error('Mainnet fixture must supply fee tiers');
    expect(fees.bo_tiers[0]).toEqual({ name: 'bo_0', required_volume: 0, fee_rate: 1 });
    expect(calls[0]?.searchParams.get('filter')).toBe('bo');
  });
  it('reports unavailable devnet tiers explicitly, without borrowing mainnet rates or masking other failures', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (url) => { requests.push(String(url)); return new Response('Not Found', { status: 404 }); };
    const devnet = createLighterTools(new LighterClient({ network: 'devnet', creators: [] }, { fetch: fetcher }));
    expect(await devnet.fee_schedule({})).toMatchObject({ available: false, bo_tiers: null, staking_tiers: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('devnet.zklighter.elliot.ai');
    const mainnet = createLighterTools(new LighterClient({ network: 'mainnet', creators: [] }, { fetch: fetcher }));
    await expect(mainnet.fee_schedule({})).rejects.toMatchObject({ code: 'upstream' });
    const offline = createLighterTools(new LighterClient({ network: 'devnet', creators: [] }, { fetch: async () => new Response('unavailable', { status: 503 }) }));
    await expect(offline.fee_schedule({})).rejects.toMatchObject({ code: 'upstream' });
  });
  it('reads public binary positions and recent fills; empty recent prints are supported', async () => {
    const { tools } = harness();
    expect(await tools.positions({ account: 761897 })).toMatchObject({ account: 761897, availableBalanceUSDC: '5.000000', positions: [] });
    expect((await tools.recent_trades({ market: MARKET })).trades[0]).toMatchObject({ price: '0.30', size: '5.0000', timestamp: 1792623109910 });
    expect((await harness({ recentTrades: { code: 200, trades: null } }).tools.recent_trades({ market: MARKET })).trades).toEqual([]);
  });
  it('does not leak upstream response bodies or network exceptions', async () => {
    const client = new LighterClient({ network: 'devnet', creators: [] }, { fetch: async () => { throw new Error('secret-upstream-text'); } });
    await expect(createLighterTools(client).list_markets({})).rejects.not.toThrow('secret-upstream-text');
  });
});

describe('Lighter CLI and MCP faces', () => {
  it('CLI and core return the same real quote and bad input uses JSON errors', async () => {
    const { tools } = harness();
    const args = ['quote', String(MARKET), '--side', 'no', '--action', 'buy', '--size', '10'];
    const result = await runLighterCli(args, tools);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(await tools.quote({ market: MARKET, side: 'no', action: 'buy', size: '10' }));
    expect((await runLighterCli(['market', 'bad'], tools)).exitCode).toBe(1);
    expect((await runCli(['lighter', '--help'])).stdout).toContain('Lighter binary');
  });
  it('MCP exposes nine namespaced tools and serves actual core responses over the SDK transport', async () => {
    const { tools, calls } = harness();
    const server = createLighterServer(tools);
    const client = new Client({ name: 'test-lighter', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(9);
      expect(listed.tools.every((t) => t.name.startsWith('lighter_'))).toBe(true);
      expect(listed.tools.some((t) => /withdraw|send|sign|transfer/.test(t.name))).toBe(false);
      const result = await client.callTool({ name: 'lighter_build_order', arguments: order });
      expect(result.structuredContent).toMatchObject({ unsigned: true, sdkArgs: { price: 35, is_ask: false } });
      const resource = await client.readResource({ uri: 'verdict-lighter://markets' });
      expect(resource.contents).toHaveLength(1);
      expect(calls.every((u) => u.origin === 'https://mainnet.zklighter.elliot.ai')).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
