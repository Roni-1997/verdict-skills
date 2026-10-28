import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ExecutionLeg, ExecutionProposal, validateExecution } from './execution.js';
import { ToolError } from './tools.js';

export const ExecutionMode = z.enum(['per_order', 'policy']);
export type ExecutionMode = z.infer<typeof ExecutionMode>;
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Decimal = z.string().max(128).regex(/^\d+(?:\.\d+)?$/);
const SignedDecimal = z.string().max(129).regex(/^-?\d+(?:\.\d+)?$/);
const Epoch = z.number().int().nonnegative().safe();
const ObservationMs = z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER);
const LegIndex = z.union([z.literal(0), z.literal(1)]);
const Authority = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('per_order'), approval: z.literal('operator_terminal') }).strict(),
  z.object({ mode: z.literal('policy'), grantId: z.string().min(1).max(128), grantHash: Digest,
    expiresAt: Epoch, newRisk: z.enum(['active', 'expired', 'revoked', 'unresolved']),
    remainingDebitUSDC: Decimal, remainingOrders: z.number().int().nonnegative().safe(), cancelOwnOrders: z.boolean(),
  }).strict(),
]);

/** Public account identity, selected only from a reviewed template or consumer scope. */
export const ExecutionLinkedAccount = z.discriminatedUnion('venue', [
  ExecutionLeg.options[0].pick({ venue: true, network: true, account: true }),
  ExecutionLeg.options[1].pick({ venue: true, network: true, account: true, apiKeyIndex: true }),
  ExecutionLeg.options[2].pick({ venue: true, network: true, account: true }),
]);
export type ExecutionLinkedAccount = z.infer<typeof ExecutionLinkedAccount>;
const PublicAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const ConnectionCheck = z.enum(['ready', 'missing', 'unknown']);
export const ConsumerLighterScope = z.object({ kind: z.literal('consumer_lighter'), version: z.literal(1), ownerWallet: PublicAddress,
  network: z.literal('testnet'), account: z.number().int().nonnegative().safe(), apiKeyIndex: z.number().int().min(5).max(254),
  creators: z.array(z.number().int().nonnegative().safe()).min(1).max(64), mode: ExecutionMode,
  maxOrderDebitUSDC: Decimal, origin: z.string().url(), enrollmentId: z.string().uuid(), epoch: z.number().int().nonnegative().safe(),
}).strict();
export type ConsumerLighterScope = z.infer<typeof ConsumerLighterScope>;
const Inspection = z.object({
  kind: z.literal('execution_connection_inspection'), authority: Authority.options[1],
  maxDebitUSDC: Decimal, maxOrders: z.number().int().positive().safe(),
  templates: z.array(ExecutionProposal).min(1).max(32),
  accounts: z.array(z.object({ account: ExecutionLinkedAccount,
    ownerWallet: PublicAddress.nullable(), agentAddress: PublicAddress.nullable(),
    checks: z.object({ registration: ConnectionCheck, builder: ConnectionCheck }).strict(),
    checkedAt: ObservationMs, notes: z.array(z.string().max(1000)).max(32),
  }).strict()).min(1).max(64),
  fundedAcceptanceVerified: z.literal(false),
}).strict();
export const ExecutionConnectionInspection = z.union([Inspection,
  Inspection.extend({ templates: z.tuple([]), scope: ConsumerLighterScope }).strict(),
]);
export type ExecutionConnectionInspection = z.infer<typeof ExecutionConnectionInspection>;

export const LocalExecutionCapabilities = z.object({
  kind: z.literal('local_execution_capabilities'), authority: Authority, fundedAcceptanceVerified: z.literal(false),
}).strict();
export type LocalExecutionCapabilities = z.infer<typeof LocalExecutionCapabilities>;
export const ExecutionPreflight = z.object({
  state: z.literal('ready'), digest: Digest, authorization: z.literal('none'), authority: Authority,
  legs: z.array(z.object({ leg: LegIndex, inventoryShares: Decimal, availableUSDC: Decimal,
    feeBoundUSDC: Decimal, checkedAt: ObservationMs, validUntil: ObservationMs,
  }).strict()).min(1).max(2),
}).strict();
export type ExecutionPreflight = z.infer<typeof ExecutionPreflight>;
export const ExecutionStatus = z.object({
  digest: Digest, state: z.enum(['complete', 'needs_reconciliation']),
  legs: z.array(z.object({ leg: LegIndex,
    state: z.enum(['not_attempted', 'open', 'pending', 'unknown', 'filled', 'canceled', 'expired', 'rejected']),
    filled: Decimal.nullable(), netInventoryChange: SignedDecimal.nullable(), settled: z.boolean(),
  }).strict()).min(1).max(2),
  automaticRetry: z.literal(false), note: z.string().max(10_000), blocked: z.string().max(10_000).optional(),
}).strict();
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

/** A mutation may have reached the broker. Reconcile the same proposal; never replace it. */
export class ExecutionDeliveryUnknownError extends ToolError {
  constructor(readonly digest: string) {
    super(`Local execution delivery is uncertain for digest ${digest}. Call status with the same proposal; do not prepare or submit a replacement.`, 'upstream');
    this.name = 'ExecutionDeliveryUnknownError';
  }
}

export interface ExecutionClient {
  readonly mode: ExecutionMode;
  capabilities(): Promise<LocalExecutionCapabilities>;
  inspectConnection(): Promise<ExecutionConnectionInspection>;
  preflight(proposal: ExecutionProposal): Promise<ExecutionPreflight>;
  submit(proposal: ExecutionProposal): Promise<ExecutionStatus>;
  status(proposal: ExecutionProposal): Promise<ExecutionStatus>;
  cancel(input: { readonly proposal: ExecutionProposal; readonly leg: 0 | 1 }): Promise<ExecutionStatus>;
}
const ConnectionFields = { socketPath: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
};
const Options = z.discriminatedUnion('expectedMode', [
  z.object({ ...ConnectionFields, expectedMode: z.literal('per_order') }).strict(),
  z.object({ ...ConnectionFields, expectedMode: z.literal('policy'), expectedGrantId: z.string().uuid().optional() }).strict(),
]);
/** Operator configuration only. expectedGrantId asserts identity; it never selects or grants authority. */
export type ExecutionConnectionOptions = Readonly<z.input<typeof Options>>;
const Envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.enum(['broker_blocked', 'broker_error']), message: z.string().max(10_000) }).strict() }).strict(),
]);
type Operation = 'inspectConnection' | 'capabilities' | 'preflight' | 'submit' | 'status' | 'cancel';
const MAX_BYTES = 1_048_576;

/** JSON.parse otherwise silently accepts duplicate keys. All values remain unknown until Zod parses them. */
function parseJson(text: string): unknown {
  const objects: ({ kind: 'object'; keys: Set<string>; key: boolean } | { kind: 'array' })[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') objects.push({ kind: 'object', keys: new Set(), key: true });
    else if (c === '[') objects.push({ kind: 'array' });
    else if (c === '}' || c === ']') objects.pop();
    else if (c === ',') { const current = objects.at(-1); if (current?.kind === 'object') current.key = true; }
    else if (c === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const current = objects.at(-1);
      if (current?.kind === 'object' && current.key) {
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (typeof key !== 'string' || current.keys.has(key)) throw new Error('Invalid JSON');
        current.keys.add(key); current.key = false;
      }
    }
  }
  return JSON.parse(text);
}

function invalidResponse(): ToolError { return new ToolError('Local broker returned an invalid response (details hidden).', 'upstream'); }
function validateResult<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

/** Connect to an operator-owned local broker. expectedMode is asserted on every request and cannot change authority. */
export async function connectExecution(options: ExecutionConnectionOptions): Promise<ExecutionClient> {
  const parsed = Options.safeParse(options);
  if (!parsed.success) throw new ToolError('Invalid local execution connection options (values hidden).', 'bad_input');
  const { expectedMode, timeoutMs = 30_000 } = parsed.data;
  const expectedGrantId = parsed.data.expectedMode === 'policy' ? parsed.data.expectedGrantId : undefined;
  const socketPath = parsed.data.socketPath ?? process.env.VERDICT_BROKER_SOCKET;
  if (!socketPath || !isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new ToolError('Configure an absolute local VERDICT_BROKER_SOCKET path or socketPath.', 'not_configured');
  }
  const destination = socketPath;

  function request(operation: Operation, proposal?: ExecutionProposal, leg?: 0 | 1): Promise<unknown> {
    const mutating = operation === 'submit' || operation === 'cancel';
    const body = `${JSON.stringify({ expectedMode, ...(expectedGrantId === undefined ? {} : { expectedGrantId }), operation, ...(proposal === undefined ? {} : { proposal }), ...(leg === undefined ? {} : { leg }) })}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) throw new ToolError('Local execution request exceeds 1 MiB.', 'bad_input');
    return new Promise((resolve, reject) => {
      const socket = connect({ path: destination });
      let finished = false; let couldBeDelivered = false; let bytes = 0;
      const chunks: Buffer[] = [];
      function finish(error: ToolError | null, result?: unknown) {
        if (finished) return;
        finished = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result);
      }
      function uncertain() {
        finish(mutating && couldBeDelivered && proposal ? new ExecutionDeliveryUnknownError(proposal.digest)
          : new ToolError('Local execution transport failed or timed out (details hidden).', 'upstream'));
      }
      const timer = setTimeout(uncertain, timeoutMs);
      socket.on('error', uncertain);
      socket.on('close', () => { if (!finished) uncertain(); });
      socket.on('connect', () => {
        couldBeDelivered = true;
        socket.end(body);
      });
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { uncertain(); return; }
        chunks.push(chunk);
        if (chunk.indexOf(10) < 0) return;
        const joined = Buffer.concat(chunks);
        const newline = joined.indexOf(10);
        if (newline < 0) return;
        try {
          if (joined.subarray(newline + 1).toString('utf8').trim()) throw invalidResponse();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(joined.subarray(0, newline));
          const envelope = validateResult(Envelope, parseJson(text));
          if (!envelope.ok) {
            finish(envelope.error.code === 'broker_blocked' ? new ToolError(envelope.error.message, 'bad_input')
              : new ToolError('Local broker operation failed; reconcile attempted orders before taking further action.', 'upstream'));
          } else finish(null, envelope.result);
        } catch { uncertain(); }
      });
    });
  }

  function authorityMode(result: LocalExecutionCapabilities | ExecutionPreflight | ExecutionConnectionInspection) {
    if (result.authority.mode !== expectedMode) throw new ToolError('Local broker mode differs from the explicitly selected expectedMode.', 'not_configured');
    if (expectedGrantId !== undefined && (result.authority.mode !== 'policy' || result.authority.grantId !== expectedGrantId)) {
      throw new ToolError('Local broker grant differs from the operator-pinned expectedGrantId.', 'not_configured');
    }
  }
  function identity(result: ExecutionPreflight | ExecutionStatus, proposal: ExecutionProposal) {
    if (result.digest !== proposal.digest || result.legs.length !== proposal.payload.legs.length
      || result.legs.some((row, index) => row.leg !== index)) throw invalidResponse();
    if (result.state === 'ready' && result.legs.some((row) => row.validUntil <= row.checkedAt)) throw invalidResponse();
    if (result.state === 'complete' && result.legs.some((row, index) => {
      const leg = proposal.payload.legs[index];
      const normalized = (value: string) => value.replace(/^0+(?=\d)/, '').replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
      return !leg || !row.settled || !['filled', 'canceled', 'expired', 'rejected'].includes(row.state)
        || row.filled === null || row.netInventoryChange === null
        || normalized(row.filled) !== normalized(leg.shares) || normalized(row.netInventoryChange) !== normalized(leg.shares);
    })) throw invalidResponse();
  }
  async function mutation(operation: 'submit' | 'cancel', proposal: ExecutionProposal, leg?: 0 | 1): Promise<ExecutionStatus> {
    const response = await request(operation, proposal, leg);
    try { const result = validateResult(ExecutionStatus, response); identity(result, proposal); return result; }
    catch { throw new ExecutionDeliveryUnknownError(proposal.digest); }
  }
  const client: ExecutionClient = {
    mode: expectedMode,
    async capabilities() {
      const result = validateResult(LocalExecutionCapabilities, await request('capabilities')); authorityMode(result); return result;
    },
    async inspectConnection() {
      if (expectedMode !== 'policy' || expectedGrantId === undefined) {
        throw new ToolError('Connection inspection requires an operator-pinned policy grant.', 'not_configured');
      }
      const result = validateResult(ExecutionConnectionInspection, await request('inspectConnection'));
      authorityMode(result);
      try {
        for (const template of result.templates) validateExecution(template);
        const accountKey = (account: ExecutionLinkedAccount) => JSON.stringify(account);
        const expected = new Set(('scope' in result ? [accountKey(ExecutionLinkedAccount.parse({ venue: 'lighter',
          network: result.scope.network, account: result.scope.account, apiKeyIndex: result.scope.apiKeyIndex }))] : result.templates.flatMap((template) => template.payload.legs.map((leg) => {
          const { venue, network, account } = leg;
          return accountKey(ExecutionLinkedAccount.parse({ venue, network, account,
            ...(leg.venue === 'lighter' ? { apiKeyIndex: leg.apiKeyIndex } : {}) }));
        }))));
        const actual = result.accounts.map((row) => accountKey(row.account));
        if (actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some((key) => !expected.has(key))) throw invalidResponse();
      } catch { throw invalidResponse(); }
      return result;
    },
    async preflight(value) {
      const proposal = validateExecution(value);
      const result = validateResult(ExecutionPreflight, await request('preflight', proposal)); identity(result, proposal); authorityMode(result); return result;
    },
    async submit(value) { return mutation('submit', validateExecution(value)); },
    async status(value) {
      const proposal = validateExecution(value);
      const result = validateResult(ExecutionStatus, await request('status', proposal)); identity(result, proposal); return result;
    },
    async cancel(value) {
      const input = z.object({ proposal: z.unknown(), leg: LegIndex }).strict().safeParse(value);
      if (!input.success) throw new ToolError('Invalid exact-leg cancellation input (values hidden).', 'bad_input');
      const proposal = validateExecution(input.data.proposal);
      if (input.data.leg >= proposal.payload.legs.length) throw new ToolError('Cancellation leg is outside this proposal.', 'bad_input');
      return mutation('cancel', proposal, input.data.leg);
    },
  };
  await client.capabilities();
  return Object.freeze(client);
}
