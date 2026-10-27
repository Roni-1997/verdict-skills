import { createHash } from 'node:crypto';
import { LighterBuyIntent, LighterClient, prepareLighterBuyIntent, type LighterIntentPlan } from '@verdict/core';
import type { HostedExecution } from './hosted-execution.js';
import type { HostedJobStore } from './hosted-job-store.js';
import { HostedError, type Principal } from './hosted-model.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Context = Awaited<ReturnType<HostedExecution['intentContext']>>;
type Dependencies = { context: (principal: Principal) => Promise<Context>;
  prepare?: typeof prepareLighterBuyIntent; client?: (context: Context) => LighterClient; now?: () => number };

/** Persist before returning. An expired or attempted proposal is never silently re-quoted under the same intent. */
export class HostedLighterIntents {
  private readonly now: () => number;
  constructor(private readonly jobs: HostedJobStore, private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now; }

  async prepare(principal: Principal, value: unknown): Promise<LighterIntentPlan> {
    return this.load(principal, value, false);
  }

  async prepareReview(principal: Principal, value: unknown): Promise<LighterIntentPlan> {
    return this.load(principal, value, true);
  }

  private async load(principal: Principal, value: unknown, retainExpired: boolean): Promise<LighterIntentPlan> {
    const parsed = LighterBuyIntent.safeParse(value);
    if (!parsed.success) throw new HostedError(400, 'invalid_intent', 'Use a stable intent UUID, market, YES/NO side and plain-decimal USDC spend cap.');
    if (!principal.authorization) throw new HostedError(403, 'consumer_connection_required', 'Connect a reviewed hosted Lighter account before preparing an intent.');
    const intent = parsed.data;
    const context = await this.dependencies.context(principal);
    const identity = { owner: hash(`${principal.issuer}\0${principal.subject}`), bindingHash: context.bindingHash,
      authorization: principal.authorization, intentId: intent.intentId, inputHash: hash(JSON.stringify(intent)) };
    const claim = await this.jobs.claimIntent({ ...identity, now: this.now() });
    const assertCurrent = async () => {
      const actual = await this.dependencies.context(principal);
      if (actual.bindingHash !== context.bindingHash) throw new HostedError(409, 'binding_changed', 'The trading connection changed during intent preparation.');
    };
    if (claim.kind === 'prepared') {
      await assertCurrent();
      if (!retainExpired && claim.plan.proposal.payload.expiresAt <= this.now()) throw new HostedError(410, 'intent_expired', 'The original proposal for this intent expired. It cannot be refreshed or retried. Use status for any original submission.');
      return claim.plan;
    }
    try {
      if (context.authorityRisk !== 'active' || !context.accountReady || context.authorityExpiresAt <= this.now()) {
        throw new HostedError(409, 'account_not_ready', 'Resolve the original account authority or venue registration before preparing a new trade. Saved proposals remain available for status.');
      }
      const client = this.dependencies.client?.(context) ?? new LighterClient({ network: context.account.network, creators: context.scope.creators });
      const plan = await (this.dependencies.prepare ?? prepareLighterBuyIntent)({ client, intent, target: context.account,
        limits: { creators: context.scope.creators, maxOrderDebitUSDC: context.scope.maxOrderDebitUSDC }, authorityExpiresAt: context.authorityExpiresAt });
      await assertCurrent();
      if (plan.proposal.payload.expiresAt <= this.now()) throw new HostedError(410, 'intent_expired', 'The prepared proposal expired before it could be returned.');
      return await this.jobs.saveIntent({ ...identity, claimId: claim.claimId, plan });
    } catch (error) {
      // Only public reads and preparation happened; no proposal was returned or mutation dispatched.
      await this.jobs.abandonIntent({ ...identity, claimId: claim.claimId });
      throw error;
    }
  }
}
