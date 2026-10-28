import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { recoverMessageAddress } from 'viem';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokenRevocationRequest, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { connectExecution, ExecutionConnectionInspection, executionConfirmation } from '@verdict/core';
import { CONNECT_PROTOCOL, ConnectAccountView, ConnectRequest, ConnectResponse, ConnectTransactionView, LighterSetup, type LighterSetupState } from './connect-contract.js';
import { AccountServiceConfig, Grant, Transaction, Profile, failure, hash, opaque, ownerHash } from './connect-model.js';
import { ConnectStore, type AuthorityRepository, type ConnectReadTx, type ConnectWriteTx } from './connect-store.js';
import { Binding, HostedError, Principal, READ_SCOPE, TRADE_SCOPE, requireScope, type BrowserSession, type ConnectorScope, type Job } from './hosted-model.js';
import type { HostedRuntime, ReviewJobIdentity, SharedPublicTransaction } from './hosted-security.js';
import { createPrivyIdentity } from './privy-identity.js';
import { LighterProvisioner, type ProvisionerSetup } from './lighter-provisioner.js';
import { PrivateSignerClient } from './private-signer-client.js';
import { requireLighterProposal } from './lighter-execution-boundary.js';
const emptyView = (reason = 'No verified trading account is provisioned. This connection permits research only.'): ConnectAccountView => ({ kind: 'read_only', reason, scopes: [READ_SCOPE] });
const profileRevision = (profile: Profile) => hash(JSON.stringify(profile));
const identical = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const safeEqual = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const transactionLifetime = 300000;
const onboardingLifetime = 30 * 60_000;
type Inspect = (profile: Profile, subject?: string) => Promise<ExecutionConnectionInspection>;
type Provisioner = Pick<LighterProvisioner, 'setup' | 'preview' | 'activate' | 'binding' | 'revoke'>;
/** Product account authorization; independent from Privy JWTs and from broker trade policy. */
export class AccountAuthority implements OAuthServerProvider, HostedRuntime {
    readonly auth = this;
    readonly resource: string;
    private reviewLookup: (id: string) => Promise<ReviewJobIdentity | null> = async () => null;
    private readonly cookieName: string;
    private readonly browserName: string;
    private readonly secure: boolean;
    private constructor(readonly config: AccountServiceConfig, private readonly store: AuthorityRepository, private readonly verifyIdentity: (token: string) => Promise<string>, private readonly relaySecret: string, private readonly inspect: Inspect, private readonly provisioner: Provisioner | null) {
        this.resource = `${config.publicOrigin}/mcp`;
        this.secure = new URL(config.publicOrigin).protocol === 'https:';
        this.cookieName = this.secure ? '__Host-verdict-connect' : 'verdict_connect';
        this.browserName = this.secure ? '__Host-verdict-review' : 'verdict_review';
    }
    static async create(input: AccountServiceConfig, inspect?: Inspect, provisioner?: Provisioner, repository?: AuthorityRepository): Promise<AccountAuthority> {
        const config = AccountServiceConfig.parse(input); const secret = process.env[config.relaySecretEnv];
        if (!secret || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) throw new HostedError(503, 'relay_configuration', 'Configure a private random relay secret of at least 32 bytes.');
        const verifyIdentity = await createPrivyIdentity(config);
        const store = repository ?? (config.storage.kind === 'local' ? new ConnectStore(config.storage.stateDir) : null);
        if (!store) throw new HostedError(503, 'authority_storage', 'PostgreSQL account authority requires an explicitly provisioned repository.');
        const remote = config.lighterProvisioner?.kind === 'hosted_signer' ? new PrivateSignerClient(config.lighterProvisioner) : null;
        const inspectProfile: Inspect = inspect ?? (async (profile, subject) => {
            const client = profile.execution.kind === 'local_socket'
                ? await connectExecution({ expectedMode: 'policy', expectedGrantId: profile.grantId, socketPath: profile.execution.socketPath })
                : remote && subject ? await remote.connect(Binding.parse({ ...profile, subject })) : null;
            if (!client) throw new HostedError(503, 'private_signer_unavailable', 'The configured private trading connection is unavailable.');
            return client.inspectConnection();
        });
        return new AccountAuthority(config, store, verifyIdentity, secret, inspectProfile, provisioner ?? (config.lighterProvisioner ? new LighterProvisioner(config.lighterProvisioner) : null));
    }
    close() { return this.store.close(); }
    setReviewLookup(lookup: (id: string) => ReviewJobIdentity | null | Promise<ReviewJobIdentity | null>) { this.reviewLookup = async (id) => lookup(id); }
    metadata() { return { resource: this.resource, authorization_servers: [this.config.publicOrigin], scopes_supported: [READ_SCOPE, TRADE_SCOPE], bearer_methods_supported: ['header'] }; }
    challenge(scope: ConnectorScope, code?: string) {
        const error = code === 'invalid_token' || code === 'insufficient_scope' ? `, error="${code}"` : '';
        return `Bearer resource_metadata="${this.config.publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="${scope === TRADE_SCOPE ? `${READ_SCOPE} ${TRADE_SCOPE}` : READ_SCOPE}"${error}`;
    }
    private cookie(name: string, value: string, seconds: number) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`; }
    private cookieValue(header: string | undefined, name: string): string | null {
        if (!header || header.length > 16384)
            return null;
        const matches = header.split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${name}=`));
        const value = matches[0]?.slice(name.length + 1);
        return matches.length === 1 && value && ConnectRequest.options[0].shape.transaction.safeParse(value).success ? value : null;
    }
    private crypt(value: string, decrypt = false): string {
        const key = createHash('sha256').update(`verdict-client-secret\0${this.relaySecret}`).digest();
        if (decrypt) {
            const bytes = Buffer.from(value, 'base64url');
            if (bytes.length < 29)
                throw failure();
            const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
            cipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
        }
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    }
    private async client(db: ConnectReadTx, clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const record = await db.get('client', clientId);
        if (!record)
            return undefined;
        const metadata = OAuthClientInformationFullSchema.parse(record.metadata);
        return record.secret === null ? metadata : { ...metadata, client_secret: this.crypt(record.secret, true) };
    }
    get clientsStore() {
        return { getClient: async (id: string) => await this.store.read(db => this.client(db, id)), registerClient: async (input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> => {
                if (!input.redirect_uris.length || input.redirect_uris.length > 16 || (input.client_name?.length ?? 0) > 256
                    || !['none', 'client_secret_post', 'client_secret_basic'].includes(input.token_endpoint_auth_method ?? 'client_secret_post'))
                    throw new InvalidClientMetadataError('Unsupported client metadata.');
                for (const value of input.redirect_uris) {
                    const url = new URL(value);
                    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
                    if (value.length > 2048 || url.username || url.password || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')))
                        throw new InvalidClientMetadataError('Use exact HTTPS or native loopback redirect URIs.');
                }
                const client = OAuthClientInformationFullSchema.parse({ ...input, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) });
                const { client_secret: secret, ...metadata } = client;
                await this.store.write([], async (db) => db.put('client', client.client_id, { metadata, secret: secret === undefined ? null : this.crypt(secret) }, Date.now() + 2592000000));
                return client;
            } };
    }
    private resourceCheck(resource: URL | undefined) { if (resource?.href !== this.resource)
        throw new InvalidTargetError('Request the exact MCP resource.'); }
    private scopes(values: string[] | undefined): (typeof READ_SCOPE | typeof TRADE_SCOPE)[] {
        const scopes = values ?? [READ_SCOPE];
        if (!scopes.includes(READ_SCOPE) || scopes.some((value) => value !== READ_SCOPE && value !== TRADE_SCOPE) || new Set(scopes).size !== scopes.length)
            throw new InvalidScopeError('Request verdict:read and optionally verdict:trade.');
        return scopes.includes(TRADE_SCOPE) ? [READ_SCOPE, TRADE_SCOPE] : [READ_SCOPE];
    }
    private appLocation(id: string) {
        const url = new URL('/connect/agent', this.config.appOrigin);
        url.searchParams.set('transaction', id);
        url.searchParams.set('net', this.config.appNetwork);
        return url.href;
    }
    private restartLocation(tx: Transaction): string {
        const url = new URL('/authorize', this.config.publicOrigin);
        url.search = new URLSearchParams({ response_type: 'code', client_id: tx.clientId, redirect_uri: tx.redirectUri,
            scope: tx.scopes.join(' '), resource: tx.resource, code_challenge: tx.challenge, code_challenge_method: 'S256',
            ...(tx.state === null ? {} : { state: tx.state }) }).toString();
        return url.href;
    }
    private async newTransaction(input: Pick<Transaction, 'purpose' | 'clientId' | 'clientName' | 'redirectUri' | 'scopes' | 'challenge' | 'state' | 'reviewPath' | 'authorization'>) {
        const cookie = opaque();
        const lifetime = input.purpose === 'oauth' && input.scopes.includes(TRADE_SCOPE)
            && this.config.appNetwork === 'lighter-testnet' && this.config.lighterProvisioner ? onboardingLifetime : transactionLifetime;
        const transaction = Transaction.parse({ ...input, id: opaque(), resource: this.resource,
            cookieHash: hash(cookie), expiresAt: Date.now() + lifetime, completed: false, subject: null, appSession: null, review: null, connection: null, receiptHash: null });
        await this.store.write([], async (db) => { if (input.authorization) await this.grant(db, input.authorization.grantId, input.authorization.epoch); await this.saveTransaction(db, transaction); });
        return { location: this.appLocation(transaction.id), cookies: [this.cookie(this.cookieName, cookie, lifetime / 1000)] };
    }
    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
        this.resourceCheck(params.resource);
        const scopes = this.scopes(params.scopes);
        if (!client.redirect_uris.includes(params.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2048)
            throw new InvalidGrantError('Invalid authorization request.');
        const result = await this.newTransaction({ purpose: 'oauth', clientId: client.client_id, clientName: client.client_name || 'MCP client', redirectUri: params.redirectUri,
            scopes, challenge: params.codeChallenge, state: params.state ?? null, reviewPath: null, authorization: null });
        res.setHeader('Set-Cookie', result.cookies);
        res.redirect(303, result.location);
    }
    private async saveTransaction(db: ConnectWriteTx, value: Transaction) { await db.put('transaction', value.id, value, value.expiresAt); }
    private async transaction(db: ConnectReadTx, id: string): Promise<Transaction> {
        const tx = await db.get('transaction', id);
        if (!tx || tx.completed || tx.expiresAt <= Date.now())
            throw failure();
        return tx;
    }
    private async profile(db: ConnectReadTx, id: string): Promise<Profile | null> {
        return this.config.profiles.find((item) => item.id === id && item.enabled) ?? (await db.get('managed-profile', id))?.profile ?? null;
    }
    private async grant(db: ConnectReadTx, id: string, epoch?: number): Promise<Grant> {
        const grant = await db.get('grant', id);
        if (!grant || grant.revoked || grant.expiresAt <= Date.now() || (epoch !== undefined && grant.epoch !== epoch))
            throw new InvalidTokenError('Connection expired or revoked.');
        if (grant.profileId !== null) {
            const profile = await this.profile(db, grant.profileId);
            const enrollment = await db.enrollment(grant.subject);
            if (!profile || profileRevision(profile) !== grant.revision || enrollment?.profileId !== profile.id || enrollment.revision !== grant.revision)
                throw new InvalidTokenError('Trading connection changed.');
        }
        return grant;
    }
    private principal(grant: Grant, scopes: Grant['scopes'], expiresAt: number): Principal {
        return Principal.parse({ issuer: this.config.publicOrigin, subject: grant.subject, scopes, expiresAt: Math.min(expiresAt, grant.expiresAt), authorization: { kind: 'first_party', grantId: grant.id, epoch: grant.epoch } });
    }
    assertActive(principal: Principal): Promise<void> { return this.store.read(db => this.checkPrincipal(db, principal)); }
    assertJobActive(job: Job): Promise<void> { return this.store.read(db => this.checkJob(db, job)); }
    binding(subject: string): Promise<Binding | null> { return this.store.read(db => this.bindingIn(db, subject)); }
    withJobAuthorization<T>(job: Job, callback: (tx: SharedPublicTransaction) => Promise<T>): Promise<T> {
        return this.store.write([`grant:${job.authorization?.grantId ?? 'missing'}`, `job:${job.id}`], async db => {
            await this.checkJob(db, job); return callback(db.transaction);
        });
    }
    private async checkPrincipal(db: ConnectReadTx, principal: Principal): Promise<void> {
        try {
            if (principal.issuer !== this.config.publicOrigin || !principal.authorization || principal.expiresAt <= Date.now())
                throw new InvalidTokenError('Invalid connection.');
            const grant = await this.grant(db, principal.authorization.grantId, principal.authorization.epoch);
            if (grant.subject !== principal.subject || principal.scopes.some((scope) => !grant.scopes.includes(scope as typeof READ_SCOPE | typeof TRADE_SCOPE)))
                throw new InvalidTokenError('Invalid connection.');
        }
        catch (error) {
            if (error instanceof HostedError)
                throw error;
            throw new HostedError(401, 'invalid_token', 'This connection expired, changed or was revoked.');
        }
    }
    private async checkJob(db: ConnectReadTx, job: Job) {
        if (!job.authorization)
            throw new HostedError(403, 'connection_revoked', 'This order has no current first-party authorization.');
        let grant: Grant;
        try {
            grant = await this.grant(db, job.authorization.grantId, job.authorization.epoch);
        }
        catch (error) {
            if (error instanceof HostedError)
                throw error;
            throw new HostedError(403, 'connection_revoked', 'The original order connection has been revoked.');
        }
        if (job.owner !== ownerHash(this.config.publicOrigin, grant.subject) || !grant.scopes.includes(TRADE_SCOPE))
            throw new HostedError(403, 'connection_revoked', 'The original order connection has been revoked.');
    }
    private async bindingIn(db: ConnectReadTx, subject: string): Promise<Binding | null> {
        const enrollment = await db.enrollment(subject);
        if (!enrollment)
            return null;
        const profile = await this.profile(db, enrollment.profileId);
        return profile && profileRevision(profile) === enrollment.revision ? Binding.parse({ ...profile, subject }) : null;
    }
    async ensureBinding(principal: Principal): Promise<void> {
        await this.assertActive(principal);
        const enrollment = await this.store.read(db => db.enrollment(principal.subject));
        if (!enrollment || !await this.store.read(db => db.get('managed-profile', enrollment.profileId)))
            return;
        const current = await this.binding(principal.subject);
        const actual = await this.provisioner?.binding(principal.subject);
        await this.assertActive(principal);
        if (!current || !actual || !identical(current, actual))
            throw new HostedError(503, 'connection_changed', 'The original hosted trading connection is unavailable or changed.');
    }
    private async credential(db: ConnectReadTx, namespace: 'access' | 'refresh', value: string) { return /^[A-Za-z0-9_-]{43}$/.test(value) ? await db.get(namespace, hash(value)) : null; }
    private async access(db: ConnectReadTx, token: string) {
        const credential = await this.credential(db, 'access', token);
        if (!credential || credential.used || credential.expiresAt <= Date.now() || credential.resource !== this.resource)
            throw new InvalidTokenError('Invalid resource token.');
        const grant = await this.grant(db, credential.grantId, credential.epoch);
        if (grant.clientId !== credential.clientId || credential.scopes.some((scope) => !grant.scopes.includes(scope)))
            throw new InvalidTokenError('Invalid resource token.');
        return { credential, principal: this.principal(grant, credential.scopes, credential.expiresAt) };
    }
    async verifyAccessToken(token: string) {
        const { credential } = await this.store.read(db => this.access(db, token));
        return { token, clientId: credential.clientId, scopes: credential.scopes, expiresAt: credential.expiresAt / 1000, resource: new URL(this.resource) };
    }
    async authenticate(header: string | undefined, scope: ConnectorScope) {
        try {
            const match = header && header.length < 128 ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header) : null;
            if (!match?.[1])
                throw new Error();
            const token = match[1];
            const { principal } = await this.store.read(db => this.access(db, token));
            requireScope(principal, scope);
            return principal;
        }
        catch (error) {
            if (error instanceof HostedError && error.code === 'insufficient_scope')
                throw error;
            throw new HostedError(401, 'invalid_token', 'Sign in with a current MCP resource token.');
        }
    }
    private async issue(db: ConnectWriteTx, grant: Grant, scopes: Grant['scopes']): Promise<OAuthTokens> {
        const access = opaque();
        const refresh = opaque();
        const expiresAt = Math.min(Date.now() + 300000, grant.expiresAt);
        const credential = { grantId: grant.id, epoch: grant.epoch, clientId: grant.clientId, resource: this.resource, scopes, used: false };
        await db.put('access', hash(access), { ...credential, expiresAt }, expiresAt);
        await db.put('refresh', hash(refresh), { ...credential, expiresAt: grant.expiresAt }, grant.expiresAt);
        return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)), scope: scopes.join(' ') };
    }
    async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
        const record = await this.store.read(db => db.get('code', hash(code)));
        if (!record || record.used || record.clientId !== client.client_id || record.expiresAt <= Date.now())
            throw new InvalidGrantError('Invalid authorization code.');
        await this.store.read(db => this.grant(db, record.grantId, record.epoch));
        return record.challenge;
    }
    async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
        this.resourceCheck(resource);
        return await this.store.write([], async (db) => {
            const record = await db.get('code', hash(code));
            if (!record || record.used || record.clientId !== client.client_id || record.redirectUri !== redirectUri || record.expiresAt <= Date.now())
                throw new InvalidGrantError('Invalid authorization code.');
            const grant = await this.grant(db, record.grantId, record.epoch);
            if (grant.clientId !== client.client_id || grant.resource !== record.resource || record.scopes.some((scope) => !grant.scopes.includes(scope)))
                throw new InvalidGrantError('Invalid authorization code.');
            await db.put('code', hash(code), { ...record, used: true }, record.expiresAt);
            return await this.issue(db, grant, record.scopes);
        });
    }
    private async revoke(db: ConnectWriteTx, grant: Grant) { await db.put('grant', grant.id, { ...grant, revoked: true, epoch: grant.epoch + 1 }, grant.expiresAt); }
    async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
        this.resourceCheck(resource);
        const result = await this.store.write([], async (db) => {
            const record = await this.credential(db, 'refresh', token);
            if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now())
                return null;
            const grant = await this.grant(db, record.grantId, record.epoch);
            if (grant.clientId !== client.client_id || grant.resource !== record.resource)
                throw new InvalidGrantError('Invalid refresh token.');
            if (record.used) {
                await this.revoke(db, grant);
                return null;
            } // Commit replay revocation before returning invalid_grant.
            const narrowed = scopes === undefined ? record.scopes : this.scopes(scopes);
            if (narrowed.some((scope) => !record.scopes.includes(scope)))
                throw new InvalidScopeError('Refresh cannot widen scopes.');
            await db.put('refresh', hash(token), { ...record, used: true }, record.expiresAt);
            return await this.issue(db, grant, narrowed);
        });
        if (!result)
            throw new InvalidGrantError('Invalid refresh token.');
        return result;
    }
    async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
        await this.store.write([], async (db) => {
            const credential = await this.credential(db, 'access', request.token) ?? await this.credential(db, 'refresh', request.token);
            if (!credential || credential.clientId !== client.client_id)
                return;
            const grant = await db.get('grant', credential.grantId);
            if (grant && !grant.revoked)
                await this.revoke(db, grant);
        });
    }
    private async identity(token: string): Promise<string> {
        return this.verifyIdentity(token);
    }
    private async verifiedWallet(subject: string) {
        return this.store.read(async db => (await db.get('onboarding', subject))?.walletAddress ?? (await db.enrollment(subject))?.walletAddress ?? null);
    }
    private async inspectProfile(profile: Profile, subject: string): Promise<ExecutionConnectionInspection> {
        if (profile.accounts.some((account) => account.venue !== 'lighter' || account.network !== (this.config.appNetwork === 'lighter-testnet' ? 'testnet' : 'mainnet'))) throw new HostedError(403, 'lighter_account_required', 'Connect a Lighter account to trade on Verdict.');
        const managed = await this.store.read(db => db.get('managed-profile', profile.id));
        if (managed) {
            const actual = await this.provisioner?.binding(managed.subject);
            if (!actual || !identical(actual, Binding.parse({ ...profile, subject: managed.subject })))
                throw new HostedError(503, 'profile_unavailable', 'The original isolated trading broker is unavailable.');
        }
        const inspection = ExecutionConnectionInspection.parse(await this.inspect(profile, subject));
        if (inspection.authority.grantId !== profile.grantId || inspection.authority.grantHash !== profile.grantHash
            || inspection.authority.newRisk !== 'active' || inspection.authority.expiresAt <= Date.now())
            throw new HostedError(503, 'profile_unavailable', 'The operator trading policy is unavailable or has changed.');
        const accountKey = (value: unknown) => JSON.stringify(value);
        if (!identical(inspection.accounts.map((row) => accountKey(row.account)).sort(), profile.accounts.map(accountKey).sort()))
            throw new HostedError(503, 'profile_mismatch', 'The broker accounts do not match the provisioned connection.');
        for (const template of inspection.templates)
            requireLighterProposal(template);
        if ('scope' in inspection && (inspection.scope.mode !== profile.mode || inspection.scope.origin !== this.config.publicOrigin
            || inspection.accounts.some((row) => row.account.venue !== 'lighter' || row.account.network !== inspection.scope.network
                || row.account.account !== inspection.scope.account || row.account.apiKeyIndex !== inspection.scope.apiKeyIndex || row.ownerWallet !== inspection.scope.ownerWallet)))
            throw new HostedError(503, 'profile_mismatch', 'The consumer trading scope does not match its account, mode or owner.');
        return inspection;
    }
    private view(profile: Profile, inspection: ExecutionConnectionInspection, scopes: Grant['scopes']): ConnectAccountView {
        const blockers: string[] = [];
        const approvals: Extract<ConnectAccountView, {
            kind: 'executable';
        }>['approvals'] = [];
        for (const row of inspection.accounts) {
            if (row.checkedAt < Date.now() - 60000 || row.checkedAt > Date.now() + 5000 || row.ownerWallet === null)
                throw new HostedError(503, 'ownership_unverified', 'Fresh account ownership could not be verified.');
            for (const [check, state] of Object.entries(row.checks))
                if (state !== 'ready')
                    blockers.push(`${row.account.venue} ${row.account.network} ${row.account.account}: ${check} ${state}`);
        }
        return ConnectAccountView.parse({ kind: 'executable', profileId: profile.id, revision: profileRevision(profile), mode: profile.mode,
            accounts: profile.accounts.map(({ venue, network, account }) => ({ venue, network, account: String(account) })), scopes, blockers, approvals,
            policy: { grantHash: inspection.authority.grantHash, expiresAt: inspection.authority.expiresAt, maxDebitUSDC: inspection.maxDebitUSDC, maxOrders: inspection.maxOrders,
                remainingDebitUSDC: inspection.authority.remainingDebitUSDC, remainingOrders: inspection.authority.remainingOrders, cancelOwnOrders: inspection.authority.cancelOwnOrders,
                templates: inspection.templates.map((template) => ({ digest: template.digest, confirmation: executionConfirmation(template).confirmation })),
                scope: 'scope' in inspection ? inspection.scope : { kind: 'ordered_templates' } } });
    }
    private async connection(subject: string, wallet: string | null, scopes: Grant['scopes']): Promise<ConnectAccountView> {
        const enrollment = await this.store.read(db => db.enrollment(subject));
        if (enrollment) {
            const profile = await this.store.read(db => this.profile(db, enrollment.profileId));
            if (!profile || profileRevision(profile) !== enrollment.revision || (wallet !== null && enrollment.walletAddress !== wallet))
                throw new HostedError(409, 'connection_changed', 'This account connection changed. Contact the operator.');
            const inspection = await this.inspectProfile(profile, subject);
            if (!inspection.accounts.every((row) => row.ownerWallet === enrollment.walletAddress))
                throw failure('ownership_changed');
            return this.view(profile, inspection, scopes);
        }
        if (wallet === null || !scopes.includes(TRADE_SCOPE))
            return emptyView();
        const matches: {
            profile: Profile;
            inspection: ExecutionConnectionInspection;
        }[] = [];
        for (const profile of this.config.profiles.filter((item) => item.enabled)) {
            const inspection = await this.inspectProfile(profile, subject);
            if (inspection.accounts.every((row) => row.ownerWallet === wallet))
                matches.push({ profile, inspection });
        }
        if (matches.length > 1)
            throw new HostedError(409, 'multiple_connections', 'Multiple trading profiles match this wallet. The operator must select one profile.');
        const match = matches[0];
        return match ? this.view(match.profile, match.inspection, scopes) : emptyView();
    }
    private async statusSubject(subject: string): Promise<ConnectResponse> {
        let connection: ConnectAccountView;
        try {
            connection = await this.connection(subject, null, [READ_SCOPE, TRADE_SCOPE]);
        }
        catch (error) {
            if (error instanceof HostedError && error.code === 'authority_storage')
                throw error;
            connection = emptyView('Trading readiness is unavailable or changed. You can still disconnect clients below; this does not change their existing scopes or the broker policy.');
        }
        const connections = await this.store.read(async db => {
            const connections = [];
            for (const grant of (await db.all('grant')).filter(grant => grant.subject === subject)) {
                connections.push({ id: grant.id, clientName: (await this.client(db, grant.clientId))?.client_name || 'MCP client',
                    scopes: grant.scopes, createdAt: grant.createdAt, expiresAt: grant.expiresAt, revoked: grant.revoked || grant.expiresAt <= Date.now() });
            }
            return connections;
        });
        return ConnectResponse.parse({ protocol: CONNECT_PROTOCOL, kind: 'connections', connection, connections });
    }
    async status(principal: Principal) { await this.assertActive(principal); return this.statusSubject(principal.subject); }
    private async setupView(tx: Transaction, subject: string, setup: ProvisionerSetup): Promise<ConnectResponse> {
        if (!tx.lighter || setup.enrollmentId !== tx.lighter.enrollmentId || setup.ownerWallet !== tx.lighter.walletAddress || setup.network !== 'testnet')
            throw failure();
        let state: LighterSetupState;
        if (setup.state === 'funding_required')
            state = { kind: 'funding_signature', enrollmentId: setup.enrollmentId, revision: setup.revision,
                owner: setup.ownerWallet, network: setup.network, message: setup.message, expiresAt: setup.expiresAt };
        else if (setup.state === 'signature_required')
            state = { kind: 'owner_signature', registration: {
                    enrollmentId: setup.enrollmentId, revision: setup.revision, owner: setup.ownerWallet, network: setup.network, chainId: setup.chainId,
                    accountIndex: setup.account, apiKeyIndex: setup.apiKeyIndex, publicKey: setup.publicKey, nonce: setup.nonce, message: setup.message, expiresAt: setup.expiresAt,
                    ...(setup.replacesPublicKey === undefined ? {} : { replacesPublicKey: setup.replacesPublicKey })
                } };
        else if (setup.state === 'registering')
            state = { kind: 'registration_pending', enrollmentId: setup.enrollmentId };
        else if (setup.state === 'blocked')
            state = { kind: 'blocked', enrollmentId: setup.enrollmentId, code: 'lighter_setup_blocked', message: setup.reason };
        else {
            const plan = await this.provisioner?.preview(subject, setup.enrollmentId);
            if (!plan || plan.enrollmentId !== setup.enrollmentId || plan.ownerWallet !== setup.ownerWallet || plan.scope.origin !== this.config.publicOrigin
                || plan.scope.ownerWallet !== setup.ownerWallet || plan.scope.account !== setup.account || plan.scope.apiKeyIndex !== setup.apiKeyIndex
                || plan.scope.enrollmentId !== setup.enrollmentId || plan.scope.network !== setup.network)
                throw failure();
            if (plan.expiresAt <= Date.now())
                return LighterSetup.parse({ protocol: CONNECT_PROTOCOL, kind: 'lighter_setup', transaction: tx.id, state: {
                    kind: 'blocked', enrollmentId: setup.enrollmentId, code: 'limits_expired',
                    message: 'Your account and trading key are ready. The trading permission expired; review a renewal to continue. No funds or key registration will be requested again.' } });
            const enrollment = await this.store.read(db => db.enrollment(subject));
            if (enrollment?.profileId === plan.planId)
                return LighterSetup.parse({ protocol: CONNECT_PROTOCOL, kind: 'lighter_setup', transaction: tx.id,
                    state: { kind: 'ready', connection: await this.connection(subject, tx.lighter.walletAddress, tx.scopes) } });
            await this.store.write([], async (db) => {
                const current = await this.transaction(db, tx.id);
                if (!identical(current, tx) || !current.lighter || current.subject !== subject || current.appSession !== tx.appSession)
                    throw failure();
                await this.saveTransaction(db, { ...current, lighter: { ...current.lighter, plan } });
            });
            state = { kind: 'scope_signature', plan };
        }
        return LighterSetup.parse({ protocol: CONNECT_PROTOCOL, kind: 'lighter_setup', transaction: tx.id, state });
    }
    private async lighterApp(request: Extract<ConnectRequest, {
        operation: 'lighter_setup' | 'lighter_faucet' | 'lighter_register' | 'lighter_status' | 'lighter_renew' | 'lighter_activate';
    }>, tx: Transaction, subject: string): Promise<ConnectResponse> {
        if (!this.provisioner || !this.config.lighterProvisioner || this.config.appNetwork !== 'lighter-testnet' || tx.purpose !== 'oauth' || !tx.scopes.includes(TRADE_SCOPE) || tx.receiptHash !== null)
            throw failure();
        if (request.operation === 'lighter_setup') {
            if (!tx.review || tx.review.expiresAt <= Date.now() || tx.review.reviewId !== request.reviewId || tx.subject !== subject)
                throw failure();
            const owner = (await recoverMessageAddress({ message: tx.review.message, signature: request.signature as `0x${string}` })).toLowerCase();
            if (owner !== tx.review.walletAddress || (tx.lighter && tx.lighter.walletAddress !== owner))
                throw failure('invalid_wallet_proof');
            if (tx.lighter)
                return this.setupView(tx, subject, await this.provisioner.setup({ operation: 'status', subject, enrollmentId: tx.lighter.enrollmentId }));
            const setup = await this.provisioner.setup({ operation: 'prepare', subject, walletAddress: owner });
            if (setup.ownerWallet !== owner)
                throw failure();
            const updated = await this.store.write([], async (db) => {
                const current = await this.transaction(db, tx.id);
                if (!identical(current, tx))
                    throw failure();
                const next = { ...current, lighter: { enrollmentId: setup.enrollmentId, walletAddress: owner, proofReviewId: request.reviewId, plan: null, activatedProfileId: null } };
                await db.put('onboarding', subject, { subject, walletAddress: owner, enrollmentId: setup.enrollmentId }, Number.MAX_SAFE_INTEGER);
                await this.saveTransaction(db, next);
                return next;
            });
            return this.setupView(updated, subject, setup);
        }
        if (!tx.lighter || tx.subject !== subject)
            throw failure();
        if (request.operation === 'lighter_status')
            return this.setupView(tx, subject, await this.provisioner.setup({ operation: 'status', subject, enrollmentId: tx.lighter.enrollmentId }));
        if (request.operation === 'lighter_renew') {
            await this.provisioner.preview(subject, tx.lighter.enrollmentId, true);
            return this.setupView(tx, subject, await this.provisioner.setup({ operation: 'status', subject, enrollmentId: tx.lighter.enrollmentId }));
        }
        if (request.enrollmentId !== tx.lighter.enrollmentId)
            throw failure();
        if (request.operation !== 'lighter_activate')
            return this.setupView(tx, subject, await this.provisioner.setup({ operation: request.operation === 'lighter_faucet' ? 'faucet' : 'register',
                subject, enrollmentId: request.enrollmentId, revision: request.revision, signature: request.signature }));
        const plan = tx.lighter.plan;
        if (!plan || plan.planId !== request.planId || plan.revision !== request.revision || plan.expiresAt <= Date.now())
            throw failure();
        const binding = await this.provisioner.activate({ operation: 'activate', subject, enrollmentId: request.enrollmentId, planId: request.planId, revision: request.revision, signature: request.signature });
        const { subject: ownerSubject, ...fields } = binding;
        const profile = Profile.parse(fields);
        if (ownerSubject !== subject || profile.id !== plan.planId || profile.mode !== plan.scope.mode || this.config.profiles.some((item) => item.id === profile.id))
            throw failure();
        const inspection = await this.inspectProfile(profile, subject);
        if (!('scope' in inspection) || !identical(inspection.scope, plan.scope) || inspection.maxDebitUSDC !== plan.limits.maxDebitUSDC
            || inspection.maxOrders !== plan.limits.maxOrders || inspection.authority.expiresAt !== plan.limits.expiresAt
            || inspection.authority.cancelOwnOrders !== plan.limits.cancelOwnOrders || inspection.accounts.some((row) => row.ownerWallet !== tx.lighter?.walletAddress || row.checks.registration !== 'ready' || row.checks.builder !== 'ready'))
            throw failure();
        await this.store.write([], async (db) => {
            const current = await this.transaction(db, tx.id);
            if (!identical(current, tx) || !current.lighter || current.subject !== subject || current.appSession !== tx.appSession)
                throw failure();
            const previous = await db.enrollment(subject);
            if (previous && previous.profileId !== profile.id)
                for (const grant of (await db.all('grant')).filter((grant) => grant.subject === subject && !grant.revoked))
                    await this.revoke(db, grant);
            await db.put('managed-profile', profile.id, { subject, walletAddress: current.lighter.walletAddress, profile }, inspection.authority.expiresAt);
            await db.replaceEnrollment(subject, profile.id, { subject, profileId: profile.id, revision: profileRevision(profile), walletAddress: current.lighter.walletAddress });
            await this.saveTransaction(db, { ...current, lighter: { ...current.lighter, activatedProfileId: profile.id } });
        });
        return LighterSetup.parse({ protocol: CONNECT_PROTOCOL, kind: 'lighter_setup', transaction: tx.id,
            state: { kind: 'ready', connection: await this.connection(subject, tx.lighter.walletAddress, tx.scopes) } });
    }
    async app(input: unknown, headers: {
        authorization?: string;
        session?: string;
        origin?: string;
    }): Promise<ConnectResponse> {
        if (!headers.authorization || !safeEqual(headers.authorization, `Relay ${this.relaySecret}`) || headers.origin !== this.config.appOrigin || !/^[a-f0-9]{64}$/.test(headers.session ?? ''))
            throw new HostedError(403, 'invalid_relay', 'Invalid connection relay.');
        const request = ConnectRequest.parse(input);
        const appSession = headers.session ?? '';
        if (request.operation === 'view') {
            const tx = await this.store.read(db => this.transaction(db, request.transaction));
            return ConnectTransactionView.parse({ protocol: CONNECT_PROTOCOL, kind: 'transaction', transaction: tx.id, purpose: tx.purpose, authorityOrigin: this.config.publicOrigin,
                client: { id: tx.clientId, name: tx.clientName, redirectUri: tx.redirectUri }, resource: tx.resource, scopes: tx.scopes, expiresAt: tx.expiresAt,
                cancelUrl: `${this.config.publicOrigin}/connect/cancel?transaction=${tx.id}`,
                ...(tx.purpose === 'oauth' && tx.scopes.includes(TRADE_SCOPE) && this.provisioner && this.config.appNetwork === 'lighter-testnet' ? { selfServiceLighter: true } : {}),
                ...(tx.purpose === 'oauth' ? { restartUrl: this.restartLocation(tx) } : {}) });
        }
        const subject = await this.identity(request.accessToken);
        if (request.operation === 'status')
            return this.statusSubject(subject);
        if (request.operation === 'disconnect') {
            await this.store.write([], async (db) => { const grant = await db.get('grant', request.connectionId); if (!grant || grant.subject !== subject)
                throw failure(); if (!grant.revoked)
                await this.revoke(db, grant); });
            return { protocol: CONNECT_PROTOCOL, kind: 'disconnected' };
        }
        const tx = await this.store.read(db => this.transaction(db, request.transaction));
        if ((tx.subject !== null && tx.subject !== subject) || (tx.appSession !== null && tx.appSession !== appSession))
            throw failure();
        if (tx.purpose === 'review') {
            const authorization = tx.authorization;
            if (!authorization || (await this.store.read(db => this.grant(db, authorization.grantId, authorization.epoch))).subject !== subject)
                throw failure();
        }
        if (request.operation === 'lighter_setup' || request.operation === 'lighter_faucet' || request.operation === 'lighter_register' || request.operation === 'lighter_status' || request.operation === 'lighter_renew' || request.operation === 'lighter_activate')
            return this.lighterApp(request, tx, subject);
        if (request.operation === 'resume' && tx.purpose === 'oauth' && tx.scopes.includes(TRADE_SCOPE) && this.provisioner && this.config.appNetwork === 'lighter-testnet'
            && await this.verifiedWallet(subject) === request.walletAddress) {
            if (tx.receiptHash !== null) throw failure();
            const known = await this.store.read(db => db.get('onboarding', subject));
            const setup = await this.provisioner.setup({ operation: 'resume', subject, walletAddress: request.walletAddress });
            if (setup.ownerWallet !== request.walletAddress || (known && setup.enrollmentId !== known.enrollmentId)) throw failure('ownership_changed');
            const current = await this.store.write([], async db => {
                const current = await this.transaction(db, tx.id);
                if (!identical(current, tx)) throw failure();
                const next = { ...current, subject, appSession, lighter: { enrollmentId: setup.enrollmentId, walletAddress: request.walletAddress,
                    proofReviewId: null, plan: null, activatedProfileId: null } };
                await db.put('onboarding', subject, { subject, walletAddress: request.walletAddress, enrollmentId: setup.enrollmentId }, Number.MAX_SAFE_INTEGER);
                await this.saveTransaction(db, next); return next;
            });
            return this.setupView(current, subject, setup);
        }
        if (request.operation === 'challenge' || request.operation === 'resume') {
            const connection = await this.connection(subject, request.walletAddress, tx.scopes);
            const reviewId = opaque();
            const expiresAt = Math.min(tx.expiresAt, Date.now() + transactionLifetime);
            const message = `Connect Verdict agent\nTransaction: ${tx.id}\nReview: ${reviewId}\nPurpose: ${tx.purpose}\nClient: ${tx.clientId}\nRedirect: ${tx.redirectUri}\nResource: ${tx.resource}\nSubject: ${subject}\nWallet: ${request.walletAddress}\nPermissions: ${connection.scopes.join(' ')}\nReview digest: ${hash(JSON.stringify(connection))}\nExpires: ${expiresAt}\nThis proof connects this client to the displayed account and limits. It never creates a broker policy or authorizes a withdrawal.`;
            const consentMethod = await this.verifiedWallet(subject) === request.walletAddress ? 'app_session' as const : 'wallet_signature' as const;
            const review = { protocol: CONNECT_PROTOCOL, kind: 'review' as const, transaction: tx.id, reviewId, expiresAt, walletAddress: request.walletAddress, message, connection, consentMethod };
            await this.store.write([], async (db) => { const current = await this.transaction(db, tx.id); if (current.receiptHash !== null || (current.subject !== null && current.subject !== subject) || (current.appSession !== null && current.appSession !== appSession))
                throw failure(); await this.saveTransaction(db, Transaction.parse({ ...current, subject, appSession, review, connection })); });
            return review;
        }
        if (!tx.review || tx.review.expiresAt <= Date.now() || tx.review.reviewId !== request.reviewId || tx.receiptHash !== null || tx.subject !== subject || tx.appSession !== appSession)
            throw failure();
        let recovered: string;
        if (request.operation === 'session_consent') {
            if (tx.review.consentMethod !== 'app_session' || await this.verifiedWallet(subject) !== tx.review.walletAddress) throw failure('invalid_wallet_proof');
            recovered = tx.review.walletAddress;
        } else recovered = (await recoverMessageAddress({ message: tx.review.message, signature: request.signature as `0x${string}` })).toLowerCase();
        if (recovered !== tx.review.walletAddress)
            throw failure('invalid_wallet_proof');
        const fresh = await this.connection(subject, recovered, tx.scopes);
        if (!identical(fresh, tx.connection))
            throw new HostedError(409, 'review_changed', 'Account readiness or policy changed. Review the updated connection.');
        const receipt = opaque();
        await this.store.write([], async (db) => { const current = await this.transaction(db, tx.id); if (!identical(current, tx))
            throw failure(); await this.saveTransaction(db, { ...current, receiptHash: hash(receipt) }); });
        const url = new URL(tx.purpose === 'oauth' ? '/connect/complete' : '/auth/callback', this.config.publicOrigin);
        url.searchParams.set('transaction', tx.id);
        url.searchParams.set('receipt', receipt);
        return { protocol: CONNECT_PROTOCOL, kind: 'complete', completionUrl: url.href };
    }
    private async completion(db: ConnectReadTx, url: URL, header: string | undefined, purpose: Transaction['purpose']) {
        if (url.origin !== this.config.publicOrigin || url.pathname !== (purpose === 'oauth' ? '/connect/complete' : '/auth/callback') || [...url.searchParams.keys()].some((key) => key !== 'transaction' && key !== 'receipt')
            || url.searchParams.getAll('transaction').length !== 1 || url.searchParams.getAll('receipt').length !== 1)
            throw failure();
        const tx = await this.transaction(db, url.searchParams.get('transaction') ?? '');
        const cookie = this.cookieValue(header, this.cookieName);
        const receipt = url.searchParams.get('receipt');
        if (tx.purpose !== purpose || !cookie || hash(cookie) !== tx.cookieHash || !receipt || !tx.receiptHash || hash(receipt) !== tx.receiptHash || !tx.subject || !tx.review || tx.review.expiresAt <= Date.now() || !tx.connection)
            throw failure();
        return tx;
    }
    async complete(url: URL, cookieHeader: string | undefined): Promise<{ location: string; cookies: string[] }> {
        return await this.store.write([], async (db) => {
            const tx = await this.completion(db, url, cookieHeader, 'oauth');
            if (!tx.subject || !tx.connection || !tx.review)
                throw failure();
            // Resolve the exact immutable reviewed profile, never a browser-supplied account selector.
            if (tx.connection.kind === 'executable') {
                const reviewed = tx.connection;
                const exact = await this.profile(db, reviewed.profileId);
                if (!exact || profileRevision(exact) !== reviewed.revision || reviewed.policy.expiresAt <= Date.now())
                    throw failure();
                const enrollment = await db.enrollment(tx.subject);
                if (enrollment && (enrollment.profileId !== reviewed.profileId || enrollment.revision !== reviewed.revision || enrollment.walletAddress !== tx.review.walletAddress))
                    throw failure();
                if (!enrollment)
                    await db.enroll(tx.subject, reviewed.profileId, { subject: tx.subject, profileId: reviewed.profileId, revision: reviewed.revision, walletAddress: tx.review.walletAddress });
            }
            const grant = Grant.parse({ id: randomUUID(), subject: tx.subject, clientId: tx.clientId, resource: this.resource,
                profileId: tx.connection.kind === 'executable' ? tx.connection.profileId : null, revision: tx.connection.kind === 'executable' ? tx.connection.revision : null,
                scopes: tx.connection.scopes, createdAt: Date.now(), expiresAt: Math.min(Date.now() + this.config.refreshTtlSeconds * 1000, tx.connection.kind === 'executable' ? tx.connection.policy.expiresAt : Number.MAX_SAFE_INTEGER), revoked: false, epoch: 0 });
            await db.put('grant', grant.id, grant, grant.expiresAt);
            const code = opaque();
            const expiresAt = Date.now() + 60000;
            await db.put('code', hash(code), { grantId: grant.id, epoch: grant.epoch, clientId: grant.clientId, resource: this.resource, scopes: grant.scopes, expiresAt, used: false, challenge: tx.challenge, redirectUri: tx.redirectUri }, expiresAt);
            const cookies = [this.cookie(this.cookieName, '', 0)];
            if (tx.connection.kind === 'executable' && tx.connection.mode === 'per_order' && grant.scopes.includes(TRADE_SCOPE)) {
                const session = opaque();
                const browserExpiresAt = Math.min(Date.now() + 600000, grant.expiresAt);
                await db.put('browser', hash(session), { authorization: { kind: 'first_party', grantId: grant.id, epoch: grant.epoch }, expiresAt: browserExpiresAt }, browserExpiresAt);
                cookies.push(this.cookie(this.browserName, session, Math.floor((browserExpiresAt - Date.now()) / 1000)));
            }
            await this.saveTransaction(db, { ...tx, completed: true, receiptHash: null });
            const redirect = new URL(tx.redirectUri);
            redirect.searchParams.set('code', code);
            if (tx.state !== null)
                redirect.searchParams.set('state', tx.state);
            redirect.searchParams.set('iss', this.config.publicOrigin);
            return { location: redirect.href, cookies };
        });
    }
    async cancel(url: URL, header: string | undefined) {
        return await this.store.write([], async (db) => {
            if (url.origin !== this.config.publicOrigin || url.pathname !== '/connect/cancel' || [...url.searchParams.keys()].some((key) => key !== 'transaction') || url.searchParams.getAll('transaction').length !== 1)
                throw failure();
            const tx = await this.transaction(db, url.searchParams.get('transaction') ?? '');
            const cookie = this.cookieValue(header, this.cookieName);
            if (!cookie || hash(cookie) !== tx.cookieHash)
                throw failure();
            await this.saveTransaction(db, { ...tx, completed: true, receiptHash: null });
            const redirect = new URL(tx.purpose === 'oauth' ? tx.redirectUri : '/connect/agent', tx.purpose === 'oauth' ? undefined : this.config.appOrigin);
            if (tx.purpose === 'oauth') {
                redirect.searchParams.set('error', 'access_denied');
                if (tx.state !== null)
                    redirect.searchParams.set('state', tx.state);
            }
            return { location: redirect.href, cookies: [this.cookie(this.cookieName, '', 0)] };
        });
    }
    async login(returnPath: string) {
        const match = /^\/review\/([a-f0-9-]{36})$/.exec(returnPath);
        const identity = match?.[1] ? await this.reviewLookup(match[1]) : null;
        if (!identity?.authorization)
            throw failure();
        const authorization = identity.authorization;
        const grant = await this.store.read(db => this.grant(db, authorization.grantId, authorization.epoch));
        if (identity.owner !== ownerHash(this.config.publicOrigin, grant.subject) || !grant.scopes.includes(TRADE_SCOPE))
            throw failure();
        const client = await this.store.read(db => this.client(db, grant.clientId));
        if (!client)
            throw failure();
        return await this.newTransaction({ purpose: 'review', clientId: grant.clientId, clientName: client.client_name || 'MCP client', redirectUri: `${this.config.publicOrigin}${returnPath}`,
            scopes: grant.scopes, challenge: '', state: null, reviewPath: returnPath, authorization: identity.authorization });
    }
    async callback(url: URL, cookieHeader: string | undefined) {
        const reviewed = await this.store.read(db => this.completion(db, url, cookieHeader, 'review'));
        if (!reviewed.reviewPath) throw failure();
        const job = await this.reviewLookup(reviewed.reviewPath.slice('/review/'.length));
        return await this.store.write([], async (db) => {
            const tx = await this.completion(db, url, cookieHeader, 'review');
            if (!tx.authorization || !tx.reviewPath || !tx.subject)
                throw failure();
            const grant = await this.grant(db, tx.authorization.grantId, tx.authorization.epoch);
            if (!identical(tx, reviewed)) throw failure();
            if (grant.subject !== tx.subject || !job || !identical(job.authorization, tx.authorization) || job.owner !== ownerHash(this.config.publicOrigin, grant.subject))
                throw failure();
            const session = opaque();
            const expiresAt = Math.min(Date.now() + 600000, grant.expiresAt);
            await db.put('browser', hash(session), { authorization: tx.authorization, expiresAt }, expiresAt);
            await this.saveTransaction(db, { ...tx, completed: true, receiptHash: null });
            return { location: tx.reviewPath, cookies: [this.cookie(this.cookieName, '', 0), this.cookie(this.browserName, session, Math.floor((expiresAt - Date.now()) / 1000))] };
        });
    }
    async readSession(header: string | undefined): Promise<BrowserSession | null> {
        const cookie = this.cookieValue(header, this.browserName);
        if (!cookie)
            return null;
        const browser = await this.store.read(db => db.get('browser', hash(cookie)));
        if (!browser || browser.expiresAt <= Date.now())
            return null;
        try {
            const grant = await this.store.read(db => this.grant(db, browser.authorization.grantId, browser.authorization.epoch));
            return { principal: this.principal(grant, grant.scopes, browser.expiresAt), csrf: createHmac('sha256', this.relaySecret).update(`review-csrf\0${cookie}`).digest('base64url'), expiresAt: browser.expiresAt };
        }
        catch {
            return null;
        }
    }
}
