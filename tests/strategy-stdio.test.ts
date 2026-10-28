import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../packages/mcp/dist/bin.js', import.meta.url));

it('default MCP is Lighter-only and ignores obsolete HL configuration', async () => {
  for (const args of [[], ['--lighter']]) {
    const client = new Client({ name: 'verdict-default-scope', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, ...args],
        env: { LIGHTER_NETWORK: 'testnet', VERDICT_NETWORK: 'invalid-obsolete-HL-setting', VERDICT_API_URL: 'http://127.0.0.1:1' }, stderr: 'pipe' }));
      expect(client.getServerVersion()?.name).toBe('verdict-lighter');
      const tools = (await client.listTools()).tools;
      expect(tools).toHaveLength(9);
      expect(tools.every((tool) => tool.name.startsWith('lighter_'))).toBe(true);
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual(['verdict-lighter://markets']);
      expect((await client.callTool({ name: 'list_markets', arguments: {} })).isError).toBe(true);
      expect((await client.callTool({ name: 'strategy_discover_pairs', arguments: {} })).isError).toBe(true);
    } finally { await client.close(); }
  }
});

it('rejects removed strategy mode before opening any server', () => {
  const result = spawnSync(process.execPath, [bin, '--strategy'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: 'bad_input', message: expect.stringContaining('Lighter agent trading kit') });
  expect(result.stdout).toBe('');
});
