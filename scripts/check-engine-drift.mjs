#!/usr/bin/env node
// Verify that the engine copies in packages/engine/src are byte for byte the files recorded
// in packages/engine/UPSTREAM.json: sha256 of each local copy against the recorded hash, and,
// when the network and gh are available, against the file fetched from GitHub at the pinned
// commit. Exits non-zero on any difference. `--offline` skips the network comparison.
//
//   node scripts/check-engine-drift.mjs [--offline] [--root <dir>]
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGithubFile, gitBlobSha1, sha256 } from './sync-engine.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = resolve(argValue('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const offline = process.argv.includes('--offline') || process.env.ENGINE_DRIFT_OFFLINE === '1';
const upstream = JSON.parse(readFileSync(resolve(root, 'packages/engine/UPSTREAM.json'), 'utf8'));

let failures = 0;
let networkChecked = 0;
let networkSkipped = null;

function fail(msg) {
  failures += 1;
  process.stdout.write(`FAIL  ${msg}\n`);
}

for (const f of upstream.files) {
  const bytes = readFileSync(resolve(root, f.local));
  const localSha = sha256(bytes);
  if (localSha !== f.sha256) {
    fail(`${f.local}: local sha256 ${localSha} != recorded ${f.sha256}`);
  } else {
    process.stdout.write(`ok    ${f.local}  sha256 ${localSha}\n`);
  }
  if (f.gitBlobSha1 && gitBlobSha1(bytes) !== f.gitBlobSha1) fail(`${f.local}: git blob sha1 does not match the recorded blob`);
  if (offline || networkSkipped) continue;
  try {
    const remote = fetchGithubFile(upstream.repo, f.upstream, upstream.commit);
    const remoteSha = sha256(remote.bytes);
    networkChecked += 1;
    if (remoteSha !== f.sha256) fail(`${f.upstream}@${upstream.commit}: GitHub sha256 ${remoteSha} != recorded ${f.sha256}`);
    else if (remoteSha !== localSha) fail(`${f.local}: differs from GitHub copy at the pinned commit`);
    else process.stdout.write(`ok    ${f.upstream}@${upstream.commit.slice(0, 12)} matches GitHub\n`);
  } catch (e) {
    networkSkipped = e instanceof Error ? e.message : String(e);
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

if (offline) process.stdout.write('note  network comparison skipped (--offline)\n');
else if (networkSkipped) process.stdout.write(`note  network comparison skipped: ${networkSkipped}\n`);
else process.stdout.write(`note  ${networkChecked} file(s) compared against GitHub at ${upstream.repo}@${upstream.commit}\n`);

if (failures) {
  process.stdout.write(`engine drift: ${failures} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('engine drift: none\n');
