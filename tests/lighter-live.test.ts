// Read-only proof of the built MCP binary against public Lighter mainnet data. No account/key or writes.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

it.skipIf(process.env.VERDICT_LIGHTER_LIVE !== '1')('built Lighter MCP serves live public market data over stdio', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../packages/mcp/dist/bin.js', import.meta.url)), '--lighter'],
    env: { LIGHTER_NETWORK: 'mainnet', LIGHTER_CREATORS: '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verdict-lighter-live-proof', version: '1.0' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(9);
    const listed = await client.callTool({ name: 'lighter_list_markets', arguments: { limit: 100 } });
    expect(listed.isError).not.toBe(true);
    const data = z.object({ network: z.literal('mainnet'), markets: z.array(z.object({ market_id: z.number() })).nonempty() }).parse(listed.structuredContent);
    const market = data.markets[0].market_id;
    for (const name of ['get_market', 'orderbook', 'recent_trades']) {
      const result = await client.callTool({ name: `lighter_${name}`, arguments: { market } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ network: 'mainnet', exchange: 'lighter' });
    }
    const fees = await client.callTool({ name: 'lighter_fee_schedule', arguments: {} });
    expect(fees.isError, JSON.stringify(fees)).not.toBe(true);
    expect(z.object({ bo_tiers: z.array(z.unknown()).nonempty() }).safeParse(fees.structuredContent).success).toBe(true);
  } finally { await client.close(); }
}, 60_000);
