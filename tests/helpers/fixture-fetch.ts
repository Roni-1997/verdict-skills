// One fetch for both halves of an engine test: Hyperliquid info POSTs (served to the injected
// InfoClient) and the GETs the engine makes to Polymarket, Kalshi and Deribit (served to the
// global fetch the engine uses). Every request is answered from tests/fixtures/engine or with
// an explicit empty result; anything else is a 404, so a test can never reach the network.
import { readFileSync } from 'node:fs';

const DIR = new URL('../fixtures/engine/', import.meta.url);

export function engineFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8')) as T;
}

interface OutcomeMetaLike {
  outcomes: { outcome: number }[];
  questions: { namedOutcomes: number[]; fallbackOutcome?: number | null }[];
}

export interface FixtureFetchOptions {
  /** Restrict outcomeMeta to these outcomes (and the questions that contain them). */
  readonly outcomes?: readonly number[];
  /** Every request is appended here as `METHOD url`. */
  readonly log?: string[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function fixtureFetch(opts: FixtureFetchOptions = {}): typeof fetch {
  const meta = engineFixture<OutcomeMetaLike>('hl_outcomeMeta');
  const filteredMeta: OutcomeMetaLike = opts.outcomes
    ? {
        ...meta,
        outcomes: meta.outcomes.filter((o) => opts.outcomes?.includes(o.outcome)),
        questions: meta.questions.filter((q) => q.namedOutcomes.some((id) => opts.outcomes?.includes(id)) || (q.fallbackOutcome != null && opts.outcomes?.includes(q.fallbackOutcome))),
      }
    : meta;
  const books = engineFixture<Record<string, unknown>>('hl_l2Books');

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    opts.log?.push(`${method} ${url}`);
    const u = new URL(url);

    if (u.hostname.endsWith('hyperliquid.xyz') || u.hostname.endsWith('hyperliquid-testnet.xyz')) {
      if (u.pathname !== '/info' || method !== 'POST') return json({ error: 'not a fixture' }, 404);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | undefined>;
      switch (body.type) {
        case 'outcomeMeta':
          return json(filteredMeta);
        case 'outcomeTemplates':
          return json(engineFixture('hl_outcomeTemplates'));
        case 'l2Book': {
          const book = books[body.coin ?? ''];
          return book ? json(book) : json(null, 404);
        }
        case 'spotMetaAndAssetCtxs':
          return json(engineFixture('hl_spotMetaAndAssetCtxs'));
        case 'allMids':
          return json(engineFixture('hl_allMids'));
        case 'maxBuilderFee':
          return json(0);
        default:
          return json({ error: 'not a fixture' }, 404);
      }
    }
    if (method !== 'GET') return json({ error: 'not a fixture' }, 404);
    if (u.hostname === 'gamma-api.polymarket.com') {
      if (u.pathname === '/events' && u.searchParams.get('tag_id') === '21') return json(engineFixture('polymarket_events_crypto'));
      return json([]);
    }
    if (u.hostname === 'external-api.kalshi.com') {
      if (u.pathname.endsWith('/events')) {
        const series = u.searchParams.get('series_ticker');
        if (series === 'KXBTCD') return json(engineFixture('kalshi_events_KXBTCD'));
        if (series === 'KXBTC') return json(engineFixture('kalshi_events_KXBTC'));
        return json({ events: [] });
      }
      return json({ markets: [] });
    }
    if (u.hostname === 'www.deribit.com') {
      if (u.searchParams.get('currency') === 'BTC') return json(engineFixture('deribit_btc_options'));
      return json({ jsonrpc: '2.0', result: [] });
    }
    return json({ error: 'not a fixture' }, 404);
  }) as typeof fetch;
}

export function recordedAt(): Date {
  return new Date(engineFixture<{ recorded_at: string }>('README').recorded_at);
}
