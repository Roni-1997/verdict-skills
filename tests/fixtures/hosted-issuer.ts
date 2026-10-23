import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface IssuerTokenOptions {
  readonly audience?: string;
  readonly issuer?: string;
  readonly expiresIn?: number;
  readonly notBefore?: number;
}
export interface IssuerOptions {
  readonly audience?: string;
  readonly mismatchAccessSubject?: boolean;
  readonly discovery?: 'redirect' | 'issuer_mismatch' | 'insecure_endpoint';
}
interface Code { subject: string; redirectUri: string; challenge: string; nonce: string; audience: string; scope: string; expiresAt: number }

/** Real ephemeral test OIDC issuer. No production keys, identity service or venue calls. */
export async function startIssuer(options: IssuerOptions = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'ephemeral-test-rsa', use: 'sig', alg: 'RS256' };
  const clientId = 'verdict-browser-test'; const clientSecret = randomBytes(24).toString('base64url');
  let issuer = ''; let subject = 'alice'; const codes = new Map<string, Code>();
  async function token(user: string, scopes: string[] = ['verdict:read', 'verdict:trade'], overrides: IssuerTokenOptions = {}) {
    const now = Math.floor(Date.now() / 1000);
    const signed = new SignJWT({ scope: scopes.join(' ') }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(overrides.issuer ?? issuer).setAudience(overrides.audience ?? options.audience ?? 'https://mcp.hyperverdict.xyz/mcp')
      .setSubject(user).setIssuedAt(now).setExpirationTime(now + (overrides.expiresIn ?? 300));
    if (overrides.notBefore !== undefined) signed.setNotBefore(overrides.notBefore);
    return signed.sign(privateKey);
  }
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        if (options.discovery === 'redirect') { response.writeHead(302, { location: `${issuer}redirect-target` }); response.end(); return; }
        send(response, 200, { issuer: options.discovery === 'issuer_mismatch' ? `${issuer}wrong` : issuer,
          authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`,
          jwks_uri: options.discovery === 'insecure_endpoint' ? 'http://provider-secret.invalid/jwks' : `${issuer}jwks`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        }); return;
      }
      if (url.pathname === '/jwks') { send(response, 200, { keys: [jwk] }); return; }
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'about:blank');
        const audience = url.searchParams.get('resource'); const challenge = url.searchParams.get('code_challenge');
        const nonce = url.searchParams.get('nonce'); const state = url.searchParams.get('state');
        if (url.searchParams.get('client_id') !== clientId || url.searchParams.get('response_type') !== 'code'
          || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || !['http:', 'https:'].includes(redirect.protocol)
          || redirect.pathname !== '/auth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password
          || !audience || url.searchParams.get('audience') !== audience || !nonce || !state
          || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || url.searchParams.get('code_challenge_method') !== 'S256') {
          send(response, 400, { error: 'invalid_authorization_request' }); return;
        }
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { subject, redirectUri: redirect.href, challenge, nonce, audience,
          scope: url.searchParams.get('scope') ?? '', expiresAt: Date.now() + 60_000 });
        redirect.searchParams.set('code', code); redirect.searchParams.set('state', state); redirect.searchParams.set('iss', issuer);
        response.writeHead(302, { location: redirect.href }); response.end(); return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) { body += String(chunk); if (body.length > 16_384) throw new Error(); }
        const form = new URLSearchParams(body); const code = form.get('code'); const stored = code ? codes.get(code) : undefined;
        if (code) codes.delete(code);
        if (!stored || stored.expiresAt <= Date.now() || form.get('grant_type') !== 'authorization_code'
          || form.get('client_id') !== clientId || form.get('redirect_uri') !== stored.redirectUri
          || (form.has('client_secret') && form.get('client_secret') !== clientSecret)
          || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== stored.challenge) {
          send(response, 400, { error: 'invalid_grant', error_description: 'provider-private-detail' }); return;
        }
        const idToken = await new SignJWT({ nonce: stored.nonce }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(issuer).setAudience(clientId).setSubject(stored.subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
        send(response, 200, { token_type: 'Bearer', id_token: idToken,
          access_token: await token(options.mismatchAccessSubject ? 'other-user' : stored.subject,
            stored.scope.split(' '), { audience: stored.audience }), expires_in: 300,
        }); return;
      }
      send(response, 404, { error: 'not_found' });
    } catch { if (!response.headersSent) send(response, 500, { error: 'test_issuer_error' }); else response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test issuer did not listen on TCP');
  issuer = `http://127.0.0.1:${address.port}/`;
  return { issuer, clientId, clientSecret, token, loginAs(user: string) { subject = user; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
