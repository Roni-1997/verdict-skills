import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LighterProvisioner } from '../packages/mcp/src/lighter-provisioner.js';

const subject = 'did:privy:alice'; const owner = `0x${'1'.repeat(40)}`; const enrollmentId = randomUUID();
let directory: string | undefined; let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>((resolve) => server?.close(() => resolve())); if (directory) await rm(directory, { recursive: true, force: true }); server = undefined; directory = undefined; });
async function fixture(response: unknown) {
  directory = await mkdtemp('/tmp/vpc-'); await chmod(directory, 0o700); const socketPath = join(directory, 'c.sock');
  const requests: unknown[] = [];
  server = createServer({ allowHalfOpen: true }, (socket) => { let body = ''; socket.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); if (!body.endsWith('\n')) return; requests.push(JSON.parse(body)); socket.end(`${JSON.stringify({ ok: true, result: response })}\n`); }); });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  return { client: new LighterProvisioner({ kind: 'local_socket', socketPath, brokerSocketRoot: directory }), requests, socketPath, root: directory };
}
it('sends only finite public enrollment identifiers across the fixed private socket', async () => {
  const setup = { enrollmentId, revision: 'a'.repeat(64), network: 'testnet', ownerWallet: owner, state: 'signature_required', account: 42,
    apiKeyIndex: 5, publicKey: `0x${'2'.repeat(80)}`, nonce: 0, chainId: 300, message: 'Official-message fixture', expiresAt: Date.now() + 60_000 };
  const { client, requests } = await fixture(setup);
  expect(await client.setup({ operation: 'prepare', subject, walletAddress: owner })).toEqual(setup);
  expect(requests).toEqual([{ operation: 'prepare', subject, walletAddress: owner }]);
});
it('rejects permissive socket state without contacting the private service', async () => {
  const { client, requests, socketPath } = await fixture(null); await chmod(socketPath, 0o666);
  await expect(client.binding(subject)).rejects.toMatchObject({ code: 'lighter_setup_unavailable' }); expect(requests).toEqual([]);
});
it('preserves a public restoration review without accepting caller-selected replacement keys', async () => {
  const setup = { enrollmentId, revision: 'a'.repeat(64), network: 'testnet', ownerWallet: owner, state: 'signature_required', account: 42,
    apiKeyIndex: 5, publicKey: `0x${'2'.repeat(80)}`, replacesPublicKey: `0x${'3'.repeat(80)}`, nonce: 7, chainId: 300, message: 'Official-message fixture', expiresAt: Date.now() + 60_000 };
  const { client, requests } = await fixture(setup);
  expect(await client.setup({ operation: 'resume', subject, walletAddress: owner })).toEqual(setup);
  expect(requests).toEqual([{ operation: 'resume', subject, walletAddress: owner }]);
});
it('fails closed for bindings outside the configured shared root, another subject or browser slot4', async () => {
  const { client, requests, root } = await fixture(null);
  // The server remains fixed; vary only its test-only response writer.
  const valid = { id: randomUUID(), subject, enabled: true, mode: 'per_order', execution: { kind: 'local_socket', socketPath: join(root, 'owned.sock') }, grantId: randomUUID(), grantHash: 'a'.repeat(64), accounts: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5 }] };
  server?.removeAllListeners('connection');
  let response: unknown = { binding: valid };
  server?.on('connection', (socket) => { socket.once('data', () => socket.end(`${JSON.stringify({ ok: true, result: response })}\n`)); });
  expect(await client.binding(subject)).toEqual(valid);
  for (const binding of [{ ...valid, execution: { kind: 'local_socket', socketPath: '/outside/foreign.sock' } }, { ...valid, subject: 'did:privy:bob' }, { ...valid, accounts: [{ ...valid.accounts[0], apiKeyIndex: 4 }] }, { ...valid, grantHash: undefined }, { ...valid, enabled: false }]) {
    response = { binding }; await expect(client.binding(subject)).rejects.toMatchObject({ code: 'lighter_setup_unavailable' });
  }
  response = { binding: valid, privateKey: 'must-never-be-forwarded' };
  await expect(client.binding(subject)).rejects.toMatchObject({ code: 'lighter_setup_unavailable' }); expect(requests).toEqual([]);
});
