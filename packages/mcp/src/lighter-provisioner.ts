import { lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, relative } from 'node:path';
import { z } from 'zod';
import { ConnectAddress, LighterScopePlan } from './connect-contract.js';
import type { AccountServiceConfig } from './connect-model.js';
import { Binding, HostedError } from './hosted-model.js';

const Id = z.string().uuid(); const Revision = z.string().regex(/^[a-f0-9]{64}$/);
const NumberId = z.number().int().nonnegative().safe();
const Identity = { enrollmentId: Id, revision: Revision, network: z.literal('testnet'), ownerWallet: ConnectAddress };
const Account = { account: NumberId, apiKeyIndex: NumberId.min(5).max(254), publicKey: z.string().regex(/^(?:0x)?[a-fA-F0-9]{80}$/) };
export const ProvisionerSetup = z.discriminatedUnion('state', [
  z.object({ ...Identity, state: z.literal('funding_required'), message: z.string().min(1).max(8192), expiresAt: NumberId }).strict(),
  z.object({ ...Identity, ...Account, state: z.literal('signature_required'), nonce: NumberId, chainId: z.literal(300), message: z.string().min(1).max(8192), expiresAt: NumberId }).strict(),
  z.object({ ...Identity, ...Account, state: z.literal('registering') }).strict(),
  z.object({ ...Identity, ...Account, state: z.literal('ready') }).strict(),
  z.object({ ...Identity, state: z.literal('blocked'), reason: z.string().min(1).max(1000) }).strict(),
]);
export type ProvisionerSetup = z.infer<typeof ProvisionerSetup>;
const Subject = z.string().regex(/^did:privy:[A-Za-z0-9_-]{1,256}$/);
const Signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const Fields = { subject: Subject, enrollmentId: Id };
const Request = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), subject: Subject, walletAddress: ConnectAddress }).strict(),
  z.object({ operation: z.literal('status'), ...Fields }).strict(),
  z.object({ operation: z.literal('faucet'), ...Fields, revision: Revision, signature: Signature }).strict(),
  z.object({ operation: z.literal('register'), ...Fields, revision: Revision, signature: Signature }).strict(),
  z.object({ operation: z.literal('preview'), ...Fields }).strict(),
  z.object({ operation: z.literal('activate'), ...Fields, planId: Id, revision: Revision, signature: Signature }).strict(),
  z.object({ operation: z.literal('binding'), subject: Subject }).strict(),
  z.object({ operation: z.literal('revoke'), subject: Subject, profileId: z.string().min(1).max(128) }).strict(),
]);
type Request = z.infer<typeof Request>;
const Envelope = z.union([z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().max(128), message: z.string().max(1000) }).strict() }).strict()]);
const unavailable = () => new HostedError(503, 'lighter_setup_unavailable', 'Hosted Lighter setup is unavailable. Keep the original enrollment and check status; do not create a replacement after an uncertain send.');

/** Finite private control protocol. No browser input selects a path, mode, limit or native method. */
export class LighterProvisioner {
  constructor(private readonly config: NonNullable<AccountServiceConfig['lighterProvisioner']>) {}
  private decode<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> { const parsed = schema.safeParse(value); if (!parsed.success) throw unavailable(); return parsed.data; }
  private async request(input: Request): Promise<unknown> {
    const request = Request.parse(input);
    try {
      const [socket, parent] = await Promise.all([lstat(this.config.socketPath), lstat(dirname(this.config.socketPath))]);
      if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0 || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw unavailable();
      return await new Promise((resolve, reject) => {
        const socket = connect({ path: this.config.socketPath }); let done = false; let size = 0; const chunks: Buffer[] = [];
        const finish = (error: Error | null, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
        const timer = setTimeout(() => finish(unavailable()), 25_000);
        socket.on('error', () => finish(unavailable())); socket.on('close', () => { if (!done) finish(unavailable()); });
        socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
        socket.on('data', (chunk: Buffer) => {
          size += chunk.length; if (size > 65_536) { finish(unavailable()); return; } chunks.push(chunk);
          if (!chunk.includes(10)) return;
          try {
            const bytes = Buffer.concat(chunks); const newline = bytes.indexOf(10);
            if (newline !== bytes.length - 1) throw unavailable();
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline));
            const envelope = Envelope.parse(JSON.parse(text)); if (!envelope.ok) throw unavailable(); finish(null, envelope.result);
          } catch { finish(unavailable()); }
        });
      });
    } catch { throw unavailable(); }
  }
  private bindingValue(value: unknown, subject: string): Binding | null {
    const result = this.decode(z.object({ binding: Binding.nullable() }).strict(), value); const binding = result.binding;
    if (!binding) return null;
    const path = relative(this.config.brokerSocketRoot, binding.brokerSocket);
    if (!path || path.startsWith('..') || binding.subject !== subject || !binding.enabled || !binding.grantHash || binding.accounts.length !== 1
      || binding.accounts.some((account) => account.venue !== 'lighter' || account.network !== 'testnet' || account.apiKeyIndex < 5)) throw unavailable();
    return binding;
  }
  async setup(input: Extract<Request, { operation: 'prepare' | 'status' | 'faucet' | 'register' }>): Promise<ProvisionerSetup> { return this.decode(ProvisionerSetup, await this.request(input)); }
  async preview(subject: string, enrollmentId: string) { return this.decode(LighterScopePlan, await this.request({ operation: 'preview', subject, enrollmentId })); }
  async activate(input: Extract<Request, { operation: 'activate' }>) { const binding = this.bindingValue(await this.request(input), input.subject); if (!binding) throw unavailable(); return binding; }
  async binding(subject: string) { return this.bindingValue(await this.request({ operation: 'binding', subject }), subject); }
  async revoke(subject: string, profileId: string) { return this.decode(z.object({ revoked: z.literal(true) }).strict(), await this.request({ operation: 'revoke', subject, profileId })); }
}
