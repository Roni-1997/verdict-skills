import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountServiceConfig } from '../packages/mcp/src/connect-model.js';
import { createPrivyIdentity } from '../packages/mcp/src/privy-identity.js';

function config(verification: unknown) { return AccountServiceConfig.parse({ publicOrigin: 'https://mcp.example', appOrigin: 'https://app.example', appNetwork: 'lighter-testnet',
  privyAppId: 'rotation-app', privyVerification: verification, relaySecretEnv: 'PRIVATE_RELAY_SECRET', stateDir: '/private/authority', gatewayJobsDir: '/private/jobs', profiles: [] }); }
async function token(key: Parameters<SignJWT['sign']>[0], kid: string, claims: { audience?: string; issuer?: string; sid?: string; age?: number } = {}) {
  return new SignJWT({ sid: claims.sid ?? 'session' }).setProtectedHeader({ alg: 'ES256', kid }).setSubject('did:privy:alice')
    .setAudience(claims.audience ?? 'rotation-app').setIssuer(claims.issuer ?? 'privy.io').setIssuedAt(Math.floor(Date.now() / 1000) - (claims.age ?? 0)).setExpirationTime('1h').sign(key);
}
afterEach(() => vi.useRealTimers());

it('verifies both configured-app rotation keys by kid and fetches one fixed bounded JWKS document', async () => {
  const first = await generateKeyPair('ES256'); const second = await generateKeyPair('ES256');
  const document = { keys: [{ ...await exportJWK(first.publicKey), kid: 'old' }, { ...await exportJWK(second.publicKey), kid: 'new' }] };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(document));
  const verify = await createPrivyIdentity(config({ kind: 'jwks' }), fetcher);
  expect(await verify(await token(first.privateKey, 'old'))).toBe('did:privy:alice');
  expect(await verify(await token(second.privateKey, 'new'))).toBe('did:privy:alice');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://auth.privy.io/api/v1/apps/rotation-app/jwks.json');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  for (const claims of [{ audience: 'other-app' }, { issuer: 'other-issuer' }, { sid: '' }, { age: 7200 }]) await expect(verify(await token(first.privateKey, 'old', claims))).rejects.toMatchObject({ code: 'invalid_identity' });
  const attacker = await generateKeyPair('ES256'); await expect(verify(await token(attacker.privateKey, 'old'))).rejects.toMatchObject({ code: 'invalid_identity' });
  await expect(verify(await token(first.privateKey, 'unknown'))).rejects.toMatchObject({ code: 'invalid_identity' });
});

it('refreshes expired JWKS cache and fails closed for oversized, duplicate and unavailable key documents', async () => {
  const key = await generateKeyPair('ES256'); const jwk = { ...await exportJWK(key.publicKey), kid: 'key' };
  vi.useFakeTimers({ toFake: ['Date'] });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ keys: [jwk] }));
  const verify = await createPrivyIdentity(config({ kind: 'jwks' }), fetcher); await verify(await token(key.privateKey, 'key'));
  vi.setSystemTime(Date.now() + 60_001); await verify(await token(key.privateKey, 'key')); expect(fetcher).toHaveBeenCalledTimes(2);
  for (const response of [new Response('x'.repeat(32_769)), Response.json({ keys: [jwk, jwk] }), new Response('', { status: 503 })]) {
    const invalid = await createPrivyIdentity(config({ kind: 'jwks' }), async () => response);
    await expect(invalid(await token(key.privateKey, 'key'))).rejects.toMatchObject({ code: 'invalid_identity' });
  }
});

it('keeps explicit pinned-SPKI deployments and rejects ambiguous identity configuration', async () => {
  const key = await generateKeyPair('ES256'); const spki = await exportSPKI(key.publicKey); const fetcher = vi.fn<typeof fetch>();
  const verify = await createPrivyIdentity(config({ kind: 'spki', key: spki }), fetcher);
  expect(await verify(await token(key.privateKey, 'unused'))).toBe('did:privy:alice'); expect(fetcher).not.toHaveBeenCalled();
  expect(() => AccountServiceConfig.parse({ ...config({ kind: 'jwks' }), privyVerificationKey: spki })).toThrow();
  await expect(createPrivyIdentity({ ...config({ kind: 'jwks' }), privyAppId: '../untrusted' })).rejects.toMatchObject({ code: 'identity_configuration' });
});
