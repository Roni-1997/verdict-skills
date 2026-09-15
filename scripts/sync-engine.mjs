#!/usr/bin/env node
// Copy the cross-venue engine from the Verdict app repository at a pinned commit into
// packages/engine/src, byte for byte, and record the pin in packages/engine/UPSTREAM.json.
// Nothing is copied by hand: every file comes from the GitHub contents API at the pinned
// commit. Re-run with --commit <sha> to move the pin; then run check-engine-drift.mjs.
//
//   node scripts/sync-engine.mjs [--commit <sha>]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPath = resolve(root, 'packages/engine/UPSTREAM.json');
const generatedPath = resolve(root, 'packages/engine/src/upstream.ts');

/** The files the engine consists of, by kit path and upstream path. check-engine-drift.mjs requires UPSTREAM.json to list exactly these. */
export const DEFAULTS = {
  repo: 'Roni-1997/verdict',
  commit: '79f3ed255dbd9a628b01d9a38eb149f2116cbffb',
  files: [
    { local: 'packages/engine/src/research-core.ts', upstream: 'src/research/research-core.ts' },
    { local: 'packages/engine/src/playbooks.ts', upstream: 'src/research/playbooks.ts' },
    { local: 'packages/engine/src/hl-shape.ts', upstream: 'src/live/hl-shape.ts' },
  ],
};

function readExisting() {
  try {
    return JSON.parse(readFileSync(upstreamPath, 'utf8'));
  } catch {
    return null;
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Why a GitHub read failed. 'unavailable': gh is not installed, not authenticated, or the network is down; an
 * environmental condition the drift check may skip under CHECK_ENGINE_OFFLINE=1. 'not_found': HTTP 404, the pinned
 * commit or path does not exist in a repository this account can read; never skipped. A 404 on the repository
 * itself (private repository, no access) is classified 'unavailable' instead. 'error': anything else.
 */
export class GithubFetchError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GithubFetchError';
    this.kind = kind;
  }
}

const GH_NOT_FOUND = /HTTP 404|\bNot Found\b/i;
const GH_UNAVAILABLE =
  /not logged in|gh auth login|authentication|Bad credentials|HTTP 401|HTTP 403|SAML|dial tcp|no such host|connection refused|network is unreachable|i\/o timeout|TLS handshake|could not resolve|Temporary failure|error connecting|timed out|unexpected EOF/i;

export function fetchGithubFile(repo, path, commit, { timeoutMs = 20_000 } = {}) {
  const res = spawnSync('gh', ['api', `repos/${repo}/contents/${path}?ref=${commit}`], { encoding: 'utf8', timeout: timeoutMs });
  if (res.error) {
    const code = res.error.code;
    if (code === 'ENOENT') throw new GithubFetchError('unavailable', 'gh is not installed (spawn gh ENOENT)');
    if (code === 'ETIMEDOUT') throw new GithubFetchError('unavailable', `gh api did not answer within ${timeoutMs} ms (offline?)`);
    throw new GithubFetchError('unavailable', `gh could not run: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim() || `exit ${res.status}`).split('\n')[0];
    if (GH_NOT_FOUND.test(detail)) {
      // A 404 means one of two things: the pinned commit or path does not exist (a real drift failure),
      // or this account cannot see the repository at all, which GitHub also answers with 404 for private
      // repositories. Probe the repository itself to tell them apart: unreadable is an environmental
      // condition (skippable under CHECK_ENGINE_OFFLINE=1), a missing path in a readable repository is not.
      const probe = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.full_name'], { encoding: 'utf8', timeout: timeoutMs });
      if (probe.status !== 0 && GH_NOT_FOUND.test((probe.stderr || probe.stdout || '').trim())) {
        throw new GithubFetchError('unavailable', `repository ${repo} is not readable by this GitHub account (HTTP 404 on the repository itself)`);
      }
      throw new GithubFetchError('not_found', detail);
    }
    if (GH_UNAVAILABLE.test(detail)) throw new GithubFetchError('unavailable', `gh not authenticated or offline: ${detail}`);
    throw new GithubFetchError('error', `gh api failed for ${path}: ${detail}`);
  }
  let body;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    throw new GithubFetchError('error', `gh api returned something other than JSON for ${path}`);
  }
  if (body.encoding !== 'base64' || typeof body.content !== 'string') throw new GithubFetchError('error', `unexpected contents response for ${path}`);
  return { bytes: Buffer.from(body.content, 'base64'), blobSha: body.sha };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function main() {
  const existing = readExisting();
  const repo = existing?.repo ?? DEFAULTS.repo;
  const commit = argValue('--commit') ?? existing?.commit ?? DEFAULTS.commit;
  const files = (existing?.files ?? DEFAULTS.files).map((f) => ({ local: f.local, upstream: f.upstream }));
  const out = [];
  for (const f of files) {
    const { bytes, blobSha } = fetchGithubFile(repo, f.upstream, commit);
    if (gitBlobSha1(bytes) !== blobSha) throw new Error(`blob sha mismatch for ${f.upstream}: content did not decode to the blob GitHub reported`);
    const target = resolve(root, f.local);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    out.push({ local: f.local, upstream: f.upstream, bytes: bytes.length, gitBlobSha1: blobSha, sha256: sha256(bytes) });
    process.stdout.write(`${f.local}  ${bytes.length} bytes  sha256 ${out.at(-1).sha256}\n`);
  }
  const record = { repo, commit, syncedAt: new Date().toISOString(), files: out };
  writeFileSync(upstreamPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(
    generatedPath,
    [
      '// Generated by scripts/sync-engine.mjs from packages/engine/UPSTREAM.json. Do not edit.',
      'export const ENGINE_UPSTREAM = {',
      `  repo: ${JSON.stringify(repo)},`,
      `  commit: ${JSON.stringify(commit)},`,
      `  files: ${JSON.stringify(out.map((f) => ({ local: f.local, upstream: f.upstream, sha256: f.sha256 })), null, 2).replace(/\n/g, '\n  ')},`,
      '} as const;',
      '',
    ].join('\n'),
  );
  process.stdout.write(`pinned ${repo}@${commit} in ${upstreamPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
