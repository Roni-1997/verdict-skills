#!/usr/bin/env node
// Verify that the engine copies in packages/engine/src are byte for byte the files recorded in
// packages/engine/UPSTREAM.json. Three legs, and every one must pass:
//   1. the sha256 (and git blob sha1) of each local copy against the recorded hashes;
//   2. packages/engine/src/upstream.ts carries the same pin and hashes;
//   3. each local copy against the file GitHub serves at the pinned commit (`gh api`).
// The check fails closed: when the GitHub leg cannot run, that is a failure, unless CHECK_ENGINE_OFFLINE=1
// is set, in which case only the "gh not installed, not authenticated or offline" class is skipped, and the
// skip is printed. A 404 (wrong commit or path, or a repository this gh account cannot see) and a hash
// mismatch fail whatever the flag says. Every file is checked; nothing stops at the first problem.
//
//   node scripts/check-engine-drift.mjs [--root <dir>]
//   CHECK_ENGINE_OFFLINE=1 node scripts/check-engine-drift.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GithubFetchError, fetchGithubFile, gitBlobSha1, sha256 } from './sync-engine.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const OFFLINE_FLAG = 'CHECK_ENGINE_OFFLINE';
const root = resolve(argValue('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const offlineAllowed = process.env[OFFLINE_FLAG] === '1';
const upstream = JSON.parse(readFileSync(resolve(root, 'packages/engine/UPSTREAM.json'), 'utf8'));

let failures = 0;
let networkChecked = 0;
/** Set once gh proved unavailable (not installed, not authenticated, offline); the cause is environmental, so the remaining files are not retried. */
let unavailable = null;

function fail(msg) {
  failures += 1;
  process.stdout.write(`FAIL  ${msg}\n`);
}

for (const f of upstream.files) {
  const bytes = readFileSync(resolve(root, f.local));
  const localSha = sha256(bytes);
  if (localSha !== f.sha256) fail(`${f.local}: local sha256 ${localSha} != recorded ${f.sha256}`);
  else process.stdout.write(`ok    ${f.local}  sha256 ${localSha}\n`);
  if (f.gitBlobSha1 && gitBlobSha1(bytes) !== f.gitBlobSha1) fail(`${f.local}: git blob sha1 does not match the recorded blob`);
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

// A generated constants module mirrors UPSTREAM.json for runtime provenance; it must agree.
try {
  const gen = readFileSync(resolve(root, 'packages/engine/src/upstream.ts'), 'utf8');
  if (!gen.includes(JSON.stringify(upstream.commit))) fail('packages/engine/src/upstream.ts does not carry the pinned commit; re-run scripts/sync-engine.mjs');
  for (const f of upstream.files) if (!gen.includes(f.sha256)) fail(`packages/engine/src/upstream.ts is missing the sha256 of ${f.local}`);
} catch (e) {
  fail(`packages/engine/src/upstream.ts unreadable: ${e instanceof Error ? e.message : String(e)}`);
}

if (unavailable) {
  if (offlineAllowed) process.stdout.write(`skip  GitHub comparison skipped (${OFFLINE_FLAG}=1): ${unavailable}\n`);
  else fail(`GitHub comparison could not run: ${unavailable}. Install and authenticate gh for ${upstream.repo}, or set ${OFFLINE_FLAG}=1 to skip this leg knowingly (a 404 or a hash mismatch is never skipped).`);
}
if (networkChecked) process.stdout.write(`note  ${networkChecked} file(s) compared against GitHub at ${upstream.repo}@${upstream.commit}\n`);

if (failures) {
  process.stdout.write(`engine drift: ${failures} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('engine drift: none\n');
