#!/usr/bin/env node
// verdict-mcp: stdio by default (Claude Desktop, Cursor, local agents); --http <port> serves streamable HTTP
// for hosted agents. Explicit --hosted-execution adds OAuth, browser consent and durable jobs.
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type ExecutionClient, ExecutionMode, type KitConfig, type LighterConfig, LighterClient, ToolError, configFromEnv, connectExecution, createLighterTools, createStrategyTools, lighterConfigFromEnv } from '@verdict/core';
import { createRequestHandler, healthBody, listenLine } from './http.js';
import { createServer } from './server.js';
import { createLighterServer } from './lighter.js';
import { createStrategyServer } from './strategy.js';
import { createExecutionServer, createLocalExecutionServer } from './execution.js';

const { values } = parseArgs({
  options: {
    lighter: { type: 'boolean', default: false },
    strategy: { type: 'boolean', default: false },
    execution: { type: 'boolean', default: false },
    'local-execution': { type: 'boolean', default: false },
    'hosted-execution': { type: 'boolean', default: false },
    'connector-config': { type: 'string' },
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
      '  verdict-mcp --lighter       Lighter binary outcomes; LIGHTER_NETWORK=devnet|mainnet, LIGHTER_CREATORS=creator indices',
      '  verdict-mcp --strategy      HL/Lighter research, conditional plans, paper fills and inventory reconciliation; no execution',
      '  verdict-mcp --execution     keyless proposal preparation/review for the separate local trading broker',
      '  verdict-mcp --local-execution  SDK lifecycle over operator-owned Unix broker; stdio only; VERDICT_BROKER_SOCKET and VERDICT_EXECUTION_MODE=per_order|policy required',
      '  verdict-mcp --hosted-execution --connector-config private.json --http 8787  authenticated account-linked SDK execution; Node 22.13+',
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
if ([values.lighter, values.strategy, values.execution, values['local-execution'], values['hosted-execution']].filter(Boolean).length > 1) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: 'Choose one MCP server mode: --lighter, --strategy, --execution, --local-execution or --hosted-execution' })}\n`);
  process.exit(1);
}
if (values['local-execution'] && values.http !== undefined) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: '--local-execution supports stdio only; account-linked HTTP requires explicit --hosted-execution configuration' })}\n`);
  process.exit(1);
}
if ((values['connector-config'] !== undefined && !values['hosted-execution']) || (values['hosted-execution'] && (values.http === undefined || values['connector-config'] === undefined))) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: 'Hosted execution requires explicit --hosted-execution --connector-config FILE --http PORT; connector configuration never enables a public server implicitly' })}\n`);
  process.exit(1);
}

// An invalid VERDICT_NETWORK or VERDICT_BUILDER_FEE_TENTHS_BP is one JSON error line and exit 4 (not configured),
// the same as the CLI, not a stack trace.
let config: KitConfig;
let lighterConfig: LighterConfig | undefined;
let executionClient: ExecutionClient | undefined;
try {
  config = configFromEnv(values.lighter || values.execution || values['local-execution'] || values['hosted-execution'] ? {} : process.env);
  if (values.lighter || values.strategy) lighterConfig = lighterConfigFromEnv();
  if (values['local-execution']) {
    const mode = ExecutionMode.safeParse(process.env.VERDICT_EXECUTION_MODE);
    if (!mode.success) throw new ToolError('Set VERDICT_EXECUTION_MODE=per_order|policy explicitly', 'not_configured');
    executionClient = await connectExecution({ expectedMode: mode.data });
  }
} catch (e) {
  process.stderr.write(`${JSON.stringify({ error: 'not_configured', message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(4);
}

const openServer = () => executionClient ? createLocalExecutionServer(executionClient) : values.execution ? createExecutionServer() : values.strategy ? createStrategyServer(createStrategyTools({ config })) : lighterConfig ? createLighterServer(createLighterTools(new LighterClient(lighterConfig))) : createServer(config);

if (values['hosted-execution']) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major === undefined || minor === undefined || major < 22 || (major === 22 && minor < 13)) throw new Error();
    const port = Number(values.http);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || values['connector-config'] === undefined) throw new Error();
    const { createHostedHandler, readHostedConfig } = await import('./hosted-http.js');
    const connectorConfig = await readHostedConfig(values['connector-config']);
    const connector = await createHostedHandler(connectorConfig);
    const listener = createHttpServer({ maxHeaderSize: 16_384 }, connector.handle);
    listener.requestTimeout = 30_000;
    listener.headersTimeout = 15_000;
    listener.on('error', () => { connector.close(); process.stderr.write(`${JSON.stringify({ error: 'connector_start_failed', message: 'Unable to bind the configured connector listener' })}\n`); process.exitCode = 1; });
    listener.listen(port, values.host, () => { process.stderr.write(`verdict-hosted-execution listening on ${values.host}:${port}; public MCP resource ${connectorConfig.publicOrigin.replace(/\/$/, '')}/mcp (authenticated real execution)\n`); });
    const stop = () => listener.close(() => { connector.close(); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    process.stderr.write(`${JSON.stringify({ error: 'not_configured', message: 'Hosted connector startup failed. Requires Node 22.13+, valid private configuration, managed OAuth discovery and private state. Details hidden.' })}\n`);
    process.exit(4);
  }
} else if (values.http === undefined) {
  const server = openServer();
  await server.connect(new StdioServerTransport());
} else {
  const port = Number(values.http);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`invalid --http port ${JSON.stringify(values.http)}\n`);
    process.exit(1);
  }
  const handler = createRequestHandler({
    health: () => values.execution ? { ok: true, mode: 'keyless_execution_preparation' } : values.strategy ? { ok: true, mode: 'paper_research', networks: { hl: config.network, lighter: lighterConfig?.network } } : lighterConfig ? { ok: true, exchange: 'lighter', network: lighterConfig.network, mode: 'unsigned' } : healthBody(config),
    open: async () => {
      const server = openServer();
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
    process.stderr.write(`${values.execution ? `verdict-execution-preparation listening on http://${values.host}:${port}/mcp (no signing)` : values.strategy ? `verdict-strategy-mcp listening on http://${values.host}:${port}/mcp (paper research only)` : values.lighter ? `verdict-lighter-mcp listening on http://${values.host}:${port}/mcp (no keys or signing)` : listenLine(config, values.host, port)}\n`);
  });
}
