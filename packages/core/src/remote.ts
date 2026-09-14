// Hosted mode. The Verdict API (GET https://hyperverdict.xyz/api/v1, contract pinned under packages/core/api-contract)
// serves six of the twelve tools with bodies that match this kit's results field for field; createRemoteTools answers
// list_markets, get_market, compare_market, fair_value, find_hedges and opportunities from it and validates every body
// with the same Zod result schemas the embedded tools return through. So a hosted MCP server needs neither the engine's
// venue fetches nor Hyperliquid's catalogue for those, and the API's error slugs come back as the kit's own errors:
// bad_input and not_found as ToolError, 429, 5xx and a network or timeout failure as UpstreamError.
// The other six tools (orderbook, quote, positions, builder_status, approve_builder_fee_payload, build_order) keep
// running locally through createTools, unchanged: books and balances are read from Hyperliquid directly and payloads
// are built in process. Every request here is an anonymous GET to the configured base URL and nowhere else: a redirect
// is refused rather than followed (it could leave the https host parseApiUrl accepted), a body larger than
// REMOTE_MAX_BODY_BYTES is refused (unread when the server declares its length, otherwise the read stops at the
// limit), and the API holds no keys and this module sends none. A body that passes its schema is also checked against
// the request it answers: a /markets or /opportunities body must name the network and venue that were sent, and a body
// addressed by outcome must be about that outcome, so a host that does not honour `net` (a proxy that drops the query
// string, a copy of the app with other defaults) cannot hand a testnet caller mainnet data as if it were the kit's own.
import { z } from 'zod';
import type { KitConfig } from './config.js';
import { CompareMarketResult, type EngineOptions, FairValueResult, FindHedgesResult, OpportunitiesResult } from './crossvenue.js';
import { type InfoClient, UpstreamError } from './hl/client.js';
import { ListMarketsResult, MarketSchema } from './markets.js';
import { ToolError, type ToolOptions, type Tools, checkLimit, checkOutcome, checkVenue, createTools } from './tools.js';

/** The tools the API serves; every other tool runs locally in hosted mode too. */
export const REMOTE_TOOLS = ['list_markets', 'get_market', 'compare_market', 'fair_value', 'find_hedges', 'opportunities'] as const satisfies readonly (keyof Tools)[];
export type RemoteToolName = (typeof REMOTE_TOOLS)[number];
export const LOCAL_TOOLS = ['orderbook', 'quote', 'positions', 'builder_status', 'approve_builder_fee_payload', 'build_order'] as const satisfies readonly (keyof Tools)[];

/** Route under the API base per remote tool. */
export const REMOTE_ROUTES: Record<RemoteToolName, string> = {
  list_markets: 'markets',
  get_market: 'market',
  compare_market: 'compare',
  fair_value: 'fair-value',
  find_hedges: 'hedges',
  opportunities: 'opportunities',
};

/** Default budget per request. The API's own deadline is 25 s for /opportunities and 12 s elsewhere. */
export const REMOTE_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Largest body accepted from the API: the biggest documented answer (/markets for every mainnet deployer) is a few
 * hundred kB. A declared Content-Length above it is refused before the body is read; a body without one (chunked or
 * compressed answers) is read through a counter that stops at the limit, so no more than the limit plus one chunk is
 * ever held.
 */
export const REMOTE_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface RemoteToolsOptions {
  /** API base URL without a trailing slash, e.g. https://hyperverdict.xyz/api/v1 (KitConfig.apiUrl). */
  readonly apiUrl: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Hyperliquid client for the tools that stay local; defaults to one for the configured network. */
  readonly client?: InfoClient;
}

/** The API's error body: `{ error: slug }` plus a message on 400 and 404 and a kind on 502. */
const ApiErrorBody = z.object({ error: z.string(), message: z.string().optional(), kind: z.string().optional() }).passthrough();

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Read the body as text, stopping once more than `limit` bytes have arrived; the stream is cancelled and the caller gets the byte count so far. */
async function readBounded(res: Response, limit: number): Promise<{ text: string } | { tooLarge: number }> {
  if (res.body === null) return { text: await res.text() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: total };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

/** The fields a body may carry that must agree with the request it answers. Read after schema validation, so they are typed by the schema when present. */
interface Addressed {
  readonly network?: unknown;
  readonly venue?: unknown;
  readonly outcome?: unknown;
  readonly market?: { readonly outcome?: unknown };
}

export function createRemoteTools(config: KitConfig, opts: RemoteToolsOptions): Tools {
  const base = opts.apiUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REMOTE_DEFAULT_TIMEOUT_MS;
  const local = createTools(config, opts.client);

  /**
   * One GET. `net` goes on every request and `venue` on the two routes whose contract takes it (/markets and
   * /opportunities; the routes addressed by outcome declare no venue parameter and the kit sends none): the production
   * host defaults to mainnet and to every deployer, so the kit's own network and venue are always spelled out ('all' is
   * the API's word for every deployer). Redirects are not followed: the kit talks to the configured host only. A body
   * that passes the schema must then be about what was asked: the network on every body that names one, the venue
   * that was sent (null for 'all') on every body that names one, and the outcome that was sent on every body about a
   * market; a body about something else is an UpstreamError schema, never returned as the kit's own result.
   */
  async function get<S extends z.ZodTypeAny>(route: string, params: Readonly<Record<string, string | undefined>>, schema: S): Promise<z.output<S>> {
    const url = new URL(`${base}/${route}`);
    url.searchParams.set('net', config.network);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let status: number;
    let retryAfter: string | null;
    let text: string;
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: ctl.signal });
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      if ((status >= 300 && status < 400) || res.type === 'opaqueredirect') {
        const location = res.headers.get('location');
        let target = location === null ? 'an undisclosed location' : location;
        try {
          if (location !== null) target = new URL(location, url).host;
        } catch {
          // Not a URL: reported as written.
        }
        throw new UpstreamError(`api ${route} answered with a redirect${status ? ` (HTTP ${status})` : ''} to ${target}; the kit follows none. Set the API base URL to the final address`, 'http', { status, location });
      }
      const length = Number(res.headers.get('content-length'));
      if (Number.isFinite(length) && length > REMOTE_MAX_BODY_BYTES) throw new UpstreamError(`api ${route} answered with a ${length}-byte body, above the ${REMOTE_MAX_BODY_BYTES}-byte limit; not read`, 'schema', { status, length });
      const read = await readBounded(res, REMOTE_MAX_BODY_BYTES);
      if ('tooLarge' in read) throw new UpstreamError(`api ${route} answered with a body above the ${REMOTE_MAX_BODY_BYTES}-byte limit (${read.tooLarge} bytes read before the kit stopped); not read further`, 'schema', { status, length: read.tooLarge });
      text = read.text;
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      if (ctl.signal.aborted) throw new UpstreamError(`api ${route} timed out after ${timeoutMs} ms`, 'network', e);
      throw new UpstreamError(`api ${route} request failed: ${describe(e)}`, 'network', e);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      if (status === 200) throw new UpstreamError(`api ${route} returned HTTP 200 with a body that is not JSON`, 'schema');
      body = undefined;
    }
    if (status === 200) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new UpstreamError(`api ${route} response did not match the expected shape`, 'schema', parsed.error.issues);
      const data = parsed.data as Addressed;
      const mismatch = (what: string, expected: unknown, got: unknown): never => {
        throw new UpstreamError(`api ${route} answered about ${what} ${JSON.stringify(got)}, not the ${what} ${JSON.stringify(expected)} the kit asked for; the host at ${JSON.stringify(base)} did not honour the request. Check the API base URL`, 'schema', { what, expected, got });
      };
      if ('network' in data && data.network !== config.network) mismatch('network', config.network, data.network);
      if (params.venue !== undefined && 'venue' in data) {
        const expected = params.venue === 'all' ? null : params.venue;
        if (data.venue !== expected) mismatch('venue', expected, data.venue);
      }
      if (params.outcome !== undefined) {
        const got = 'outcome' in data ? data.outcome : data.market?.outcome;
        if (got !== Number(params.outcome)) mismatch('outcome', Number(params.outcome), got);
      }
      return parsed.data as z.output<S>;
    }
    const err = ApiErrorBody.safeParse(body);
    const slug = err.success ? err.data.error : null;
    const message = err.success && err.data.message ? err.data.message : null;
    // The kit's own error classes, only when the API says so; a 400 or 404 without the slug (a proxy page, a wrong base
    // URL) is an upstream failure, not a claim about the input or the market.
    if (status === 400 && slug === 'bad_input') throw new ToolError(message ?? `api ${route} rejected the request`, 'bad_input');
    if (status === 404 && slug === 'not_found') throw new ToolError(message ?? `api ${route}: not found on ${config.network}`, 'not_found');
    const labelled = slug === null ? '' : ` (${slug}${err.success && err.data.kind ? `: ${err.data.kind}` : ''})`;
    if (status === 429) throw new UpstreamError(`api ${route} rate limited (HTTP 429)${retryAfter ? `; retry after ${retryAfter} s` : ''}`, 'http', { status, retryAfter });
    if (status === 404) throw new UpstreamError(`api ${route} returned HTTP 404 without the API's not_found body; check the API base URL ${JSON.stringify(base)}`, 'http', { status, body });
    throw new UpstreamError(`api ${route} returned HTTP ${status}${labelled}`, 'http', { status, body });
  }

  return {
    ...local,

    async list_markets(input) {
      const venue = checkVenue(input.venue ?? config.venue) ?? 'all';
      return get(REMOTE_ROUTES.list_markets, { venue, includeExpired: input.includeExpired ? 'true' : undefined }, ListMarketsResult);
    },

    async get_market(input) {
      checkOutcome(input.outcome);
      return get(REMOTE_ROUTES.get_market, { outcome: String(input.outcome) }, MarketSchema);
    },

    async compare_market(input) {
      checkOutcome(input.outcome);
      return get(REMOTE_ROUTES.compare_market, { outcome: String(input.outcome) }, CompareMarketResult);
    },

    async fair_value(input) {
      checkOutcome(input.outcome);
      return get(REMOTE_ROUTES.fair_value, { outcome: String(input.outcome) }, FairValueResult);
    },

    async find_hedges(input) {
      checkOutcome(input.outcome);
      return get(REMOTE_ROUTES.find_hedges, { outcome: String(input.outcome) }, FindHedgesResult);
    },

    async opportunities(input) {
      const limit = checkLimit(input.limit);
      const venue = checkVenue(config.venue) ?? 'all';
      return get(REMOTE_ROUTES.opportunities, { venue, limit: String(limit) }, OpportunitiesResult);
    },
  };
}

export interface ToolsFromConfigOptions {
  /** Hyperliquid client for the local tools (every tool in embedded mode, the six local ones in hosted mode). */
  readonly client?: InfoClient;
  /** Embedded mode: the cross-venue engine's fetch budget and scan size. */
  readonly engine?: EngineOptions;
  /** Hosted mode: fetch and per-request budget for the API calls. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** 'hosted' when KitConfig.apiUrl is set (VERDICT_API_URL or --api), 'embedded' otherwise. */
export function toolsMode(config: KitConfig): 'embedded' | 'hosted' {
  return config.apiUrl === null ? 'embedded' : 'hosted';
}

/** The tool set a face runs: the embedded engine by default, the hosted API when the configuration names one. */
export function toolsFromConfig(config: KitConfig, opts: ToolsFromConfigOptions = {}): Tools {
  if (config.apiUrl === null) {
    const options: ToolOptions = opts.engine ? { engine: opts.engine } : {};
    return createTools(config, opts.client, options);
  }
  return createRemoteTools(config, {
    apiUrl: config.apiUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.client ? { client: opts.client } : {}),
  });
}
