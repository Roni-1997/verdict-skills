import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { importSPKI, jwtVerify } from 'jose';
import { recoverMessageAddress } from 'viem';
import { z } from 'zod';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokenRevocationRequest, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { connectExecution, ExecutionConnectionInspection, executionConfirmation, validateExecution } from '@verdict/core';
import { CONNECT_PROTOCOL, ConnectAccountView, ConnectRequest, ConnectResponse, ConnectTransactionView } from './connect-contract.js';
import { AccountServiceConfig, Browser, Code, Credential, Enrollment, Grant, Transaction, failure, hash, opaque, ownerHash, type Profile } from './connect-model.js';
import { ConnectStore } from './connect-store.js';
import { Binding, HostedError, Principal, READ_SCOPE, TRADE_SCOPE, requireScope, type BrowserSession, type ConnectorScope, type Job } from './hosted-model.js';
import type { HostedRuntime, ReviewJobIdentity } from './hosted-security.js';

const ClientRecord = z.object({ metadata: z.unknown(), secret: z.string().nullable() }).strict();
const emptyView = (reason = 'No verified trading account is provisioned. This connection permits research only.'): ConnectAccountView => ({ kind: 'read_only', reason, scopes: [READ_SCOPE] });
const profileRevision = (profile: Profile) => hash(JSON.stringify(profile));
const identical = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const safeEqual = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const transactionLifetime = 300_000;
type Inspect = (profile: Profile) => Promise<ExecutionConnectionInspection>;

/** Product account authorization; independent from Privy JWTs and from broker trade policy. */
export class AccountAuthority implements OAuthServerProvider, HostedRuntime {
  readonly auth = this;
  readonly resource: string;
  private reviewLookup: (id: string) => ReviewJobIdentity | null = () => null;
  private readonly cookieName: string;
  private readonly browserName: string;
  private readonly secure: boolean;

  private constructor(readonly config: AccountServiceConfig, private readonly store: ConnectStore,
    private readonly key: Awaited<ReturnType<typeof importSPKI>>, private readonly relaySecret: string,
    private readonly inspect: Inspect) {
    this.resource = `${config.publicOrigin}/mcp`; this.secure = new URL(config.publicOrigin).protocol === 'https:';
    this.cookieName = this.secure ? '__Host-verdict-connect' : 'verdict_connect';
    this.browserName = this.secure ? '__Host-verdict-review' : 'verdict_review';
  }
  static async create(input: AccountServiceConfig, inspect: Inspect = async (profile) => {
    const client = await connectExecution({ expectedMode: 'policy', expectedGrantId: profile.grantId, socketPath: profile.brokerSocket });
    return client.inspectConnection();
  }): Promise<AccountAuthority> {
    const config = AccountServiceConfig.parse(input); const secret = process.env[config.relaySecretEnv];
    if (!secret || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) throw new HostedError(503, 'relay_configuration', 'Configure a private random relay secret of at least 32 bytes.');
    const key = await importSPKI(config.privyVerificationKey, 'ES256');
    return new AccountAuthority(config, new ConnectStore(config.stateDir), key, secret, inspect);
  }
  close() { this.store.close(); }
  setReviewLookup(lookup: (id: string) => ReviewJobIdentity | null) { this.reviewLookup = lookup; }
  metadata() { return { resource: this.resource, authorization_servers: [this.config.publicOrigin], scopes_supported: [READ_SCOPE, TRADE_SCOPE], bearer_methods_supported: ['header'] }; }
  challenge(scope: ConnectorScope, code?: string) {
    const error = code === 'invalid_token' || code === 'insufficient_scope' ? `, error="${code}"` : '';
    return `Bearer resource_metadata="${this.config.publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="${scope === TRADE_SCOPE ? `${READ_SCOPE} ${TRADE_SCOPE}` : READ_SCOPE}"${error}`;
  }
  private cookie(name: string, value: string, seconds: number) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`; }
  private cookieValue(header: string | undefined, name: string): string | null {
    if (!header || header.length > 16_384) return null;
    const matches = header.split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${name}=`));
    const value = matches[0]?.slice(name.length + 1);
    return matches.length === 1 && value && ConnectRequest.options[0].shape.transaction.safeParse(value).success ? value : null;
  }
  private crypt(value: string, decrypt = false): string {
    const key = createHash('sha256').update(`verdict-client-secret\0${this.relaySecret}`).digest();
    if (decrypt) {
      const bytes = Buffer.from(value, 'base64url'); if (bytes.length < 29) throw failure();
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    }
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  private client(clientId: string): OAuthClientInformationFull | undefined {
    const record = this.store.get('client', clientId, ClientRecord); if (!record) return undefined;
    const metadata = OAuthClientInformationFullSchema.parse(record.metadata);
    return record.secret === null ? metadata : { ...metadata, client_secret: this.crypt(record.secret, true) };
  }
  get clientsStore() {
    return { getClient: (id: string) => this.client(id), registerClient: async (input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> => {
      if (!input.redirect_uris.length || input.redirect_uris.length > 16 || (input.client_name?.length ?? 0) > 256
        || !['none', 'client_secret_post', 'client_secret_basic'].includes(input.token_endpoint_auth_method ?? 'client_secret_post')) throw new InvalidClientMetadataError('Unsupported client metadata.');
      for (const value of input.redirect_uris) {
        const url = new URL(value); const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (value.length > 2048 || url.username || url.password || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) throw new InvalidClientMetadataError('Use exact HTTPS or native loopback redirect URIs.');
      }
      const client = OAuthClientInformationFullSchema.parse({ ...input, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) });
      const { client_secret: secret, ...metadata } = client;
      this.store.transaction(() => this.store.put('client', client.client_id, { metadata, secret: secret === undefined ? null : this.crypt(secret) }, Date.now() + 2_592_000_000));
      return client;
    } };
  }
  private resourceCheck(resource: URL | undefined) { if (resource?.href !== this.resource) throw new InvalidTargetError('Request the exact MCP resource.'); }
  private scopes(values: string[] | undefined): (typeof READ_SCOPE | typeof TRADE_SCOPE)[] {
    const scopes = values ?? [READ_SCOPE];
    if (!scopes.includes(READ_SCOPE) || scopes.some((value) => value !== READ_SCOPE && value !== TRADE_SCOPE) || new Set(scopes).size !== scopes.length) throw new InvalidScopeError('Request verdict:read and optionally verdict:trade.');
    return scopes.includes(TRADE_SCOPE) ? [READ_SCOPE, TRADE_SCOPE] : [READ_SCOPE];
  }
  private appLocation(id: string) {
    const url = new URL('/connect/agent', this.config.appOrigin); url.searchParams.set('transaction', id); url.searchParams.set('net', this.config.appNetwork); return url.href;
  }
  private newTransaction(input: Pick<Transaction, 'purpose' | 'clientId' | 'clientName' | 'redirectUri' | 'scopes' | 'challenge' | 'state' | 'reviewPath' | 'authorization'>) {
    const cookie = opaque(); const transaction = Transaction.parse({ ...input, id: opaque(), resource: this.resource,
      cookieHash: hash(cookie), expiresAt: Date.now() + transactionLifetime, completed: false, subject: null, appSession: null, review: null, connection: null, receiptHash: null });
    this.store.transaction(() => this.saveTransaction(transaction));
    return { location: this.appLocation(transaction.id), cookies: [this.cookie(this.cookieName, cookie, transactionLifetime / 1000)] };
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.resourceCheck(params.resource); const scopes = this.scopes(params.scopes);
    if (!client.redirect_uris.includes(params.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2048) throw new InvalidGrantError('Invalid authorization request.');
    const result = this.newTransaction({ purpose: 'oauth', clientId: client.client_id, clientName: client.client_name || 'MCP client', redirectUri: params.redirectUri,
      scopes, challenge: params.codeChallenge, state: params.state ?? null, reviewPath: null, authorization: null });
    res.setHeader('Set-Cookie', result.cookies); res.redirect(303, result.location);
  }
  private saveTransaction(value: Transaction) { this.store.put('transaction', value.id, value, value.expiresAt); }
  private transaction(id: string): Transaction {
    const tx = this.store.get('transaction', id, Transaction);
    if (!tx || tx.completed || tx.expiresAt <= Date.now()) throw failure(); return tx;
  }
  private grant(id: string, epoch?: number): Grant {
    const grant = this.store.get('grant', id, Grant);
    if (!grant || grant.revoked || grant.expiresAt <= Date.now() || (epoch !== undefined && grant.epoch !== epoch)) throw new InvalidTokenError('Connection expired or revoked.');
    if (grant.profileId !== null) {
      const profile = this.config.profiles.find((item) => item.id === grant.profileId && item.enabled);
      const enrollment = this.store.enrollment(grant.subject, Enrollment);
      if (!profile || profileRevision(profile) !== grant.revision || enrollment?.profileId !== profile.id || enrollment.revision !== grant.revision) throw new InvalidTokenError('Trading connection changed.');
    }
    return grant;
  }
  private principal(grant: Grant, scopes: Grant['scopes'], expiresAt: number): Principal {
    return Principal.parse({ issuer: this.config.publicOrigin, subject: grant.subject, scopes, expiresAt: Math.min(expiresAt, grant.expiresAt), authorization: { kind: 'first_party', grantId: grant.id, epoch: grant.epoch } });
  }
  assertActive(principal: Principal): void {
    try {
      if (principal.issuer !== this.config.publicOrigin || !principal.authorization || principal.expiresAt <= Date.now()) throw new InvalidTokenError('Invalid connection.');
      const grant = this.grant(principal.authorization.grantId, principal.authorization.epoch);
      if (grant.subject !== principal.subject || principal.scopes.some((scope) => !grant.scopes.includes(scope as typeof READ_SCOPE | typeof TRADE_SCOPE))) throw new InvalidTokenError('Invalid connection.');
    } catch (error) { if (error instanceof HostedError) throw error; throw new HostedError(401, 'invalid_token', 'This connection expired, changed or was revoked.'); }
  }
  assertJobActive(job: Job) {
    if (!job.authorization) throw new HostedError(403, 'connection_revoked', 'This order has no current first-party authorization.');
    let grant: Grant;
    try { grant = this.grant(job.authorization.grantId, job.authorization.epoch); }
    catch (error) { if (error instanceof HostedError) throw error; throw new HostedError(403, 'connection_revoked', 'The original order connection has been revoked.'); }
    if (job.owner !== ownerHash(this.config.publicOrigin, grant.subject) || !grant.scopes.includes(TRADE_SCOPE)) throw new HostedError(403, 'connection_revoked', 'The original order connection has been revoked.');
  }
  binding(subject: string): Binding | null {
    const enrollment = this.store.enrollment(subject, Enrollment); if (!enrollment) return null;
    const profile = this.config.profiles.find((item) => item.id === enrollment.profileId && item.enabled);
    return profile && profileRevision(profile) === enrollment.revision ? Binding.parse({ ...profile, subject }) : null;
  }
  private credential(namespace: 'access' | 'refresh', value: string) { return /^[A-Za-z0-9_-]{43}$/.test(value) ? this.store.get(namespace, hash(value), Credential) : null; }
  private access(token: string) {
    const credential = this.credential('access', token);
    if (!credential || credential.used || credential.expiresAt <= Date.now() || credential.resource !== this.resource) throw new InvalidTokenError('Invalid resource token.');
    const grant = this.grant(credential.grantId, credential.epoch);
    if (grant.clientId !== credential.clientId || credential.scopes.some((scope) => !grant.scopes.includes(scope))) throw new InvalidTokenError('Invalid resource token.');
    return { credential, principal: this.principal(grant, credential.scopes, credential.expiresAt) };
  }
  async verifyAccessToken(token: string) {
    const { credential } = this.access(token);
    return { token, clientId: credential.clientId, scopes: credential.scopes, expiresAt: credential.expiresAt / 1000, resource: new URL(this.resource) };
  }
  async authenticate(header: string | undefined, scope: ConnectorScope) {
    try {
      const match = header && header.length < 128 ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header) : null;
      if (!match?.[1]) throw new Error(); const { principal } = this.access(match[1]); requireScope(principal, scope); return principal;
    } catch (error) { if (error instanceof HostedError && error.code === 'insufficient_scope') throw error; throw new HostedError(401, 'invalid_token', 'Sign in with a current MCP resource token.'); }
  }
  private issue(grant: Grant, scopes: Grant['scopes']): OAuthTokens {
    const access = opaque(); const refresh = opaque(); const expiresAt = Math.min(Date.now() + 300_000, grant.expiresAt);
    const credential = { grantId: grant.id, epoch: grant.epoch, clientId: grant.clientId, resource: this.resource, scopes, used: false };
    this.store.put('access', hash(access), { ...credential, expiresAt }, expiresAt);
    this.store.put('refresh', hash(refresh), { ...credential, expiresAt: grant.expiresAt }, grant.expiresAt);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)), scope: scopes.join(' ') };
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const record = this.store.get('code', hash(code), Code);
    if (!record || record.used || record.clientId !== client.client_id || record.expiresAt <= Date.now()) throw new InvalidGrantError('Invalid authorization code.');
    this.grant(record.grantId, record.epoch); return record.challenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    this.resourceCheck(resource);
    return this.store.transaction(() => {
      const record = this.store.get('code', hash(code), Code);
      if (!record || record.used || record.clientId !== client.client_id || record.redirectUri !== redirectUri || record.expiresAt <= Date.now()) throw new InvalidGrantError('Invalid authorization code.');
      const grant = this.grant(record.grantId, record.epoch);
      if (grant.clientId !== client.client_id || grant.resource !== record.resource || record.scopes.some((scope) => !grant.scopes.includes(scope))) throw new InvalidGrantError('Invalid authorization code.');
      this.store.put('code', hash(code), { ...record, used: true }, record.expiresAt); return this.issue(grant, record.scopes);
    });
  }
  private revoke(grant: Grant) { this.store.put('grant', grant.id, { ...grant, revoked: true, epoch: grant.epoch + 1 }, grant.expiresAt); }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.resourceCheck(resource);
    const result = this.store.transaction(() => {
      const record = this.credential('refresh', token);
      if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now()) return null;
      const grant = this.grant(record.grantId, record.epoch);
      if (grant.clientId !== client.client_id || grant.resource !== record.resource) throw new InvalidGrantError('Invalid refresh token.');
      if (record.used) { this.revoke(grant); return null; } // Commit replay revocation before returning invalid_grant.
      const narrowed = scopes === undefined ? record.scopes : this.scopes(scopes);
      if (narrowed.some((scope) => !record.scopes.includes(scope))) throw new InvalidScopeError('Refresh cannot widen scopes.');
      this.store.put('refresh', hash(token), { ...record, used: true }, record.expiresAt);
      return this.issue(grant, narrowed);
    });
    if (!result) throw new InvalidGrantError('Invalid refresh token.'); return result;
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    this.store.transaction(() => {
      const credential = this.credential('access', request.token) ?? this.credential('refresh', request.token);
      if (!credential || credential.clientId !== client.client_id) return;
      const grant = this.store.get('grant', credential.grantId, Grant); if (grant && !grant.revoked) this.revoke(grant);
    });
  }
  private async identity(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['ES256'], issuer: 'privy.io', audience: this.config.privyAppId,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'sid'], maxTokenAge: '1h', clockTolerance: 5 });
      if (typeof payload.sub !== 'string' || !/^did:privy:[A-Za-z0-9_-]{1,256}$/.test(payload.sub) || typeof payload.sid !== 'string' || payload.sid.length > 512) throw new Error();
      return payload.sub;
    } catch { throw new HostedError(401, 'invalid_identity', 'Sign in to Verdict again before connecting.'); }
  }
  private async inspectProfile(profile: Profile): Promise<ExecutionConnectionInspection> {
    const inspection = ExecutionConnectionInspection.parse(await this.inspect(profile));
    if (inspection.authority.grantId !== profile.grantId || inspection.authority.grantHash !== profile.grantHash
      || inspection.authority.newRisk !== 'active' || inspection.authority.expiresAt <= Date.now()) throw new HostedError(503, 'profile_unavailable', 'The operator trading policy is unavailable or has changed.');
    const accountKey = (value: unknown) => JSON.stringify(value);
    if (!identical(inspection.accounts.map((row) => accountKey(row.account)).sort(), profile.accounts.map(accountKey).sort())) throw new HostedError(503, 'profile_mismatch', 'The broker accounts do not match the provisioned connection.');
    for (const template of inspection.templates) validateExecution(template);
    return inspection;
  }
  private view(profile: Profile, inspection: ExecutionConnectionInspection, scopes: Grant['scopes']): ConnectAccountView {
    const blockers: string[] = []; const approvals: Extract<ConnectAccountView, { kind: 'executable' }>['approvals'] = [];
    for (const row of inspection.accounts) {
      if (row.checkedAt < Date.now() - 60_000 || row.checkedAt > Date.now() + 5000 || row.ownerWallet === null) throw new HostedError(503, 'ownership_unverified', 'Fresh account ownership could not be verified.');
      for (const [check, state] of Object.entries(row.checks)) if (state !== 'ready') blockers.push(`${row.account.venue} ${row.account.network} ${row.account.account}: ${check} ${state}`);
      if (row.account.venue === 'hl' && row.agentAddress && row.checks.registration !== 'ready') approvals.push({ kind: 'hyperliquid', network: row.account.network, account: row.account.account, agentAddress: row.agentAddress, agentName: 'Verdict Hosted' });
    }
    return ConnectAccountView.parse({ kind: 'executable', profileId: profile.id, revision: profileRevision(profile), mode: profile.mode,
      accounts: profile.accounts.map(({ venue, network, account }) => ({ venue, network, account: String(account) })), scopes, blockers, approvals,
      policy: { grantHash: inspection.authority.grantHash, expiresAt: inspection.authority.expiresAt, maxDebitUSDC: inspection.maxDebitUSDC, maxOrders: inspection.maxOrders,
        remainingDebitUSDC: inspection.authority.remainingDebitUSDC, remainingOrders: inspection.authority.remainingOrders, cancelOwnOrders: inspection.authority.cancelOwnOrders,
        templates: inspection.templates.map((template) => ({ digest: template.digest, confirmation: executionConfirmation(template).confirmation })) } });
  }
  private async connection(subject: string, wallet: string | null, scopes: Grant['scopes']): Promise<ConnectAccountView> {
    const enrollment = this.store.enrollment(subject, Enrollment);
    if (enrollment) {
      const profile = this.config.profiles.find((item) => item.id === enrollment.profileId && item.enabled);
      if (!profile || profileRevision(profile) !== enrollment.revision || (wallet !== null && enrollment.walletAddress !== wallet)) throw new HostedError(409, 'connection_changed', 'This account connection changed. Contact the operator.');
      const inspection = await this.inspectProfile(profile);
      if (!inspection.accounts.every((row) => row.ownerWallet === enrollment.walletAddress)) throw failure('ownership_changed');
      return this.view(profile, inspection, scopes);
    }
    if (wallet === null || !scopes.includes(TRADE_SCOPE)) return emptyView();
    const matches: { profile: Profile; inspection: ExecutionConnectionInspection }[] = [];
    for (const profile of this.config.profiles.filter((item) => item.enabled)) {
      const inspection = await this.inspectProfile(profile);
      if (inspection.accounts.every((row) => row.ownerWallet === wallet)) matches.push({ profile, inspection });
    }
    if (matches.length > 1) throw new HostedError(409, 'multiple_connections', 'Multiple trading profiles match this wallet. The operator must select one profile.');
    const match = matches[0]; return match ? this.view(match.profile, match.inspection, scopes) : emptyView();
  }
  private async statusSubject(subject: string): Promise<ConnectResponse> {
    let connection: ConnectAccountView;
    try { connection = await this.connection(subject, null, [READ_SCOPE, TRADE_SCOPE]); }
    catch (error) {
      if (error instanceof HostedError && error.code === 'authority_storage') throw error;
      connection = emptyView('Trading readiness is unavailable or changed. You can still disconnect clients below; this does not change their existing scopes or the broker policy.');
    }
    const connections = this.store.all('grant', Grant).filter((grant) => grant.subject === subject).map((grant) => ({ id: grant.id,
      clientName: this.client(grant.clientId)?.client_name || 'MCP client', scopes: grant.scopes, createdAt: grant.createdAt, expiresAt: grant.expiresAt,
      revoked: grant.revoked || grant.expiresAt <= Date.now() }));
    return ConnectResponse.parse({ protocol: CONNECT_PROTOCOL, kind: 'connections', connection, connections });
  }
  async status(principal: Principal) { this.assertActive(principal); return this.statusSubject(principal.subject); }
  async app(input: unknown, headers: { authorization?: string; session?: string; origin?: string }): Promise<ConnectResponse> {
    if (!headers.authorization || !safeEqual(headers.authorization, `Relay ${this.relaySecret}`) || headers.origin !== this.config.appOrigin || !/^[a-f0-9]{64}$/.test(headers.session ?? '')) throw new HostedError(403, 'invalid_relay', 'Invalid connection relay.');
    const request = ConnectRequest.parse(input); const appSession = headers.session ?? '';
    if (request.operation === 'view') {
      const tx = this.transaction(request.transaction);
      return ConnectTransactionView.parse({ protocol: CONNECT_PROTOCOL, kind: 'transaction', transaction: tx.id, purpose: tx.purpose, authorityOrigin: this.config.publicOrigin,
        client: { id: tx.clientId, name: tx.clientName, redirectUri: tx.redirectUri }, resource: tx.resource, scopes: tx.scopes, expiresAt: tx.expiresAt,
        cancelUrl: `${this.config.publicOrigin}/connect/cancel?transaction=${tx.id}` });
    }
    const subject = await this.identity(request.accessToken);
    if (request.operation === 'status') return this.statusSubject(subject);
    if (request.operation === 'disconnect') {
      this.store.transaction(() => { const grant = this.store.get('grant', request.connectionId, Grant); if (!grant || grant.subject !== subject) throw failure(); if (!grant.revoked) this.revoke(grant); });
      return { protocol: CONNECT_PROTOCOL, kind: 'disconnected' };
    }
    const tx = this.transaction(request.transaction);
    if ((tx.subject !== null && tx.subject !== subject) || (tx.appSession !== null && tx.appSession !== appSession)) throw failure();
    if (tx.purpose === 'review') {
      if (!tx.authorization || this.grant(tx.authorization.grantId, tx.authorization.epoch).subject !== subject) throw failure();
    }
    if (request.operation === 'challenge') {
      const connection = await this.connection(subject, request.walletAddress, tx.scopes); const reviewId = opaque();
      const message = `Connect Verdict agent\nTransaction: ${tx.id}\nReview: ${reviewId}\nPurpose: ${tx.purpose}\nClient: ${tx.clientId}\nRedirect: ${tx.redirectUri}\nResource: ${tx.resource}\nSubject: ${subject}\nWallet: ${request.walletAddress}\nPermissions: ${connection.scopes.join(' ')}\nReview digest: ${hash(JSON.stringify(connection))}\nExpires: ${tx.expiresAt}\nThis proof connects this client to the displayed account and limits. It never creates a broker policy or authorizes a withdrawal.`;
      const review = { protocol: CONNECT_PROTOCOL, kind: 'review' as const, transaction: tx.id, reviewId, expiresAt: tx.expiresAt, walletAddress: request.walletAddress, message, connection };
      this.store.transaction(() => { const current = this.transaction(tx.id); if (current.receiptHash !== null || (current.subject !== null && current.subject !== subject) || (current.appSession !== null && current.appSession !== appSession)) throw failure(); this.saveTransaction(Transaction.parse({ ...current, subject, appSession, review, connection })); });
      return review;
    }
    if (!tx.review || tx.review.reviewId !== request.reviewId || tx.receiptHash !== null || tx.subject !== subject || tx.appSession !== appSession) throw failure();
    const recovered = (await recoverMessageAddress({ message: tx.review.message, signature: request.signature as `0x${string}` })).toLowerCase();
    if (recovered !== tx.review.walletAddress) throw failure('invalid_wallet_proof');
    const fresh = await this.connection(subject, recovered, tx.scopes);
    if (!identical(fresh, tx.connection)) throw new HostedError(409, 'review_changed', 'Account readiness or policy changed. Review the updated connection.');
    const receipt = opaque();
    this.store.transaction(() => { const current = this.transaction(tx.id); if (!identical(current, tx)) throw failure(); this.saveTransaction({ ...current, receiptHash: hash(receipt) }); });
    const url = new URL(tx.purpose === 'oauth' ? '/connect/complete' : '/auth/callback', this.config.publicOrigin);
    url.searchParams.set('transaction', tx.id); url.searchParams.set('receipt', receipt);
    return { protocol: CONNECT_PROTOCOL, kind: 'complete', completionUrl: url.href };
  }
  private completion(url: URL, header: string | undefined, purpose: Transaction['purpose']) {
    if (url.origin !== this.config.publicOrigin || url.pathname !== (purpose === 'oauth' ? '/connect/complete' : '/auth/callback') || [...url.searchParams.keys()].some((key) => key !== 'transaction' && key !== 'receipt')
      || url.searchParams.getAll('transaction').length !== 1 || url.searchParams.getAll('receipt').length !== 1) throw failure();
    const tx = this.transaction(url.searchParams.get('transaction') ?? ''); const cookie = this.cookieValue(header, this.cookieName); const receipt = url.searchParams.get('receipt');
    if (tx.purpose !== purpose || !cookie || hash(cookie) !== tx.cookieHash || !receipt || !tx.receiptHash || hash(receipt) !== tx.receiptHash || !tx.subject || !tx.review || !tx.connection) throw failure();
    return tx;
  }
  complete(url: URL, cookieHeader: string | undefined): { location: string; cookies: string[] } {
    return this.store.transaction(() => {
      const tx = this.completion(url, cookieHeader, 'oauth'); if (!tx.subject || !tx.connection || !tx.review) throw failure();
      // Resolve the exact immutable reviewed profile, never a browser-supplied account selector.
      if (tx.connection.kind === 'executable') {
        const reviewed = tx.connection; const exact = this.config.profiles.find((item) => item.id === reviewed.profileId && item.enabled);
        if (!exact || profileRevision(exact) !== reviewed.revision || reviewed.policy.expiresAt <= Date.now()) throw failure();
        const enrollment = this.store.enrollment(tx.subject, Enrollment);
        if (enrollment && (enrollment.profileId !== reviewed.profileId || enrollment.revision !== reviewed.revision || enrollment.walletAddress !== tx.review.walletAddress)) throw failure();
        if (!enrollment) this.store.enroll(tx.subject, reviewed.profileId, { subject: tx.subject, profileId: reviewed.profileId, revision: reviewed.revision, walletAddress: tx.review.walletAddress });
      }
      const grant = Grant.parse({ id: randomUUID(), subject: tx.subject, clientId: tx.clientId, resource: this.resource,
        profileId: tx.connection.kind === 'executable' ? tx.connection.profileId : null, revision: tx.connection.kind === 'executable' ? tx.connection.revision : null,
        scopes: tx.connection.scopes, createdAt: Date.now(), expiresAt: Math.min(Date.now() + this.config.refreshTtlSeconds * 1000, tx.connection.kind === 'executable' ? tx.connection.policy.expiresAt : Number.MAX_SAFE_INTEGER), revoked: false, epoch: 0 });
      this.store.put('grant', grant.id, grant, grant.expiresAt); const code = opaque(); const expiresAt = Date.now() + 60_000;
      this.store.put('code', hash(code), { grantId: grant.id, epoch: grant.epoch, clientId: grant.clientId, resource: this.resource, scopes: grant.scopes, expiresAt, used: false, challenge: tx.challenge, redirectUri: tx.redirectUri }, expiresAt);
      this.saveTransaction({ ...tx, completed: true, receiptHash: null });
      const redirect = new URL(tx.redirectUri); redirect.searchParams.set('code', code); if (tx.state !== null) redirect.searchParams.set('state', tx.state); redirect.searchParams.set('iss', this.config.publicOrigin);
      return { location: redirect.href, cookies: [this.cookie(this.cookieName, '', 0)] };
    });
  }
  cancel(url: URL, header: string | undefined) {
    return this.store.transaction(() => {
      if (url.origin !== this.config.publicOrigin || url.pathname !== '/connect/cancel' || [...url.searchParams.keys()].some((key) => key !== 'transaction') || url.searchParams.getAll('transaction').length !== 1) throw failure();
      const tx = this.transaction(url.searchParams.get('transaction') ?? ''); const cookie = this.cookieValue(header, this.cookieName);
      if (!cookie || hash(cookie) !== tx.cookieHash) throw failure(); this.saveTransaction({ ...tx, completed: true, receiptHash: null });
      const redirect = new URL(tx.purpose === 'oauth' ? tx.redirectUri : '/connect/agent', tx.purpose === 'oauth' ? undefined : this.config.appOrigin);
      if (tx.purpose === 'oauth') { redirect.searchParams.set('error', 'access_denied'); if (tx.state !== null) redirect.searchParams.set('state', tx.state); }
      return { location: redirect.href, cookies: [this.cookie(this.cookieName, '', 0)] };
    });
  }
  login(returnPath: string) {
    const match = /^\/review\/([a-f0-9-]{36})$/.exec(returnPath); const identity = match?.[1] ? this.reviewLookup(match[1]) : null;
    if (!identity?.authorization) throw failure(); const grant = this.grant(identity.authorization.grantId, identity.authorization.epoch);
    if (identity.owner !== ownerHash(this.config.publicOrigin, grant.subject) || !grant.scopes.includes(TRADE_SCOPE)) throw failure();
    const client = this.client(grant.clientId); if (!client) throw failure();
    return this.newTransaction({ purpose: 'review', clientId: grant.clientId, clientName: client.client_name || 'MCP client', redirectUri: `${this.config.publicOrigin}${returnPath}`,
      scopes: grant.scopes, challenge: '', state: null, reviewPath: returnPath, authorization: identity.authorization });
  }
  async callback(url: URL, cookieHeader: string | undefined) {
    return this.store.transaction(() => {
      const tx = this.completion(url, cookieHeader, 'review'); if (!tx.authorization || !tx.reviewPath || !tx.subject) throw failure();
      const grant = this.grant(tx.authorization.grantId, tx.authorization.epoch); const job = this.reviewLookup(tx.reviewPath.slice('/review/'.length));
      if (grant.subject !== tx.subject || !job || !identical(job.authorization, tx.authorization) || job.owner !== ownerHash(this.config.publicOrigin, grant.subject)) throw failure();
      const session = opaque(); const expiresAt = Math.min(Date.now() + 600_000, grant.expiresAt);
      this.store.put('browser', hash(session), { authorization: tx.authorization, expiresAt }, expiresAt); this.saveTransaction({ ...tx, completed: true, receiptHash: null });
      return { location: tx.reviewPath, cookies: [this.cookie(this.cookieName, '', 0), this.cookie(this.browserName, session, Math.floor((expiresAt - Date.now()) / 1000))] };
    });
  }
  readSession(header: string | undefined): BrowserSession | null {
    const cookie = this.cookieValue(header, this.browserName); if (!cookie) return null;
    const browser = this.store.get('browser', hash(cookie), Browser); if (!browser || browser.expiresAt <= Date.now()) return null;
    try {
      const grant = this.grant(browser.authorization.grantId, browser.authorization.epoch);
      return { principal: this.principal(grant, grant.scopes, browser.expiresAt), csrf: createHmac('sha256', this.relaySecret).update(`review-csrf\0${cookie}`).digest('base64url'), expiresAt: browser.expiresAt };
    } catch { return null; }
  }
}
