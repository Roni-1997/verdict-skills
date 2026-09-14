#!/usr/bin/env node
// Verify that the API contract copy in packages/core/api-contract is byte for byte the document recorded
// in packages/core/api-contract/UPSTREAM.json, the way check-engine-drift.mjs verifies the engine. Legs:
//   0. UPSTREAM.json records exactly the files sync-api-contract.mjs syncs (the record cannot be shrunk);
//   1. the sha256 (and git blob sha1) of each local copy against the recorded hashes, and the copy parses
//      as JSON and documents the routes the hosted tools call;
//   2. packages/core/src/api-contract.ts carries the same pin and hashes;
//   3. each local copy against the file GitHub serves at the pinned commit (`gh api`).
// Fails closed: when the GitHub leg cannot run, that is a failure, unless CHECK_ENGINE_OFFLINE=1 is set, in
// which case only the "gh not installed, not authenticated or offline" class is skipped, and the skip is
// printed. A 404 (wrong commit or path) and a hash mismatch fail whatever the flag says.
//
//   node scripts/check-api-contract.mjs [--root <dir>]
//   CHECK_ENGINE_OFFLINE=1 node scripts/check-api-contract.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, GENERATED_PATH, UPSTREAM_PATH } from './sync-api-contract.mjs';
import { GithubFetchError, fetchGithubFile, gitBlobSha1, sha256 } from './sync-engine.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const OFFLINE_FLAG = 'CHECK_ENGINE_OFFLINE';
/** The routes remote.ts calls; the pinned document must describe each with a GET and a 200 JSON body. */
const REQUIRED_ROUTES = ['/markets', '/market', '/compare', '/fair-value', '/hedges', '/opportunities'];

const root = resolve(argValue('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const offlineAllowed = process.env[OFFLINE_FLAG] === '1';

let failures = 0;
let networkChecked = 0;
let unavailable = null;

function fail(msg) {
  failures += 1;
  process.stdout.write(`FAIL  ${msg}\n`);
}

let upstream;
try {
  upstream = JSON.parse(readFileSync(resolve(root, UPSTREAM_PATH), 'utf8'));
} catch (e) {
  fail(`${UPSTREAM_PATH} unreadable: ${e instanceof Error ? e.message : String(e)}`);
  process.stdout.write(`api contract: ${failures} problem(s)\n`);
  process.exit(1);
}

// Leg 0: the record lists exactly the synced files.
const recorded = new Set((upstream.files ?? []).map((f) => f.local));
if (recorded.size === 0) fail(`${UPSTREAM_PATH} records no files; nothing would be verified`);
const expected = new Set(DEFAULTS.files.map((f) => f.local));
for (const p of expected) if (!recorded.has(p)) fail(`${p}: synced by scripts/sync-api-contract.mjs but not recorded in ${UPSTREAM_PATH}; the pin record was shrunk`);
for (const p of recorded) if (!expected.has(p)) fail(`${p}: recorded in ${UPSTREAM_PATH} but not in scripts/sync-api-contract.mjs DEFAULTS; add it there so a pin move syncs it`);
if (typeof upstream.commit !== 'string' || !/^[0-9a-f]{40}$/.test(upstream.commit)) fail(`${UPSTREAM_PATH}: commit is not a 40-hex sha`);

for (const f of upstream.files ?? []) {
  let bytes;
  try {
    bytes = readFileSync(resolve(root, f.local));
  } catch {
    fail(`${f.local}: recorded in ${UPSTREAM_PATH} but missing`);
    continue;
  }
  const localSha = sha256(bytes);
  if (localSha !== f.sha256) fail(`${f.local}: local sha256 ${localSha} != recorded ${f.sha256}`);
  else process.stdout.write(`ok    ${f.local}  sha256 ${localSha}\n`);
  if (f.gitBlobSha1 && gitBlobSha1(bytes) !== f.gitBlobSha1) fail(`${f.local}: git blob sha1 does not match the recorded blob`);
  if (typeof f.bytes === 'number' && f.bytes !== bytes.length) fail(`${f.local}: ${bytes.length} bytes, recorded ${f.bytes}`);

  // Leg 1b: the document is JSON and describes the routes the hosted tools call.
  let doc = null;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    fail(`${f.local}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc) {
    if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) fail(`${f.local}: not an OpenAPI 3 document (openapi=${JSON.stringify(doc.openapi)})`);
    for (const route of REQUIRED_ROUTES) {
      const op = doc.paths?.[route]?.get;
      const schema = op?.responses?.['200']?.content?.['application/json']?.schema;
      if (!op) fail(`${f.local}: no GET ${route}; remote.ts calls it`);
      else if (!schema) fail(`${f.local}: GET ${route} documents no 200 application/json body`);
      else process.stdout.write(`ok    GET ${route} documented with a 200 JSON body\n`);
    }
  }

  if (unavailable) continue;
  try {
    const remote = fetchGithubFile(upstream.repo, f.upstream, upstream.commit);
    networkChecked += 1;
    const remoteSha = sha256(remote.bytes);
    if (remoteSha !== f.sha256) fail(`${f.upstream}@${upstream.commit}: GitHub sha256 ${remoteSha} != recorded ${f.sha256} (hash mismatch; never skipped)`);
    else if (remoteSha !== localSha) fail(`${f.local}: differs from the GitHub copy at the pinned commit (hash mismatch; never skipped)`);
    else process.stdout.write(`ok    ${f.upstream}@${upstream.commit.slice(0, 12)} matches GitHub\n`);
  } catch (e) {
    const kind = e instanceof GithubFetchError ? e.kind : 'error';
    const message = e instanceof Error ? e.message : String(e);
    if (kind === 'unavailable') unavailable = message;
    else if (kind === 'not_found') fail(`${f.upstream}@${upstream.commit}: not found on GitHub (HTTP 404): the pinned commit or path does not exist in ${upstream.repo}, or this gh account cannot see the repository. Not skippable. ${message}`);
    else fail(`${f.upstream}@${upstream.commit}: GitHub comparison failed: ${message}`);
  }
}

// Leg 2: the generated provenance constant agrees with the record.
try {
  const gen = readFileSync(resolve(root, GENERATED_PATH), 'utf8');
  if (!gen.includes(JSON.stringify(upstream.commit))) fail(`${GENERATED_PATH} does not carry the pinned commit; re-run scripts/sync-api-contract.mjs`);
  for (const f of upstream.files ?? []) if (!gen.includes(f.sha256)) fail(`${GENERATED_PATH} is missing the sha256 of ${f.local}`);
} catch (e) {
  fail(`${GENERATED_PATH} unreadable: ${e instanceof Error ? e.message : String(e)}`);
}

if (unavailable) {
  if (offlineAllowed) process.stdout.write(`skip  GitHub comparison skipped (${OFFLINE_FLAG}=1): ${unavailable}\n`);
  else fail(`GitHub comparison could not run: ${unavailable}. Install and authenticate gh for ${upstream.repo}, or set ${OFFLINE_FLAG}=1 to skip this leg knowingly (a 404 or a hash mismatch is never skipped).`);
}
if (networkChecked) process.stdout.write(`note  ${networkChecked} file(s) compared against GitHub at ${upstream.repo}@${upstream.commit}\n`);

if (failures) {
  process.stdout.write(`api contract: ${failures} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('api contract: no drift\n');
