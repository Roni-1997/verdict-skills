#!/usr/bin/env node
// Record production responses of the Verdict API (https://hyperverdict.xyz/api/v1) for the hosted-mode tests:
// one body per route on testnet (venue at) and mainnet (every deployer), plus the error bodies the kit maps.
// The data is public market data; nothing is redacted. README.json is the index the tests iterate, with
// recorded_at, the request behind every file and the HTTP status. Re-run to refresh; commit the result.
// Sequential with a pause between requests, well inside the API's 60 (20 for opportunities) per minute per IP.
//
//   node tests/fixtures/record_api_v1.mjs [--base https://hyperverdict.xyz/api/v1]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'api-v1');
const baseArg = process.argv.indexOf('--base');
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : 'https://hyperverdict.xyz/api/v1';
const PAUSE_MS = 700;

const files = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(name, route, query) {
  const url = new URL(`${BASE}/${route}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  const body = JSON.parse(text);
  writeFileSync(resolve(DIR, `${name}.json`), `${JSON.stringify(body, null, 1)}\n`);
  files.push({ file: `${name}.json`, route: `/${route}`, query, status: res.status });
  process.stdout.write(`${name}  HTTP ${res.status}  ${text.length} bytes\n`);
  await sleep(PAUSE_MS);
  return body;
}

/** A live BTC price binary (binaryPrice, binaryPrice4, ...) of a named deployer, else the first market with a venue, else the first market. */
function pick(list) {
  const now = Date.now();
  const live = list.markets.filter((m) => m.expiresAt === null || Date.parse(m.expiresAt) > now);
  return live.find((m) => m.venue && m.templateId?.startsWith('binaryPrice') && m.underlying === 'BTC') ?? live.find((m) => m.venue) ?? live[0] ?? list.markets[0];
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Testnet, Verdict's own deployer.
  const tMarkets = await record('testnet_markets_at', 'markets', { net: 'testnet', venue: 'at' });
  const t = pick(tMarkets);
  if (!t) throw new Error('testnet venue at lists no markets');
  await record(`testnet_market_${t.outcome}`, 'market', { net: 'testnet', outcome: String(t.outcome) });
  await record(`testnet_compare_${t.outcome}`, 'compare', { net: 'testnet', outcome: String(t.outcome) });
  await record(`testnet_fair_value_${t.outcome}`, 'fair-value', { net: 'testnet', outcome: String(t.outcome) });
  await record(`testnet_hedges_${t.outcome}`, 'hedges', { net: 'testnet', outcome: String(t.outcome) });
  // A market that is not a price binary, for the not-available fair value.
  const other = tMarkets.markets.find((m) => !m.templateId?.startsWith('binaryPrice') && m.outcome !== t.outcome);
  if (other) await record(`testnet_fair_value_${other.outcome}`, 'fair-value', { net: 'testnet', outcome: String(other.outcome) });
  await record('testnet_opportunities_at', 'opportunities', { net: 'testnet', venue: 'at', limit: '8' });

  // Error bodies the kit maps back to its own errors.
  await record('error_not_found_market', 'market', { net: 'testnet', outcome: '999999' });
  await record('error_bad_input_limit', 'opportunities', { net: 'testnet', venue: 'at', limit: '9' });
  await record('error_bad_input_outcome_missing', 'market', { net: 'testnet' });

  // Mainnet, every deployer.
  const mMarkets = await record('mainnet_markets_all', 'markets', { net: 'mainnet', venue: 'all' });
  const m = pick(mMarkets);
  if (!m) throw new Error('mainnet lists no markets');
  await record(`mainnet_market_${m.outcome}`, 'market', { net: 'mainnet', outcome: String(m.outcome) });
  await record(`mainnet_compare_${m.outcome}`, 'compare', { net: 'mainnet', outcome: String(m.outcome) });
  await record(`mainnet_fair_value_${m.outcome}`, 'fair-value', { net: 'mainnet', outcome: String(m.outcome) });
  await record(`mainnet_hedges_${m.outcome}`, 'hedges', { net: 'mainnet', outcome: String(m.outcome) });
  await record('mainnet_opportunities_all', 'opportunities', { net: 'mainnet', venue: 'all', limit: '8' });

  const readme = {
    recorded_at: recordedAt,
    base: BASE,
    source: 'Production responses of the Verdict API, recorded with tests/fixtures/record_api_v1.mjs. Public market data, nothing redacted. Do not edit by hand.',
    contract: 'packages/core/api-contract/UPSTREAM.json pins the OpenAPI document these bodies are checked against; engine.commit in each body is the app commit that served it.',
    app_fixtures: 'The Verdict app repository keeps its own copies of this kit\'s tests/fixtures/engine inputs under tests/fixtures/api-v1 (hl_*, polymarket_*, kalshi_*, deribit_*, testnet_*); it records no response bodies, so there was nothing to copy back. tests/remote.test.ts runs the kit\'s embedded tools on those same inputs and validates the results against the pinned OpenAPI schemas instead.',
    files,
  };
  writeFileSync(resolve(DIR, 'README.json'), `${JSON.stringify(readme, null, 1)}\n`);
  process.stdout.write(`${files.length} file(s) recorded at ${recordedAt} from ${BASE}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
