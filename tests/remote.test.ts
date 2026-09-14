// Hosted mode: the six tools the Verdict API serves, driven with a stubbed fetch (no live network), the API contract
// pinned under packages/core/api-contract, the production bodies recorded in tests/fixtures/api-v1, and the CLI and
// MCP plumbing of VERDICT_API_URL and --api. Two contract directions: (a) the kit's result schemas accept the recorded
// production bodies, (b) the embedded tools' results on the engine fixtures validate against the pinned OpenAPI
// response schemas. Loopback HTTP servers on ephemeral ports stand in for the API where a whole face is exercised.
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  API_CONTRACT,
  CompareMarketResult,
  FairValueResult,
  FindHedgesResult,
  InfoClient,
  type KitConfig,
  LOCAL_TOOLS,
  ListMarketsResult,
  MAX_OUTCOME,
  MarketSchema,
  OpportunitiesResult,
  REMOTE_MAX_BODY_BYTES,
  REMOTE_ROUTES,
  REMOTE_TOOLS,
  ToolError,
  type Tools,
  UpstreamError,
  VENUE_MESSAGE,
  checkVenue,
  configFromEnv,
  createRemoteTools,
  createTools,
  normalizeVenue,
  parseApiUrl,
  toolsFromConfig,
  toolsMode,
} from '../packages/core/src/index.js';
import { runCli } from '../packages/cli/src/index.js';
import { createRequestHandler, healthBody, listenLine } from '../packages/mcp/src/http.js';
import { createServer, hostedInstructions } from '../packages/mcp/src/server.js';
import { formatIssues, responseSchema, validateSchema } from './_json-schema.js';
import { fixtureFetch, recordedAt } from './helpers/fixture-fetch.js';

const ROOT = new URL('../', import.meta.url);
const readJson = <T = unknown>(rel: string): T => JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8')) as T;

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}

// The pinned contract and the recorded production bodies.
const openapi = readJson<{ paths: Record<string, unknown>; components: { parameters: Record<string, unknown>; schemas: Record<string, unknown> } }>('packages/core/api-contract/openapi.json');
interface RecordedFile {
  readonly file: string;
  readonly route: string;
  readonly query: Record<string, string>;
  readonly status: number;
}
const recorded = readJson<{ recorded_at: string; base: string; files: RecordedFile[] }>('tests/fixtures/api-v1/README.json');
const recordedBody = (f: RecordedFile): unknown => readJson(`tests/fixtures/api-v1/${f.file}`);
const okFiles = (route: string) => recorded.files.filter((f) => f.route === route && f.status === 200);

/** The kit result schema per API route. */
const KIT_SCHEMA = {
  '/markets': ListMarketsResult,
  '/market': MarketSchema,
  '/compare': CompareMarketResult,
  '/fair-value': FairValueResult,
  '/hedges': FindHedgesResult,
  '/opportunities': OpportunitiesResult,
} as const;

const API = 'https://api.example.test/api/v1';
const testnetAt: KitConfig = { network: 'testnet', venue: 'at', builder: null, apiUrl: API };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Seen {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly redirect: RequestInit['redirect'];
}

/** A fetch that answers from `handler` and records every request. */
function apiFetch(handler: (url: URL) => Response | Promise<Response>, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), redirect: init?.redirect });
    return handler(url);
  }) as typeof fetch;
}

/** Serves the recorded mainnet bodies: /markets filtered to the venue asked for (`all` is every deployer, as on the API). */
function mainnetApi(url: URL): Response {
  const route = url.pathname.replace(/^\/api\/v1/, '');
  const venue = url.searchParams.get('venue') ?? 'all';
  if (route === '/markets') {
    const all = recordedBody(must(okFiles('/markets').find((f) => f.query.net === 'mainnet' && f.query.venue === 'all'), 'mainnet markets')) as { markets: { venue: string }[] };
    if (venue === 'all') return json(all);
    const markets = all.markets.filter((m) => m.venue === venue);
    return json({ network: 'mainnet', venue, count: markets.length, markets });
  }
  if (route === '/opportunities') return json(recordedBody(must(okFiles('/opportunities').find((f) => f.query.net === 'mainnet'), 'mainnet opportunities')));
  return recordedApi(url);
}

/** Serves the recorded testnet bodies by route and outcome, the recorded error bodies otherwise. */
function recordedApi(url: URL): Response {
  const route = url.pathname.replace(/^\/api\/v1/, '');
  const outcome = url.searchParams.get('outcome');
  const byOutcome = (files: RecordedFile[]) => files.find((f) => f.query.outcome === outcome && f.query.net === 'testnet');
  const notFound = json({ error: 'not_found', message: `no outcome market with index ${outcome} on testnet` }, 404);
  switch (route) {
    case '/markets':
      return json(recordedBody(must(okFiles('/markets').find((f) => f.query.net === 'testnet'), 'testnet markets')));
    case '/opportunities':
      return json(recordedBody(must(okFiles('/opportunities').find((f) => f.query.net === 'testnet'), 'testnet opportunities')));
    case '/market':
    case '/compare':
    case '/fair-value':
    case '/hedges': {
      const f = byOutcome(okFiles(route));
      return f ? json(recordedBody(f)) : notFound;
    }
    default:
      return new Response('<html>not here</html>', { status: 404, headers: { 'content-type': 'text/html' } });
  }
}

function hosted(seen: Seen[] = [], handler: (url: URL) => Response | Promise<Response> = recordedApi, config: KitConfig = testnetAt, timeoutMs?: number): Tools {
  return createRemoteTools(config, { apiUrl: API, fetch: apiFetch(handler, seen), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

const btc = must(okFiles('/compare').find((f) => f.query.net === 'testnet'), 'a recorded testnet compare');
const BTC_OUTCOME = Number(btc.query.outcome);

describe('hosted tools: every request is an anonymous GET carrying net and venue, and every body is validated', () => {
  it('list_markets calls /markets with net and venue from the configuration and returns the typed list', async () => {
    const seen: Seen[] = [];
    const tools = hosted(seen);
    const r = await tools.list_markets({});
    expect(r.network).toBe('testnet');
    expect(r.venue).toBe('at');
    expect(r.count).toBe(r.markets.length);
    expect(r.markets.length).toBeGreaterThan(0);
    const req = must(seen[0], 'request');
    expect(req.method).toBe('GET');
    expect(req.url.origin + req.url.pathname).toBe(`${API}/markets`);
    expect(req.url.searchParams.get('net')).toBe('testnet');
    expect(req.url.searchParams.get('venue')).toBe('at');
    expect(req.url.searchParams.has('includeExpired')).toBe(false);
    expect(req.headers.get('accept')).toBe('application/json');
    expect(req.headers.get('authorization')).toBeNull();
  });
  it('an explicit venue and includeExpired travel as parameters; a null venue is spelled "all"', async () => {
    const seen: Seen[] = [];
    await hosted(seen).list_markets({ venue: 'other', includeExpired: true });
    expect(must(seen[0], 'request').url.searchParams.get('venue')).toBe('other');
    expect(must(seen[0], 'request').url.searchParams.get('includeExpired')).toBe('true');
    const seenAll: Seen[] = [];
    await hosted(seenAll, recordedApi, { ...testnetAt, venue: null }).list_markets({});
    expect(must(seenAll[0], 'request').url.searchParams.get('venue')).toBe('all');
    const seenMainnet: Seen[] = [];
    await hosted(seenMainnet, recordedApi, { ...testnetAt, network: 'mainnet', venue: null }).opportunities({ limit: 3 });
    const url = must(seenMainnet[0], 'request').url;
    expect(url.searchParams.get('net')).toBe('mainnet');
    expect(url.searchParams.get('venue')).toBe('all');
    expect(url.searchParams.get('limit')).toBe('3');
  });
  it('get_market, compare_market, fair_value and find_hedges address the market by outcome and still carry net and venue', async () => {
    const seen: Seen[] = [];
    const tools = hosted(seen);
    const m = await tools.get_market({ outcome: BTC_OUTCOME });
    expect(m.outcome).toBe(BTC_OUTCOME);
    expect(m.sides).toHaveLength(2);
    expect(m.sides[0].tokenName).toMatch(/^\+\d+$/);
    expect(m.settlementRule).toBeTruthy();
    const c = await tools.compare_market({ outcome: BTC_OUTCOME });
    expect(CompareMarketResult.safeParse(c).success).toBe(true);
    expect(c.market.outcome).toBe(BTC_OUTCOME);
    const fv = await tools.fair_value({ outcome: BTC_OUTCOME });
    expect(FairValueResult.safeParse(fv).success).toBe(true);
    const h = await tools.find_hedges({ outcome: BTC_OUTCOME });
    expect(FindHedgesResult.safeParse(h).success).toBe(true);
    expect(h.market.outcome).toBe(BTC_OUTCOME);
    expect(seen.map((s) => s.url.pathname)).toEqual(['/api/v1/market', '/api/v1/compare', '/api/v1/fair-value', '/api/v1/hedges']);
    for (const s of seen) {
      expect(s.method).toBe('GET');
      expect(s.url.searchParams.get('outcome')).toBe(String(BTC_OUTCOME));
      expect(s.url.searchParams.get('net')).toBe('testnet');
      expect(s.url.searchParams.get('venue')).toBe('at');
    }
  });
  it('opportunities sends the limit, defaulting to the engine maximum, and returns the typed scan', async () => {
    const seen: Seen[] = [];
    const tools = hosted(seen);
    const r = await tools.opportunities({});
    expect(OpportunitiesResult.safeParse(r).success).toBe(true);
    expect(r.engineMax).toBe(8);
    expect(must(seen[0], 'request').url.searchParams.get('limit')).toBe('8');
    await tools.opportunities({ limit: 2 });
    expect(must(seen[1], 'request').url.searchParams.get('limit')).toBe('2');
  });
  it('the six remote tools never touch Hyperliquid; the remote and local tool name lists partition the Tools interface', async () => {
    const seen: Seen[] = [];
    const tools = hosted(seen);
    await tools.list_markets({});
    await tools.get_market({ outcome: BTC_OUTCOME });
    await tools.compare_market({ outcome: BTC_OUTCOME });
    await tools.fair_value({ outcome: BTC_OUTCOME });
    await tools.find_hedges({ outcome: BTC_OUTCOME });
    await tools.opportunities({ limit: 1 });
    expect(seen).toHaveLength(6);
    for (const s of seen) expect(s.url.host).toBe('api.example.test');
    expect([...REMOTE_TOOLS, ...LOCAL_TOOLS].sort()).toEqual(Object.keys(tools).sort());
    expect(Object.values(REMOTE_ROUTES).map((r) => `/${r}`).sort()).toEqual(Object.keys(KIT_SCHEMA).sort());
  });
  it('the request carries redirect: manual, and a 3xx is an UpstreamError http naming the target host, never followed', async () => {
    const seen: Seen[] = [];
    const redirecting = hosted(seen, () => new Response(null, { status: 302, headers: { location: 'http://evil.example/api/v1/markets' } }));
    const e = await redirecting.list_markets({}).catch((x: unknown) => x);
    expect(must(seen[0], 'request').redirect).toBe('manual');
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('http');
    expect((e as UpstreamError).message).toBe('api markets answered with a redirect (HTTP 302) to evil.example; the kit follows none. Set the API base URL to the final address');
    expect((e as UpstreamError).detail).toEqual({ status: 302, location: 'http://evil.example/api/v1/markets' });
    expect(seen).toHaveLength(1);
    const silent = await hosted([], () => new Response(null, { status: 301 })).get_market({ outcome: 1 }).catch((x: unknown) => x);
    expect((silent as UpstreamError).message).toContain('to an undisclosed location');
  });
  it('a body the API declares larger than the limit is refused unread, as a schema failure', async () => {
    const e = await hosted([], () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(REMOTE_MAX_BODY_BYTES + 1) } }))
      .list_markets({})
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('schema');
    expect((e as UpstreamError).message).toContain(`above the ${REMOTE_MAX_BODY_BYTES}-byte limit; not read`);
  });
});

describe('venue: one meaning in both modes', () => {
  const mainnetOut: KitConfig = { network: 'mainnet', venue: 'out', builder: null, apiUrl: API };
  const hl = () => new InfoClient({ network: 'mainnet', fetch: fixtureFetch() });
  const embedded = (config: KitConfig = mainnetOut) => createTools({ ...config, apiUrl: null }, hl());
  const hostedOn = (seen: Seen[], config: KitConfig = mainnetOut) => createRemoteTools(config, { apiUrl: API, fetch: apiFetch(mainnetApi, seen) });
  const venuesOf = (r: { markets: { venue: string | null }[] }) => new Set(r.markets.map((m) => m.venue));

  it('normalizeVenue and checkVenue: unset, blank and all (any case) are every deployer; a name is trimmed; a name outside the API rule is bad_input with the API words', () => {
    for (const v of [undefined, null, '', '   ', 'all', 'ALL', ' All ']) {
      expect(normalizeVenue(v), String(v)).toBeNull();
      expect(checkVenue(v), String(v)).toBeNull();
    }
    expect(normalizeVenue(' at ')).toBe('at');
    expect(checkVenue('out')).toBe('out');
    expect(checkVenue('a_b-C9')).toBe('a_b-C9');
    for (const bad of ['my.venue', 'bad venue', 'x'.repeat(33), 'all!']) {
      const e = (() => {
        try {
          checkVenue(bad);
        } catch (x) {
          return x;
        }
        return null;
      })();
      expect(e, bad).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('bad_input');
      expect((e as ToolError).message).toBe(VENUE_MESSAGE);
    }
  });
  it('list_markets: venue all, ALL and "" list every deployer with venue null in embedded and hosted mode alike; the wire carries venue=all', async () => {
    const onlyOut = await embedded().list_markets({ includeExpired: true });
    expect(onlyOut.venue).toBe('out');
    expect(venuesOf(onlyOut)).toEqual(new Set(['out']));
    for (const venue of ['all', 'ALL', '']) {
      const e = await embedded().list_markets({ venue, includeExpired: true });
      expect(e.venue, venue).toBeNull();
      expect(e.count).toBe(e.markets.length);
      expect(e.count).toBeGreaterThan(onlyOut.count);
      expect(venuesOf(e).size).toBeGreaterThan(1);
      const seen: Seen[] = [];
      const h = await hostedOn(seen).list_markets({ venue, includeExpired: true });
      expect(must(seen[0], 'request').url.searchParams.get('venue'), venue).toBe('all');
      expect(h.venue, venue).toBeNull();
      expect(h.count).toBe(h.markets.length);
      expect(venuesOf(h).size).toBeGreaterThan(1);
    }
    // The same through the configuration (VERDICT_VENUE=all) and with no venue at all.
    for (const configVenue of ['all', null]) {
      const e = await embedded({ ...mainnetOut, venue: configVenue }).list_markets({ includeExpired: true });
      expect(e.venue).toBeNull();
      expect(venuesOf(e).size).toBeGreaterThan(1);
      const seen: Seen[] = [];
      const h = await hostedOn(seen, { ...mainnetOut, venue: configVenue }).list_markets({});
      expect(must(seen[0], 'request').url.searchParams.get('venue')).toBe('all');
      expect(h.venue).toBeNull();
    }
    // An explicit venue still wins over the configuration in both modes.
    const seen: Seen[] = [];
    const h = await hostedOn(seen, { ...mainnetOut, venue: 'all' }).list_markets({ venue: 'skew' });
    expect(must(seen[0], 'request').url.searchParams.get('venue')).toBe('skew');
    expect(h.venue).toBe('skew');
    const e = await embedded({ ...mainnetOut, venue: null }).list_markets({ venue: 'skew', includeExpired: true });
    expect(e.venue).toBe('skew');
    expect(venuesOf(e)).toEqual(new Set(['skew']));
  });
  it('a venue name the API would refuse is refused before any request in both modes, with the same words', async () => {
    const seen: Seen[] = [];
    const hlLog: string[] = [];
    const local = createTools({ ...mainnetOut, apiUrl: null }, new InfoClient({ network: 'mainnet', fetch: fixtureFetch({ log: hlLog }) }));
    for (const bad of ['my.venue', 'bad venue']) {
      const h = await hostedOn(seen).list_markets({ venue: bad }).catch((x: unknown) => x);
      const l = await local.list_markets({ venue: bad }).catch((x: unknown) => x);
      expect((h as ToolError).code, bad).toBe('bad_input');
      expect((l as ToolError).code, bad).toBe('bad_input');
      expect((h as ToolError).message).toBe(VENUE_MESSAGE);
      expect((l as ToolError).message).toBe(VENUE_MESSAGE);
    }
    expect(seen).toHaveLength(0);
    expect(hlLog).toHaveLength(0);
  });
  it('opportunities: a configured venue of all scans every deployer in both modes', async () => {
    const seen: Seen[] = [];
    await hostedOn(seen, { ...mainnetOut, venue: 'ALL' }).opportunities({ limit: 2 });
    expect(must(seen[0], 'request').url.searchParams.get('venue')).toBe('all');
    const bad = await hostedOn([], { ...mainnetOut, venue: 'my.venue' }).opportunities({ limit: 2 }).catch((x: unknown) => x);
    expect((bad as ToolError).code).toBe('bad_input');
    // Embedded: the scan over every deployer sees more markets than the scan over one, and reports venue null.
    const hlLog: string[] = [];
    const all = createTools({ ...mainnetOut, venue: 'all', apiUrl: null }, new InfoClient({ network: 'mainnet', fetch: fixtureFetch({ log: hlLog }) }), { engine: { timeoutMs: 5_000, maxBooks: 0 } });
    const r = await all.opportunities({ limit: 1 });
    expect(r.venue).toBeNull();
    const out = await embedded().opportunities({ limit: 1 });
    expect(out.venue).toBe('out');
    expect(r.scanned).toBeGreaterThan(out.scanned);
  }, 60_000);
  it('configFromEnv reads VERDICT_VENUE the same way and refuses a malformed name as not configured', () => {
    expect(configFromEnv({ VERDICT_VENUE: 'all' }).venue).toBeNull();
    expect(configFromEnv({ VERDICT_VENUE: 'ALL' }).venue).toBeNull();
    expect(configFromEnv({ VERDICT_VENUE: '' }).venue).toBeNull();
    expect(configFromEnv({}).venue).toBeNull();
    expect(configFromEnv({ VERDICT_VENUE: ' at ' }).venue).toBe('at');
    expect(() => configFromEnv({ VERDICT_VENUE: 'bad venue' })).toThrow(/^VERDICT_VENUE venue must be 1 to 32 letters, digits, _ or -, got "bad venue"$/);
    expect(() => configFromEnv({ VERDICT_VENUE: 'x'.repeat(33) })).toThrow(/VERDICT_VENUE/);
  });
  it('CLI: --venue all and --venue "" list every deployer, a malformed --venue is exit 1, a malformed VERDICT_VENUE is exit 4', async () => {
    const tools = embedded();
    for (const venue of ['all', '']) {
      const r = await runCli(['markets', '--venue', venue, '--include-expired'], { ...mainnetOut, apiUrl: null }, tools);
      expect(r.exitCode, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { venue: string | null; count: number };
      expect(out.venue).toBeNull();
      expect(out.count).toBeGreaterThan(83);
    }
    const bad = await runCli(['markets', '--venue', 'my.venue'], { ...mainnetOut, apiUrl: null }, tools);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr)).toEqual({ error: 'bad_input', message: VENUE_MESSAGE });
    const saved = process.env.VERDICT_VENUE;
    process.env.VERDICT_VENUE = 'bad venue';
    try {
      const env = await runCli(['markets']);
      expect(env.exitCode).toBe(4);
      expect(JSON.parse(env.stderr)).toMatchObject({ error: 'not_configured' });
      expect((JSON.parse(env.stderr) as { message: string }).message).toContain('VERDICT_VENUE');
    } finally {
      if (saved === undefined) delete process.env.VERDICT_VENUE;
      else process.env.VERDICT_VENUE = saved;
    }
  });
});

describe('hosted tools: error mapping', () => {
  const only = (status: number, body: unknown, headers: Record<string, string> = {}) => hosted([], () => json(body, status, headers));
  it('400 bad_input is a ToolError bad_input carrying the API message', async () => {
    // A 400 the kit's own checks did not anticipate (the input passes checkVenue; the API still refuses it).
    const seen: Seen[] = [];
    const e = await hosted(seen, () => json({ error: 'bad_input', message: 'venue is not deployed on this network' }, 400)).list_markets({ venue: 'other' }).catch((x: unknown) => x);
    expect(seen).toHaveLength(1);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe('bad_input');
    expect((e as ToolError).message).toBe('venue is not deployed on this network');
  });
  it('404 not_found is a ToolError not_found with the same words the embedded tool uses', async () => {
    const e = await hosted().get_market({ outcome: 999999 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe('not_found');
    expect((e as ToolError).message).toBe('no outcome market with index 999999 on testnet');
    // The recorded production 404 body maps the same way.
    const rec = must(recorded.files.find((f) => f.status === 404), 'recorded 404');
    const e2 = await hosted([], () => json(recordedBody(rec), 404)).compare_market({ outcome: 999999 }).catch((x: unknown) => x);
    expect((e2 as ToolError).code).toBe('not_found');
  });
  it('a 404 without the API body (a wrong base URL, a proxy page) is an upstream failure naming the base URL, never a not_found', async () => {
    const e = await hosted([], () => new Response('<html>nope</html>', { status: 404 })).get_market({ outcome: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('http');
    expect((e as UpstreamError).message).toContain(API);
    const e2 = await hosted([], () => json({ error: 'bad_input', message: 'x' }, 404)).get_market({ outcome: 1 }).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(UpstreamError);
  });
  it('a 400 without the bad_input slug is upstream, not a claim about the input', async () => {
    const e = await only(400, 'Bad Request').list_markets({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('http');
  });
  it('429 rate_limited is an UpstreamError http that names the Retry-After', async () => {
    const e = await only(429, { error: 'rate_limited' }, { 'retry-after': '7' }).opportunities({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('http');
    expect((e as UpstreamError).message).toContain('HTTP 429');
    expect((e as UpstreamError).message).toContain('retry after 7 s');
    expect((e as UpstreamError).detail).toEqual({ status: 429, retryAfter: '7' });
  });
  it('502 upstream and other 5xx are UpstreamError http with the API slug and kind in the message', async () => {
    const e = await only(502, { error: 'upstream', kind: 'schema' }).compare_market({ outcome: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('http');
    expect((e as UpstreamError).message).toBe('api compare returned HTTP 502 (upstream: schema)');
    const e2 = await only(503, { error: 'not_configured', message: 'no' }).fair_value({ outcome: 1 }).catch((x: unknown) => x);
    expect((e2 as UpstreamError).kind).toBe('http');
    expect((e2 as UpstreamError).message).toContain('HTTP 503 (not_configured)');
    const e3 = await only(500, 'oops').find_hedges({ outcome: 1 }).catch((x: unknown) => x);
    expect((e3 as UpstreamError).message).toBe('api hedges returned HTTP 500');
    const e4 = await only(405, { error: 'method_not_allowed' }).list_markets({}).catch((x: unknown) => x);
    expect((e4 as UpstreamError).kind).toBe('http');
  });
  it('a 200 that is not JSON, or JSON that does not match the result schema, is an UpstreamError schema', async () => {
    const e = await hosted([], () => new Response('<html>', { status: 200 })).list_markets({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('schema');
    const e2 = await only(200, { network: 'testnet', venue: 'at', count: 'many', markets: [] }).list_markets({}).catch((x: unknown) => x);
    expect((e2 as UpstreamError).kind).toBe('schema');
    expect(Array.isArray((e2 as UpstreamError).detail)).toBe(true);
    // A comparator that breaks the kit's invariants (low confidence with a gap) is refused, not passed through.
    const compare = recordedBody(btc) as { comparators: Record<string, { confidence: string; gap: number | null } | null> };
    const broken = JSON.parse(JSON.stringify(compare)) as typeof compare;
    const venue = Object.keys(broken.comparators).find((k) => broken.comparators[k] !== null);
    if (venue) {
      const c = must(broken.comparators[venue], 'comparator');
      c.confidence = 'low';
      c.gap = 0.1;
      const e3 = await only(200, broken).compare_market({ outcome: BTC_OUTCOME }).catch((x: unknown) => x);
      expect((e3 as UpstreamError).kind).toBe('schema');
    }
  });
  it('a network failure is an UpstreamError network', async () => {
    const e = await hosted([], () => {
      throw new TypeError('fetch failed');
    })
      .list_markets({})
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('network');
    expect((e as UpstreamError).message).toContain('fetch failed');
  });
  it('the timeout aborts the request and reports it as network, naming the budget', async () => {
    const seen: Seen[] = [];
    const never = apiFetch(() => new Promise<Response>(() => {}), seen);
    const hanging = ((input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        void never(input, init);
      })) as typeof fetch;
    const tools = createRemoteTools(testnetAt, { apiUrl: API, fetch: hanging, timeoutMs: 20 });
    const e = await tools.opportunities({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).kind).toBe('network');
    expect((e as UpstreamError).message).toBe('api opportunities timed out after 20 ms');
  });
  it('bad input is refused before any request, with the words the embedded tools use', async () => {
    const seen: Seen[] = [];
    const tools = hosted(seen);
    const local = createTools({ ...testnetAt, apiUrl: null }, new InfoClient({ network: 'testnet', fetch: apiFetch(() => json(null, 404)) }));
    for (const [call, input] of [
      ['get_market', { outcome: -1 }],
      ['compare_market', { outcome: 1.5 }],
      ['fair_value', { outcome: Number.NaN }],
      ['find_hedges', { outcome: -3 }],
      // The API's nine-digit rule: a longer index can name no market and is bad input in both modes, not a not_found in one.
      ['get_market', { outcome: MAX_OUTCOME + 1 }],
      ['compare_market', { outcome: 1e21 }],
      ['find_hedges', { outcome: Number.MAX_SAFE_INTEGER }],
    ] as const) {
      const e = await (tools[call] as (i: { outcome: number }) => Promise<unknown>)(input).catch((x: unknown) => x);
      const l = await (local[call] as (i: { outcome: number }) => Promise<unknown>)(input).catch((x: unknown) => x);
      expect((e as ToolError).code, call).toBe('bad_input');
      expect((l as ToolError).code, call).toBe('bad_input');
      expect((e as ToolError).message, call).toBe((l as ToolError).message);
      expect((e as ToolError).message, call).toContain('at most 9 digits');
    }
    expect(MAX_OUTCOME).toBe(999_999_999);
    expect(await hosted(seen).get_market({ outcome: MAX_OUTCOME }).catch((x: unknown) => x)).toBeInstanceOf(ToolError);
    expect(seen).toHaveLength(1);
    seen.length = 0;
    for (const limit of [0, 9, 2.5]) {
      const e = await tools.opportunities({ limit }).catch((x: unknown) => x);
      const l = await local.opportunities({ limit }).catch((x: unknown) => x);
      expect((e as ToolError).code).toBe('bad_input');
      expect((e as ToolError).message).toBe((l as ToolError).message);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('hosted tools: the other six tools run locally, unchanged', () => {
  const fixture = (name: string): unknown => readJson(`tests/fixtures/${name}.json`);
  const APPROVED = '0x00000000000000000000000000000000000000a1';
  const routes: Record<string, unknown> = {
    outcomeMeta: fixture('mainnet_outcomeMeta'),
    outcomeTemplates: fixture('mainnet_outcomeTemplates'),
    'l2Book:#12100': fixture('mainnet_l2Book_12100'),
    'l2Book:#12101': fixture('mainnet_l2Book_12101'),
    spotClearinghouseState: fixture('testnet_spotClearinghouseState_subdeployer'),
    [`maxBuilderFee:${APPROVED}`]: 10,
  };
  const hlLog: string[] = [];
  const hlFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | undefined>;
    const type = body.type ?? '';
    const key = type === 'l2Book' ? `l2Book:${body.coin ?? ''}` : type === 'maxBuilderFee' ? `maxBuilderFee:${body.user ?? ''}` : type;
    hlLog.push(key);
    return key in routes ? json(routes[key]) : new Response('null', { status: 404 });
  }) as typeof fetch;
  const config: KitConfig = { network: 'mainnet', venue: 'out', builder: { address: '0x00000000000000000000000000000000000000b1', feeTenthsBp: 10 }, apiUrl: API };
  const client = new InfoClient({ network: 'mainnet', fetch: hlFetch });
  const apiSeen: Seen[] = [];
  const remote = createRemoteTools(config, { apiUrl: API, fetch: apiFetch(recordedApi, apiSeen), client });
  const embedded = createTools({ ...config, apiUrl: null }, client);

  it('orderbook, quote, positions, builder_status, approve_builder_fee_payload and build_order give the embedded results and make no API call', async () => {
    const same = async <K extends (typeof LOCAL_TOOLS)[number]>(name: K, input: Parameters<Tools[K]>[0]) => {
      const a = await (remote[name] as (i: unknown) => Promise<unknown>)(input);
      const b = await (embedded[name] as (i: unknown) => Promise<unknown>)(input);
      expect(a, name).toEqual(b);
      return a;
    };
    await same('orderbook', { outcome: 1210 });
    await same('quote', { outcome: 1210, side: 'yes', action: 'buy', size: 10 });
    await same('positions', { address: '0x2bd816e68b18d1dd6327266f273f0658f20467dc' });
    await same('builder_status', { address: APPROVED });
    const built = (await same('build_order', { outcome: 1210, side: 'yes', action: 'buy', price: '0.02', size: '3' })) as { action: { orders: { b: boolean }[]; builder: { b: string; f: number } } };
    expect(built.action.builder).toEqual({ b: '0x00000000000000000000000000000000000000b1', f: 10 });
    // The approval payload carries a fresh nonce, so compare everything but that.
    const a = await remote.approve_builder_fee_payload({});
    const b = await embedded.approve_builder_fee_payload({});
    expect({ ...a, action: { ...a.action, nonce: 0 } }).toEqual({ ...b, action: { ...b.action, nonce: 0 } });
    expect(apiSeen).toHaveLength(0);
    expect(hlLog).toContain('l2Book:#12100');
  });
  it('a builder code is still required for the payload tools in hosted mode', async () => {
    const noBuilder = createRemoteTools({ ...config, builder: null }, { apiUrl: API, fetch: apiFetch(recordedApi), client });
    const e = await noBuilder.build_order({ outcome: 1210, side: 'yes', action: 'buy', price: '0.02', size: '3' }).catch((x: unknown) => x);
    expect((e as ToolError).code).toBe('not_configured');
  });
});

describe('configuration: VERDICT_API_URL and --api', () => {
  it('unset or blank keeps the embedded engine', () => {
    expect(configFromEnv({ VERDICT_NETWORK: 'testnet' }).apiUrl).toBeNull();
    expect(configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_API_URL: '' }).apiUrl).toBeNull();
    expect(configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_API_URL: '   ' }).apiUrl).toBeNull();
    expect(toolsMode(configFromEnv({}))).toBe('embedded');
  });
  it('accepts https URLs and http on localhost only, as written', () => {
    expect(parseApiUrl('https://hyperverdict.xyz/api/v1')).toBe('https://hyperverdict.xyz/api/v1');
    expect(parseApiUrl('https://preview.example/api/v1')).toBe('https://preview.example/api/v1');
    expect(parseApiUrl('https://host')).toBe('https://host');
    expect(parseApiUrl('http://localhost:8787/api/v1')).toBe('http://localhost:8787/api/v1');
    expect(parseApiUrl('http://127.0.0.1:1/api/v1')).toBe('http://127.0.0.1:1/api/v1');
    expect(parseApiUrl('http://[::1]:8787')).toBe('http://[::1]:8787');
    const cfg = configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_API_URL: ' https://hyperverdict.xyz/api/v1 ' });
    expect(cfg.apiUrl).toBe('https://hyperverdict.xyz/api/v1');
    expect(toolsMode(cfg)).toBe('hosted');
  });
  it('rejects plain http off localhost, trailing slashes, queries, fragments, credentials, whitespace and non-URLs, naming the setting', () => {
    for (const bad of ['http://hyperverdict.xyz/api/v1', 'https://hyperverdict.xyz/api/v1/', 'https://hyperverdict.xyz/api/v1?net=testnet', 'https://hyperverdict.xyz/api/v1#x', 'https://user:pw@hyperverdict.xyz/api/v1', 'hyperverdict.xyz/api/v1', 'ftp://hyperverdict.xyz', 'https://hyper verdict.xyz', 'http://localhost.evil.example/api/v1']) {
      expect(() => parseApiUrl(bad), bad).toThrow(/VERDICT_API_URL must be an https:\/\/ URL/);
      expect(() => configFromEnv({ VERDICT_API_URL: bad }), bad).toThrow(/VERDICT_API_URL/);
    }
    expect(() => parseApiUrl('nope', '--api')).toThrow(/^--api must be/);
    expect(() => parseApiUrl('https://hyperverdict.xyz/api/v1/')).toThrow(/got "https:\/\/hyperverdict\.xyz\/api\/v1\/"/);
    // A URL that carries credentials is refused without echoing them.
    const withSecret = (() => {
      try {
        parseApiUrl('https://operator:s3cretvalue@hyperverdict.xyz/api/v1');
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return '';
    })();
    expect(withSecret).toContain('credentials in the URL');
    expect(withSecret).not.toContain('s3cretvalue');
    expect(withSecret).not.toContain('operator');
    expect(withSecret).toContain('got "https://hyperverdict.xyz/api/v1"');
    expect(() => parseApiUrl('https://x/')).toThrow(/trailing slash/);
    expect(() => parseApiUrl('https://x?y')).toThrow(/query string/);
  });
  it('never echoes a query string, a fragment or a non-URL that could carry a token, in the message that reaches logs', () => {
    const messageFor = (value: string, name?: string): string => {
      try {
        parseApiUrl(value, name);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return '';
    };
    const cases: [string, string, string][] = [
      ['https://hyperverdict.xyz/api/v1?apikey=SECRET123', 'query string', 'SECRET123'],
      ['https://hyperverdict.xyz/api/v1#token=SECRET456', 'fragment', 'SECRET456'],
      ['https://hyperverdict.xyz/api/v1/?key=SECRET789', 'query string', 'SECRET789'],
      ['http://hyperverdict.xyz/api/v1?key=SECRETabc', 'scheme not allowed', 'SECRETabc'],
      ['hyperverdict.xyz/api/v1?apikey=SECRETdef', 'not a URL', 'SECRETdef'],
      // Parses as a URL with the scheme "operator" and an opaque path holding the rest: only the scheme may be shown.
      ['operator:SECRETghi@hyperverdict.xyz/api/v1', 'scheme not allowed', 'SECRETghi'],
      ['ftp://operator:SECRETmno@hyperverdict.xyz/api/v1', 'scheme not allowed', 'SECRETmno'],
      ['hyperverdict.xyz/api/v1#SECRETjkl', 'not a URL', 'SECRETjkl'],
    ];
    for (const [value, why, secret] of cases) {
      const message = messageFor(value, '--api');
      expect(message, value).toContain(`--api must be an https:// URL`);
      expect(message, value).toContain(why);
      expect(message, value).not.toContain(secret);
      expect(message, value).not.toContain('apikey');
    }
    // What is shown once the value parses is scheme, host and path only; a plain typo without those characters is shown whole.
    expect(messageFor('https://hyperverdict.xyz/api/v1?apikey=SECRET123')).toContain('got "https://hyperverdict.xyz/api/v1"');
    expect(messageFor('hyperverdict.xyz/api/v1')).toContain('got "hyperverdict.xyz/api/v1"');
    expect(messageFor('hyperverdict.xyz/api/v1?apikey=SECRETdef')).toContain('got [not shown: not a URL, and it may carry a token]');
    expect(messageFor('operator:SECRETghi@hyperverdict.xyz/api/v1')).toContain('got [not shown: scheme operator, not http(s)]');
    // Through the faces: the CLI's stderr JSON and the configuration error carry the same redaction.
    return (async () => {
      const cli = await runCli(['markets', '--api', 'https://hyperverdict.xyz/api/v1?apikey=SECRET123'], { network: 'testnet', venue: 'at', builder: null, apiUrl: null });
      expect(cli.exitCode).toBe(1);
      expect(cli.stderr).not.toContain('SECRET123');
      expect(cli.stderr).toContain('query string');
      expect(() => configFromEnv({ VERDICT_API_URL: 'https://hyperverdict.xyz/api/v1#token=SECRET456' })).toThrow(/fragment/);
      expect(() => configFromEnv({ VERDICT_API_URL: 'https://hyperverdict.xyz/api/v1#token=SECRET456' })).not.toThrow(/SECRET456/);
    })();
  });
  it('toolsFromConfig picks the mode and forwards the injected fetch and client', async () => {
    const seen: Seen[] = [];
    const tools = toolsFromConfig(testnetAt, { fetch: apiFetch(recordedApi, seen) });
    await tools.list_markets({});
    expect(seen).toHaveLength(1);
    const embedded = toolsFromConfig({ ...testnetAt, apiUrl: null }, { fetch: apiFetch(recordedApi, seen), client: new InfoClient({ network: 'testnet', fetch: apiFetch(() => json({ error: 'boom' }, 500)) }) });
    const e = await embedded.list_markets({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect(seen).toHaveLength(1);
  });
});

describe('API contract (a): the kit result schemas accept the recorded production bodies, and the bodies match the pinned OpenAPI document', () => {
  it('the recording is dated, comes from production and was served by the pinned app commit', () => {
    expect(recorded.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(recorded.base).toBe('https://hyperverdict.xyz/api/v1');
    expect(recorded.files.length).toBeGreaterThanOrEqual(12);
    for (const route of Object.keys(KIT_SCHEMA)) expect(okFiles(route).length, route).toBeGreaterThan(0);
    for (const f of recorded.files.filter((x) => x.status === 200 && x.route !== '/markets' && x.route !== '/market')) {
      const body = recordedBody(f) as { engine: { repo: string; commit: string } };
      expect(body.engine.repo, f.file).toBe(API_CONTRACT.repo);
      expect(body.engine.commit, f.file).toBe(API_CONTRACT.commit);
    }
  });
  for (const f of recorded.files.filter((x) => x.status === 200)) {
    it(`${f.file}: ${f.route} on ${f.query.net}${f.query.venue ? ` venue ${f.query.venue}` : ''}${f.query.outcome ? ` outcome ${f.query.outcome}` : ''}`, () => {
      const body = recordedBody(f);
      const schema = KIT_SCHEMA[f.route as keyof typeof KIT_SCHEMA];
      const parsed = schema.safeParse(body);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 1)).toBe(true);
      expect(formatIssues(validateSchema(responseSchema(openapi, f.route), body, openapi))).toBe('');
      const reported = body as { network?: string; venue?: string | null; outcome?: number; market?: { outcome: number } };
      if (reported.network !== undefined) expect(reported.network).toBe(f.query.net);
      if (f.query.venue !== undefined && reported.venue !== undefined) expect(reported.venue).toBe(f.query.venue === 'all' ? null : f.query.venue);
      if (f.query.outcome !== undefined) expect(reported.outcome ?? reported.market?.outcome).toBe(Number(f.query.outcome));
    });
  }
  it('the recorded error bodies are the shapes remote.ts maps, and validate against the documented error schemas', () => {
    const notFound = recorded.files.filter((f) => f.status === 404);
    const badInput = recorded.files.filter((f) => f.status === 400);
    expect(notFound.length).toBeGreaterThan(0);
    expect(badInput.length).toBeGreaterThan(0);
    for (const f of notFound) {
      const body = recordedBody(f) as { error: string; message: string };
      expect(body.error).toBe('not_found');
      expect(formatIssues(validateSchema({ $ref: '#/components/schemas/ErrorNotFound' }, body, openapi))).toBe('');
    }
    for (const f of badInput) {
      const body = recordedBody(f) as { error: string; message: string };
      expect(body.error).toBe('bad_input');
      expect(body.message.length).toBeGreaterThan(0);
      expect(formatIssues(validateSchema({ $ref: '#/components/schemas/ErrorBadInput' }, body, openapi))).toBe('');
    }
  });
  it('the fair value fixtures cover both branches of the result', () => {
    const branches = new Set(okFiles('/fair-value').map((f) => (recordedBody(f) as { available: boolean }).available));
    expect(branches).toEqual(new Set([true, false]));
  });
  it('the routes and parameters remote.ts uses are the documented ones; the document serves production', () => {
    for (const route of Object.values(REMOTE_ROUTES)) expect(openapi.paths, route).toHaveProperty(`/${route}`);
    for (const p of ['net', 'venue', 'outcome', 'limit', 'includeExpired']) expect(openapi.components.parameters, p).toHaveProperty(p);
    const servers = (openapi as unknown as { servers: { url: string }[] }).servers;
    expect(servers.map((s) => s.url)).toContain('https://hyperverdict.xyz/api/v1');
    expect(openapi.components.parameters.net).toMatchObject({ schema: { enum: ['testnet', 'mainnet'] } });
    expect(openapi.components.parameters.limit).toMatchObject({ schema: { pattern: '^[1-8]$' } });
  });
});

describe('API contract (b): the embedded tools on the engine fixtures produce bodies the pinned OpenAPI schemas accept', () => {
  let savedOddpoolKey: string | undefined;
  beforeAll(() => {
    savedOddpoolKey = process.env.ODDPOOL_API_KEY;
    delete process.env.ODDPOOL_API_KEY;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(recordedAt());
  });
  afterAll(() => {
    vi.useRealTimers();
    if (savedOddpoolKey !== undefined) process.env.ODDPOOL_API_KEY = savedOddpoolKey;
  });
  const config: KitConfig = { network: 'mainnet', venue: 'out', builder: null, apiUrl: null };
  const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  const check = (route: string, body: unknown) => expect(formatIssues(validateSchema(responseSchema(openapi, route), roundTrip(body), openapi)), route).toBe('');

  it('list_markets and get_market', async () => {
    const tools = createTools(config, new InfoClient({ network: 'mainnet', fetch: fixtureFetch() }));
    check('/markets', await tools.list_markets({}));
    check('/markets', await tools.list_markets({ includeExpired: true, venue: 'skew' }));
    check('/market', await tools.get_market({ outcome: 1210 }));
    check('/market', await tools.get_market({ outcome: 2899 }));
  });
  it('compare_market, fair_value and find_hedges', async () => {
    const tools = createTools(config, new InfoClient({ network: 'mainnet', fetch: fixtureFetch() }));
    check('/compare', await tools.compare_market({ outcome: 1210 }));
    check('/fair-value', await tools.fair_value({ outcome: 1210 }));
    check('/fair-value', await tools.fair_value({ outcome: 1472 }));
    check('/hedges', await tools.find_hedges({ outcome: 1210 }));
  }, 60_000);
  it('opportunities', async () => {
    const tools = createTools(config, new InfoClient({ network: 'mainnet', fetch: fixtureFetch() }));
    check('/opportunities', await tools.opportunities({ limit: 8 }));
  }, 60_000);
});

describe('faces: --api and VERDICT_API_URL', () => {
  let server: Server;
  let base: string;
  const served: URL[] = [];
  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      served.push(url);
      const answer = recordedApi(new URL(url.pathname + url.search, 'http://127.0.0.1'));
      void answer.text().then((text) => {
        res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
        res.end(text);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
  const embeddedConfig: KitConfig = { network: 'testnet', venue: 'at', builder: null, apiUrl: null };

  it('CLI --api routes the six commands to the API with net and venue, overriding the environment', async () => {
    served.length = 0;
    const r = await runCli(['markets', '--api', base], embeddedConfig);
    expect(r.exitCode, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { network: string; venue: string; count: number };
    expect(out.network).toBe('testnet');
    expect(out.venue).toBe('at');
    expect(out.count).toBeGreaterThan(0);
    expect(served.map((u) => u.pathname)).toEqual(['/api/v1/markets']);
    expect(must(served[0], 'request').searchParams.get('net')).toBe('testnet');
    expect(must(served[0], 'request').searchParams.get('venue')).toBe('at');
    const c = await runCli(['compare', String(BTC_OUTCOME), '--api', base], embeddedConfig);
    expect(c.exitCode, c.stderr).toBe(0);
    expect((JSON.parse(c.stdout) as { market: { outcome: number } }).market.outcome).toBe(BTC_OUTCOME);
    const missing = await runCli(['market', '999999', '--api', base], embeddedConfig);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stderr)).toEqual({ error: 'not_found', message: 'no outcome market with index 999999 on testnet' });
  });
  it('CLI --api with a malformed URL is bad_input with exit 1; the flag wins over VERDICT_API_URL', async () => {
    const bad = await runCli(['markets', '--api', 'nope'], embeddedConfig);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: 'bad_input' });
    expect((JSON.parse(bad.stderr) as { message: string }).message).toMatch(/^--api must be an https:\/\/ URL/);
    const plain = await runCli(['markets', '--api', 'http://hyperverdict.xyz/api/v1'], embeddedConfig);
    expect(plain.exitCode).toBe(1);
    served.length = 0;
    const r = await runCli(['markets', '--api', base], { ...embeddedConfig, apiUrl: 'https://unreachable.example/api/v1' });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(served).toHaveLength(1);
  });
  it('the CLI honours VERDICT_API_URL from the environment and reports a malformed value as not_configured with exit 4', async () => {
    served.length = 0;
    const r = await runCli(['market', String(BTC_OUTCOME)], configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_VENUE: 'at', VERDICT_API_URL: base }));
    expect(r.exitCode, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { outcome: number }).outcome).toBe(BTC_OUTCOME);
    expect(served.map((u) => u.pathname)).toEqual(['/api/v1/market']);
    const envBad = await (async () => {
      const saved = process.env.VERDICT_API_URL;
      process.env.VERDICT_API_URL = 'https://x/';
      try {
        return await runCli(['markets']);
      } finally {
        if (saved === undefined) delete process.env.VERDICT_API_URL;
        else process.env.VERDICT_API_URL = saved;
      }
    })();
    expect(envBad.exitCode).toBe(4);
    expect(JSON.parse(envBad.stderr)).toMatchObject({ error: 'not_configured' });
    expect((JSON.parse(envBad.stderr) as { message: string }).message).toContain('VERDICT_API_URL');
  });
  it('USAGE documents --api and VERDICT_API_URL without adding a command', async () => {
    const help = await runCli(['--help']);
    expect(help.stdout).toContain('--api <url>');
    expect(help.stdout).toContain('VERDICT_API_URL');
    expect(help.stdout).not.toMatch(/^ {2}verdict --api/m);
  });
  it('MCP: createServer over a configuration with apiUrl serves the six tools from the API and says so in its instructions', async () => {
    served.length = 0;
    const server = createServer(configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_VENUE: 'at', VERDICT_API_URL: base }));
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getInstructions()).toContain(hostedInstructions(base));
    expect(client.getInstructions()).toContain('holds no keys');
    const listed = await client.callTool({ name: 'list_markets', arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect((listed.structuredContent as { venue: string }).venue).toBe('at');
    const opp = await client.callTool({ name: 'opportunities', arguments: { limit: 2 } });
    expect(opp.isError).toBeFalsy();
    expect(served.map((u) => u.pathname)).toEqual(['/api/v1/markets', '/api/v1/opportunities']);
    expect(must(served[1], 'request').searchParams.get('limit')).toBe('2');
    const missing = await client.callTool({ name: 'get_market', arguments: { outcome: 999999 } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse((missing.content as { text: string }[])[0]?.text ?? '')).toMatchObject({ error: 'not_found' });
    const { tools: names } = await client.listTools();
    expect(names).toHaveLength(12);
  });
  it('MCP --http: /healthz reports the mode and the API base URL, and the listen line names them', async () => {
    const hostedCfg = configFromEnv({ VERDICT_NETWORK: 'testnet', VERDICT_VENUE: 'at', VERDICT_API_URL: base });
    expect(healthBody(hostedCfg)).toEqual({ ok: true, network: 'testnet', venue: 'at', mode: 'hosted', api: base });
    expect(healthBody(embeddedConfig)).toEqual({ ok: true, network: 'testnet', venue: 'at', mode: 'embedded', api: null });
    expect(healthBody({ ...embeddedConfig, venue: null }).venue).toBeNull();
    expect(listenLine(hostedCfg, '127.0.0.1', 8787)).toBe(`verdict-mcp listening on http://127.0.0.1:8787/mcp (testnet, venue at, hosted via ${base})`);
    expect(listenLine({ ...embeddedConfig, venue: null }, '0.0.0.0', 1)).toBe('verdict-mcp listening on http://0.0.0.0:1/mcp (testnet, embedded)');
    // Served by the request handler exactly as bin.ts wires it.
    const http = createHttpServer(createRequestHandler({ health: () => healthBody(hostedCfg), open: () => Promise.reject(new Error('not used')), log: () => {} }));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, network: 'testnet', venue: 'at', mode: 'hosted', api: base });
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
  it('MCP: without apiUrl the instructions carry no hosted line', async () => {
    const server = createServer(embeddedConfig, createTools(embeddedConfig, new InfoClient({ network: 'testnet', fetch: apiFetch(() => json(null, 404)) })));
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getInstructions()).not.toContain('Hosted mode');
  });
});
