#!/usr/bin/env node
// verdict-mcp: stdio by default (Claude Desktop, Cursor, local agents); --http <port> serves streamable HTTP
// for hosted agents. Stateless: one transport per request, no sessions, no keys.
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { configFromEnv } from '@verdict/core';
import { parseJsonBody } from './http.js';
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
      'Environment: VERDICT_NETWORK (testnet|mainnet), VERDICT_VENUE, VERDICT_BUILDER_ADDRESS, VERDICT_BUILDER_FEE_TENTHS_BP',
      "Optional: ODDPOOL_API_KEY routes the engine's Polymarket and Kalshi reads through api.oddpool.com; the key is sent to OddPool on every compare_market",
      '          and opportunities call, so never set it on a hosted (--http) server.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const config = configFromEnv();

if (values.http === undefined) {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
} else {
  const port = Number(values.http);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`invalid --http port ${JSON.stringify(values.http)}\n`);
    process.exit(1);
  }
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, network: config.network, venue: config.venue }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = parseJsonBody(Buffer.concat(chunks).toString('utf8'));
      if (!parsed.ok) {
        res.writeHead(parsed.status, { 'content-type': 'application/json' });
        res.end(parsed.response);
        return;
      }
      body = parsed.body;
    }
    const server = createServer(config);
    // Stateless: no session ids, one transport per request. The SDK's option type marks
    // sessionIdGenerator optional, so pass an options object without the key.
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The SDK's Transport interface declares optional callbacks without `| undefined`; under
    // exactOptionalPropertyTypes the class instance is not assignable, so widen once here.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, body);
  };
  // One failing request must not end the process: a rejection here would otherwise be unhandled.
  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      process.stderr.write(`verdict-mcp: request failed: ${e instanceof Error ? e.message : String(e)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      } else {
        res.end();
      }
    });
  });
  httpServer.listen(port, values.host, () => {
    process.stderr.write(`verdict-mcp listening on http://${values.host}:${port}/mcp (${config.network}${config.venue ? `, venue ${config.venue}` : ''})\n`);
  });
}
