// scripts/check-api-contract.mjs pins the Verdict API contract the way check-engine-drift.mjs pins the engine, and is
// held to the same fail-closed behaviour here, with a fake gh on PATH and no network: a tampered copy, a copy that no
// longer documents a route the hosted tools call, a shrunk or empty pin record, a stale provenance constant and a pin
// GitHub cannot find all fail whatever CHECK_ENGINE_OFFLINE says; only "gh not installed, not authenticated or
// offline" is skipped, and only under the flag.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_CONTRACT, REMOTE_ROUTES } from '../packages/core/src/index.js';
import { fakeGh } from './helpers/fake-gh.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT = 'packages/core/api-contract';
const UPSTREAM = `${CONTRACT}/UPSTREAM.json`;
const DOCUMENT = `${CONTRACT}/openapi.json`;
const GENERATED = 'packages/core/src/api-contract.ts';

/** Run the contract check with only `pathDir` on PATH (so the real gh is never reached) and CHECK_ENGINE_OFFLINE set or unset. */
function check(pathDir: string, offlineFlag: boolean, args: readonly string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env, PATH: pathDir };
  delete env.CHECK_ENGINE_OFFLINE;
  if (offlineFlag) env.CHECK_ENGINE_OFFLINE = '1';
  return spawnSync(process.execPath, ['scripts/check-api-contract.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env });
}

/** A scratch copy of the three files the check reads, so a case can tamper with them without touching this checkout. */
function scratch(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'api-contract-'));
  for (const f of [UPSTREAM, DOCUMENT, GENERATED]) {
    mkdirSync(join(tmp, dirname(f)), { recursive: true });
    cpSync(join(ROOT, f), join(tmp, f));
  }
  return tmp;
}

type Doc = { openapi: string; paths: Record<string, { get?: { responses?: Record<string, { content?: Record<string, unknown> }> } }> };
function rewriteDocument(tmp: string, edit: (doc: Doc) => void): void {
  const doc = JSON.parse(readFileSync(join(tmp, DOCUMENT), 'utf8')) as Doc;
  edit(doc);
  writeFileSync(join(tmp, DOCUMENT), JSON.stringify(doc, null, 2));
}

type Record_ = { repo: string; commit: string; files: { local: string; upstream: string; sha256: string }[] };
function rewriteRecord(tmp: string, edit: (record: Record_) => void): void {
  const path = join(tmp, UPSTREAM);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record_;
  edit(record);
  writeFileSync(path, JSON.stringify(record, null, 2));
}

describe('api contract pin', () => {
  it('the local copy is the pinned document: recorded hashes, the routes remote.ts calls and the GitHub copy agree', () => {
    const r = check(fakeGh('serve'), false);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`ok    ${DOCUMENT}  sha256 ${API_CONTRACT.files[0].sha256}`);
    for (const route of Object.values(REMOTE_ROUTES)) expect(r.stdout).toContain(`ok    GET /${route} documented with a 200 JSON body`);
    expect(r.stdout).toContain('1 file(s) compared against GitHub');
    expect(r.stdout).toContain('api contract: no drift');
    expect(r.stdout).not.toContain('skip');
  });
  it('a byte-tampered copy fails against the recorded hash and against GitHub, under CHECK_ENGINE_OFFLINE=1 too', () => {
    const tmp = scratch();
    appendFileSync(join(tmp, DOCUMENT), '\n');
    for (const flag of [false, true]) {
      const r = check(fakeGh('serve'), flag, ['--root', tmp]);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: local sha256`);
      expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: git blob sha1 does not match the recorded blob`);
      expect(r.stdout).toMatch(/FAIL {2}packages\/core\/api-contract\/openapi\.json: \d+ bytes, recorded \d+/);
      expect(r.stdout).toContain('differs from the GitHub copy at the pinned commit (hash mismatch; never skipped)');
      expect(r.stdout).toMatch(/api contract: \d+ problem\(s\)/);
      expect(r.stdout).not.toContain('no drift');
      expect(r.stdout).not.toContain('skip  ');
    }
  });
  it('a copy that stops documenting a route the hosted tools call fails by route name, and every route is reported', () => {
    const tmp = scratch();
    rewriteDocument(tmp, (doc) => {
      delete doc.paths['/compare'];
      const hedges = doc.paths['/hedges']?.get?.responses?.['200'];
      if (hedges) delete hedges.content;
    });
    const r = check(fakeGh('serve'), true, ['--root', tmp]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: no GET /compare; remote.ts calls it`);
    expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: GET /hedges documents no 200 application/json body`);
    for (const route of ['/markets', '/market', '/fair-value', '/opportunities']) expect(r.stdout).toContain(`ok    GET ${route} documented with a 200 JSON body`);
    // The tampered bytes fail the hash legs as well: a rewrite is never silent.
    expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: local sha256`);
  });
  it('a copy that is not JSON, or not an OpenAPI 3 document, fails and says which', () => {
    const notJson = scratch();
    writeFileSync(join(notJson, DOCUMENT), '{"openapi": "3.1.0",');
    const r = check(fakeGh('serve'), true, ['--root', notJson]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: not JSON:`);
    const swagger = scratch();
    rewriteDocument(swagger, (doc) => {
      doc.openapi = '2.0';
    });
    const r2 = check(fakeGh('serve'), true, ['--root', swagger]);
    expect(r2.status, r2.stdout).toBe(1);
    expect(r2.stdout).toContain(`FAIL  ${DOCUMENT}: not an OpenAPI 3 document (openapi="2.0")`);
  });
  it('an empty or shrunk pin record fails instead of verifying nothing', () => {
    const tmp = scratch();
    rewriteRecord(tmp, (record) => {
      record.files = [];
    });
    const r = check(fakeGh('serve'), true, ['--root', tmp]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FAIL  ${UPSTREAM} records no files; nothing would be verified`);
    expect(r.stdout).toContain(`FAIL  ${DOCUMENT}: synced by scripts/sync-api-contract.mjs but not recorded in ${UPSTREAM}; the pin record was shrunk`);
    expect(r.stdout).not.toContain('no drift');
  });
  it('a record that names a file sync-api-contract.mjs does not sync, or a commit that is not a sha, fails by name', () => {
    const tmp = scratch();
    rewriteRecord(tmp, (record) => {
      record.commit = 'main';
      record.files.push({ local: `${CONTRACT}/extra.json`, upstream: 'docs/api/extra.json', sha256: '0'.repeat(64) });
    });
    const r = check(fakeGh('serve'), true, ['--root', tmp]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FAIL  ${CONTRACT}/extra.json: recorded in ${UPSTREAM} but not in scripts/sync-api-contract.mjs DEFAULTS`);
    expect(r.stdout).toContain(`FAIL  ${CONTRACT}/extra.json: recorded in ${UPSTREAM} but missing`);
    expect(r.stdout).toContain(`FAIL  ${UPSTREAM}: commit is not a 40-hex sha`);
  });
  it('an unreadable pin record is exit 1 with the reason', () => {
    const tmp = scratch();
    rmSync(join(tmp, UPSTREAM));
    const r = check(fakeGh('serve'), true, ['--root', tmp]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FAIL  ${UPSTREAM} unreadable:`);
    expect(r.stdout).toContain('api contract: 1 problem(s)');
  });
  it('the generated provenance constant must carry the pinned commit and every recorded hash', () => {
    const noHash = scratch();
    const gen = join(noHash, GENERATED);
    writeFileSync(gen, readFileSync(gen, 'utf8').replace(API_CONTRACT.files[0].sha256, '0'.repeat(64)));
    const r = check(fakeGh('serve'), true, ['--root', noHash]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FAIL  ${GENERATED} is missing the sha256 of ${DOCUMENT}`);
    const noCommit = scratch();
    const gen2 = join(noCommit, GENERATED);
    writeFileSync(gen2, readFileSync(gen2, 'utf8').replace(API_CONTRACT.commit, '0'.repeat(40)));
    const r2 = check(fakeGh('serve'), true, ['--root', noCommit]);
    expect(r2.status, r2.stdout).toBe(1);
    expect(r2.stdout).toContain(`FAIL  ${GENERATED} does not carry the pinned commit; re-run scripts/sync-api-contract.mjs`);
    // And the checked-in constant agrees with the checked-in record.
    const record = JSON.parse(readFileSync(join(ROOT, UPSTREAM), 'utf8')) as Record_;
    expect(API_CONTRACT.repo).toBe(record.repo);
    expect(API_CONTRACT.commit).toBe(record.commit);
    expect(API_CONTRACT.files.map((f) => f.sha256)).toEqual(record.files.map((f) => f.sha256));
    expect(API_CONTRACT.commit).toBe('352b2352918cfb9d0616ae19cd4f80346e1d44a9');
  });
  it('a pin GitHub cannot find (HTTP 404) fails even under CHECK_ENGINE_OFFLINE=1', () => {
    for (const flag of [false, true]) {
      const r = check(fakeGh('not_found'), flag);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('not found on GitHub (HTTP 404)');
      expect(r.stdout).toContain('Not skippable');
      expect(r.stdout).not.toContain('skip  ');
      expect(r.stdout).toContain('api contract: 1 problem(s)');
    }
  });
  it('a private upstream this account cannot read fails by default and is skipped, saying so, only under CHECK_ENGINE_OFFLINE=1', () => {
    const dir = fakeGh('unreadable');
    const closed = check(dir, false);
    expect(closed.status, closed.stdout).toBe(1);
    expect(closed.stdout).toContain('FAIL  GitHub comparison could not run: repository Roni-1997/verdict is not readable by this GitHub account (HTTP 404 on the repository itself)');
    const open = check(dir, true);
    expect(open.status, open.stdout).toBe(0);
    expect(open.stdout).toContain('skip  GitHub comparison skipped (CHECK_ENGINE_OFFLINE=1): repository Roni-1997/verdict is not readable by this GitHub account');
    expect(open.stdout).toContain('api contract: no drift');
    expect(open.stdout).not.toContain('compared against GitHub');
  });
  it('gh offline or not authenticated fails by default and is skipped, saying so, only under CHECK_ENGINE_OFFLINE=1', () => {
    for (const mode of ['offline', 'unauthenticated'] as const) {
      const dir = fakeGh(mode);
      const closed = check(dir, false);
      expect(closed.status, closed.stdout).toBe(1);
      expect(closed.stdout).toContain('FAIL  GitHub comparison could not run: gh not authenticated or offline');
      expect(closed.stdout).toContain('set CHECK_ENGINE_OFFLINE=1 to skip this leg knowingly');
      const open = check(dir, true);
      expect(open.status, open.stdout).toBe(0);
      expect(open.stdout).toContain('skip  GitHub comparison skipped (CHECK_ENGINE_OFFLINE=1): gh not authenticated or offline');
      expect(open.stdout).toContain('api contract: no drift');
      expect(open.stdout).not.toContain('compared against GitHub');
    }
  });
  it('gh not installed: the same, with the reason named', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-gh-'));
    const closed = check(empty, false);
    expect(closed.status).toBe(1);
    expect(closed.stdout).toContain('gh is not installed');
    const open = check(empty, true);
    expect(open.status, open.stdout).toBe(0);
    expect(open.stdout).toContain('skip  GitHub comparison skipped (CHECK_ENGINE_OFFLINE=1): gh is not installed');
  });
  it('pnpm run check runs the contract check', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:api']).toBe('node scripts/check-api-contract.mjs');
    expect(pkg.scripts.check).toContain('pnpm run check:api');
  });
});
