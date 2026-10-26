import type { HostedJobs } from './hosted-jobs.js';
import type { SharedPublicTransaction } from './hosted-security.js';

type AwaitableMethod<F> = F extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
type Operations = Pick<HostedJobs, 'getOrCreate' | 'get' | 'find' | 'claim' | 'observe' | 'decline'
  | 'claimIntent' | 'saveIntent' | 'abandonIntent' | 'close'>;

/** Both local synchronous state and shared transactional state retain the same lifecycle. */
export type HostedJobStore = { [K in Exclude<keyof Operations, 'claim'>]: AwaitableMethod<Operations[K]> } & {
  claim: (value: Parameters<HostedJobs['claim']>[0], transaction?: SharedPublicTransaction) => ReturnType<HostedJobs['claim']> | Promise<ReturnType<HostedJobs['claim']>>;
};
