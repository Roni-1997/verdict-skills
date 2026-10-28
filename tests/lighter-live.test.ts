// Read-only proof of the built MCP binary on both Lighter networks. No account/key or writes.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

it.skipIf(process.env.VERDICT_LIGHTER_LIVE !== '1').each(['devnet', 'mainnet'] as const)('built Lighter MCP serves live public %s market data over stdio', async (network) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../packages/mcp/dist/bin.js', import.meta.url)), '--lighter'],
    env: { LIGHTER_NETWORK: network, LIGHTER_CREATORS: '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verdict-lighter-live-proof', version: '1.0' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(9);
    const listed = await client.callTool({ name: 'lighter_list_markets', arguments: { limit: 100 } });
    expect(listed.isError).not.toBe(true);
    const data = z.object({ network: z.literal(network), markets: z.tuple([z.object({ market_id: z.number() })]).rest(z.object({ market_id: z.number() })) }).parse(listed.structuredContent);
    const market = data.markets[0].market_id;
    for (const name of ['get_market', 'orderbook', 'recent_trades']) {
      const result = await client.callTool({ name: `lighter_${name}`, arguments: { market } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ network, exchange: 'lighter' });
    }
    const fees = await client.callTool({ name: 'lighter_fee_schedule', arguments: {} });
    expect(fees.isError, JSON.stringify(fees)).not.toBe(true);
    const feeResult = z.discriminatedUnion('available', [
      z.object({ available: z.literal(true), bo_tiers: z.array(z.unknown()).nonempty() }),
      z.object({ available: z.literal(false), network: z.literal('devnet'), bo_tiers: z.null(), reason: z.string().min(1) }),
    ]).parse(fees.structuredContent);
    if (network === 'mainnet') expect(feeResult.available).toBe(true);
  } finally { await client.close(); }
}, 60_000);
