import { createLocalJWKSet, importSPKI, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { AccountServiceConfig } from './connect-model.js';
import { HostedError } from './hosted-model.js';

const Keys = z.object({ keys: z.array(z.object({ kty: z.literal('EC'), crv: z.literal('P-256'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().min(1).max(256), alg: z.literal('ES256').optional(), use: z.literal('sig').optional(),
}).passthrough()).min(1).max(16) }).strict();

/** The only remote key destination is derived from the configured Privy app ID. */
export async function createPrivyIdentity(config: AccountServiceConfig, fetcher: typeof fetch = fetch): Promise<(token: string) => Promise<string>> {
  const verification = config.privyVerification ?? (config.privyVerificationKey === undefined ? null : { kind: 'spki' as const, key: config.privyVerificationKey });
  if (!verification || !/^[A-Za-z0-9_-]{1,256}$/.test(config.privyAppId)) throw new HostedError(503, 'identity_configuration', 'Configure the exact Privy app verification method.');
  let resolver: JWTVerifyGetKey | null = null; let fetchedAt = 0; let loading: Promise<JWTVerifyGetKey> | null = null;
  async function keys(): Promise<JWTVerifyGetKey> {
    if (resolver && Date.now() - fetchedAt < 60_000) return resolver;
    if (loading) return loading;
    loading = (async () => {
      const response = await fetcher(`https://auth.privy.io/api/v1/apps/${config.privyAppId}/jwks.json`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 32_768) throw new Error('Identity key response unavailable');
      let text = ''; if (!response.body) throw new Error('Missing identity keys');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32_768) throw new Error('Identity keys too large'); chunks.push(next.value); } }
      finally { await reader.cancel(); }
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const document = Keys.parse(JSON.parse(text));
      if (new Set(document.keys.map((key) => key.kid)).size !== document.keys.length) throw new Error('Ambiguous identity keys');
      resolver = createLocalJWKSet({ keys: document.keys.map(({ kty, crv, x, y, kid }) => ({ kty, crv, x, y, kid, alg: 'ES256', use: 'sig' })) }); fetchedAt = Date.now(); return resolver;
    })();
    try { return await loading; } finally { loading = null; }
  }
  const pinned = verification.kind === 'spki' ? await importSPKI(verification.key, 'ES256') : null;
  return async (token) => {
    try {
      const options = { algorithms: ['ES256'], issuer: 'privy.io', audience: config.privyAppId,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'sid'], maxTokenAge: '1h', clockTolerance: 5 };
      const result = pinned ? await jwtVerify(token, pinned, options) : await jwtVerify(token, await keys(), options);
      const { sub, sid } = result.payload;
      if (typeof sub !== 'string' || !/^did:privy:[A-Za-z0-9_-]{1,256}$/.test(sub) || typeof sid !== 'string' || sid.length === 0 || sid.length > 512) throw new Error('Invalid identity claims');
      return sub;
    } catch { throw new HostedError(401, 'invalid_identity', 'Sign in to Verdict again before connecting.'); }
  };
}
