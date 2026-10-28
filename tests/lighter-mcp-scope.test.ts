import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { type ExecutionClient, prepareExecution } from '../packages/core/src/index.js';
import { createLocalExecutionServer } from '../packages/mcp/src/execution.js';
import { createServer } from '../packages/mcp/src/index.js';
import { LighterExecutionProposal, requireLighterProposal } from '../packages/mcp/src/lighter-execution-boundary.js';

const common = { title: 'Scope test', settlementRule: 'Synthetic oracle closing value exceeds 100.', side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1' };
const lighter = { ...common, venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 2, market: 123, creator: 7, tif: 'ioc' };
const hl = { ...common, venue: 'hl', network: 'testnet', account: `0x${'1'.repeat(40)}`, outcome: 123, tif: 'Ioc', builder: { address: `0x${'2'.repeat(40)}`, feeTenthsBp: 0 }, allInFeeBpsCap: '10' };
const polymarket = { ...common, venue: 'polymarket', network: 'polygon', account: `0x${'1'.repeat(40)}`, marketId: '123', assetId: '123', tif: 'FAK' };
const request = (legs: unknown[]) => ({ legs, policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' }, ...(legs.length === 2 ? { settlementReview: { relationship: 'same_event_same_orientation', notes: 'Legacy synthetic paired request; reject before effects.' } } : {}) });

it('public MCP factory defaults to Lighter', async () => {
  const server = createServer(); const client = new Client({ name: 'factory-scope', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    expect((await client.listTools()).tools.every((tool) => tool.name.startsWith('lighter_'))).toBe(true);
  } finally { await client.close(); await server.close(); }
});

it('every local execution input rejects unsupported venues and pairs before broker effects', async () => {
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Broker must not be called'); });
  const broker: ExecutionClient = { mode: 'policy', capabilities: forbidden, inspectConnection: forbidden, preflight: forbidden, submit: forbidden, status: forbidden, cancel: forbidden };
  const server = createLocalExecutionServer(broker); const client = new Client({ name: 'execution-scope', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools;
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/"const":"(?:hl|polymarket)"/);
    for (const legs of [[hl], [polymarket], [lighter, { ...hl, side: 'no' }], [lighter, lighter]]) {
      expect((await client.callTool({ name: 'execution_prepare', arguments: request(legs) })).isError).toBe(true);
      // A valid canonical single-Lighter proposal is the baseline; legacy shapes cannot enter any lifecycle tool.
      const original = prepareExecution(request([lighter]));
      const invalid = legs.length === 1 || legs[1] === undefined || legs[1] !== lighter
        ? prepareExecution(request(legs)) : { ...original, payload: { ...original.payload, legs } };
      for (const name of ['execution_review', 'execution_preflight', 'execution_submit', 'execution_status']) {
        expect((await client.callTool({ name, arguments: invalid })).isError).toBe(true);
      }
      expect((await client.callTool({ name: 'execution_cancel', arguments: { proposal: invalid, leg: 0 } })).isError).toBe(true);
    }
    expect(forbidden).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});

it('Lighter scope validation preserves canonical identity even after expiry', () => {
  const original = prepareExecution(request([lighter]), 1_792_623_100_000, '0189d5e0-1c82-4be1-a667-f5fa7b430171');
  // Recorded from the pre-scope core at commit 3c24c77, with the same fixed input/time/request UUID.
  expect(original.digest).toBe('1bdc822f28cfd6f5894199409481b4b82b138c9b19641dccfd1809b0243beba7');
  expect(requireLighterProposal(original)).toEqual(original);
  expect(LighterExecutionProposal.parse(original)).toEqual(original);
  expect(original.payload.expiresAt).toBeLessThan(Date.now());
});
