import { isAbsolute } from 'node:path';
import { ExecutionLinkedAccount, ExecutionProposal, ExecutionStatus } from '@verdict/core';
import { z } from 'zod';

export const READ_SCOPE = 'verdict:read';
export const TRADE_SCOPE = 'verdict:trade';
export type ConnectorScope = typeof READ_SCOPE | typeof TRADE_SCOPE;
export const AuthorityRef = z.object({ kind: z.literal('first_party'), grantId: z.string().uuid(), epoch: z.number().int().nonnegative().safe() }).strict();
export type AuthorityRef = z.infer<typeof AuthorityRef>;
export const Principal = z.object({ issuer: z.string().url(), subject: z.string().min(1).max(512),
  scopes: z.array(z.string()), expiresAt: z.number().finite().nonnegative(),
  authorization: AuthorityRef.optional(),
}).strict();
export type Principal = z.infer<typeof Principal>;
export type BrowserSession = Readonly<{ principal: Principal; csrf: string; expiresAt: number }>;
export class HostedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'HostedError'; }
}
export function requireScope(principal: Principal, scope: ConnectorScope): void {
  if (principal.expiresAt <= Date.now()) throw new HostedError(401, 'invalid_token', 'Authentication expired. Sign in again.');
  if (!principal.scopes.includes(scope)) throw new HostedError(403, 'insufficient_scope', 'This operation requires additional account permission.');
}
export const LinkedAccount = ExecutionLinkedAccount;
export type LinkedAccount = z.infer<typeof LinkedAccount>;
const AbsolutePath = z.string().min(1).refine(isAbsolute);
const EnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
export const PrivateSignerConfig = z.object({ kind: z.literal('hosted_signer'), origin: z.string().url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
}), deploymentId: z.string().uuid(), secretEnv: EnvironmentName }).strict();
export type PrivateSignerConfig = z.infer<typeof PrivateSignerConfig>;
export const Binding = z.object({ id: z.string().min(1).max(128), subject: z.string().min(1).max(512),
  enabled: z.boolean(), mode: z.enum(['per_order', 'policy']), execution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local_socket'), socketPath: AbsolutePath }).strict(),
    z.object({ kind: z.literal('hosted_signer'), profileId: z.string().uuid() }).strict(),
  ]),
  grantId: z.string().uuid(), grantHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), accounts: z.array(LinkedAccount).min(1).max(32),
}).strict();
export type Binding = z.infer<typeof Binding>;
export const HostedConfig = z.object({ publicOrigin: z.string().url(), issuer: z.string().url(),
  browserClientId: z.string().min(1), browserClientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  lighter: z.object({ network: z.enum(['devnet', 'testnet', 'mainnet']), creators: z.array(z.number().int().nonnegative().safe()) }).strict().optional(),
  storage: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), stateDir: AbsolutePath }).strict(),
    z.object({ kind: z.literal('postgres'), deploymentId: z.string().uuid(), databaseId: z.string().uuid() }).strict(),
  ]), bindings: z.array(Binding).max(1000),
  approvalTtlSeconds: z.number().int().min(30).max(900).prefault(300),
  allowInsecureLocalhost: z.boolean().prefault(false),
}).strict().superRefine((config, context) => {
  for (const [field, value] of [['publicOrigin', config.publicOrigin], ['issuer', config.issuer]] as const) {
    const url = new URL(value);
    const loopback = config.allowInsecureLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash
      || (field === 'publicOrigin' && url.pathname !== '/')) context.addIssue({ code: 'custom', path: [field], message: 'Configure HTTPS URLs without credentials or query strings; publicOrigin must be an origin.' });
  }
  const subjects = new Set<string>(); const ids = new Set<string>(); const accounts = new Set<string>(); const sockets = new Set<string>();
  for (const binding of config.bindings) {
    if (subjects.has(binding.subject) || ids.has(binding.id) || sockets.has(JSON.stringify(binding.execution))) context.addIssue({ code: 'custom', message: 'Bindings must have unique subjects, IDs and broker sockets.' });
    subjects.add(binding.subject); ids.add(binding.id); sockets.add(JSON.stringify(binding.execution));
    for (const account of binding.accounts) {
      const key = `${account.venue}:${account.network}:${account.account}`;
      if (accounts.has(key)) context.addIssue({ code: 'custom', message: 'An account cannot be shared across connector bindings.' });
      accounts.add(key);
    }
  }
}).transform((config) => ({ ...config, publicOrigin: new URL(config.publicOrigin).origin }));
export type HostedConfig = z.infer<typeof HostedConfig>;
export type AuthConfig = Pick<HostedConfig, 'publicOrigin' | 'issuer' | 'browserClientId' | 'browserClientSecretEnv' | 'allowInsecureLocalhost'>;
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Job = z.object({ id: z.string().uuid(), owner: Digest, bindingHash: Digest,
  authorization: AuthorityRef.nullable().prefault(null),
  purpose: z.enum(['submit', 'cancel']), proposal: ExecutionProposal, leg: z.union([z.literal(0), z.literal(1)]).nullable(),
  expiresAt: z.number().int().nonnegative(), state: z.enum(['pending', 'attempted', 'observed', 'declined']),
  result: ExecutionStatus.nullable(),
}).strict();
export type Job = z.infer<typeof Job>;
export const HostedMutation = z.union([ExecutionStatus,
  z.object({ state: z.literal('approval_required'), digest: Digest, approvalUrl: z.string().url(), expiresAt: z.number(), nextOperation: z.literal('status'), automaticRetry: z.literal(false) }).strict(),
  z.object({ state: z.literal('delivery_unknown'), digest: Digest, nextOperation: z.literal('status'), automaticRetry: z.literal(false) }).strict(),
]);
export type HostedMutation = z.infer<typeof HostedMutation>;
