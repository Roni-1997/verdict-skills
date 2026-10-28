import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CONNECT_PROTOCOL, ConnectAccountView, ConnectResponse } from '../packages/mcp/src/connect-contract.js';

const owner = `0x${'1'.repeat(40)}`;
const transaction = 't'.repeat(43);
function templateConnection(mode: 'per_order' | 'policy' = 'per_order') {
  return { kind: 'executable', profileId: 'reviewed-profile', revision: 'a'.repeat(64), mode,
    accounts: [{ venue: 'lighter', network: 'testnet', account: '42' }], scopes: ['verdict:read', 'verdict:trade'], blockers: [], approvals: [],
    policy: { grantHash: 'b'.repeat(64), expiresAt: Date.now() + 60_000, maxDebitUSDC: '100', maxOrders: 20,
      remainingDebitUSDC: '100', remainingOrders: 20, cancelOwnOrders: true,
      templates: [{ digest: 'c'.repeat(64), confirmation: ['Buy the displayed YES contract within the reviewed limit.'] }],
      scope: { kind: 'ordered_templates' } } };
}
function consumerConnection(mode: 'per_order' | 'policy' = 'per_order') {
  const connection = templateConnection(mode);
  return { ...connection, policy: { ...connection.policy, templates: [], scope: { kind: 'consumer_lighter', version: 1,
    ownerWallet: owner, network: 'testnet', account: 42, apiKeyIndex: 5, creators: [7], mode,
    maxOrderDebitUSDC: '10', origin: 'https://mcp.contract.fixture', enrollmentId: randomUUID(), epoch: 0 } } };
}
function responseViews(connection: unknown) {
  return [{ protocol: CONNECT_PROTOCOL, kind: 'review', transaction, reviewId: 'r'.repeat(43), expiresAt: Date.now() + 60_000,
    walletAddress: owner, message: 'Review this exact account and authority.', connection },
  { protocol: CONNECT_PROTOCOL, kind: 'connections', connection, connections: [] },
  { protocol: CONNECT_PROTOCOL, kind: 'lighter_setup', transaction, state: { kind: 'ready', connection } }];
}

it.each(['per_order', 'policy'] as const)('requires displayed templates for an ordered-template %s connection at every response boundary', mode => {
  const valid = templateConnection(mode); expect(ConnectAccountView.safeParse(valid).success).toBe(true);
  const missing = { ...valid, policy: { ...valid.policy, templates: [] } };
  const parsed = ConnectAccountView.safeParse(missing); expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('An undisplayed template grant was accepted');
  expect(parsed.error.issues).toMatchObject([{ path: ['policy', 'templates'] }]);
  for (const value of responseViews(valid)) expect(ConnectResponse.safeParse(value).success).toBe(true);
  for (const value of responseViews(missing)) expect(ConnectResponse.safeParse(value).success).toBe(false);
});

it.each(['per_order', 'policy'] as const)('requires consumer scope and displayed %s mode to agree at every response boundary', mode => {
  const valid = consumerConnection(mode); expect(ConnectAccountView.safeParse(valid).success).toBe(true);
  const misleading = { ...valid, policy: { ...valid.policy, scope: { ...valid.policy.scope, mode: mode === 'per_order' ? 'policy' : 'per_order' } } };
  const parsed = ConnectAccountView.safeParse(misleading); expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('A misleading consumer mode was accepted');
  expect(parsed.error.issues).toMatchObject([{ path: ['policy', 'scope', 'mode'] }]);
  for (const value of responseViews(valid)) expect(ConnectResponse.safeParse(value).success).toBe(true);
  for (const value of responseViews(misleading)) expect(ConnectResponse.safeParse(value).success).toBe(false);
});

it('preserves read-only connections without manufacturing trading templates', () => {
  expect(ConnectAccountView.parse({ kind: 'read_only', reason: 'Connect an account to trade.', scopes: ['verdict:read'] })).toEqual({
    kind: 'read_only', reason: 'Connect an account to trade.', scopes: ['verdict:read'] });
});
