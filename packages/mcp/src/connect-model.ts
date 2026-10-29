import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ConnectAccountView, ConnectAddress, ConnectId, ConnectReview, LighterScopePlan } from './connect-contract.js';
import { AuthorityRef, Binding, HostedError, PrivateSignerConfig, READ_SCOPE, TRADE_SCOPE } from './hosted-model.js';

export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const ownerHash = (issuer: string, subject: string) => hash(`${issuer}\0${subject}`);
export const Scope = z.enum([READ_SCOPE, TRADE_SCOPE]);
const Time = z.number().int().nonnegative().safe();
export const Profile = Binding.omit({ subject: true }).extend({ grantHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type Profile = z.infer<typeof Profile>;
export const AccountServiceConfig = z.object({ publicOrigin: z.string().url(), appOrigin: z.string().url(),
  appNetwork: z.enum(['mainnet', 'testnet', 'lighter', 'lighter-testnet']), privyAppId: z.string().min(1).max(256),
  privyVerificationKey: z.string().min(50).max(8192).optional(),
  privyVerification: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('spki'), key: z.string().min(50).max(8192) }).strict(),
    z.object({ kind: z.literal('jwks') }).strict(),
  ]).optional(),
  lighterProvisioner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local_socket'), socketPath: z.string().refine(isAbsolute), brokerSocketRoot: z.string().refine(isAbsolute) }).strict(),
    PrivateSignerConfig,
  ]).optional(),
  relaySecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  storage: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), stateDir: z.string().refine(isAbsolute), gatewayJobsDir: z.string().refine(isAbsolute) }).strict(),
    z.object({ kind: z.literal('postgres'), connectionStringEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/), deploymentId: z.string().uuid(), databaseId: z.string().uuid() }).strict(),
  ]),
  profiles: z.array(Profile).max(1000), allowInsecureLocalhost: z.boolean().prefault(false),
  refreshTtlSeconds: z.number().int().min(600).max(2_592_000).prefault(86_400),
  approvalTtlSeconds: z.number().int().min(30).max(900).prefault(300),
}).strict().superRefine((config, context) => {
  if ((config.privyVerificationKey === undefined) === (config.privyVerification === undefined)) context.addIssue({ code: 'custom', message: 'Select exactly one pinned Privy verification method.' });
  if (config.lighterProvisioner && config.appNetwork !== 'lighter-testnet') context.addIssue({ code: 'custom', message: 'Self-service Lighter pilot requires the explicit lighter-testnet app network.' });
  for (const field of ['publicOrigin', 'appOrigin'] as const) {
    const url = new URL(config[field]);
    const local = config.allowInsecureLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      context.addIssue({ code: 'custom', path: [field], message: 'Use a fixed HTTPS origin.' });
  }
  if (new URL(config.publicOrigin).origin === new URL(config.appOrigin).origin || (config.storage.kind === 'local' && config.storage.stateDir === config.storage.gatewayJobsDir)) context.addIssue({ code: 'custom', message: 'Authority and app origins and state directories must be distinct.' });
  if (config.storage.kind === 'postgres' && config.lighterProvisioner?.kind === 'hosted_signer' && config.storage.deploymentId !== config.lighterProvisioner.deploymentId) context.addIssue({ code: 'custom', message: 'Public and private transports must pin the same deployment.' });
  const ids = new Set<string>(); const sockets = new Set<string>(); const accounts = new Set<string>();
  for (const profile of config.profiles) {
    if (ids.has(profile.id) || sockets.has(JSON.stringify(profile.execution))) context.addIssue({ code: 'custom', message: 'Profiles require unique IDs and broker sockets.' });
    ids.add(profile.id); sockets.add(JSON.stringify(profile.execution));
    for (const account of profile.accounts) {
      const key = `${account.venue}:${account.network}:${account.account}`;
      if (accounts.has(key) || (account.venue === 'hl' && ['mainnet', 'testnet'].includes(config.appNetwork) && account.network !== config.appNetwork)) context.addIssue({ code: 'custom', message: 'Accounts must be unique and HL must match an explicitly selected HL app network.' });
      accounts.add(key);
    }
  }
}).transform((config) => ({ ...config, publicOrigin: new URL(config.publicOrigin).origin, appOrigin: new URL(config.appOrigin).origin }));
export type AccountServiceConfig = z.infer<typeof AccountServiceConfig>;
export const Enrollment = z.object({ subject: z.string(), profileId: z.string(), revision: z.string(), walletAddress: z.string() }).strict();
export const Grant = z.object({ id: z.string().uuid(), subject: z.string(), clientId: z.string(),
  profileId: z.string().nullable(), revision: z.string().nullable(), scopes: z.array(Scope),
  resource: z.string(), createdAt: Time, expiresAt: Time, revoked: z.boolean(), epoch: Time,
  /** End of the owner-signed limits. Trade permission stops here; reads and status last until expiresAt. */
  tradeExpiresAt: Time.optional(),
}).strict();
export type Grant = z.infer<typeof Grant>;
export const Credential = z.object({ grantId: z.string().uuid(), epoch: Time, clientId: z.string(), resource: z.string(),
  scopes: z.array(Scope), expiresAt: Time, used: z.boolean(),
}).strict();
export const Code = Credential.extend({ challenge: z.string(), redirectUri: z.string() }).strict();
export const Browser = z.object({ authorization: AuthorityRef, expiresAt: Time }).strict();
export const Transaction = z.object({ id: ConnectId, purpose: z.enum(['oauth', 'review']), cookieHash: z.string(),
  clientId: z.string(), clientName: z.string(), redirectUri: z.string(), resource: z.string(), scopes: z.array(Scope),
  challenge: z.string(), state: z.string().nullable(), expiresAt: Time, completed: z.boolean(),
  reviewPath: z.string().nullable(), authorization: AuthorityRef.nullable(),
  subject: z.string().nullable(), appSession: z.string().nullable(), review: ConnectReview.nullable(),
  connection: ConnectAccountView.nullable(), receiptHash: z.string().nullable(),
  lighter: z.object({ enrollmentId: z.string().uuid(), walletAddress: z.string(), proofReviewId: ConnectId.nullable().prefault(null),
    plan: LighterScopePlan.nullable(), activatedProfileId: z.string().nullable(),
  }).strict().nullable().prefault(null),
}).strict();
export type Transaction = z.infer<typeof Transaction>;
export const failure = (code = 'invalid_connection') => new HostedError(400, code, 'Connection could not be verified. Start a new connection from the original agent.');

export const ClientRecord = z.object({ metadata: z.unknown(), secret: z.string().nullable() }).strict();
export const ManagedProfile = z.object({ subject: z.string(), walletAddress: ConnectAddress, profile: Profile }).strict();
export const VerifiedOnboarding = z.object({ subject: z.string(), walletAddress: ConnectAddress, enrollmentId: z.string().uuid() }).strict();
export const AuthoritySchemas = { client: ClientRecord, transaction: Transaction, grant: Grant, access: Credential, refresh: Credential, code: Code, browser: Browser, 'managed-profile': ManagedProfile, onboarding: VerifiedOnboarding };
export type AuthorityRecords = { [K in keyof typeof AuthoritySchemas]: z.output<(typeof AuthoritySchemas)[K]> };
