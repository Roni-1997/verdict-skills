// The CLI and the MCP server are thin faces over the same tool module: prove both against the recorded
// fixtures through a fake fetch, with no network and no keys.
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { InfoClient, createTools, type KitConfig } from '../packages/core/src/index.js';
import { runCli } from '../packages/cli/src/index.js';
import { INTERNAL_ERROR_RESPONSE, type RequestHandlerOptions, createRequestHandler, parseJsonBody } from '../packages/mcp/src/http.js';
import { TWO_MESSAGE_RULE } from '../packages/mcp/src/prompts.js';
import { createServer } from '../packages/mcp/src/server.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | undefined>;
    const type = body.type ?? '';
    const key =
      type === 'l2Book' || type === 'recentTrades'
        ? `${type}:${body.coin ?? ''}`
        : type === 'candleSnapshot'
          ? `candleSnapshot:${(body.req as unknown as { coin: string } | undefined)?.coin ?? ''}`
          : type === 'maxBuilderFee' || type === 'userFills' || type === 'frontendOpenOrders' || type === 'openOrders'
            ? `${type}:${body.user ?? ''}`
            : type === 'orderStatus'
              ? `orderStatus:${body.user ?? ''}:${String(body.oid)}`
              : type;
    if (!(key in routes)) return new Response('null', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const APPROVED = '0x00000000000000000000000000000000000000a1';
const UNAPPROVED = '0x00000000000000000000000000000000000000a2';
/** Public testnet addresses from recentTrades output (tests/fixtures/record.py); their fills and orders are replayed here as data, whatever the configured network. */
const TRADER = '0xa98361b7c825e8ee9434b433d58d6126d2ccd04e';
const MAKER = '0x876fa87b4d3818f437f38f1263bee508d7672d85';

const routes = {
  outcomeMeta: fixture('mainnet_outcomeMeta'),
  outcomeTemplates: fixture('mainnet_outcomeTemplates'),
  'l2Book:#12100': fixture('mainnet_l2Book_12100'),
  'l2Book:#12101': fixture('mainnet_l2Book_12101'),
  spotClearinghouseState: fixture('testnet_spotClearinghouseState_subdeployer'),
  [`maxBuilderFee:${APPROVED}`]: 10,
  [`maxBuilderFee:${UNAPPROVED}`]: 0,
  'recentTrades:#12100': fixture('mainnet_recentTrades_12100'),
  'candleSnapshot:#12100': fixture('mainnet_candleSnapshot_12100_1h'),
  [`userFills:${TRADER}`]: fixture('testnet_userFills_trader'),
  [`frontendOpenOrders:${MAKER}`]: fixture('testnet_frontendOpenOrders_maker'),
  [`orderStatus:${MAKER}:55896593277`]: fixture('testnet_orderStatus_maker_open'),
  [`orderStatus:${MAKER}:1`]: fixture('testnet_orderStatus_maker_unknown'),
  [`orderStatus:${TRADER}:0xa638f7c5c92a6ac186872360e3086040`]: fixture('testnet_orderStatus_trader_filled'),
};

const config: KitConfig = { network: 'mainnet', venue: 'out', builder: { address: '0x00000000000000000000000000000000000000b1', feeTenthsBp: 10 }, apiUrl: null };
const tools = createTools(config, new InfoClient({ network: 'mainnet', fetch: fakeFetch(routes) }));

describe('CLI face', () => {
  it('prints usage and exits 1 without a command', async () => {
    const r = await runCli([], config, tools);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('verdict markets');
  });
  it('lists markets for the configured venue as JSON', async () => {
    const r = await runCli(['markets', '--include-expired'], config, tools);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { venue: string; count: number; markets: { venue: string }[] };
    expect(out.venue).toBe('out');
    expect(out.count).toBeGreaterThan(0);
    expect(out.markets.every((m) => m.venue === 'out')).toBe(true);
  });
  it('quotes a size on the live fixture book', async () => {
    const r = await runCli(['quote', '1210', '--side', 'yes', '--action', 'buy', '--size', '10'], config, tools);
    expect(r.exitCode).toBe(0);
    const q = JSON.parse(r.stdout) as { complete: boolean; averagePrice: number; market: { outcome: number } };
    expect(q.complete).toBe(true);
    expect(q.averagePrice).toBeGreaterThan(0);
    expect(q.market.outcome).toBe(1210);
  });
  it('builds an unsigned order with the builder code and confirmation lines', async () => {
    const r = await runCli(['build-order', '1210', '--side', 'no', '--action', 'sell', '--price', '0.97', '--size', '5'], config, tools);
    expect(r.exitCode).toBe(0);
    const built = JSON.parse(r.stdout) as { action: { builder: { b: string; f: number }; orders: { a: number; b: boolean }[] }; confirmation: string[] };
    expect(built.action.builder).toEqual({ b: '0x00000000000000000000000000000000000000b1', f: 10 });
    expect(built.action.orders[0]?.a).toBe(100_012_101);
    expect(built.action.orders[0]?.b).toBe(false);
    expect(built.confirmation.at(-1)).toContain('unsigned');
  });
  it('validates --cloid as 0x plus 32 hex characters before the payload exists, and passes a valid one through as c', async () => {
    const base = ['build-order', '1210', '--side', 'yes', '--action', 'buy', '--price', '0.018', '--size', '250'];
    for (const bad of ['garbage', '0x1234', '0xZZ000000000000000000000000000000', `0x${'a'.repeat(31)}`, `0x${'a'.repeat(33)}`]) {
      const r = await runCli([...base, '--cloid', bad], config, tools);
      expect(r.exitCode, bad).toBe(1);
      expect(r.stdout).toBe('');
      expect(JSON.parse(r.stderr)).toMatchObject({ error: 'bad_input' });
      expect(r.stderr).toContain('--cloid');
    }
    const cloid = '0x00112233445566778899aabbccddeeff';
    const ok = await runCli([...base, '--cloid', cloid], config, tools);
    expect(ok.exitCode).toBe(0);
    const built = JSON.parse(ok.stdout) as { action: { orders: { c?: string }[] } };
    expect(built.action.orders[0]?.c).toBe(cloid);
    expect((await runCli(base, config, tools)).stdout).not.toContain('"c":');
  });
  it('maps tool errors to exit codes and JSON on stderr', async () => {
    expect((await runCli(['market', '999999'], config, tools)).exitCode).toBe(2);
    expect((await runCli(['quote', '1210', '--side', 'yes', '--action', 'hold', '--size', '1'], config, tools)).exitCode).toBe(1);
    const unset = await runCli(['build-order', '1210', '--side', 'yes', '--action', 'buy', '--price', '0.5', '--size', '1'], { ...config, builder: null }, createTools({ ...config, builder: null }, new InfoClient({ network: 'mainnet', fetch: fakeFetch(routes) })));
    expect(unset.exitCode).toBe(4);
    expect(unset.stderr).toContain('VERDICT_BUILDER_ADDRESS');
  });
  it('reports an invalid operator configuration as the not_configured JSON error with exit 4, never a stack trace', async () => {
    // No config or tools passed: runCli reads the environment, as bin.ts does.
    const saved = { ...process.env };
    const restore = () => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    };
    try {
      process.env.VERDICT_NETWORK = 'devnet';
      const net = await runCli(['markets']);
      expect(net.exitCode).toBe(4);
      expect(net.stdout).toBe('');
      expect(net.stderr.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(net.stderr)).toEqual({ error: 'not_configured', message: 'VERDICT_NETWORK must be "testnet" or "mainnet", got "devnet"' });
      expect(net.stderr).not.toContain('    at ');
      process.env.VERDICT_NETWORK = 'testnet';
      process.env.VERDICT_BUILDER_ADDRESS = '0x00000000000000000000000000000000000000b1';
      process.env.VERDICT_BUILDER_FEE_TENTHS_BP = '1.5';
      const fee = await runCli(['approve-builder-fee-payload']);
      expect(fee.exitCode).toBe(4);
      expect(fee.stdout).toBe('');
      expect(JSON.parse(fee.stderr)).toEqual({ error: 'not_configured', message: 'VERDICT_BUILDER_FEE_TENTHS_BP must be an integer between 0 and 10000, got "1.5"' });
      // Usage needs no configuration at all.
      expect((await runCli(['--help'])).exitCode).toBe(0);
      expect((await runCli([])).exitCode).toBe(1);
    } finally {
      restore();
    }
  });
  it('recent-trades reads YES by default, candles takes an interval from the venue set and a whole number of minutes', async () => {
    const trades = await runCli(['recent-trades', '1210'], config, tools);
    expect(trades.exitCode, trades.stderr).toBe(0);
    expect(JSON.parse(trades.stdout)).toMatchObject({ outcome: 1210, side: 0, coin: '#12100', count: 10 });
    expect((await runCli(['recent-trades', '1210', '--side', 'maybe'], config, tools)).exitCode).toBe(1);
    const candles = await runCli(['candles', '1210', '--side', 'yes', '--interval', '1h', '--lookback', '1440'], config, tools);
    expect(candles.exitCode, candles.stderr).toBe(0);
    const c = JSON.parse(candles.stdout) as { interval: string; count: number; candles: { open: number }[] };
    expect(c.interval).toBe('1h');
    expect(c.count).toBe(24);
    expect(c.candles[0]?.open).toBe(0.01851);
    for (const bad of [
      ['candles', '1210', '--side', 'yes', '--interval', '7m', '--lookback', '60'],
      ['candles', '1210', '--side', 'yes', '--interval', '1h', '--lookback', 'abc'],
      ['candles', '1210', '--side', 'yes', '--interval', '1h', '--lookback', '1.5'],
      ['candles', '1210', '--side', 'yes', '--lookback', '60'],
      ['candles', '1210', '--interval', '1h', '--lookback', '60'],
    ]) {
      const r = await runCli(bad, config, tools);
      expect(r.exitCode, bad.join(' ')).toBe(1);
      expect(JSON.parse(r.stderr)).toMatchObject({ error: 'bad_input' });
    }
    expect((await runCli(['candles', '1210', '--side', 'yes', '--interval', '7m', '--lookback', '60'], config, tools)).stderr).toContain('--interval');
    expect((await runCli(['candles', '1210', '--side', 'yes', '--interval', '1h', '--lookback', 'abc'], config, tools)).stderr).toContain('--lookback');
  });
  it('fills, open-orders and order-status read an address; a malformed address is exit 1 and not echoed; an unknown order is exit 2', async () => {
    const fills = await runCli(['fills', TRADER], config, tools);
    expect(fills.exitCode, fills.stderr).toBe(0);
    expect(JSON.parse(fills.stdout)).toMatchObject({ address: TRADER, scanned: 328, count: 56 });
    const bad = await runCli(['fills', '0x123'], config, tools);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: 'bad_input' });
    expect(bad.stderr).not.toContain('0x123');
    expect((await runCli(['fills'], config, tools)).exitCode).toBe(1);
    const orders = await runCli(['open-orders', MAKER], config, tools);
    expect(orders.exitCode, orders.stderr).toBe(0);
    expect(JSON.parse(orders.stdout)).toMatchObject({ address: MAKER, source: 'frontendOpenOrders', count: 1 });
    const open = await runCli(['order-status', MAKER, '55896593277'], config, tools);
    expect(open.exitCode, open.stderr).toBe(0);
    expect(JSON.parse(open.stdout)).toMatchObject({ oid: 55896593277, status: 'open', order: { coin: '#104740', tif: 'Gtc' } });
    const byCloid = await runCli(['order-status', TRADER, '0xa638f7c5c92a6ac186872360e3086040'], config, tools);
    expect(byCloid.exitCode, byCloid.stderr).toBe(0);
    expect(JSON.parse(byCloid.stdout)).toMatchObject({ oid: '0xa638f7c5c92a6ac186872360e3086040', status: 'filled' });
    const unknown = await runCli(['order-status', MAKER, '1'], config, tools);
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stderr)).toMatchObject({ error: 'not_found' });
    const missing = await runCli(['order-status', MAKER], config, tools);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('<oid> is required');
    expect((await runCli(['order-status', MAKER, 'abc'], config, tools)).exitCode).toBe(1);
  });
  it('reports builder approval status with a next step', async () => {
    const yes = JSON.parse((await runCli(['builder-status', APPROVED], config, tools)).stdout) as { approved: boolean };
    const no = JSON.parse((await runCli(['builder-status', UNAPPROVED], config, tools)).stdout) as { approved: boolean; nextStep: string };
    expect(yes.approved).toBe(true);
    expect(no.approved).toBe(false);
    expect(no.nextStep).toContain('MAIN wallet');
  });
});

describe('MCP streamable HTTP body parsing (no port bound)', () => {
  it('answers a malformed POST body with 400 and a JSON-RPC parse error instead of throwing', () => {
    const r = parseJsonBody('{not json');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected a parse failure');
    expect(r.status).toBe(400);
    expect(JSON.parse(r.response)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect((JSON.parse(r.response) as { error: { message: string } }).error.message).toMatch(/^Parse error: /);
  });
  it('treats an empty body as absent and returns parsed JSON otherwise', () => {
    expect(parseJsonBody('')).toEqual({ ok: true, body: undefined });
    expect(parseJsonBody('{"jsonrpc":"2.0","method":"ping","id":1}')).toEqual({ ok: true, body: { jsonrpc: '2.0', method: 'ping', id: 1 } });
    expect(parseJsonBody('null')).toEqual({ ok: true, body: null });
  });
});

describe('MCP streamable HTTP request handler (ephemeral port): a failing request is answered once and never ends the process', () => {
  const PING = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
  const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  async function serve(open: RequestHandlerOptions['open']) {
    const lines: string[] = [];
    const server = createHttpServer(createRequestHandler({ health: () => ({ ok: true }), open, log: (line) => lines.push(line) }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, lines, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  it('a session that cannot be opened is answered with one HTTP 500 JSON-RPC error, logged once, and the server keeps serving', async () => {
    let opened = 0;
    const s = await serve(async () => {
      opened += 1;
      throw new Error('connect failed');
    });
    try {
      const r = await fetch(`${s.url}/mcp`, { method: 'POST', headers: HEADERS, body: PING });
      expect(r.status).toBe(500);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(await r.text()).toBe(INTERNAL_ERROR_RESPONSE);
      expect(JSON.parse(INTERNAL_ERROR_RESPONSE)).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      expect(s.lines).toEqual(['verdict-mcp: request failed: connect failed']);
      const health = await fetch(`${s.url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const again = await fetch(`${s.url}/mcp`, { method: 'POST', headers: HEADERS, body: PING });
      expect(again.status).toBe(500);
      expect(opened).toBe(2);
      expect(s.lines).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
  it('a transport that fails after the headers went out gets the response ended, not a second answer; a failing close is only logged', async () => {
    const s = await serve(async () => ({
      handleRequest: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        throw new Error('mid-stream');
      },
      close: async () => {
        throw new Error('close failed');
      },
    }));
    try {
      const r = await fetch(`${s.url}/mcp`, { method: 'POST', headers: HEADERS, body: PING });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('{"partial":');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(s.lines).toEqual(['verdict-mcp: request failed: mid-stream', 'verdict-mcp: session close failed: close failed']);
    } finally {
      await s.close();
    }
  });
  it('with the real server and transport, a valid-JSON body that is not an MCP message is refused by the transport (4xx), not the crash path, and a malformed body is 400', async () => {
    const s = await serve(async () => {
      const server = createServer(config, tools);
      const transport = new StreamableHTTPServerTransport({});
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      return {
        handleRequest: (req, res, body) => transport.handleRequest(req, res, body),
        close: async () => {
          await Promise.all([transport.close(), server.close()]);
        },
      };
    });
    try {
      const notMcp = await fetch(`${s.url}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ hello: 1 }) });
      expect(notMcp.status).toBeGreaterThanOrEqual(400);
      expect(notMcp.status).toBeLessThan(500);
      expect((await notMcp.json()) as { error: unknown }).toMatchObject({ jsonrpc: '2.0', error: {} });
      const malformed = await fetch(`${s.url}/mcp`, { method: 'POST', headers: HEADERS, body: '{not json' });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
      const ping = await fetch(`${s.url}/mcp`, { method: 'POST', headers: HEADERS, body: PING });
      expect(ping.status).toBe(200);
      const nowhere = await fetch(`${s.url}/nowhere`);
      expect(nowhere.status).toBe(404);
      expect(s.lines).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe('MCP face', () => {
  async function connect() {
    const server = createServer(config, tools);
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { server, client };
  }
  it('exposes the seventeen tools with read-only annotations on the read tools', async () => {
    const { client } = await connect();
    const { tools: listed } = await client.listTools();
    const names = listed.map((t) => t.name).sort();
    expect(names).toEqual(['approve_builder_fee_payload', 'build_order', 'builder_status', 'candles', 'compare_market', 'fair_value', 'fills', 'find_hedges', 'get_market', 'list_markets', 'open_orders', 'opportunities', 'order_status', 'orderbook', 'positions', 'quote', 'recent_trades']);
    const byName = new Map(listed.map((t) => [t.name, t]));
    expect(byName.get('quote')?.annotations?.readOnlyHint).toBe(true);
    for (const name of ['recent_trades', 'candles', 'fills', 'open_orders', 'order_status']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.description, name).toContain('Read only');
    }
    const candles = byName.get('candles')?.inputSchema as { properties?: { interval?: { enum?: string[] } } } | undefined;
    expect(candles?.properties?.interval?.enum).toEqual(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']);
    expect(byName.get('build_order')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('build_order')?.description).toContain('wait for an explicit yes');
  });
  it('quote and build_order return structured content; errors are flagged not thrown', async () => {
    const { client } = await connect();
    const q = await client.callTool({ name: 'quote', arguments: { outcome: 1210, side: 'yes', action: 'buy', size: 10 } });
    expect(q.isError).toBeFalsy();
    const structured = q.structuredContent as { complete: boolean } | undefined;
    expect(structured?.complete).toBe(true);
    const built = await client.callTool({ name: 'build_order', arguments: { outcome: 1210, side: 'yes', action: 'buy', price: '0.02', size: '3' } });
    const action = (built.structuredContent as { action: { builder: { f: number } } }).action;
    expect(action.builder.f).toBe(10);
    const missing = await client.callTool({ name: 'get_market', arguments: { outcome: 999999 } });
    expect(missing.isError).toBe(true);
    const text = (missing.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
  });
  it('the trade and order tools answer structured content; an interval outside the venue set never reaches the tool', async () => {
    const { client } = await connect();
    const trades = await client.callTool({ name: 'recent_trades', arguments: { outcome: 1210 } });
    expect(trades.isError).toBeFalsy();
    expect(trades.structuredContent).toMatchObject({ coin: '#12100', side: 0, count: 10 });
    const candles = await client.callTool({ name: 'candles', arguments: { outcome: 1210, side: 'yes', interval: '1h', lookbackMinutes: 1440 } });
    expect(candles.isError).toBeFalsy();
    expect(candles.structuredContent).toMatchObject({ interval: '1h', count: 24 });
    // The MCP input schema is the venue's interval list, so a bad interval is refused by the SDK before the tool runs (an error result or a JSON-RPC error, by SDK version).
    const refused = await client.callTool({ name: 'candles', arguments: { outcome: 1210, side: 'yes', interval: '7m', lookbackMinutes: 60 } }).then((r) => r.isError === true, () => true);
    expect(refused).toBe(true);
    const fills = await client.callTool({ name: 'fills', arguments: { address: TRADER } });
    expect(fills.structuredContent).toMatchObject({ count: 56 });
    const orders = await client.callTool({ name: 'open_orders', arguments: { address: MAKER } });
    expect(orders.structuredContent).toMatchObject({ source: 'frontendOpenOrders', count: 1 });
    const status = await client.callTool({ name: 'order_status', arguments: { address: TRADER, oid: '0xa638f7c5c92a6ac186872360e3086040' } });
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toMatchObject({ status: 'filled', order: { tif: 'Ioc' } });
    const unknown = await client.callTool({ name: 'order_status', arguments: { address: MAKER, oid: 1 } });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse((unknown.content as { text: string }[])[0]?.text ?? '')).toMatchObject({ error: 'not_found' });
  });
});

describe('MCP prompts and resources', () => {
  async function connect() {
    const server = createServer(config, tools);
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { server, client };
  }
  it('lists the four prompts with their argument schemas and names them, and the resources, in the instructions', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['hedge_check', 'market_brief', 'prepare_order', 'scan_and_compare']);
    const args = (name: string) => Object.fromEntries((prompts.find((p) => p.name === name)?.arguments ?? []).map((a) => [a.name, a.required]));
    expect(args('scan_and_compare')).toEqual({ limit: false });
    expect(args('market_brief')).toEqual({ outcome: true });
    expect(args('hedge_check')).toEqual({ address: true });
    expect(args('prepare_order')).toEqual({ outcome: true, side: true, action: true, size: true, price: false });
    for (const p of prompts) {
      expect(p.description, p.name).toBeTruthy();
      for (const a of p.arguments ?? []) expect(a.description, `${p.name}.${a.name}`).toBeTruthy();
    }
    const instructions = client.getInstructions() ?? '';
    for (const name of ['scan_and_compare', 'market_brief', 'hedge_check', 'prepare_order', 'verdict://markets', 'verdict://market/{outcome}']) expect(instructions).toContain(name);
  });
  it('renders each prompt with sample arguments naming the tools in order; prepare_order carries the two-message rule and never says to sign', async () => {
    const { client } = await connect();
    const text = async (name: string, args: Record<string, string>) => {
      const r = await client.getPrompt({ name, arguments: args });
      expect(r.messages).toHaveLength(1);
      const c = r.messages[0]?.content as { type: string; text: string };
      expect(c.type).toBe('text');
      return c.text;
    };
    const scan = await text('scan_and_compare', { limit: '3' });
    expect(scan).toContain('opportunities with limit 3');
    expect(scan.indexOf('opportunities')).toBeLessThan(scan.indexOf('compare_market'));
    expect(scan).toContain('mainnet, venue out');
    expect(scan).toContain('Never subtract two prices yourself');
    expect(await text('scan_and_compare', {})).toContain('opportunities with limit 8');
    const brief = await text('market_brief', { outcome: '1210' });
    let last = -1;
    for (const tool of ['get_market', 'orderbook', 'recent_trades', 'compare_market', 'fair_value', 'find_hedges']) {
      const i = brief.indexOf(tool);
      expect(i, tool).toBeGreaterThan(last);
      last = i;
    }
    expect(brief).toContain('market 1210');
    expect(brief).toContain('settlement rule verbatim');
    const hedge = await text('hedge_check', { address: TRADER });
    expect(hedge).toContain(`positions with address ${TRADER}`);
    expect(hedge.indexOf('positions')).toBeLessThan(hedge.indexOf('find_hedges'));
    expect(hedge).toContain('never build a perp or spot order');
    const order = await text('prepare_order', { outcome: '1210', side: 'yes', action: 'buy', size: '250' });
    expect(order.indexOf('Call quote')).toBeLessThan(order.indexOf('Call build_order'));
    expect(order).toContain('buy 250 YES on market 1210');
    expect(order).toContain('size "250"');
    expect(order).toContain("the quote's worstPrice");
    expect(order).toContain(TWO_MESSAGE_RULE);
    for (const phrase of ['UNSIGNED', 'END YOUR MESSAGE', 'NEW message', 'Never fabricate the confirmation', 'no yes flag', 'cents per $1,000', 'builder address', 'settlement rule']) {
      expect(order, phrase).toContain(phrase);
    }
    // The prompt repeats that nothing is signed; it never instructs the agent to sign or submit.
    expect(order).not.toMatch(/\b(then|now|and|please|may|can|should) sign\b|\bsign (it|the (order|payload|action)|and submit)\b|\bsubmit (it|the order)\b/i);
    const priced = await text('prepare_order', { outcome: '1210', side: 'no', action: 'sell', size: '3', price: '0.97' });
    expect(priced).toContain('sell 3 NO on market 1210');
    expect(priced).toContain('price "0.97"');
  });
  it('refuses a malformed prompt argument before any text is rendered', async () => {
    const { client } = await connect();
    const bad: [string, Record<string, string>][] = [
      ['market_brief', { outcome: '12a' }],
      ['market_brief', { outcome: '1234567890' }],
      ['market_brief', {}],
      ['hedge_check', { address: '0x1234' }],
      ['hedge_check', { address: `${TRADER}0` }],
      ['prepare_order', { outcome: '1210', side: 'yes', action: 'buy', size: '0' }],
      ['prepare_order', { outcome: '1210', side: 'yes', action: 'buy', size: '2.5' }],
      ['prepare_order', { outcome: '1210', side: 'maybe', action: 'buy', size: '1' }],
      ['prepare_order', { outcome: '1210', side: 'yes', action: 'hold', size: '1' }],
      ['prepare_order', { outcome: '1210', side: 'yes', action: 'buy', size: '1', price: '1.5' }],
      ['prepare_order', { outcome: '1210', side: 'yes', action: 'buy', size: '1', price: '0.000000' }],
      ['scan_and_compare', { limit: '9' }],
      ['scan_and_compare', { limit: '0' }],
      ['scan_and_compare', { limit: 'all' }],
    ];
    for (const [name, args] of bad) await expect(client.getPrompt({ name, arguments: args }), `${name} ${JSON.stringify(args)}`).rejects.toThrow(/Invalid arguments/);
  });
  it('serves the market list and one market as JSON resources, read through the stubbed client, and the template resolves an outcome', async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    expect(resources).toEqual([expect.objectContaining({ uri: 'verdict://markets', name: 'markets', mimeType: 'application/json' })]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toEqual([expect.objectContaining({ uriTemplate: 'verdict://market/{outcome}', name: 'market', mimeType: 'application/json' })]);
    const list = await client.readResource({ uri: 'verdict://markets' });
    expect(list.contents).toHaveLength(1);
    const listContent = list.contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(listContent.uri).toBe('verdict://markets');
    expect(listContent.mimeType).toBe('application/json');
    const parsed = JSON.parse(listContent.text ?? '') as { network: string; venue: string | null; count: number; markets: unknown[] };
    expect(parsed).toEqual(await tools.list_markets({}));
    expect(parsed.network).toBe('mainnet');
    expect(parsed.venue).toBe('out');
    expect(parsed.count).toBe(parsed.markets.length);
    const one = await client.readResource({ uri: 'verdict://market/1210' });
    const oneContent = one.contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(oneContent.uri).toBe('verdict://market/1210');
    expect(oneContent.mimeType).toBe('application/json');
    const market = JSON.parse(oneContent.text ?? '') as { outcome: number; settlementRule: string | null };
    expect(market.outcome).toBe(1210);
    expect(market).toHaveProperty('settlementRule');
    expect(market).toEqual(await tools.get_market({ outcome: 1210 }));
    await expect(client.readResource({ uri: 'verdict://market/999999' })).rejects.toThrow(/not_found/);
    await expect(client.readResource({ uri: 'verdict://market/abc' })).rejects.toThrow(/bad_input/);
    await expect(client.readResource({ uri: 'verdict://nothing' })).rejects.toThrow(/not found/);
  });
});

describe('operator configuration', () => {
  it('rejects a bad builder fee even when no builder address is set', async () => {
    const { configFromEnv } = await import('../packages/core/src/index.js');
    expect(() => configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_BUILDER_FEE_TENTHS_BP: 'abc' })).toThrow(/VERDICT_BUILDER_FEE_TENTHS_BP/);
    expect(() => configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_BUILDER_FEE_TENTHS_BP: '1.5' })).toThrow(/VERDICT_BUILDER_FEE_TENTHS_BP/);
    expect(configFromEnv({ VERDICT_NETWORK: 'testnet' }).builder).toBeNull();
    expect(configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_BUILDER_ADDRESS: '0x00000000000000000000000000000000000000b1', VERDICT_BUILDER_FEE_TENTHS_BP: '7' }).builder).toEqual({ address: '0x00000000000000000000000000000000000000b1', feeTenthsBp: 7 });
  });
});
