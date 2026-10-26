import { createHash } from 'node:crypto';
import {
  connectExecution, type ExecutionClient, type ExecutionConnectionOptions,
  ExecutionPreflight, ExecutionStatus, executionConfirmation, prepareExecution, validateExecution,
} from '@verdict/core';
import type { ExecutionLeg, ExecutionProposal, LocalExecutionCapabilities } from '@verdict/core';
import { z } from 'zod';
import { requireLighterProposal, requireLighterRequest } from './lighter-execution-boundary.js';
import type { HostedJobStore } from './hosted-job-store.js';
import type { HostedRuntime } from './hosted-security.js';
import {
  type Binding, HostedConfig, HostedError, type HostedMutation, type Job, type LinkedAccount, Principal,
  READ_SCOPE, requireScope, TRADE_SCOPE, type ConnectorScope,
} from './hosted-model.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
type Context = Readonly<{ binding: Binding; bindingHash: string; owner: string }>;
export type HostedRemoteConnect = (binding: Binding) => Promise<ExecutionClient>;
type Connect = (options: ExecutionConnectionOptions) => Promise<ExecutionClient>;
const Cancel = z.object({ proposal: z.unknown(), leg: z.union([z.literal(0), z.literal(1)]) }).strict();

/** Account-linked transport only. All order and budget semantics stay in the SDK/broker. */
export class HostedExecution {
  private readonly config: HostedConfig;
  constructor(config: HostedConfig, private readonly jobs: HostedJobStore, private readonly connect: Connect = connectExecution, private readonly runtime?: HostedRuntime, private readonly remoteConnect?: HostedRemoteConnect) {
    const parsed = HostedConfig.safeParse(config);
    if (!parsed.success) throw new HostedError(503, 'not_configured', 'Hosted execution configuration is invalid.');
    this.config = parsed.data;
  }

  private async context(value: Principal, scope: ConnectorScope): Promise<Context> {
    const parsed = Principal.safeParse(value);
    if (!parsed.success || parsed.data.issuer !== this.config.issuer) throw new HostedError(401, 'invalid_token', 'Sign in with the configured account provider.');
    requireScope(parsed.data, READ_SCOPE);
    if (scope !== READ_SCOPE) requireScope(parsed.data, scope);
    await this.runtime?.assertActive(parsed.data);
    const binding = this.runtime ? await this.runtime.binding(parsed.data.subject) : this.config.bindings.find((item) => item.subject === parsed.data.subject);
    if (!binding?.enabled) throw new HostedError(403, 'account_not_linked', 'This account has no enabled trading connection.');
    return { binding, bindingHash: hash(JSON.stringify(canonical(binding))), owner: hash(`${parsed.data.issuer}\0${parsed.data.subject}`) };
  }

  private proposal(value: unknown, scope: 'historical' | 'new_order' = 'historical'): ExecutionProposal {
    try {
      const proposal = scope === 'new_order' ? requireLighterProposal(value) : validateExecution(value);
      if (scope === 'new_order' && this.config.lighter && proposal.payload.legs.some((leg) => leg.network !== this.config.lighter?.network)) throw new Error('Research and execution network mismatch');
      return proposal;
    }
    catch { throw new HostedError(400, 'invalid_proposal', 'Use the unchanged canonical execution proposal.'); }
  }

  private accountsMatch(context: Context, proposal: ExecutionProposal): void {
    const matches = (leg: ExecutionLeg) => context.binding.accounts.some((account) => {
      if (account.venue !== leg.venue || account.network !== leg.network || account.account !== leg.account) return false;
      return leg.venue !== 'lighter' || (account.venue === 'lighter' && account.apiKeyIndex === leg.apiKeyIndex);
    });
    if (!proposal.payload.legs.every(matches)) throw new HostedError(403, 'account_mismatch', 'Every order must use this signed-in account’s configured venue connection.');
  }

  private async current(principal: Principal, expected: Context, scope: ConnectorScope): Promise<Context> {
    const actual = await this.context(principal, scope);
    if (actual.owner !== expected.owner || actual.bindingHash !== expected.bindingHash) throw new HostedError(409, 'binding_changed', 'The trading connection changed. Review it with the operator before continuing.');
    return actual;
  }

  private grant(capabilities: Pick<LocalExecutionCapabilities | ExecutionPreflight, 'authority'>, context: Context): void {
    if (capabilities.authority.mode !== 'policy' || capabilities.authority.grantId !== context.binding.grantId
      || (context.binding.grantHash !== undefined && capabilities.authority.grantHash !== context.binding.grantHash)) {
      throw new HostedError(503, 'broker_authority_mismatch', 'The operator trading policy does not match this linked account.');
    }
  }

  private async client(principal: Principal, context: Context, scope: ConnectorScope): Promise<ExecutionClient> {
    await this.current(principal, context, scope);
    await this.runtime?.ensureBinding?.(principal);
    await this.current(principal, context, scope);
    const execution = context.binding.execution;
    const client = execution.kind === 'local_socket'
      ? await this.connect({ expectedMode: 'policy', expectedGrantId: context.binding.grantId, socketPath: execution.socketPath })
      : this.remoteConnect ? await this.remoteConnect(context.binding)
        : (() => { throw new HostedError(503, 'signer_not_configured', 'The fixed private signer transport is unavailable.'); })();
    await this.current(principal, context, scope);
    if (client.mode !== 'policy') throw new HostedError(503, 'broker_authority_mismatch', 'Hosted execution requires the operator’s bounded policy broker.');
    this.grant(await client.capabilities(), context);
    await this.current(principal, context, scope);
    return client;
  }

  private validProposalNow(proposal: ExecutionProposal): void {
    if (proposal.payload.expiresAt <= Date.now() || proposal.payload.createdAt > Date.now() + 5000) throw new HostedError(409, 'proposal_expired', 'Prepare and review a current proposal before requesting a new trade.');
  }

  private checkJob(job: Job, context: Context): void {
    if (job.owner !== context.owner) throw new HostedError(404, 'order_not_found', 'This order request is unavailable.');
    if (job.bindingHash !== context.bindingHash) throw new HostedError(409, 'binding_changed', 'This saved request belongs to an earlier trading connection. It cannot be resubmitted.');
    this.accountsMatch(context, job.proposal);
  }

  private pending(job: Job): HostedMutation {
    if (job.state === 'declined') throw new HostedError(409, 'approval_declined', 'This request was declined. Nothing will be retried.');
    if (job.expiresAt <= Date.now()) throw new HostedError(410, 'approval_expired', 'This approval request expired. It cannot be renewed or sent.');
    return { state: 'approval_required', digest: job.proposal.digest, approvalUrl: `${this.config.publicOrigin.replace(/\/$/, '')}/review/${job.id}`,
      expiresAt: job.expiresAt, nextOperation: 'status', automaticRetry: false };
  }

  private unknown(proposal: ExecutionProposal): HostedMutation {
    return { state: 'delivery_unknown', digest: proposal.digest, nextOperation: 'status', automaticRetry: false };
  }

  private result(value: unknown, proposal: ExecutionProposal): ExecutionStatus {
    const parsed = ExecutionStatus.safeParse(value);
    if (!parsed.success || parsed.data.digest !== proposal.digest || parsed.data.legs.length !== proposal.payload.legs.length
      || parsed.data.legs.some((leg, index) => leg.leg !== index)) throw new HostedError(502, 'invalid_broker_result', 'The trading response could not be verified. Reconcile the original proposal.');
    return parsed.data;
  }

  private async reconcile(principal: Principal, context: Context, job: Job): Promise<HostedMutation> {
    this.checkJob(job, context);
    try {
      const client = await this.client(principal, context, READ_SCOPE);
      const result = this.result(await client.status(job.proposal), job.proposal);
      await this.jobs.observe(job.id, result);
      return result;
    } catch { return this.unknown(job.proposal); }
  }

  private async dispatch(principal: Principal, context: Context, job: Job): Promise<HostedMutation> {
    this.checkJob(job, context);
    if (job.purpose === 'submit' && job.state === 'pending') this.proposal(job.proposal, 'new_order');
    await this.current(principal, context, TRADE_SCOPE);
    await this.runtime?.assertJobActive(job);
    if (job.purpose === 'submit' && job.state === 'pending') this.validProposalNow(job.proposal);
    const claim = { id: job.id, owner: context.owner, bindingHash: context.bindingHash, now: Date.now() };
    const claimed = this.runtime?.withJobAuthorization
      ? await this.runtime.withJobAuthorization(job, (transaction) => Promise.resolve(this.jobs.claim(claim, transaction)))
      : await this.jobs.claim(claim);
    if (claimed.kind === 'already_attempted') return this.reconcile(principal, context, claimed.job);
    // From this durable boundary onward EVERY error is ambiguous. Never retry
    // a mutation even when failure appears to precede venue submission.
    try {
      const client = await this.client(principal, context, TRADE_SCOPE);
      await this.current(principal, context, TRADE_SCOPE);
      await this.runtime?.assertJobActive(claimed.job);
      const response = claimed.job.purpose === 'submit' ? await client.submit(claimed.job.proposal)
        : await client.cancel({ proposal: claimed.job.proposal, leg: this.cancelLeg(claimed.job) });
      const result = this.result(response, claimed.job.proposal);
      await this.jobs.observe(claimed.job.id, result);
      return result;
    } catch { return this.unknown(claimed.job.proposal); }
  }

  private cancelLeg(job: Job): 0 | 1 {
    if (job.leg === null || job.leg >= job.proposal.payload.legs.length) throw new HostedError(400, 'invalid_leg', 'Choose one existing order leg.');
    return job.leg;
  }

  async accounts(principal: Principal): Promise<{ gatewayMode: Binding['mode']; brokerMode: 'policy'; accounts: LinkedAccount[];
    authority: LocalExecutionCapabilities['authority']; singleLegConfirmationOnly: boolean }> {
    const context = await this.context(principal, READ_SCOPE);
    const accounts = context.binding.accounts.filter((account) => account.venue === 'lighter');
    if (accounts.length === 0) throw new HostedError(403, 'lighter_account_required', 'Connect a Lighter account to trade on Verdict.');
    const client = await this.client(principal, context, READ_SCOPE);
    const capabilities = await client.capabilities(); this.grant(capabilities, context);
    return { gatewayMode: context.binding.mode, brokerMode: 'policy', accounts: accounts.map((account) => ({ ...account })),
      authority: capabilities.authority, singleLegConfirmationOnly: true };
  }

  async prepare(principal: Principal, input: unknown): Promise<ExecutionProposal> {
    const context = await this.context(principal, READ_SCOPE);
    let proposal: ExecutionProposal;
    try { proposal = prepareExecution(requireLighterRequest(input)); }
    catch { throw new HostedError(400, 'invalid_proposal', 'The trade request does not match the supported execution schema.'); }
    this.proposal(proposal, 'new_order');
    this.accountsMatch(context, proposal);
    return proposal;
  }

  async intentContext(principal: Principal) {
    const context = await this.context(principal, READ_SCOPE); const client = await this.client(principal, context, READ_SCOPE);
    const inspection = await client.inspectConnection(); await this.current(principal, context, READ_SCOPE);
    if (!('scope' in inspection) || inspection.scope.kind !== 'consumer_lighter' || inspection.scope.mode !== context.binding.mode
      || inspection.scope.origin !== this.config.publicOrigin || inspection.accounts.length !== 1) throw new HostedError(403, 'consumer_connection_required', 'Connect a reviewed hosted Lighter account before preparing a budget-based trade.');
    const account = context.binding.accounts[0]; const verified = inspection.accounts[0]?.account;
    if (account?.venue !== 'lighter' || !verified || JSON.stringify(account) !== JSON.stringify(verified)
      || account.account !== inspection.scope.account || account.network !== inspection.scope.network || account.apiKeyIndex !== inspection.scope.apiKeyIndex) throw new HostedError(503, 'broker_authority_mismatch', 'The hosted Lighter scope does not match this account.');
    this.grant(inspection, context);
    const readiness = inspection.accounts[0];
    const accountReady = readiness !== undefined && readiness.ownerWallet === inspection.scope.ownerWallet && readiness.checks.registration === 'ready'
      && readiness.checks.builder === 'ready' && readiness.checkedAt >= Date.now() - 60_000 && readiness.checkedAt <= Date.now() + 5000;
    return { account, scope: inspection.scope, bindingHash: context.bindingHash, authorityExpiresAt: inspection.authority.expiresAt,
      authorityRisk: inspection.authority.newRisk, accountReady };
  }

  async review(principal: Principal, value: unknown): Promise<ReturnType<typeof executionConfirmation>> {
    const context = await this.context(principal, READ_SCOPE); const proposal = this.proposal(value, 'new_order');
    this.accountsMatch(context, proposal);
    return executionConfirmation(proposal, 'hosted');
  }

  async preflight(principal: Principal, value: unknown): Promise<ExecutionPreflight> {
    const context = await this.context(principal, READ_SCOPE); const proposal = this.proposal(value, 'new_order');
    this.accountsMatch(context, proposal);
    const client = await this.client(principal, context, READ_SCOPE);
    const result = ExecutionPreflight.parse(await client.preflight(proposal)); this.grant(result, context);
    if (result.digest !== proposal.digest || result.legs.length !== proposal.payload.legs.length) throw new HostedError(502, 'invalid_broker_result', 'The account preflight response could not be verified.');
    return result;
  }

  async submit(principal: Principal, value: unknown): Promise<HostedMutation> {
    const context = await this.context(principal, TRADE_SCOPE); const proposal = this.proposal(value, 'new_order');
    this.accountsMatch(context, proposal);
    const existing = await this.jobs.find({ owner: context.owner, purpose: 'submit', digest: proposal.digest, leg: null });
    if (existing) {
      this.checkJob(existing, context);
      if (existing.state !== 'pending') {
        if (existing.state === 'declined') return this.pending(existing);
        return this.reconcile(principal, context, existing);
      }
      if (context.binding.mode === 'per_order') return this.pending(existing);
      return this.dispatch(principal, context, existing);
    }
    this.validProposalNow(proposal);
    if (context.binding.mode === 'per_order') {
      const result = await this.preflight(principal, proposal);
      if (result.legs.some((leg) => leg.validUntil <= Date.now())) throw new HostedError(409, 'preflight_expired', 'The account preflight expired. Request a new preflight before review.');
    }
    await this.current(principal, context, TRADE_SCOPE); this.validProposalNow(proposal);
    const job = await this.jobs.getOrCreate({ owner: context.owner, bindingHash: context.bindingHash, purpose: 'submit', proposal, leg: null,
      authorization: principal.authorization ?? null,
      expiresAt: Math.min(proposal.payload.expiresAt, Date.now() + this.config.approvalTtlSeconds * 1000) });
    this.checkJob(job, context);
    return context.binding.mode === 'per_order' && job.state === 'pending' ? this.pending(job) : this.dispatch(principal, context, job);
  }

  async status(principal: Principal, value: unknown): Promise<HostedMutation> {
    const context = await this.context(principal, READ_SCOPE); const proposal = this.proposal(value);
    this.accountsMatch(context, proposal);
    const job = await this.jobs.find({ owner: context.owner, purpose: 'submit', digest: proposal.digest, leg: null });
    if (!job) throw new HostedError(404, 'order_not_found', 'No order request belongs to this account and proposal.');
    this.checkJob(job, context);
    if (job.state === 'pending' || job.state === 'declined') return this.pending(job);
    if (context.binding.mode === 'per_order') {
      for (const leg of [0, 1] satisfies (0 | 1)[]) {
        if (leg >= proposal.payload.legs.length) continue;
        const pending = await this.jobs.find({ owner: context.owner, purpose: 'cancel', digest: proposal.digest, leg });
        if (pending?.state === 'pending' && pending.expiresAt > Date.now()) {
          this.checkJob(pending, context); return this.pending(pending);
        }
      }
    }
    return this.reconcile(principal, context, job);
  }

  async cancel(principal: Principal, value: unknown): Promise<HostedMutation> {
    const context = await this.context(principal, TRADE_SCOPE); const input = Cancel.safeParse(value);
    if (!input.success) throw new HostedError(400, 'invalid_leg', 'Provide only the original proposal and exact order leg.');
    const proposal = this.proposal(input.data.proposal); this.accountsMatch(context, proposal);
    if (input.data.leg >= proposal.payload.legs.length) throw new HostedError(400, 'invalid_leg', 'Choose one existing order leg.');
    const original = await this.jobs.find({ owner: context.owner, purpose: 'submit', digest: proposal.digest, leg: null });
    if (!original || !['attempted', 'observed'].includes(original.state)) throw new HostedError(409, 'order_not_attempted', 'Only a previously attempted order from this account can be canceled.');
    this.checkJob(original, context);
    if (original.result?.legs[input.data.leg]?.state === 'not_attempted') throw new HostedError(409, 'order_not_attempted', 'This order leg was never attempted.');
    const existing = await this.jobs.find({ owner: context.owner, purpose: 'cancel', digest: proposal.digest, leg: input.data.leg });
    if (existing) {
      this.checkJob(existing, context);
      if (existing.state === 'declined') return this.pending(existing);
      if (existing.state !== 'pending') return this.reconcile(principal, context, existing);
      return context.binding.mode === 'per_order' ? this.pending(existing) : this.dispatch(principal, context, existing);
    }
    const job = await this.jobs.getOrCreate({ owner: context.owner, bindingHash: context.bindingHash, purpose: 'cancel', proposal, leg: input.data.leg,
      authorization: principal.authorization ?? null,
      expiresAt: Date.now() + this.config.approvalTtlSeconds * 1000 });
    return context.binding.mode === 'per_order' && job.state === 'pending' ? this.pending(job) : this.dispatch(principal, context, job);
  }

  async reviewJob(principal: Principal, id: string): Promise<Job> {
    const context = await this.context(principal, READ_SCOPE); const job = await this.jobs.get(id);
    if (!job || job.owner !== context.owner) throw new HostedError(404, 'order_not_found', 'This order request is unavailable.');
    this.checkJob(job, context);
    if (job.authorization && (!principal.authorization || JSON.stringify(job.authorization) !== JSON.stringify(principal.authorization))) throw new HostedError(403, 'review_connection_required', 'Sign in for the original agent connection to review this order.');
    await this.runtime?.assertJobActive(job);
    return job;
  }

  async confirm(principal: Principal, id: string): Promise<HostedMutation> {
    const context = await this.context(principal, TRADE_SCOPE); const job = await this.reviewJob(principal, id);
    if (context.binding.mode !== 'per_order') throw new HostedError(409, 'confirmation_not_required', 'This connection uses an explicitly configured autonomous policy.');
    return this.dispatch(principal, context, job);
  }

  async decline(principal: Principal, id: string): Promise<Job> {
    const context = await this.context(principal, TRADE_SCOPE); const job = await this.reviewJob(principal, id);
    if (context.binding.mode !== 'per_order') throw new HostedError(409, 'confirmation_not_required', 'This connection uses an explicitly configured autonomous policy.');
    return this.jobs.decline({ id: job.id, owner: context.owner, bindingHash: context.bindingHash, now: Date.now() });
  }
}
