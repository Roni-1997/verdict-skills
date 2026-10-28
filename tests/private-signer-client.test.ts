import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareExecution } from '../packages/core/src/index.js';
import { Binding, PrivateSignerConfig } from '../packages/mcp/src/hosted-model.js';
import { PrivateSignerClient } from '../packages/mcp/src/private-signer-client.js';

const deploymentId = randomUUID(); const grantId = randomUUID(); const profileId = randomUUID(); const grantHash = 'a'.repeat(64);
const config = PrivateSignerConfig.parse({ kind: 'hosted_signer', origin: 'https://private.signer.fixture', deploymentId, secretEnv: 'VERDICT_PRIVATE_CLIENT_TEST_SECRET' });
const binding = Binding.parse({ id: profileId, subject: 'did:privy:alice', enabled: true, mode: 'per_order', execution: { kind: 'hosted_signer', profileId },
  grantId, grantHash, accounts: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5 }] });
const capability = { kind: 'local_execution_capabilities', authority: { mode: 'policy', grantId, grantHash, expiresAt: Date.now() + 60_000,
  newRisk: 'active', remainingDebitUSDC: '100', remainingOrders: 20, cancelOwnOrders: true }, fundedAcceptanceVerified: false };
const proposal = () => prepareExecution({ legs: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5, market: 9001, creator: 7,
  title: 'Nonfunded private HTTP fixture', settlementRule: 'Synthetic fixture resolves YES.', side: 'yes', action: 'buy', shares: '1', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }],
  policy: { maxTotalDebitUSDC: '1', maxLegDebitUSDC: '1' } });
const Request = z.object({ operation: z.string(), request: z.object({ operation: z.string() }).passthrough().optional() }).passthrough();
const Claims = z.object({ version: z.literal(1), deploymentId: z.string().uuid(), audience: z.literal('verdict-private-signer'), requestId: z.string().uuid(),
  issuedAt: z.number().int(), expiresAt: z.number().int(), bodyHash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, result: value }), { headers: { 'content-type': 'application/json' } });
function secret() { const value = randomBytes(32); process.env.VERDICT_PRIVATE_CLIENT_TEST_SECRET = value.toString('base64url'); return value; }
afterEach(() => { delete process.env.VERDICT_PRIVATE_CLIENT_TEST_SECRET; });

it('authenticates exact body bytes at one fixed HTTPS endpoint with bounded fresh claims', async () => {
  const key = secret(); const ids: string[] = []; let count = 0;
  const transport: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('https://private.signer.fixture/internal/operation'); expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers); const encoded = headers.get('x-verdict-service-auth'); if (!encoded || typeof init?.body !== 'string') throw new Error('missing fixed authentication');
    const claims = Claims.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    expect(claims.deploymentId).toBe(deploymentId); expect(claims.bodyHash).toBe(createHash('sha256').update(init.body).digest('hex'));
    expect(claims.expiresAt - claims.issuedAt).toBe(30_000); expect(claims.issuedAt).toBeLessThanOrEqual(Date.now());
    expect(claims.signature).toBe(createHmac('sha256', key).update(['verdict-signer/1', deploymentId, claims.audience, claims.requestId,
      String(claims.issuedAt), String(claims.expiresAt), claims.bodyHash].join('\n')).digest('hex'));
    ids.push(claims.requestId); count++; return response({ binding: null });
  };
  const client = new PrivateSignerClient(config, transport);
  await client.operation({ operation: 'binding', subject: binding.subject }); await client.operation({ operation: 'binding', subject: binding.subject });
  expect(count).toBe(2); expect(new Set(ids).size).toBe(2);
});

it('rejects arbitrary native operations, paths, users and profile selectors before transport', async () => {
  secret(); let calls = 0; const client = new PrivateSignerClient(config, async () => { calls++; return response(null); });
  const pathInjection = { operation: 'binding' as const, subject: binding.subject, socketPath: '/foreign/key.sock' };
  const unknownSubject = { operation: 'binding' as const, subject: 'attacker' };
  const privateKeyInjection = { operation: 'prepare' as const, subject: binding.subject, walletAddress: `0x${'1'.repeat(40)}`, privateKey: 'secret' };
  await expect(client.operation(pathInjection)).rejects.toThrow(); await expect(client.operation(unknownSubject)).rejects.toThrow(); await expect(client.operation(privateKeyInjection)).rejects.toThrow();
  expect(calls).toBe(0);
  for (const origin of ['http://private.signer.fixture', 'https://u:p@private.signer.fixture', 'https://private.signer.fixture/other', 'https://private.signer.fixture?token=secret']) expect(PrivateSignerConfig.safeParse({ ...config, origin }).success).toBe(false);
});

it('rejects wrong pinned grant or mode at the broker boundary', async () => {
  secret();
  for (const authority of [{ ...capability.authority, grantHash: 'b'.repeat(64) }, { ...capability.authority, grantId: randomUUID() }, { mode: 'per_order', approval: 'operator_terminal' }]) {
    const client = new PrivateSignerClient(config, async () => response({ ...capability, authority }));
    await expect(client.connect(binding)).rejects.toMatchObject({ code: 'private_signer_unavailable' });
  }
});

it('reports uncertain mutations without a retry and checks exact fills, inventory and digest', async () => {
  secret(); const value = proposal(); let mutations = 0;
  const transport: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('missing body'); const request = Request.parse(JSON.parse(init.body));
    if (request.request?.operation === 'capabilities') return response(capability);
    mutations++; return response({ digest: value.digest, state: 'complete', legs: [{ leg: 0, state: 'filled', filled: '0.5', netInventoryChange: '0.5', settled: true }], automaticRetry: false, note: 'Invalid full-fill assertion.' });
  };
  const client = await new PrivateSignerClient(config, transport).connect(binding); expect(client.mode).toBe('policy');
  await expect(client.submit(value)).rejects.toMatchObject({ name: 'ExecutionDeliveryUnknownError', digest: value.digest }); expect(mutations).toBe(1);
  await expect(client.status(value)).rejects.toMatchObject({ code: 'private_signer_unavailable' }); expect(mutations).toBe(2);
});

it('hides private transport failures, rejects redirects and never automatically retries a send', async () => {
  secret(); const value = proposal(); let calls = 0;
  const client = await new PrivateSignerClient(config, async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('missing body'); const request = Request.parse(JSON.parse(init.body));
    if (request.request?.operation === 'capabilities') return response(capability);
    calls++; throw new Error('private-key-and-database-credentials');
  }).connect(binding);
  await expect(client.submit(value)).rejects.toMatchObject({ name: 'ExecutionDeliveryUnknownError' }); expect(calls).toBe(1);
  const redirected = new PrivateSignerClient(config, async () => new Response('', { status: 302, headers: { location: 'https://attacker.fixture' } }));
  await expect(redirected.operation({ operation: 'binding', subject: binding.subject })).rejects.toMatchObject({ code: 'private_signer_unavailable' });
});

it('rejects noncanonical service secrets and overlarge or invalid private responses', async () => {
  process.env.VERDICT_PRIVATE_CLIENT_TEST_SECRET = 'not-a-private-service-secret'; expect(() => new PrivateSignerClient(config)).toThrow(); secret();
  const oversized = new PrivateSignerClient(config, async () => new Response('x'.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }));
  await expect(oversized.operation({ operation: 'binding', subject: binding.subject })).rejects.toMatchObject({ code: 'private_signer_unavailable' });
  for (const body of ['{"ok":true,"result":{},"extra":true}', '{"ok":false,"ok":true,"result":{}}']) {
    const malformed = new PrivateSignerClient(config, async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    await expect(malformed.operation({ operation: 'binding', subject: binding.subject })).rejects.toMatchObject({ code: 'private_signer_unavailable' });
  }
});
