import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  connectExecution, ExecutionDeliveryUnknownError, ExecutionMode, ExecutionPreflight, ExecutionStatus,
  LocalExecutionCapabilities, prepareExecution, type ExecutionProposal,
} from '../packages/core/src/index.js';

const Request = z.object({ expectedMode: ExecutionMode,
  expectedGrantId: z.string().uuid().optional(),
  operation: z.enum(['capabilities', 'preflight', 'submit', 'status', 'cancel']),
  proposal: z.unknown().optional(), leg: z.union([z.literal(0), z.literal(1)]).optional(),
}).strict();
type Request = z.infer<typeof Request>;
type Handler = (request: Request, socket: Socket) => void;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function proposal() {
  return prepareExecution({ legs: [{ venue: 'hl', network: 'testnet', account: `0x${'1'.repeat(40)}`, outcome: 123,
    title: 'Oracle event', settlementRule: 'The specified oracle resolves YES when the closing value exceeds 100.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'Ioc',
    builder: { address: `0x${'2'.repeat(40)}`, feeTenthsBp: 10 }, allInFeeBpsCap: '10',
  }], policy: { maxTotalDebitUSDC: '10', maxLegDebitUSDC: '5' } });
}
function capabilities(mode: ExecutionMode, grantId = 'operator-grant') {
  return LocalExecutionCapabilities.parse({ kind: 'local_execution_capabilities', fundedAcceptanceVerified: false,
    authority: mode === 'per_order' ? { mode, approval: 'operator_terminal' } : {
      mode, grantId, grantHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
      newRisk: 'active', remainingDebitUSDC: '20', remainingOrders: 4, cancelOwnOrders: true,
    },
  });
}
function status(p: ExecutionProposal) {
  return ExecutionStatus.parse({ digest: p.digest, state: 'needs_reconciliation', legs: [{ leg: 0,
    state: 'open', filled: '0', netInventoryChange: '0', settled: false,
  }], automaticRetry: false, note: 'Synthetic account evidence.' });
}
function reply(socket: Socket, result: unknown) { socket.end(`${JSON.stringify({ ok: true, result })}\n`); }

async function server(handler: Handler) {
  const directory = await mkdtemp('/tmp/verdict-client-');
  const socketPath = join(directory, 'broker.sock');
  const requests: Request[] = []; const sockets = new Set<Socket>();
  const listener = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let raw = '';
    socket.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    socket.on('end', () => {
      const request = Request.parse(JSON.parse(raw)); requests.push(request); handler(request, socket);
    });
  });
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(socketPath, resolve); });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

describe('local execution SDK over a real Unix socket', () => {
  it.each(['per_order', 'policy'] satisfies ExecutionMode[])('asserts %s authority on every lifecycle call without transporting secrets or configuration', async (mode) => {
    const p = proposal(); const now = Date.now();
    const preflight = ExecutionPreflight.parse({ state: 'ready', digest: p.digest, authorization: 'none',
      authority: capabilities(mode).authority, legs: [{ leg: 0, inventoryShares: '0', availableUSDC: '100',
        feeBoundUSDC: '0.01', checkedAt: now + 0.125, validUntil: now + 5000.125 }],
    });
    const broker = await server((request, socket) => reply(socket,
      request.operation === 'capabilities' ? capabilities(mode) : request.operation === 'preflight' ? preflight : status(p)));
    const client = await connectExecution({ expectedMode: mode, socketPath: broker.socketPath });
    expect(client.mode).toBe(mode);
    expect((await client.capabilities()).authority.mode).toBe(mode);
    expect(await client.preflight(p)).toEqual(preflight);
    expect(await client.submit(p)).toEqual(status(p));
    expect(await client.status(p)).toEqual(status(p));
    expect(await client.cancel({ proposal: p, leg: 0 })).toEqual(status(p));
    expect(broker.requests.map((request) => request.operation)).toEqual(['capabilities', 'capabilities', 'preflight', 'submit', 'status', 'cancel']);
    expect(broker.requests.every((request) => request.expectedMode === mode)).toBe(true);
    expect(broker.requests.at(-1)?.leg).toBe(0);
    const serialized = JSON.stringify(broker.requests);
    for (const name of ['socketPath', 'timeoutMs', 'privateKey', 'approved', 'grantId', 'stateDir', 'factory']) expect(serialized).not.toContain(`"${name}"`);
    expect(Object.isFrozen(client)).toBe(true);
  });

  it('uses operator environment configuration and refuses missing, relative or URL destinations without echoing them', async () => {
    const broker = await server((_request, socket) => reply(socket, capabilities('policy')));
    const previous = process.env.VERDICT_BROKER_SOCKET;
    try {
      process.env.VERDICT_BROKER_SOCKET = broker.socketPath;
      expect((await connectExecution({ expectedMode: 'policy' })).mode).toBe('policy');
      delete process.env.VERDICT_BROKER_SOCKET;
      await expect(connectExecution({ expectedMode: 'policy' })).rejects.toMatchObject({ code: 'not_configured' });
      for (const socketPath of ['relative-secret-path', 'https://secret.invalid/broker']) {
        await expect(connectExecution({ expectedMode: 'policy', socketPath })).rejects.toThrow('absolute local');
        await expect(connectExecution({ expectedMode: 'policy', socketPath })).rejects.not.toThrow(socketPath);
      }
    } finally { if (previous === undefined) delete process.env.VERDICT_BROKER_SOCKET; else process.env.VERDICT_BROKER_SOCKET = previous; }
  });

  it('carries an operator-pinned grant on every lifecycle request and validates capability identity', async () => {
    const grant = '11111111-1111-4111-8111-111111111111'; const p = proposal();
    const broker = await server((request, socket) => reply(socket,
      request.operation === 'capabilities' ? capabilities('policy', grant) : request.operation === 'preflight'
        ? { state: 'ready', digest: p.digest, authorization: 'none', authority: capabilities('policy', grant).authority,
          legs: [{ leg: 0, inventoryShares: '0', availableUSDC: '100', feeBoundUSDC: '0.01', checkedAt: Date.now(), validUntil: Date.now() + 5000 }] }
        : status(p)));
    const client = await connectExecution({ expectedMode: 'policy', expectedGrantId: grant, socketPath: broker.socketPath });
    await client.capabilities(); await client.preflight(p); await client.submit(p); await client.status(p); await client.cancel({ proposal: p, leg: 0 });
    expect(broker.requests).toHaveLength(6);
    expect(broker.requests.every((request) => request.expectedGrantId === grant)).toBe(true);
    await expect(connectExecution({ expectedMode: 'policy', expectedGrantId: '22222222-2222-4222-8222-222222222222', socketPath: broker.socketPath })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('cannot spend a replacement policy grant after a successful capabilities check', async () => {
    const grant = '11111111-1111-4111-8111-111111111111'; let active = grant; let sends = 0;
    const p = proposal();
    const broker = await server((request, socket) => {
      if (request.expectedGrantId !== active) socket.end(`${JSON.stringify({ ok: false, error: { code: 'broker_blocked', message: 'Pinned grant changed.' } })}\n`);
      else if (request.operation === 'capabilities') reply(socket, capabilities('policy', active));
      else { sends++; reply(socket, status(p)); }
    });
    const client = await connectExecution({ expectedMode: 'policy', expectedGrantId: grant, socketPath: broker.socketPath });
    active = '22222222-2222-4222-8222-222222222222';
    await expect(client.submit(p)).rejects.toThrow('Pinned grant changed');
    expect(broker.requests.at(-1)?.expectedGrantId).toBe(grant); expect(sends).toBe(0);
  });

  it('rejects authority mode mismatch before any order request', async () => {
    const broker = await server((_request, socket) => reply(socket, capabilities('per_order')));
    await expect(connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath })).rejects.toMatchObject({ code: 'not_configured' });
    expect(broker.requests.map((request) => request.operation)).toEqual(['capabilities']);
  });

  it('validates immutable proposals and exact-leg cancellation before network access', async () => {
    const broker = await server((_request, socket) => reply(socket, capabilities('policy')));
    const client = await connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath });
    const p = proposal();
    const changed = { ...p, payload: { ...p.payload, createdAt: p.payload.createdAt + 1 } };
    for (const operation of ['preflight', 'submit', 'status'] as const) await expect(client[operation](changed)).rejects.toThrow('changed');
    await expect(client.cancel({ proposal: p, leg: 1 })).rejects.toThrow('outside');
    expect(broker.requests).toHaveLength(1);
  });

  it('requires mode assertion for each request even when authority changes after connection', async () => {
    let mode: ExecutionMode = 'policy';
    const broker = await server((request, socket) => {
      if (request.expectedMode !== mode) socket.end(`${JSON.stringify({ ok: false, error: { code: 'broker_blocked', message: 'Operator changed execution mode.' } })}\n`);
      else reply(socket, capabilities(mode));
    });
    const client = await connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath }); mode = 'per_order';
    await expect(client.submit(proposal())).rejects.toThrow('Operator changed execution mode');
    expect(broker.requests.at(-1)?.expectedMode).toBe('policy');
  });

  it.each(['disconnect', 'timeout', 'slow_response', 'malformed', 'wrong_digest', 'extra_result_field', 'duplicate_key', 'oversized', 'false_complete'] as const)(
    'never retries mutation after %s and preserves its original digest for reconciliation', async (failure) => {
      const p = proposal();
      const broker = await server((request, socket) => {
        if (request.operation === 'capabilities') { reply(socket, capabilities('policy')); return; }
        if (request.operation === 'status') { reply(socket, status(p)); return; }
        if (failure === 'disconnect') socket.destroy();
        if (failure === 'slow_response') { const timer = setInterval(() => socket.write(' '), 10); socket.once('close', () => clearInterval(timer)); }
        if (failure === 'malformed') socket.end('SDK exception contains private-signature-secret\n');
        if (failure === 'wrong_digest') reply(socket, { ...status(p), digest: '0'.repeat(64) });
        if (failure === 'extra_result_field') reply(socket, { ...status(p), signedOrder: 'private-signature-secret' });
        if (failure === 'false_complete') reply(socket, { ...status(p), state: 'complete' });
        if (failure === 'duplicate_key') socket.end(`{"ok":true,"result":${JSON.stringify(status(p))},"result":${JSON.stringify(status(p))}}\n`);
        if (failure === 'oversized') socket.end(`${'x'.repeat(1_048_577)}\n`);
      });
      const client = await connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath, timeoutMs: failure === 'timeout' || failure === 'slow_response' ? 200 : 1000 });
      const result = client.submit(p);
      await expect(result).rejects.toBeInstanceOf(ExecutionDeliveryUnknownError);
      await expect(result).rejects.toMatchObject({ digest: p.digest, code: 'upstream' });
      await expect(result).rejects.toThrow('same proposal');
      await expect(result).rejects.not.toThrow('private-signature-secret');
      expect(broker.requests.filter((request) => request.operation === 'submit')).toHaveLength(1);
      expect(await client.status(p)).toEqual(status(p));
      expect(broker.requests.filter((request) => request.operation === 'submit')).toHaveLength(1);
    },
  );

  it('treats lost cancellation response as uncertain without resending the cancellation', async () => {
    const p = proposal();
    const broker = await server((request, socket) => {
      if (request.operation === 'capabilities') reply(socket, capabilities('policy'));
      else socket.destroy();
    });
    const client = await connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath });
    await expect(client.cancel({ proposal: p, leg: 0 })).rejects.toMatchObject({ name: 'ExecutionDeliveryUnknownError', digest: p.digest });
    expect(broker.requests.filter((request) => request.operation === 'cancel')).toHaveLength(1);
  });

  it('hides transport and raw SDK exception details while preserving explicitly public broker blocks', async () => {
    let error = { code: 'broker_error', message: 'private-signature-secret' };
    const broker = await server((request, socket) => {
      if (request.operation === 'capabilities') reply(socket, capabilities('policy'));
      else socket.end(`${JSON.stringify({ ok: false, error })}\n`);
    });
    const client = await connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath });
    const p = proposal();
    await expect(client.submit(p)).rejects.toThrow('reconcile attempted orders');
    await expect(client.status(p)).rejects.not.toThrow('private-signature-secret');
    error = { code: 'broker_blocked', message: 'Grant revoked; new risk is blocked.' };
    await expect(client.preflight(p)).rejects.toThrow(error.message);
    await expect(connectExecution({ expectedMode: 'policy', socketPath: '/tmp/private-path-secret/missing.sock' })).rejects.not.toThrow('private-path-secret');
  });

  it('rejects mismatched market leg evidence and unexpected capability claims for reads', async () => {
    const p = proposal(); let result: unknown = { ...status(p), legs: [{ ...status(p).legs[0], leg: 1 }] }; let replaceCapabilities = false;
    const broker = await server((request, socket) => reply(socket, request.operation === 'capabilities' && !replaceCapabilities ? capabilities('policy') : result));
    const client = await connectExecution({ expectedMode: 'policy', socketPath: broker.socketPath });
    await expect(client.status(p)).rejects.toThrow('invalid response');
    result = { ...status(p), automaticRetry: true };
    await expect(client.status(p)).rejects.toThrow('invalid response');
    result = { ...capabilities('policy'), fundedAcceptanceVerified: true };
    replaceCapabilities = true;
    await expect(client.capabilities()).rejects.toThrow('invalid response');
  });
});
