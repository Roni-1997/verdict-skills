// Read-only Hyperliquid info client. No signing lives here, on purpose (GOAL.md hard rules).
import type { z } from 'zod';
import { networkConfig, type Network, type NetworkConfig } from '../network.js';
import { AllMids, L2Book, MaxBuilderFee, OutcomeMeta, OutcomeTemplates, SpotClearinghouseState, SpotMetaAndAssetCtxs } from './schemas.js';

export interface InfoClientOptions {
  readonly network?: Network;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Backoff before the single retry of a request Hyperliquid rate-limited (HTTP 429) when the response carries no
   * Retry-After header. Default 1,000 ms. Hyperliquid allows 1,200 request weight per minute per IP.
   */
  readonly retryAfterMs?: number;
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

/** Longest backoff the client accepts from a Retry-After header; anything larger is capped so a scan never stalls for minutes. */
const MAX_RETRY_AFTER_MS = 10_000;

/** Milliseconds to wait before the one retry of a rate-limited request: the Retry-After header (seconds or HTTP date) when present and sane, else the configured default. */
export function retryDelayMs(retryAfter: string | null, fallbackMs: number, now = Date.now()): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, seconds * 1000));
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, at - now));
  }
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, fallbackMs));
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export class InfoClient {
  readonly config: NetworkConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryAfterMs: number;

  constructor(opts: InfoClientOptions = {}) {
    this.config = networkConfig(opts.network ?? 'testnet');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retryAfterMs = opts.retryAfterMs ?? 1_000;
  }

  private async send(type: unknown, payload: string): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.config.infoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: ctl.signal,
      });
    } catch (e) {
      throw new UpstreamError(`info ${String(type)} request failed: ${String(e)}`, 'network', e);
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<S extends z.ZodTypeAny>(body: Record<string, unknown>, schema: S): Promise<z.output<S>> {
    const payload = JSON.stringify(body);
    let res = await this.send(body.type, payload);
    if (res.status === 429) {
      // Hyperliquid's limit is 1,200 request weight per minute per IP (an l2Book weighs 2, so an 80-book scan sits
      // well inside it), but a shared IP can still be throttled. One retry after a backoff; a second 429 is the
      // caller's error to handle.
      await sleep(retryDelayMs(res.headers.get('retry-after'), this.retryAfterMs));
      res = await this.send(body.type, payload);
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

  /** Spot metadata plus per-coin contexts (mark, mid, 24h volume) for every spot and outcome coin. */
  spotMetaAndAssetCtxs() {
    return this.post({ type: 'spotMetaAndAssetCtxs' }, SpotMetaAndAssetCtxs);
  }

  /** Mid price of every coin, used for the underlying reference mids (BTC, ETH, SOL, HYPE) of hedges. */
  allMids() {
    return this.post({ type: 'allMids' }, AllMids);
  }
}
