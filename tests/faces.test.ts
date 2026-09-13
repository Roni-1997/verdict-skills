// The CLI and the MCP server are thin faces over the same tool module: prove both against the recorded
// fixtures through a fake fetch, with no network and no keys.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { InfoClient, createTools, type KitConfig } from '../packages/core/src/index.js';
import { runCli } from '../packages/cli/src/index.js';
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
  it('maps tool errors to exit codes and JSON on stderr', async () => {
    expect((await runCli(['market', '999999'], config, tools)).exitCode).toBe(2);
    expect((await runCli(['quote', '1210', '--side', 'yes', '--action', 'hold', '--size', '1'], config, tools)).exitCode).toBe(1);
    const unset = await runCli(['build-order', '1210', '--side', 'yes', '--action', 'buy', '--price', '0.5', '--size', '1'], { ...config, builder: null }, createTools({ ...config, builder: null }, new InfoClient({ network: 'mainnet', fetch: fakeFetch(routes) })));
    expect(unset.exitCode).toBe(4);
    expect(unset.stderr).toContain('VERDICT_BUILDER_ADDRESS');
  });
  it('reports builder approval status with a next step', async () => {
    const yes = JSON.parse((await runCli(['builder-status', APPROVED], config, tools)).stdout) as { approved: boolean };
    const no = JSON.parse((await runCli(['builder-status', UNAPPROVED], config, tools)).stdout) as { approved: boolean; nextStep: string };
    expect(yes.approved).toBe(true);
    expect(no.approved).toBe(false);
    expect(no.nextStep).toContain('MAIN wallet');
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
