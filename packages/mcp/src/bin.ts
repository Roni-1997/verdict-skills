#!/usr/bin/env node
// verdict-mcp: stdio by default (Claude Desktop, Cursor, local agents); --http <port> serves streamable HTTP
// for hosted agents. Stateless: one transport per request, no sessions, no keys.
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { configFromEnv } from '@verdict/core';
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
  const httpServer = createHttpServer(async (req, res) => {
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
    let body: unknown = undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      body = text ? JSON.parse(text) : undefined;
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
  });
  httpServer.listen(port, values.host, () => {
    process.stderr.write(`verdict-mcp listening on http://${values.host}:${port}/mcp (${config.network}${config.venue ? `, venue ${config.venue}` : ''})\n`);
  });
}
