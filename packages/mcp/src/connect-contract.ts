import { z } from 'zod';

/** Versioned HTTPS boundary shared with the product UI; contains no execution credentials. */
export const CONNECT_PROTOCOL = 'verdict-connect/1' as const;
export const ConnectId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ConnectAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Decimal = z.string().max(128).regex(/^\d+(?:\.\d+)?$/);
const Time = z.number().int().nonnegative().safe();
const Scope = z.enum(['verdict:read', 'verdict:trade']);
const PublicAccount = z.object({ venue: z.enum(['hl', 'lighter', 'polymarket']), network: z.string().min(1).max(32), account: z.string().min(1).max(128) }).strict();
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
      templates: z.array(z.object({ digest: Digest, confirmation: z.array(z.string().max(5000)).max(100) }).strict()).min(1).max(64),
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
export const ConnectResponse = z.union([ConnectTransactionView, ConnectReview, ConnectComplete, ConnectStatus,
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
]);
export type ConnectRequest = z.infer<typeof ConnectRequest>;
