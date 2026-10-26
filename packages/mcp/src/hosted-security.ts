import type { ConnectorAuth } from './hosted-auth.js';
import type { Binding, Job, Principal } from './hosted-model.js';

/** Resource and independent browser authentication share one narrow composition contract. */
export type ConnectorSecurity = Pick<ConnectorAuth, 'metadata' | 'challenge' | 'authenticate' | 'login' | 'callback' | 'readSession'>;
export interface HostedRuntime {
  readonly auth: ConnectorSecurity;
  binding(subject: string): Binding | null;
  ensureBinding?(principal: Principal): Promise<void>;
  assertActive(principal: Principal): void;
  assertJobActive(job: Job): void;
  status(principal: Principal): Promise<unknown>;
}
export type ReviewJobIdentity = Pick<Job, 'owner' | 'authorization'>;
