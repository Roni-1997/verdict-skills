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
import { createServer } from '../packages/mcp/src/server.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | undefined>;
    const type = body.type ?? '';
    const key = type === 'l2Book' ? `l2Book:${body.coin ?? ''}` : type === 'maxBuilderFee' ? `maxBuilderFee:${body.user ?? ''}` : type;
    if (!(key in routes)) return new Response('null', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const APPROVED = '0x00000000000000000000000000000000000000a1';
const UNAPPROVED = '0x00000000000000000000000000000000000000a2';

const routes = {
  outcomeMeta: fixture('mainnet_outcomeMeta'),
  outcomeTemplates: fixture('mainnet_outcomeTemplates'),
  'l2Book:#12100': fixture('mainnet_l2Book_12100'),
  'l2Book:#12101': fixture('mainnet_l2Book_12101'),
  spotClearinghouseState: fixture('testnet_spotClearinghouseState_subdeployer'),
  [`maxBuilderFee:${APPROVED}`]: 10,
  [`maxBuilderFee:${UNAPPROVED}`]: 0,
};

const config: KitConfig = { network: 'mainnet', venue: 'out', builder: { address: '0x00000000000000000000000000000000000000b1', feeTenthsBp: 10 } };
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
  it('exposes the twelve tools with read-only annotations on the read tools', async () => {
    const { client } = await connect();
    const { tools: listed } = await client.listTools();
    const names = listed.map((t) => t.name).sort();
    expect(names).toEqual(['approve_builder_fee_payload', 'build_order', 'builder_status', 'compare_market', 'fair_value', 'find_hedges', 'get_market', 'list_markets', 'opportunities', 'orderbook', 'positions', 'quote']);
    const byName = new Map(listed.map((t) => [t.name, t]));
    expect(byName.get('quote')?.annotations?.readOnlyHint).toBe(true);
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
});
