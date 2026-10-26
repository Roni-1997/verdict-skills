import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectExecution, prepareExecution } from '../packages/core/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const request = (price = '0.4', shares = '10') => ({ validForSeconds: 3600, legs: [{
  venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 2, market: 123, creator: 7,
  title: 'Synthetic integration contract', settlementRule: 'Synthetic exact rule; not a live contract.',
  side: 'yes', action: 'buy', shares, limitPrice: price, feeReserveUSDC: '0.1', tif: 'ioc',
}], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } });
let directory: string;
let socketPath: string;
let child: ChildProcess;
let diagnostics = '';
const original = prepareExecution(request());

beforeAll(async () => {
  directory = await mkdtemp('/tmp/verdict-lifecycle-');
  socketPath = join(directory, 'broker.sock');
  const template = join(directory, 'template.json');
  await writeFile(template, JSON.stringify(original));
  child = spawn(process.env.VERDICT_BROKER_PYTHON ?? 'python3', [join(root, 'local-runner/tests/lifecycle_fixture.py'), template, socketPath, join(directory, 'state')], {
    cwd: root, env: { PATH: process.env.PATH ?? '', PYTHONPATH: join(root, 'local-runner'), PYTHONDONTWRITEBYTECODE: '1', VERDICT_NODE_BINARY: process.execPath }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
  let failed = false;
  child.on('error', () => { failed = true; });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await stat(socketPath)).isSocket()) {
        await connectExecution({ expectedMode: 'policy', socketPath });
        return;
      }
    } catch { /* Await an actual broker capabilities response. */ }
    if (failed || child.exitCode !== null) throw new Error(`Nonfunded broker fixture failed: ${diagnostics}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Nonfunded broker fixture did not start: ${diagnostics}`);
}, 15_000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
    child.kill('SIGTERM'); await stopped;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('the SDK completes a real local-broker lifecycle and preserves history after later trades', async () => {
  const client = await connectExecution({ expectedMode: 'policy', socketPath });
  expect((await client.capabilities()).authority.mode).toBe('policy');
  expect((await client.preflight(original)).authorization).toBe('none');
  const first = await client.submit(original);
  expect(first.state).toBe('complete');
  expect((await client.submit(original)).state).toBe('complete');
  const second = prepareExecution(request('0.39'));
  expect((await client.submit(second)).state).toBe('complete');
  expect(await client.status(original)).toEqual(first);
  expect((await client.cancel({ proposal: original, leg: 0 })).state).toBe('complete');
  const partial = await client.submit(prepareExecution(request('0.38', '9')));
  expect(partial.state).toBe('needs_reconciliation');
  expect(partial.legs[0]?.filled).toBe('4');
  await expect(client.submit(prepareExecution(request('0.37')))).rejects.toThrow();
  expect(await client.status(original)).toEqual(first);
}, 20_000);

it('built CLI and MCP use the same SDK broker connection while hosted preparation remains keyless', async () => {
  const env = { PATH: process.env.PATH ?? '', VERDICT_BROKER_SOCKET: socketPath, VERDICT_EXECUTION_MODE: 'policy' };
  const cli = spawnSync(process.execPath, [join(root, 'packages/cli/dist/bin.js'), 'execution', 'status', '--input', JSON.stringify(original)], { env, encoding: 'utf8' });
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout).state).toBe('complete');
  const bin = join(root, 'packages/mcp/dist/bin.js');
  const client = new Client({ name: 'local-execution-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, '--local-execution'], env, stderr: 'pipe' }));
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['execution_prepare', 'execution_review', 'execution_capabilities', 'execution_preflight', 'execution_submit', 'execution_status', 'execution_cancel']);
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/"items":\[/);
    const status = await client.callTool({ name: 'execution_status', arguments: original });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ digest: original.digest, state: 'complete' });
    const capabilities = await client.callTool({ name: 'execution_capabilities', arguments: {} });
    expect(capabilities.structuredContent).toMatchObject({ authority: { mode: 'policy' }, fundedAcceptanceVerified: false });
  } finally { await client.close(); }
  const denied = spawnSync(process.execPath, [bin, '--local-execution', '--http', '8788'], { env: { ...env, VERDICT_BROKER_SOCKET: '/does-not-exist.sock' }, encoding: 'utf8' });
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain('stdio only');
  const keyless = new Client({ name: 'keyless-execution-test', version: '1' });
  try {
    await keyless.connect(new StdioClientTransport({ command: process.execPath, args: [bin, '--execution'], env, stderr: 'pipe' }));
    expect((await keyless.listTools()).tools.map((tool) => tool.name)).toEqual(['execution_prepare', 'execution_review', 'execution_capabilities']);
  } finally { await keyless.close(); }
}, 20_000);
