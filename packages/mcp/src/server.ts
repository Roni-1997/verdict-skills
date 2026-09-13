// The MCP face: every tool is a thin call into @verdict/core. No keys, no signing, no LLM.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_DOCS, ToolError, UpstreamError, configFromEnv, createTools, type KitConfig, type Tools } from '@verdict/core';

export const SERVER_NAME = 'verdict';
export const SERVER_VERSION = '0.0.0';

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte hex address');
const Side = z.union([z.literal(0), z.literal(1), z.string()]).describe('yes | no | 0 | 1 | a side name');
const Action = z.enum(['buy', 'sell']);

function ok(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> };
}

function fail(e: unknown) {
  const payload =
    e instanceof ToolError
      ? { error: e.code, message: e.message }
      : e instanceof UpstreamError
        ? { error: 'upstream', kind: e.kind, message: e.message }
        : { error: 'internal', message: e instanceof Error ? e.message : String(e) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true as const };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

export function createServer(config: KitConfig = configFromEnv(), tools: Tools = createTools(config)): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        `Verdict HIP-4 outcome markets on Hyperliquid ${config.network}${config.venue ? `, venue ${config.venue}` : ''}.`,
        'Read tools never prompt and need no account. approve_builder_fee_payload and build_order return UNSIGNED payloads only:',
        'show their confirmation lines to the user, stop, and wait for an explicit yes in a new message before anything is signed or submitted.',
        'Never sign on behalf of the user, never fabricate a confirmation, never add a yes flag. Analysis and trading do not happen in the same turn.',
      ].join(' '),
    },
  );

  const annot = (name: keyof Tools) => ({ title: TOOL_DOCS[name].title, readOnlyHint: TOOL_DOCS[name].readOnly, destructiveHint: false, openWorldHint: true });

  server.registerTool(
    'list_markets',
    { description: TOOL_DOCS.list_markets.description, inputSchema: { venue: z.string().optional(), includeExpired: z.boolean().optional() }, annotations: annot('list_markets') },
    (input) => run(() => tools.list_markets(input)),
  );
  server.registerTool(
    'get_market',
    { description: TOOL_DOCS.get_market.description, inputSchema: { outcome: z.number().int().nonnegative() }, annotations: annot('get_market') },
    (input) => run(() => tools.get_market(input)),
  );
  server.registerTool(
    'orderbook',
    { description: TOOL_DOCS.orderbook.description, inputSchema: { outcome: z.number().int().nonnegative() }, annotations: annot('orderbook') },
    (input) => run(() => tools.orderbook(input)),
  );
  server.registerTool(
    'quote',
    {
      description: TOOL_DOCS.quote.description,
      inputSchema: { outcome: z.number().int().nonnegative(), side: Side, action: Action, size: z.number().positive() },
      annotations: annot('quote'),
    },
    (input) => run(() => tools.quote(input)),
  );
  server.registerTool(
    'positions',
    { description: TOOL_DOCS.positions.description, inputSchema: { address: Address }, annotations: annot('positions') },
    (input) => run(() => tools.positions(input)),
  );
  server.registerTool(
    'builder_status',
    { description: TOOL_DOCS.builder_status.description, inputSchema: { address: Address }, annotations: annot('builder_status') },
    (input) => run(() => tools.builder_status(input)),
  );
  server.registerTool(
    'approve_builder_fee_payload',
    { description: TOOL_DOCS.approve_builder_fee_payload.description, inputSchema: {}, annotations: annot('approve_builder_fee_payload') },
    () => run(() => tools.approve_builder_fee_payload({})),
  );
  server.registerTool(
    'build_order',
    {
      description: TOOL_DOCS.build_order.description,
      inputSchema: {
        outcome: z.number().int().nonnegative(),
        side: Side,
        action: Action,
        price: z.string().describe('limit price per token as a decimal string strictly between 0 and 1, e.g. "0.62"'),
        size: z.string().describe('whole number of tokens as a decimal string, e.g. "250"'),
        tif: z.enum(['Gtc', 'Ioc', 'Alo']).optional(),
        cloid: z.string().regex(/^0x[0-9a-fA-F]{32}$/).optional(),
      },
      annotations: annot('build_order'),
    },
    (input) => run(() => tools.build_order({ ...input, cloid: input.cloid as `0x${string}` | undefined })),
  );

  return server;
}
