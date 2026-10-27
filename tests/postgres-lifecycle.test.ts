import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { closeTestPool } from './fixtures/postgres-lifecycle.js';

it('does not report a fixture pool closed until its client sockets have ended', async () => {
  let finishSocket = () => {};
  const socket = new Promise<void>(resolve => { finishSocket = resolve; });
  let closed = false;
  const closing = closeTestPool({ end: async () => {} }, [socket]).then(() => { closed = true; });
  await setImmediate();
  expect(closed).toBe(false);
  finishSocket();
  await closing;
  expect(closed).toBe(true);
});
