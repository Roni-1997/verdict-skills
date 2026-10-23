import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectorAuth } from '../packages/mcp/src/hosted-auth.js';
import { type AuthConfig, READ_SCOPE, TRADE_SCOPE } from '../packages/mcp/src/hosted-model.js';
import { startIssuer, type IssuerOptions } from './fixtures/hosted-issuer.js';

const publicOrigin = 'http://127.0.0.1:54321';
const resource = `${publicOrigin}/mcp`;
let issuer: Awaited<ReturnType<typeof startIssuer>>;
const extraIssuers: Awaited<ReturnType<typeof startIssuer>>[] = [];
beforeAll(async () => { issuer = await startIssuer({ audience: resource }); });
afterAll(async () => { await issuer.close(); });
afterEach(async () => { vi.restoreAllMocks(); for (const item of extraIssuers.splice(0)) await item.close(); });
const config = (provider = issuer): AuthConfig => ({ publicOrigin, issuer: provider.issuer, browserClientId: provider.clientId, allowInsecureLocalhost: true });
const cookie = (cookies: string[]) => cookies.map((value) => value.split(';')[0]).join('; ');
async function authorize(auth: ConnectorAuth, provider = issuer, change?: (url: URL) => void) {
  const start = auth.login(`/review/${randomUUID()}`); const target = new URL(start.location); change?.(target);
  expect(target.origin).toBe(new URL(provider.issuer).origin);
  const response = await fetch(target, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = response.headers.get('location'); if (!location) throw new Error('Issuer did not redirect');
  return { start, callback: new URL(location) };
}
async function login(auth: ConnectorAuth, user = 'alice', provider = issuer) {
  provider.loginAs(user); const flow = await authorize(auth, provider);
  const result = await auth.callback(flow.callback, cookie(flow.start.cookies));
  return { ...flow, result, sessionCookie: cookie(result.cookies.filter((value) => !value.includes('Max-Age=0;') && !value.endsWith('Max-Age=0'))) };
}

describe('hosted identity verification through a real ephemeral OIDC issuer', () => {
  it('publishes resource discovery and challenges for exact read/trade permissions', async () => {
    const auth = await ConnectorAuth.create(config());
    expect(auth.metadata()).toEqual({ resource, authorization_servers: [issuer.issuer],
      scopes_supported: [READ_SCOPE, TRADE_SCOPE], bearer_methods_supported: ['header'] });
    expect(auth.challenge(TRADE_SCOPE, 'insufficient_scope')).toContain('scope="verdict:read verdict:trade"');
    expect(auth.challenge(READ_SCOPE, 'invalid_token')).toContain(`${publicOrigin}/.well-known/oauth-protected-resource/mcp`);
    expect(auth.challenge(READ_SCOPE, 'secret-provider-error')).not.toContain('secret-provider-error');
  });

  it('verifies signature, issuer, audience, expiry, not-before and scopes instead of trusting claims', async () => {
    const auth = await ConnectorAuth.create(config());
    const valid = await issuer.token('alice');
    expect(await auth.authenticate(`Bearer ${valid}`, READ_SCOPE)).toMatchObject({ issuer: issuer.issuer, subject: 'alice', scopes: [READ_SCOPE, TRADE_SCOPE] });
    for (const token of [await issuer.token('alice', [READ_SCOPE], { audience: 'https://wrong-audience.invalid/mcp' }),
      await issuer.token('alice', [READ_SCOPE], { issuer: 'https://wrong-issuer.invalid/' }),
      await issuer.token('alice', [READ_SCOPE], { expiresIn: -60 }),
      await issuer.token('alice', [READ_SCOPE], { notBefore: Math.floor(Date.now() / 1000) + 60 }),
      `${valid.slice(0, valid.lastIndexOf('.') + 10)}${valid[valid.lastIndexOf('.') + 10] === 'A' ? 'B' : 'A'}${valid.slice(valid.lastIndexOf('.') + 11)}`,
    ]) await expect(auth.authenticate(`Bearer ${token}`, READ_SCOPE)).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    for (const value of [undefined, '', 'Basic provider-private-detail', 'Bearer not.a.signature', `Bearer ${valid} extra`]) {
      await expect(auth.authenticate(value, READ_SCOPE)).rejects.toThrow('Sign in again');
    }
    const readOnly = await issuer.token('alice', [READ_SCOPE]);
    await expect(auth.authenticate(`Bearer ${readOnly}`, TRADE_SCOPE)).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    await expect(auth.authenticate(`Bearer ${valid}`, TRADE_SCOPE)).resolves.toMatchObject({ subject: 'alice' });
  });

  it('runs authorization code, PKCE, state, nonce and same-user access/ID token checks before issuing an opaque session', async () => {
    const auth = await ConnectorAuth.create(config()); const flow = await login(auth);
    expect(flow.result.location).toMatch(/^\/review\/[a-f0-9-]{36}$/);
    const request = new URL(flow.start.location);
    expect(request.searchParams.get('resource')).toBe(resource); expect(request.searchParams.get('audience')).toBe(resource);
    expect(request.searchParams.get('code_challenge_method')).toBe('S256');
    const session = auth.readSession(flow.sessionCookie);
    expect(session?.principal).toMatchObject({ subject: 'alice', issuer: issuer.issuer });
    expect(session?.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(session?.expiresAt).toBeLessThanOrEqual(session?.principal.expiresAt ?? 0);
    expect(JSON.stringify(flow.result)).not.toContain('access_token'); expect(JSON.stringify(flow.result)).not.toContain('id_token');
    expect(flow.result.cookies.every((value) => value.includes('HttpOnly') && value.includes('SameSite=Lax'))).toBe(true);
    await expect(auth.callback(flow.callback, cookie(flow.start.cookies))).rejects.toMatchObject({ code: 'invalid_callback' });
  });

  it('sets host-only Secure cookies for HTTPS and permits only internal exact review return paths', async () => {
    const auth = await ConnectorAuth.create({ ...config(), publicOrigin: 'https://mcp.hyperverdict.xyz' });
    const start = auth.login(`/review/${randomUUID()}`);
    expect(start.cookies[0]).toContain('__Host-verdict-login='); expect(start.cookies[0]).toContain('; Secure');
    for (const path of ['https://evil.invalid/review/x', '//evil.invalid/x', '/review/invalid', `/review/${randomUUID()}?next=https://evil.invalid`, '/review/%2f%2fevil.invalid']) {
      expect(() => auth.login(path)).toThrow('account review page');
    }
  });

  it.each(['cookie', 'state', 'duplicate_state', 'duplicate_code', 'issuer', 'nonce', 'pkce'] as const)('rejects tampered %s without exposing provider details', async (caseName) => {
    const auth = await ConnectorAuth.create(config());
    const flow = await authorize(auth, issuer, (url) => {
      if (caseName === 'nonce') url.searchParams.set('nonce', 'attacker-changed-nonce');
      if (caseName === 'pkce') url.searchParams.set('code_challenge', createHash('sha256').update('wrong-verifier').digest('base64url'));
    });
    let cookies = cookie(flow.start.cookies);
    if (caseName === 'cookie') cookies = cookies.replace(/=.+$/, `=${'z'.repeat(43)}`);
    if (caseName === 'state') flow.callback.searchParams.set('state', 'z'.repeat(43));
    if (caseName === 'duplicate_state') flow.callback.searchParams.append('state', 'z'.repeat(43));
    if (caseName === 'duplicate_code') flow.callback.searchParams.append('code', 'another-code');
    if (caseName === 'issuer') flow.callback.searchParams.set('iss', 'https://issuer-secret.invalid/');
    const pending = auth.callback(flow.callback, cookies);
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'invalid_callback' });
    await expect(pending).rejects.not.toThrow('provider-private-detail'); await expect(pending).rejects.not.toThrow('issuer-secret');
  });

  it('rejects ID/access subject mismatch even when both tokens are signed by the configured provider', async () => {
    const provider = await startIssuer({ audience: resource, mismatchAccessSubject: true }); extraIssuers.push(provider);
    const auth = await ConnectorAuth.create(config(provider)); const flow = await authorize(auth, provider);
    await expect(auth.callback(flow.callback, cookie(flow.start.cookies))).rejects.toMatchObject({ code: 'invalid_callback' });
  });

  it('keeps Alice and Bob sessions and CSRF secrets separate and does not accept bearer tokens as cookies', async () => {
    const auth = await ConnectorAuth.create(config()); const alice = await login(auth, 'alice'); const bob = await login(auth, 'bob');
    const a = auth.readSession(alice.sessionCookie); const b = auth.readSession(bob.sessionCookie);
    expect(a?.principal.subject).toBe('alice'); expect(b?.principal.subject).toBe('bob'); expect(a?.csrf).not.toBe(b?.csrf);
    expect(auth.readSession(`Bearer ${await issuer.token('alice')}`)).toBeNull();
    expect(auth.readSession(`${alice.sessionCookie}; ${alice.sessionCookie}`)).toBeNull();
    if (a) a.principal.scopes.length = 0;
    expect(auth.readSession(alice.sessionCookie)?.principal.scopes).toContain(READ_SCOPE);
    expect((await ConnectorAuth.create(config())).readSession(alice.sessionCookie)).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue((b?.expiresAt ?? Date.now()) + 1);
    expect(auth.readSession(bob.sessionCookie)).toBeNull();
  });

  it('supports configured confidential client credentials without returning or persisting their values', async () => {
    const name = 'VERDICT_TEST_BROWSER_CLIENT_SECRET'; const previous = process.env[name];
    try {
      process.env[name] = issuer.clientSecret;
      const auth = await ConnectorAuth.create({ ...config(), browserClientSecretEnv: name }); const flow = await login(auth);
      expect(auth.readSession(flow.sessionCookie)?.principal.subject).toBe('alice');
      expect(JSON.stringify(flow.result)).not.toContain(issuer.clientSecret);
      delete process.env[name];
      await expect(ConnectorAuth.create({ ...config(), browserClientSecretEnv: name })).rejects.not.toThrow(name);
    } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  });

  it.each(['redirect', 'issuer_mismatch', 'insecure_endpoint'] satisfies NonNullable<IssuerOptions['discovery']>[])('fails closed for provider discovery %s', async (discovery) => {
    const provider = await startIssuer({ discovery }); extraIssuers.push(provider);
    const attempt = ConnectorAuth.create(config(provider));
    await expect(attempt).rejects.toMatchObject({ status: 503, code: 'auth_configuration' });
    await expect(attempt).rejects.not.toThrow('provider-secret');
  });
});
