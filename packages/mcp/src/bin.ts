#!/usr/bin/env node
// verdict-mcp: stdio by default (Claude Desktop, Cursor, local agents); --http <port> serves streamable HTTP
// for hosted agents. Explicit --hosted-execution adds OAuth, browser consent and durable jobs.
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type ExecutionClient, ExecutionMode, type LighterConfig, LighterClient, ToolError, connectExecution, createLighterTools, lighterConfigFromEnv } from '@verdict/core';
import { createRequestHandler } from './http.js';
import { createLighterServer } from './lighter.js';
import { createExecutionServer, createLocalExecutionServer } from './execution.js';

const { values } = parseArgs({
  options: {
    lighter: { type: 'boolean', default: false },
    strategy: { type: 'boolean', default: false },
    execution: { type: 'boolean', default: false },
    'local-execution': { type: 'boolean', default: false },
    'hosted-execution': { type: 'boolean', default: false },
    'account-service': { type: 'boolean', default: false },
    'connector-config': { type: 'string' },
    http: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    [
      'verdict-mcp: Verdict agent kit for Lighter binary outcome markets',
      '',
      '  verdict-mcp                 Lighter research over stdio (default)',
      '  verdict-mcp --lighter       compatibility alias for the same Lighter research server',
      '  verdict-mcp --execution     keyless single-Lighter-order preparation and review',
      '  verdict-mcp --local-execution  SDK lifecycle over operator-owned Unix broker; stdio only; VERDICT_BROKER_SOCKET and explicit VERDICT_EXECUTION_MODE=per_order|policy',
      '  verdict-mcp --hosted-execution --connector-config private.json --http 8787  authenticated Lighter SDK execution; Node 22.13+',
      '  verdict-mcp --account-service --connector-config private.json --http 8787  Privy account connection, OAuth and Lighter SDK execution; Node 22.13+',
      '  verdict-mcp --http 8787     keyless Lighter research on http://127.0.0.1:8787/mcp',
      '  verdict-mcp --http 8787 --host 0.0.0.0',
      '',
      'Environment: LIGHTER_NETWORK=devnet|testnet|mainnet (default devnet); LIGHTER_CREATORS=comma-separated creator account indices.',
      'Trading requires an explicitly provisioned account and operator authority. No tool can approve an order or change mode.',
      'The kit supports Lighter binary outcomes. Cross-venue strategy/arb mode is not part of this MCP.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}
if (values.strategy) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: 'The Verdict MCP is a Lighter agent trading kit. --strategy is no longer supported; launch verdict-mcp for Lighter research.' })}\n`);
  process.exit(1);
}
if ([values.lighter, values.execution, values['local-execution'], values['hosted-execution'], values['account-service']].filter(Boolean).length > 1) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: 'Choose one MCP server mode: --lighter, --execution, --local-execution, --hosted-execution or --account-service' })}\n`);
  process.exit(1);
}
if (values['local-execution'] && values.http !== undefined) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: '--local-execution supports stdio only; account-linked HTTP requires explicit --hosted-execution configuration' })}\n`);
  process.exit(1);
}
if ((values['connector-config'] !== undefined && !values['hosted-execution'] && !values['account-service']) || ((values['hosted-execution'] || values['account-service']) && (values.http === undefined || values['connector-config'] === undefined))) {
  process.stderr.write(`${JSON.stringify({ error: 'bad_input', message: 'Hosted execution requires explicit --hosted-execution --connector-config FILE --http PORT; connector configuration never enables a public server implicitly' })}\n`);
  process.exit(1);
}

// Validate only this mode's configuration; stale HL settings cannot change the Lighter kit.
let lighterConfig: LighterConfig | undefined;
let executionClient: ExecutionClient | undefined;
try {
  if (!values.execution && !values['local-execution'] && !values['hosted-execution'] && !values['account-service']) lighterConfig = lighterConfigFromEnv();
  if (values['local-execution']) {
    const mode = ExecutionMode.safeParse(process.env.VERDICT_EXECUTION_MODE);
    if (!mode.success) throw new ToolError('Set VERDICT_EXECUTION_MODE=per_order|policy explicitly', 'not_configured');
    executionClient = await connectExecution({ expectedMode: mode.data });
  }
} catch (e) {
  process.stderr.write(`${JSON.stringify({ error: 'not_configured', message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(4);
}

const openServer = () => executionClient ? createLocalExecutionServer(executionClient) : values.execution ? createExecutionServer() : createLighterServer(createLighterTools(new LighterClient(lighterConfig)));

if (values['hosted-execution'] || values['account-service']) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major === undefined || minor === undefined || major < 22 || (major === 22 && minor < 13)) throw new Error();
    const port = Number(values.http);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || values['connector-config'] === undefined) throw new Error();
    const connectorConfig = values['account-service'] ? await (await import('./connect-http.js')).readAccountServiceConfig(values['connector-config']) : await (await import('./hosted-http.js')).readHostedConfig(values['connector-config']);
    const connector = values['account-service'] ? await (await import('./connect-http.js')).createAccountService((await import('./connect-model.js')).AccountServiceConfig.parse(connectorConfig))
      : await (await import('./hosted-http.js')).createHostedHandler((await import('./hosted-model.js')).HostedConfig.parse(connectorConfig));
    const listener = createHttpServer({ maxHeaderSize: 16_384 }, connector.handle);
    listener.requestTimeout = 30_000;
    listener.headersTimeout = 15_000;
    listener.on('error', () => { connector.close(); process.stderr.write(`${JSON.stringify({ error: 'connector_start_failed', message: 'Unable to bind the configured connector listener' })}\n`); process.exitCode = 1; });
    listener.listen(port, values.host, () => { process.stderr.write(`verdict-hosted-execution listening on ${values.host}:${port}; public MCP resource ${connectorConfig.publicOrigin.replace(/\/$/, '')}/mcp (authenticated real execution)\n`); });
    const stop = () => listener.close(() => { connector.close(); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    process.stderr.write(`${JSON.stringify({ error: 'not_configured', message: 'Hosted connector startup failed. Requires Node 22.13+, valid private configuration, configured identity verification and persistent private state. Details hidden.' })}\n`);
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
    health: () => values.execution ? { ok: true, exchange: 'lighter', mode: 'keyless_execution_preparation' } : { ok: true, exchange: 'lighter', network: lighterConfig?.network, mode: 'unsigned' },
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
    process.stderr.write(`${values.execution ? `verdict-execution-preparation listening on http://${values.host}:${port}/mcp (Lighter, no signing)` : `verdict-lighter-mcp listening on http://${values.host}:${port}/mcp (${lighterConfig?.network}, no keys or signing)`}\n`);
  });
}
