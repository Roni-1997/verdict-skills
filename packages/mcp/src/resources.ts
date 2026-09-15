// The MCP resources: the live market list and one market with its settlement rule, as JSON. Read only, no
// account, no key. Both are thin over the same core tools the list_markets and get_market tools call, so the
// configured network and venue apply and the JSON is the tool result field for field.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_OUTCOME, ToolError, type Tools, UpstreamError } from '@verdict/core';

export const MARKETS_URI = 'verdict://markets';
export const MARKET_URI_TEMPLATE = 'verdict://market/{outcome}';
const JSON_MIME = 'application/json';

export const RESOURCE_DOCS = {
  markets: {
    title: 'Verdict markets',
    description: 'The live outcome markets for the configured network and venue, each with the settlement rule it resolves on: the list_markets result as JSON. Read only. No account needed.',
    mimeType: JSON_MIME,
  },
  market: {
    title: 'One Verdict market',
    description: 'One outcome market by index with its sides, coins, asset ids, settlement rule, expiry and fee scale: the get_market result as JSON. Read only. No account needed.',
    mimeType: JSON_MIME,
  },
} as const;

/** Compact JSON: the catalogue can run to a few hundred markets, and a resource is read whole. */
function jsonContents(uri: URL, value: unknown): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(value) }] };
}

/** A resource read answers a JSON-RPC error, not a tool-style error body: map the kit's errors onto the MCP codes. */
export function toMcpError(e: unknown): McpError {
  if (e instanceof McpError) return e;
  if (e instanceof ToolError) return new McpError(e.code === 'upstream' ? ErrorCode.InternalError : ErrorCode.InvalidParams, `${e.code}: ${e.message}`);
  if (e instanceof UpstreamError) return new McpError(ErrorCode.InternalError, `upstream (${e.kind}): ${e.message}`);
  return new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
}

/** The {outcome} variable of the template: 1 to 9 digits, the tools' rule (checkOutcome), checked before any request. */
export function parseOutcomeVariable(value: string | string[] | undefined): number {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string' || !/^\d{1,9}$/.test(v) || Number(v) > MAX_OUTCOME) {
    throw new McpError(ErrorCode.InvalidParams, `bad_input: outcome must be a nonnegative integer of at most 9 digits, got ${JSON.stringify(String(v ?? '').slice(0, 16))}`);
  }
  return Number(v);
}

/** Registers verdict://markets and the verdict://market/{outcome} template over the given tools. */
export function registerResources(server: McpServer, tools: Tools): void {
  server.registerResource('markets', MARKETS_URI, RESOURCE_DOCS.markets, async (uri) => {
    try {
      return jsonContents(uri, await tools.list_markets({}));
    } catch (e) {
      throw toMcpError(e);
    }
  });
  server.registerResource('market', new ResourceTemplate(MARKET_URI_TEMPLATE, { list: undefined }), RESOURCE_DOCS.market, async (uri, variables) => {
    const outcome = parseOutcomeVariable(variables.outcome);
    try {
      return jsonContents(uri, await tools.get_market({ outcome }));
    } catch (e) {
      throw toMcpError(e);
    }
  });
}
