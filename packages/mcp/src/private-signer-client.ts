import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ExecutionConnectionInspection, ExecutionDeliveryUnknownError, ExecutionPreflight, ExecutionProposal, ExecutionStatus,
  LocalExecutionCapabilities, ToolError, validateExecution, type ExecutionClient } from '@verdict/core';
import { z } from 'zod';
import { Binding, HostedError, PrivateSignerConfig } from './hosted-model.js';

const Envelope = z.union([z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1).max(128), message: z.string().max(1000) }).strict() }).strict()]);
const Id = z.string().uuid();
const Subject = z.string().regex(/^did:privy:[A-Za-z0-9_-]{1,256}$/);
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
const Signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const Fields = { subject: Subject, enrollmentId: Id };
export const ProvisionerRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), subject: Subject, walletAddress: z.string().regex(/^0x[0-9a-f]{40}$/) }).strict(),
  z.object({ operation: z.literal('status'), ...Fields }).strict(),
  z.object({ operation: z.literal('faucet'), ...Fields, revision: Revision, signature: Signature }).strict(),
  z.object({ operation: z.literal('register'), ...Fields, revision: Revision, signature: Signature }).strict(),
  z.object({ operation: z.literal('preview'), ...Fields }).strict(),
  z.object({ operation: z.literal('activate'), ...Fields, planId: Id, revision: Revision, signature: Signature }).strict(),
  z.object({ operation: z.literal('binding'), subject: Subject }).strict(),
  z.object({ operation: z.literal('revoke'), subject: Subject, profileId: Id }).strict(),
]);
const BrokerFields = { expectedMode: z.literal('policy'), expectedGrantId: Id };
const BrokerRequest = z.discriminatedUnion('operation', [
  z.object({ ...BrokerFields, operation: z.literal('capabilities') }).strict(),
  z.object({ ...BrokerFields, operation: z.literal('inspectConnection') }).strict(),
  z.object({ ...BrokerFields, operation: z.literal('preflight'), proposal: ExecutionProposal }).strict(),
  z.object({ ...BrokerFields, operation: z.literal('submit'), proposal: ExecutionProposal }).strict(),
  z.object({ ...BrokerFields, operation: z.literal('status'), proposal: ExecutionProposal }).strict(),
  z.object({ ...BrokerFields, operation: z.literal('cancel'), proposal: ExecutionProposal, leg: z.union([z.literal(0), z.literal(1)]) }).strict(),
]);
const Operation = z.union([ProvisionerRequest,
  z.object({ operation: z.literal('broker'), subject: Subject, profileId: Id, request: BrokerRequest }).strict()]);
const unavailable = () => new HostedError(503, 'private_signer_unavailable', 'The private trading service is unavailable. Check the original enrollment or order status; do not replace an uncertain request.');
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function sameDecimal(a: string, b: string): boolean {
  const normalized = (value: string) => value.replace(/^0+(?=\d)/, '').replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
  return normalized(a) === normalized(b);
}

function parseJson(text: string): unknown {
  const stack: ({ kind: 'object'; keys: Set<string>; key: boolean } | { kind: 'array' })[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{') stack.push({ kind: 'object', keys: new Set(), key: true });
    else if (character === '[') stack.push({ kind: 'array' });
    else if (character === '}' || character === ']') stack.pop();
    else if (character === ',') { const current = stack.at(-1); if (current?.kind === 'object') current.key = true; }
    else if (character === '"') {
      const start = index;
      for (index++; index < text.length; index++) { if (text[index] === '\\') index++; else if (text[index] === '"') break; }
      const current = stack.at(-1);
      if (current?.kind === 'object' && current.key) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== 'string' || current.keys.has(key)) throw unavailable();
        current.keys.add(key); current.key = false;
      }
    }
  }
  return JSON.parse(text);
}

/** Fixed deployment destination. No browser, model, binding or record can supply its URL or secret. */
export class PrivateSignerClient {
  private readonly config: PrivateSignerConfig;
  private readonly secret: Buffer;
  constructor(config: PrivateSignerConfig, private readonly transport: typeof fetch = fetch) {
    this.config = PrivateSignerConfig.parse(config);
    const value = process.env[config.secretEnv];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw unavailable();
    this.secret = Buffer.from(value, 'base64url');
    if (this.secret.length !== 32 || this.secret.toString('base64url') !== value) throw unavailable();
  }
  async operation(value: z.input<typeof Operation>): Promise<unknown> {
    const body = JSON.stringify(Operation.parse(value));
    if (Buffer.byteLength(body) > 65_536) throw new HostedError(400, 'private_request_size', 'The private service request exceeds its size limit.');
    const issuedAt = Date.now(); const expiresAt = issuedAt + 30_000; const requestId = randomUUID(); const bodyHash = sha256(body);
    const claims = { version: 1, deploymentId: this.config.deploymentId, audience: 'verdict-private-signer', requestId, issuedAt, expiresAt, bodyHash };
    const frame = ['verdict-signer/1', claims.deploymentId, claims.audience, requestId, String(issuedAt), String(expiresAt), bodyHash].join('\n');
    const signature = createHmac('sha256', this.secret).update(frame, 'utf8').digest('hex');
    const authentication = Buffer.from(JSON.stringify({ ...claims, signature }), 'utf8').toString('base64url');
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 25_000);
    try {
      const response = await this.transport(new URL('/internal/operation', this.config.origin), { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-verdict-service-auth': authentication }, body });
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw unavailable();
      const reader = response.body?.getReader(); if (!reader) throw unavailable();
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 1_048_576) throw unavailable(); chunks.push(value); } }
      finally { await reader.cancel(); }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const envelope = Envelope.parse(parseJson(text));
      if (!envelope.ok) {
        if (envelope.error.code === 'broker_blocked') throw new ToolError(envelope.error.message, 'bad_input');
        throw unavailable();
      }
      return envelope.result;
    } catch (error) { if (error instanceof ToolError) throw error; throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  async connect(value: Binding): Promise<ExecutionClient> {
    const binding = Binding.parse(value);
    if (!binding.enabled || binding.execution.kind !== 'hosted_signer' || binding.execution.profileId !== binding.id || !binding.grantHash) throw unavailable();
    const profileId = binding.execution.profileId;
    const request = (request: z.input<typeof BrokerRequest>) => this.operation({ operation: 'broker', subject: binding.subject, profileId, request });
    const identity = (result: ExecutionPreflight | ExecutionStatus, proposal: ExecutionProposal) => {
      if (result.digest !== proposal.digest || result.legs.length !== proposal.payload.legs.length || result.legs.some((row, index) => row.leg !== index)) throw unavailable();
      if (result.state === 'ready' && result.legs.some(row => row.validUntil <= row.checkedAt)) throw unavailable();
      if (result.state === 'complete' && result.legs.some((row, index) => {
        const leg = proposal.payload.legs[index]; return !leg || !row.settled || !['filled', 'canceled', 'expired', 'rejected'].includes(row.state)
          || row.filled === null || row.netInventoryChange === null || !sameDecimal(row.filled, leg.shares) || !sameDecimal(row.netInventoryChange, leg.shares);
      })) throw unavailable();
    };
    const authority = (result: LocalExecutionCapabilities | ExecutionConnectionInspection | ExecutionPreflight) => {
      if (result.authority.mode !== 'policy' || result.authority.grantId !== binding.grantId || result.authority.grantHash !== binding.grantHash) throw unavailable();
    };
    const base = { expectedMode: 'policy' as const, expectedGrantId: binding.grantId };
    const mutation = async (operation: 'submit' | 'cancel', value: ExecutionProposal, leg?: 0 | 1): Promise<ExecutionStatus> => {
      const proposal = validateExecution(value);
      if (operation === 'cancel' && (leg === undefined || leg >= proposal.payload.legs.length)) throw new ToolError('Cancellation requires an exact existing proposal leg.', 'bad_input');
      try {
        const raw = operation === 'submit' ? await request({ ...base, operation, proposal }) : await request({ ...base, operation, proposal, leg: leg ?? 0 });
        const result = ExecutionStatus.parse(raw); identity(result, proposal); return result;
      } catch (error) { if (error instanceof ToolError && error.code === 'bad_input') throw error; throw new ExecutionDeliveryUnknownError(proposal.digest); }
    };
    const client: ExecutionClient = {
      mode: 'policy',
      capabilities: async () => { const result = LocalExecutionCapabilities.parse(await request({ ...base, operation: 'capabilities' })); authority(result); return result; },
      inspectConnection: async () => {
        const result = ExecutionConnectionInspection.parse(await request({ ...base, operation: 'inspectConnection' })); authority(result);
        for (const template of result.templates) validateExecution(template);
        const actual = result.accounts.map(row => JSON.stringify(row.account)).sort();
        if (JSON.stringify(actual) !== JSON.stringify(binding.accounts.map(account => JSON.stringify(account)).sort())) throw unavailable();
        if ('scope' in result && (result.scope.ownerWallet !== result.accounts[0]?.ownerWallet || result.scope.mode !== binding.mode
          || result.scope.account !== result.accounts[0]?.account.account || result.accounts[0]?.account.venue !== 'lighter'
          || result.scope.apiKeyIndex !== result.accounts[0].account.apiKeyIndex || result.scope.network !== result.accounts[0].account.network)) throw unavailable();
        return result;
      },
      preflight: async value => { const proposal = validateExecution(value); const result = ExecutionPreflight.parse(await request({ ...base, operation: 'preflight', proposal })); identity(result, proposal); authority(result); return result; },
      submit: value => mutation('submit', value),
      status: async value => { const proposal = validateExecution(value); const result = ExecutionStatus.parse(await request({ ...base, operation: 'status', proposal })); identity(result, proposal); return result; },
      cancel: value => mutation('cancel', value.proposal, value.leg),
    };
    await client.capabilities(); return Object.freeze(client);
  }
}
