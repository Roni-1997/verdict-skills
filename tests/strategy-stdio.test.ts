import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { configFromEnv, createTools, createLighterTools, LighterClient } from '../packages/core/src/index.js';

const bin = fileURLToPath(new URL('../packages/mcp/dist/bin.js', import.meta.url));
const open = (hl = 'testnet', lighter = 'devnet') => new StdioClientTransport({ command: process.execPath, args: [bin, '--strategy'], env: { VERDICT_NETWORK: hl, LIGHTER_NETWORK: lighter }, stderr: 'pipe' });

it('built strategy MCP replays offline inputs and rejects conflicting modes', async () => {
  const request = z.record(z.unknown()).parse(JSON.parse(readFileSync(new URL('../examples/strategy/assessment.json', import.meta.url), 'utf8')));
  const transport = open(); const client = new Client({ name: 'strategy-stdio-proof', version: '1' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(7);
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/"items":\[/);
    const assessment = await client.callTool({ name: 'strategy_assess_pair', arguments: request });
    expect(assessment.isError).not.toBe(true);
    expect(assessment.structuredContent).toMatchObject({ kind: 'conditional_plan', liveReady: false, selectedDirection: 'hl_yes' });
    const originalSnapshot = z.record(z.unknown()).parse(request.snapshot);
    const originalHl = z.record(z.unknown()).parse(originalSnapshot.hl);
    const invalidSides = { ...request, snapshot: { ...originalSnapshot, hl: { ...originalHl, sideNames: ['yes'] } } };
    expect((await client.callTool({ name: 'strategy_assess_pair', arguments: invalidSides })).isError).toBe(true);
    const paper = await client.callTool({ name: 'strategy_paper_pair', arguments: { ...request, direction: 'hl_yes', fills: { hl: '9', lighter: '0' } } });
    expect(paper.isError).not.toBe(true);
    expect(paper.structuredContent).toMatchObject({ kind: 'paper_result', strandedShares: { hl: '9', lighter: '0' }, conditionalSettlement: { floorPnlUSDC: '-3.87387' } });
    const forged = await client.callTool({ name: 'strategy_paper_pair', arguments: { ...request, direction: 'hl_yes', fills: { hl: '9', lighter: '9' }, plan: { allInCostUSDC: '0' } } });
    expect(forged.isError).toBe(true);
  } finally { await client.close(); }
  const conflict = spawnSync(process.execPath, [bin, '--strategy', '--lighter'], { encoding: 'utf8' });
  expect(conflict.status).toBe(1); expect(JSON.parse(conflict.stderr).error).toBe('bad_input');
});

it.skipIf(process.env.VERDICT_STRATEGY_LIVE !== '1')('built strategy MCP captures real public mainnet books and keeps an unreviewed pair blocked', async () => {
  const hl = createTools(configFromEnv({ VERDICT_NETWORK: 'mainnet' }));
  const lighter = createLighterTools(new LighterClient({ network: 'mainnet', creators: [] }));
  const [hlList, lList] = await Promise.all([hl.list_markets({}), lighter.list_markets({ limit: 100 })]);
  const h = hlList.markets.find((m) => m.templateId === 'binaryPrice' && m.underlying === 'BTC');
  const l = lList.markets[0];
  if (!h || !l) throw new Error('Live mainnet discovery did not supply public demonstration markets');
  const client = new Client({ name: 'strategy-live-read-proof', version: '1' }); const transport = open('mainnet', 'mainnet');
  try {
    await client.connect(transport);
    const captured = await client.callTool({ name: 'strategy_snapshot', arguments: { outcome: h.outcome, market: l.market_id } });
    expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
    const data = z.object({ kind: z.literal('paired_books'), hl: z.object({ network: z.literal('mainnet') }), lighter: z.object({ network: z.literal('mainnet'), sourceAt: z.null() }) }).parse(captured.structuredContent);
    expect(data.kind).toBe('paired_books');
    const assessment = await client.callTool({ name: 'strategy_assess_pair', arguments: { snapshot: captured.structuredContent, at: Date.now(), shares: '1', policy: { maxCapitalUSDC: '100', maxUnhedgedLossUSDC: '100' } } });
    expect(assessment.isError).not.toBe(true); expect(assessment.structuredContent).toMatchObject({ kind: 'blocked', liveReady: false, settlementVerification: 'not_verified' });
  } finally { await client.close(); }
}, 60_000);
