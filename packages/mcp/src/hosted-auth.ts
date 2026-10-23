import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { type AuthConfig, type BrowserSession, type ConnectorScope, HostedError, Principal, READ_SCOPE, requireScope, TRADE_SCOPE } from './hosted-model.js';

const MAX_ENTRIES = 1000;
const LOGIN_MS = 300_000;
const SESSION_MS = 600_000;
const MAX_RESPONSE = 131_072;
const Discovery = z.object({ issuer: z.string().url(), authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(), jwks_uri: z.string().url(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
}).passthrough();
const TokenResponse = z.object({ access_token: z.string().min(1).max(32_768), id_token: z.string().min(1).max(32_768),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
}).passthrough();
type LoginState = { cookieHash: string; verifier: string; nonce: string; returnPath: string; expiresAt: number };
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const invalidToken = () => new HostedError(401, 'invalid_token', 'Authentication is missing, invalid or expired. Sign in again.');
const invalidCallback = () => new HostedError(400, 'invalid_callback', 'Browser sign-in could not be verified. Start sign-in again.');

function safeUrl(value: string, insecure: boolean): URL {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(insecure && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.hash) throw new Error('Invalid provider configuration');
  return url;
}

async function json(url: URL, init: RequestInit = {}): Promise<unknown> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const response = await fetch(url, { ...init, redirect: 'manual', signal });
  if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE || !response.body) throw new Error('Provider request failed');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('Provider response too large'); }
    chunks.push(chunk.value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header || header.length > 16_384) return null;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export class ConnectorAuth {
  private readonly states = new Map<string, LoginState>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly origin: string;
  private readonly resource: string;
  private readonly loginCookie: string;
  private readonly sessionCookie: string;
  private readonly secure: boolean;

  private constructor(private readonly config: AuthConfig, private readonly discovery: z.infer<typeof Discovery>, private readonly secret: string | undefined) {
    this.origin = new URL(config.publicOrigin).origin; this.resource = `${this.origin}/mcp`;
    this.secure = new URL(config.publicOrigin).protocol === 'https:';
    this.loginCookie = this.secure ? '__Host-verdict-login' : 'verdict_login';
    this.sessionCookie = this.secure ? '__Host-verdict-session' : 'verdict_session';
    this.keys = createRemoteJWKSet(safeUrl(discovery.jwks_uri, config.allowInsecureLocalhost), { timeoutDuration: 5000,
      [customFetch]: async (url, options) => new Response(JSON.stringify(await json(new URL(url), options)), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
  }

  static async create(config: AuthConfig): Promise<ConnectorAuth> {
    try {
      const origin = safeUrl(config.publicOrigin, config.allowInsecureLocalhost);
      const issuer = safeUrl(config.issuer, config.allowInsecureLocalhost);
      if (origin.pathname !== '/' || origin.search || issuer.search || !config.browserClientId) throw new Error();
      const discovery = Discovery.parse(await json(new URL(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)));
      if (discovery.issuer !== config.issuer || (discovery.code_challenge_methods_supported && !discovery.code_challenge_methods_supported.includes('S256'))) throw new Error();
      for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.jwks_uri]) safeUrl(endpoint, config.allowInsecureLocalhost);
      const secret = config.browserClientSecretEnv === undefined ? undefined : process.env[config.browserClientSecretEnv];
      if (config.browserClientSecretEnv !== undefined && !secret) throw new Error();
      const methods = discovery.token_endpoint_auth_methods_supported;
      if (methods && !(secret ? methods.includes('client_secret_post') : methods.includes('none'))) throw new Error();
      return new ConnectorAuth({ ...config }, discovery, secret);
    } catch { throw new HostedError(503, 'auth_configuration', 'The configured sign-in provider is unavailable or unsupported.'); }
  }

  metadata() {
    return { resource: this.resource, authorization_servers: [this.config.issuer],
      scopes_supported: [READ_SCOPE, TRADE_SCOPE], bearer_methods_supported: ['header'] };
  }

  challenge(scope: ConnectorScope, code?: string): string {
    const error = code === 'invalid_token' || code === 'insufficient_scope'
      ? `, error="${code}", error_description="${code === 'invalid_token' ? 'Sign in with a valid resource access token.' : 'Grant the requested account permissions.'}"` : '';
    return `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp", scope="${scope === TRADE_SCOPE ? `${READ_SCOPE} ${TRADE_SCOPE}` : READ_SCOPE}"${error}`;
  }

  private async access(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.keys, { algorithms: ['RS256', 'ES256'], issuer: this.config.issuer,
      audience: this.resource, requiredClaims: ['iss', 'sub', 'aud', 'exp'],
    });
    const scope = payload.scope ?? payload.scp ?? '';
    if (typeof scope !== 'string' || scope.length > 8192 || typeof payload.exp !== 'number') throw new Error();
    return Principal.parse({ issuer: payload.iss, subject: payload.sub, scopes: [...new Set(scope.split(/\s+/).filter(Boolean))], expiresAt: payload.exp * 1000 });
  }

  async authenticate(authorization: string | undefined, scope: ConnectorScope): Promise<Principal> {
    let principal: Principal;
    try {
      const match = authorization && authorization.length <= 32_780 ? /^Bearer[ \t]+([^\s]+)$/i.exec(authorization) : null;
      if (!match?.[1]) throw new Error();
      principal = await this.access(match[1]);
    } catch { throw invalidToken(); }
    requireScope(principal, scope); return principal;
  }

  private prune() {
    const now = Date.now();
    for (const [key, state] of this.states) if (state.expiresAt <= now) this.states.delete(key);
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
  }

  private cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }

  login(returnPath: string): { location: string; cookies: string[] } {
    if (!/^\/review\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(returnPath)) {
      throw new HostedError(400, 'invalid_return_path', 'Sign-in must return to an account review page.');
    }
    this.prune();
    if (this.states.size >= MAX_ENTRIES) throw new HostedError(503, 'auth_capacity', 'Sign-in is temporarily busy. Try again later.');
    const state = opaque(); const cookie = opaque(); const verifier = opaque(); const nonce = opaque();
    this.states.set(hash(state), { cookieHash: hash(cookie), verifier, nonce, returnPath, expiresAt: Date.now() + LOGIN_MS });
    const location = new URL(this.discovery.authorization_endpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: this.config.browserClientId,
      redirect_uri: `${this.origin}/auth/callback`, scope: `openid ${READ_SCOPE} ${TRADE_SCOPE}`,
      resource: this.resource, audience: this.resource, state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })) location.searchParams.set(name, value);
    return { location: location.href, cookies: [this.cookie(this.loginCookie, cookie, LOGIN_MS / 1000)] };
  }

  async callback(url: URL, cookieHeader: string | undefined): Promise<{ location: string; cookies: string[] }> {
    this.prune();
    try {
      if (url.origin !== this.origin || url.pathname !== '/auth/callback' || url.username || url.password || url.hash || url.searchParams.has('error')
        || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1
        || url.searchParams.getAll('iss').length > 1 || (url.searchParams.has('iss') && url.searchParams.get('iss') !== this.config.issuer)) throw new Error();
      const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
      const cookie = cookieValue(cookieHeader, this.loginCookie);
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096 || !cookie) throw new Error();
      const stored = this.states.get(hash(state));
      if (!stored || !equal(stored.cookieHash, hash(cookie))) throw new Error();
      this.states.delete(hash(state));
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.browserClientId,
        code, redirect_uri: `${this.origin}/auth/callback`, code_verifier: stored.verifier });
      if (this.secret !== undefined) body.set('client_secret', this.secret);
      const tokens = TokenResponse.parse(await json(new URL(this.discovery.token_endpoint), { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }));
      const { payload } = await jwtVerify(tokens.id_token, this.keys, { algorithms: ['RS256', 'ES256'], issuer: this.config.issuer,
        audience: this.config.browserClientId, requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'] });
      this.checkIdentityToken(payload, stored.nonce);
      const principal = await this.access(tokens.access_token); requireScope(principal, READ_SCOPE);
      if (payload.sub !== principal.subject) throw new Error();
      if (this.sessions.size >= MAX_ENTRIES) throw new Error();
      const id = opaque(); const csrf = opaque();
      const expiresAt = Math.min(principal.expiresAt, Date.now() + SESSION_MS);
      this.sessions.set(hash(id), { principal, csrf, expiresAt });
      return { location: stored.returnPath, cookies: [this.cookie(this.loginCookie, '', 0),
        this.cookie(this.sessionCookie, id, Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)))] };
    } catch { throw invalidCallback(); }
  }

  private checkIdentityToken(payload: JWTPayload, nonce: string) {
    if (typeof payload.nonce !== 'string' || !equal(payload.nonce, nonce)
      || (payload.azp !== undefined && payload.azp !== this.config.browserClientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.browserClientId)) throw new Error();
  }

  readSession(cookieHeader: string | undefined): BrowserSession | null {
    this.prune();
    const id = cookieValue(cookieHeader, this.sessionCookie); const session = id ? this.sessions.get(hash(id)) : undefined;
    return session ? { ...session, principal: { ...session.principal, scopes: [...session.principal.scopes] } } : null;
  }
}
