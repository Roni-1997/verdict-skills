import type { PoolClient } from 'pg';
import type { ConnectorAuth } from './hosted-auth.js';
import type { Binding, Job, Principal } from './hosted-model.js';

export type SharedPublicTransaction = { kind: 'postgres'; client: PoolClient; deploymentId: string; databaseId: string } | { kind: 'local' };
export type Awaitable<T> = T | Promise<T>;
/** Authentication may read durable shared state on every request. */
export type ConnectorSecurity = Pick<ConnectorAuth, 'metadata' | 'challenge'> & {
  [K in 'authenticate' | 'login' | 'callback' | 'readSession']:
    (...args: Parameters<ConnectorAuth[K]>) => Awaitable<Awaited<ReturnType<ConnectorAuth[K]>>>;
};
export interface HostedRuntime {
  readonly auth: ConnectorSecurity;
  binding(subject: string): Awaitable<Binding | null>;
  ensureBinding?(principal: Principal): Promise<void>;
  assertActive(principal: Principal): Awaitable<void>;
  assertJobActive(job: Job): Awaitable<void>;
  withJobAuthorization?<T>(job: Job, callback: (tx: SharedPublicTransaction) => Promise<T>): Promise<T>;
  status(principal: Principal): Promise<unknown>;
}
export type ReviewJobIdentity = Pick<Job, 'owner' | 'authorization'>;
