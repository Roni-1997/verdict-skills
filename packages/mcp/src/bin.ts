#!/usr/bin/env node
// verdict-mcp: stdio by default (Claude Desktop, Cursor, local agents); --http <port> serves streamable HTTP
// for hosted agents. Stateless: one transport per request, no sessions, no keys.
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type KitConfig, configFromEnv } from '@verdict/core';
import { createRequestHandler, healthBody, listenLine } from './http.js';
import { createServer } from './server.js';

const { values } = parseArgs({
  options: {
    http: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    [
      'verdict-mcp: Verdict HIP-4 tools as an MCP server',
      '',
      '  verdict-mcp                 stdio transport (default)',
      '  verdict-mcp --http 8787     streamable HTTP on 127.0.0.1:8787/mcp',
      '  verdict-mcp --http 8787 --host 0.0.0.0',
      '',
      'Environment: VERDICT_NETWORK (testnet|mainnet), VERDICT_VENUE (a deployer venue; unset, blank or all: every deployer), VERDICT_BUILDER_ADDRESS, VERDICT_BUILDER_FEE_TENTHS_BP',
      'Hosted mode: VERDICT_API_URL=https://hyperverdict.xyz/api/v1 answers list_markets, get_market, compare_market, fair_value, find_hedges',
      '          and opportunities from the Verdict API instead of the embedded engine; set it on every --http deployment so the server',
      '          fetches no venue itself. The other tools run in process against Hyperliquid. The server holds no keys in either mode.',
      "Optional: ODDPOOL_API_KEY routes the engine's Polymarket and Kalshi reads through api.oddpool.com; the key is sent to OddPool on every compare_market",
      '          and opportunities call, so never set it on a hosted (--http) server.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// An invalid VERDICT_NETWORK or VERDICT_BUILDER_FEE_TENTHS_BP is one JSON error line and exit 4 (not configured),
// the same as the CLI, not a stack trace.
let config: KitConfig;
try {
  config = configFromEnv();
} catch (e) {
  process.stderr.write(`${JSON.stringify({ error: 'not_configured', message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(4);
}

if (values.http === undefined) {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
} else {
  const port = Number(values.http);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`invalid --http port ${JSON.stringify(values.http)}\n`);
    process.exit(1);
  }
  const handler = createRequestHandler({
    health: () => healthBody(config),
    open: async () => {
      const server = createServer(config);
      // Stateless: no session ids, one transport per request. The SDK's option type marks
      // sessionIdGenerator optional, so pass an options object without the key.
      const transport = new StreamableHTTPServerTransport({});
      // The SDK's Transport interface declares optional callbacks without `| undefined`; under
      // exactOptionalPropertyTypes the class instance is not assignable, so widen once here.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      return {
        handleRequest: (req, res, body) => transport.handleRequest(req, res, body),
        close: async () => {
          await Promise.all([transport.close(), server.close()]);
        },
      };
    },
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const httpServer = createHttpServer(handler);
  httpServer.listen(port, values.host, () => {
    process.stderr.write(`${listenLine(config, values.host, port)}\n`);
  });
}
