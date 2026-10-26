import { z } from 'zod';

/** Versioned HTTPS boundary shared with the product UI; contains no execution credentials. */
export const CONNECT_PROTOCOL = 'verdict-connect/2' as const;
export const ConnectId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ConnectAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Decimal = z.string().max(128).regex(/^\d+(?:\.\d+)?$/);
const Time = z.number().int().nonnegative().safe();
const Scope = z.enum(['verdict:read', 'verdict:trade']);
const PublicAccount = z.object({ venue: z.enum(['hl', 'lighter', 'polymarket']), network: z.string().min(1).max(32), account: z.string().min(1).max(128) }).strict();
const Id = z.number().int().nonnegative().safe();
export const ConsumerLighterScope = z.object({ kind: z.literal('consumer_lighter'), version: z.literal(1), ownerWallet: ConnectAddress,
  network: z.literal('testnet'), account: Id, apiKeyIndex: Id.min(5).max(254), creators: z.array(Id).min(1).max(64),
  mode: z.enum(['per_order', 'policy']), maxOrderDebitUSDC: Decimal, origin: z.string().url(), enrollmentId: z.string().uuid(), epoch: Id,
}).strict();
export type ConsumerLighterScope = z.infer<typeof ConsumerLighterScope>;
export const LighterRegistration = z.object({ enrollmentId: z.string().uuid(), revision: Digest, owner: ConnectAddress,
  network: z.literal('testnet'), chainId: z.literal(300), accountIndex: Id, apiKeyIndex: Id.min(5).max(254),
  publicKey: z.string().regex(/^(?:0x)?[0-9a-fA-F]{80}$/), nonce: Id,
  message: z.string().min(1).max(8192), expiresAt: Time,
}).strict();
export type LighterRegistration = z.infer<typeof LighterRegistration>;
export const LighterScopePlan = z.object({ planId: z.string().uuid(), revision: Digest, enrollmentId: z.string().uuid(),
  ownerWallet: ConnectAddress, network: z.literal('testnet'), message: z.string().min(1).max(32_768), expiresAt: Time,
  scope: ConsumerLighterScope, limits: z.object({ maxDebitUSDC: Decimal, maxOrders: Id.positive(), expiresAt: Time, cancelOwnOrders: z.boolean() }).strict(),
}).strict();
export type LighterScopePlan = z.infer<typeof LighterScopePlan>;
export const HostedAgentApproval = z.object({ kind: z.literal('hyperliquid'), account: ConnectAddress,
  network: z.enum(['mainnet', 'testnet']), agentAddress: ConnectAddress, agentName: z.literal('Verdict Hosted'),
}).strict();
export type HostedAgentApproval = z.infer<typeof HostedAgentApproval>;
export const ConnectAccountView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read_only'), reason: z.string().min(1).max(1000), scopes: z.tuple([z.literal('verdict:read')]) }).strict(),
  z.object({ kind: z.literal('executable'), profileId: z.string().min(1).max(128), revision: Digest,
    mode: z.enum(['per_order', 'policy']), accounts: z.array(PublicAccount).min(1).max(32),
    scopes: z.array(Scope).min(1).max(2), blockers: z.array(z.string().max(1000)).max(64),
    approvals: z.array(HostedAgentApproval).max(32),
    policy: z.object({ grantHash: Digest, expiresAt: Time, maxDebitUSDC: Decimal, maxOrders: z.number().int().nonnegative().safe(),
      remainingDebitUSDC: Decimal, remainingOrders: z.number().int().nonnegative().safe(), cancelOwnOrders: z.boolean(),
      templates: z.array(z.object({ digest: Digest, confirmation: z.array(z.string().max(5000)).max(100) }).strict()).max(64),
      scope: z.union([z.object({ kind: z.literal('ordered_templates') }).strict(), ConsumerLighterScope]),
    }).strict(),
  }).strict(),
]);
export type ConnectAccountView = z.infer<typeof ConnectAccountView>;
export const ConnectTransactionView = z.object({ protocol: z.literal(CONNECT_PROTOCOL), kind: z.literal('transaction'),
  transaction: ConnectId, purpose: z.enum(['oauth', 'review']), authorityOrigin: z.string().url(),
  client: z.object({ id: z.string().min(1).max(512), name: z.string().min(1).max(256), redirectUri: z.string().url() }).strict(),
  resource: z.string().url(), scopes: z.array(Scope).min(1).max(2), expiresAt: Time, cancelUrl: z.string().url(),
}).strict();
export type ConnectTransactionView = z.infer<typeof ConnectTransactionView>;
export const ConnectReview = z.object({ protocol: z.literal(CONNECT_PROTOCOL), kind: z.literal('review'), transaction: ConnectId,
  reviewId: ConnectId, expiresAt: Time, walletAddress: ConnectAddress, message: z.string().min(1).max(32_768),
  connection: ConnectAccountView,
}).strict();
export type ConnectReview = z.infer<typeof ConnectReview>;
export const ConnectComplete = z.object({ protocol: z.literal(CONNECT_PROTOCOL), kind: z.literal('complete'), completionUrl: z.string().url() }).strict();
export const ConnectStatus = z.object({ protocol: z.literal(CONNECT_PROTOCOL), kind: z.literal('connections'),
  connection: ConnectAccountView,
  connections: z.array(z.object({ id: z.string().uuid(), clientName: z.string().max(256), scopes: z.array(Scope).max(2),
    createdAt: Time, expiresAt: Time, revoked: z.boolean(),
  }).strict()).max(1000),
}).strict();
export const LighterSetupState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('funding_signature'), enrollmentId: z.string().uuid(), revision: Digest, owner: ConnectAddress,
    network: z.literal('testnet'), message: z.string().min(1).max(8192), expiresAt: Time }).strict(),
  z.object({ kind: z.literal('owner_signature'), registration: LighterRegistration }).strict(),
  z.object({ kind: z.literal('registration_pending'), enrollmentId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('scope_signature'), plan: LighterScopePlan }).strict(),
  z.object({ kind: z.literal('ready'), connection: ConnectAccountView }).strict(),
  z.object({ kind: z.literal('blocked'), enrollmentId: z.string().uuid(), code: z.string().min(1).max(128), message: z.string().min(1).max(1000) }).strict(),
]);
export type LighterSetupState = z.infer<typeof LighterSetupState>;
export const LighterSetup = z.object({ protocol: z.literal(CONNECT_PROTOCOL), kind: z.literal('lighter_setup'),
  transaction: ConnectId, state: LighterSetupState,
}).strict();
export const ConnectResponse = z.union([ConnectTransactionView, ConnectReview, ConnectComplete, ConnectStatus,
  LighterSetup,
  z.object({ protocol: z.literal(CONNECT_PROTOCOL), kind: z.literal('disconnected') }).strict(),
]);
export type ConnectResponse = z.infer<typeof ConnectResponse>;
const Token = z.string().min(1).max(32_768);
export const ConnectRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('view'), transaction: ConnectId }).strict(),
  z.object({ operation: z.literal('challenge'), transaction: ConnectId, accessToken: Token, walletAddress: ConnectAddress }).strict(),
  z.object({ operation: z.literal('consent'), transaction: ConnectId, accessToken: Token, reviewId: ConnectId,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }).strict(),
  z.object({ operation: z.literal('status'), accessToken: Token }).strict(),
  z.object({ operation: z.literal('disconnect'), accessToken: Token, connectionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('lighter_setup'), transaction: ConnectId, accessToken: Token, reviewId: ConnectId,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }).strict(),
  z.object({ operation: z.literal('lighter_faucet'), transaction: ConnectId, accessToken: Token, enrollmentId: z.string().uuid(), revision: Digest,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }).strict(),
  z.object({ operation: z.literal('lighter_status'), transaction: ConnectId, accessToken: Token }).strict(),
  z.object({ operation: z.literal('lighter_register'), transaction: ConnectId, accessToken: Token, enrollmentId: z.string().uuid(),
    revision: Digest, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }).strict(),
  z.object({ operation: z.literal('lighter_activate'), transaction: ConnectId, accessToken: Token, enrollmentId: z.string().uuid(),
    planId: z.string().uuid(), revision: Digest, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }).strict(),
]);
export type ConnectRequest = z.infer<typeof ConnectRequest>;
