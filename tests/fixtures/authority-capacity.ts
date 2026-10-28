import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { AccountAuthority } from '../../packages/mcp/src/connect-authority.js';
import { hash, opaque, type Grant } from '../../packages/mcp/src/connect-model.js';
import type { AuthorityRepository } from '../../packages/mcp/src/connect-store.js';

export async function registerBeyondLegacyCapacity(service: AccountAuthority, store: AuthorityRepository) {
  const input = { redirect_uris: ['https://agent.capacity.fixture/callback'], token_endpoint_auth_method: 'none' };
  const first = await service.clientsStore.registerClient(input);
  for (let i = 0; i < 1000; i++) await service.clientsStore.registerClient(input);
  expect(await store.read(tx => tx.all('client'))).toHaveLength(1001);
  expect(await service.clientsStore.getClient(first.client_id)).toEqual(first);
}

export async function rotateBeyondLegacyCapacity(service: AccountAuthority, store: AuthorityRepository) {
  const client = await service.clientsStore.registerClient({ redirect_uris: ['https://agent.capacity.fixture/callback'], token_endpoint_auth_method: 'none' });
  const resource = new URL(service.resource);
  const issue = async (subject: string) => {
    const value: Grant = { id: randomUUID(), subject, clientId: client.client_id, profileId: null, revision: null,
      scopes: ['verdict:read'], resource: resource.href, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, revoked: false, epoch: 0 };
    const code = opaque();
    await store.write([], async tx => {
      await tx.put('grant', value.id, value, value.expiresAt);
      await tx.put('code', hash(code), { grantId: value.id, epoch: 0, clientId: client.client_id, resource: resource.href,
        scopes: value.scopes, expiresAt: value.expiresAt, used: false, challenge: 'a'.repeat(43), redirectUri: client.redirect_uris[0] ?? '' }, value.expiresAt);
    });
    return { grant: value, tokens: await service.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resource) };
  };
  const families = await Promise.all(['alice', 'bob', 'carol', 'dave'].map(name => issue(`did:privy:${name}`)));
  const first = families[0];
  if (!first?.tokens.refresh_token) throw new Error('Missing refresh fixture');
  const originalRefresh = first.tokens.refresh_token;
  for (let i = 0; i < 251; i++) {
    for (const family of families) {
      if (!family.tokens.refresh_token) throw new Error('Missing rotating credential');
      family.tokens = await service.exchangeRefreshToken(client, family.tokens.refresh_token, undefined, resource);
    }
  }
  expect(await store.read(tx => tx.all('refresh'))).toHaveLength(1008);
  expect(await store.read(tx => tx.get('refresh', hash(originalRefresh)))).toMatchObject({ used: true, grantId: first.grant.id, expiresAt: first.grant.expiresAt });
  const later = await issue('did:privy:later');
  await service.authenticate(`Bearer ${later.tokens.access_token}`, 'verdict:read');
  await expect(service.exchangeRefreshToken(client, originalRefresh, undefined, resource)).rejects.toThrow();
  await expect(service.authenticate(`Bearer ${first.tokens.access_token}`, 'verdict:read')).rejects.toMatchObject({ code: 'invalid_token' });
  for (const family of families.slice(1)) await service.authenticate(`Bearer ${family.tokens.access_token}`, 'verdict:read');
  expect(await store.read(tx => tx.get('grant', first.grant.id))).toMatchObject({ revoked: true, epoch: 1 });
  const expired = opaque();
  await store.write([], tx => tx.put('refresh', hash(expired), { grantId: later.grant.id, epoch: 0, clientId: client.client_id,
    resource: resource.href, scopes: later.grant.scopes, expiresAt: Date.now() - 1, used: true }, Date.now() - 1));
  if (!later.tokens.refresh_token) throw new Error('Missing later credential');
  await service.exchangeRefreshToken(client, later.tokens.refresh_token, undefined, resource);
  expect(await store.read(tx => tx.get('refresh', hash(expired)))).toBeNull();
  expect(await store.read(tx => tx.get('refresh', hash(originalRefresh)))).toMatchObject({ used: true });
}
