// Read-only Hyperliquid info client. No signing lives here, on purpose (GOAL.md hard rules).
import type { z } from 'zod';
import { networkConfig, type Network, type NetworkConfig } from '../network.js';
import { L2Book, MaxBuilderFee, OutcomeMeta, OutcomeTemplates, SpotClearinghouseState } from './schemas.js';

export interface InfoClientOptions {
  readonly network?: Network;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'schema' | 'network',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class InfoClient {
  readonly config: NetworkConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: InfoClientOptions = {}) {
    this.config = networkConfig(opts.network ?? 'testnet');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async post<S extends z.ZodTypeAny>(body: Record<string, unknown>, schema: S): Promise<z.output<S>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.infoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new UpstreamError(`info request failed: ${String(e)}`, 'network', e);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new UpstreamError(`info ${String(body.type)} returned HTTP ${res.status}`, 'http', res.status);
    const json: unknown = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new UpstreamError(`info ${String(body.type)} response did not match the expected shape`, 'schema', parsed.error.issues);
    }
    return parsed.data as z.output<S>;
  }

  outcomeMeta() {
    return this.post({ type: 'outcomeMeta' }, OutcomeMeta);
  }

  outcomeTemplates() {
    return this.post({ type: 'outcomeTemplates' }, OutcomeTemplates);
  }

  l2Book(coin: string) {
    return this.post({ type: 'l2Book', coin }, L2Book);
  }

  maxBuilderFee(user: string, builder: string) {
    return this.post({ type: 'maxBuilderFee', user, builder }, MaxBuilderFee);
  }

  spotClearinghouseState(user: string) {
    return this.post({ type: 'spotClearinghouseState', user }, SpotClearinghouseState);
  }
}
