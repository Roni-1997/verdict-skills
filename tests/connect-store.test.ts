import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { ConnectStore, type ConnectWriteTx } from '../packages/mcp/src/connect-store.js';

const roots: string[] = [];
const stores: ConnectStore[] = [];
async function open() { const root = await mkdtemp('/tmp/verdict-connect-store-'); roots.push(root); const store = new ConnectStore(root); stores.push(store); return store; }
const grant = () => ({ id: randomUUID(), subject: 'did:privy:alice', clientId: 'client', profileId: null, revision: null,
  scopes: ['verdict:read' as const], resource: 'https://fixture.example/mcp', createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, epoch: 0 });
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('serializes root reads, writes and close across awaited transaction callbacks', async () => {
  const store = await open(); const value = grant(); let release = () => {}; let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = store.write([], async tx => { await tx.put('grant', value.id, value, value.expiresAt); entered(); await gate; await tx.put('grant', value.id, { ...value, epoch: 1 }, value.expiresAt); });
  await started; let readFinished = false;
  const reading = store.read(async tx => { const result = await tx.get('grant', value.id); readFinished = true; return result; });
  await Promise.resolve(); expect(readFinished).toBe(false); const closing = store.close(); release();
  await writing; expect(await reading).toMatchObject({ epoch: 1 }); await closing;
  await expect(store.read(tx => tx.get('grant', value.id))).rejects.toMatchObject({ code: 'authority_storage' });
});

it('rolls back awaited failures and invalidates escaped transaction capabilities', async () => {
  const store = await open(); const value = grant(); let escaped: ConnectWriteTx | undefined;
  await expect(store.write([], async tx => { escaped = tx; await tx.put('grant', value.id, value, value.expiresAt); await Promise.resolve(); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect(await store.read(tx => tx.get('grant', value.id))).toBeNull();
  if (!escaped) throw new Error('Missing transaction');
  await expect(escaped.get('grant', value.id)).rejects.toMatchObject({ code: 'authority_storage' });
});

it('rejects nested root repositories rather than deadlocking or leaking ambient state', async () => {
  const store = await open(); const value = grant();
  await store.write([], async tx => {
    await tx.put('grant', value.id, value, value.expiresAt);
    await expect(store.read(inner => inner.get('grant', value.id))).rejects.toMatchObject({ code: 'authority_storage' });
  });
  expect(await store.read(tx => tx.get('grant', value.id))).toEqual(value);
});
