#!/usr/bin/env node
// Release check: every workspace package under packages/ is publishable to npm as prepared, before anyone runs
// `pnpm -r publish`. It builds them all, then checks each manifest against one set of rules (scope, version,
// license, repository, files, access, engines, entry points, bin files, workspace dependencies), that its dist
// and README exist, that the root LICENSE is present, and that the MCP server reports the package version.
// Publishes nothing, logs in to nothing, needs no network.
//
// Usage: node scripts/release-check.mjs [--no-build]
// Exit: 0 every check passed, 1 a check failed.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

export const RULES = {
  scope: '@verdict/',
  license: 'MIT',
  repositoryUrl: 'https://github.com/Roni-1997/verdict-skills.git',
  access: 'public',
  engines: '>=22',
  requiredFiles: ['dist', 'README.md'],
  versionPattern: /^\d+\.\d+\.\d+$/,
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDir(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/** Every directory under packages/ with a package.json, sorted by name. */
export function workspacePackages(dir = packagesDir) {
  return readdirSync(dir)
    .filter((d) => isFile(join(dir, d, 'package.json')))
    .sort()
    .map((d) => ({ dir: d, path: join(dir, d), manifest: readJson(join(dir, d, 'package.json')) }));
}

/** The checks for one package: an array of { ok, what } lines, with the failing ones first when printed. */
export function checkPackage(pkg, { names, version }) {
  const m = pkg.manifest;
  const out = [];
  const check = (ok, what) => out.push({ ok: Boolean(ok), what });

  check(m.name === `${RULES.scope}${pkg.dir}`, `name is ${RULES.scope}${pkg.dir} (got ${JSON.stringify(m.name)})`);
  check(m.private === false, `"private": false (got ${JSON.stringify(m.private)})`);
  check(typeof m.version === 'string' && RULES.versionPattern.test(m.version), `version is x.y.z (got ${JSON.stringify(m.version)})`);
  check(m.version === version, `version ${JSON.stringify(m.version)} equals the workspace version ${JSON.stringify(version)}`);
  check(m.license === RULES.license, `license is ${RULES.license} (got ${JSON.stringify(m.license)})`);
  check(typeof m.description === 'string' && m.description.length > 0, 'description present');
  check(m.type === 'module', '"type": "module"');
  check(m.repository?.type === 'git' && m.repository?.url === RULES.repositoryUrl, `repository.url is ${RULES.repositoryUrl}`);
  check(m.repository?.directory === `packages/${pkg.dir}`, `repository.directory is packages/${pkg.dir} (got ${JSON.stringify(m.repository?.directory)})`);
  check(m.publishConfig?.access === RULES.access, `publishConfig.access is ${RULES.access}`);
  check(m.engines?.node === RULES.engines, `engines.node is ${JSON.stringify(RULES.engines)} (got ${JSON.stringify(m.engines?.node)})`);

  const files = Array.isArray(m.files) ? m.files : [];
  for (const f of RULES.requiredFiles) check(files.includes(f), `files lists ${f}`);
  for (const f of files) check(existsSync(join(pkg.path, f)), `files entry ${f} exists`);
  check(isDir(join(pkg.path, 'dist')), 'dist/ exists (built)');
  check(isFile(join(pkg.path, 'README.md')), 'README.md exists');
  const readme = isFile(join(pkg.path, 'README.md')) ? readFileSync(join(pkg.path, 'README.md'), 'utf8') : '';
  check(readme.startsWith(`# ${m.name}\n`), `README.md opens with "# ${m.name}"`);
  check(/github\.com\/Roni-1997\/verdict-skills/.test(readme), 'README.md links to the repository');

  for (const key of ['main', 'types']) {
    check(typeof m[key] === 'string' && m[key].startsWith('./dist/'), `${key} points into dist (got ${JSON.stringify(m[key])})`);
    if (typeof m[key] === 'string') check(isFile(join(pkg.path, m[key])), `${key} target ${m[key]} exists`);
  }
  const exp = m.exports?.['.'];
  check(exp && exp.types === m.types && exp.import === m.main, 'exports["."] matches main and types');

  if (m.bin !== undefined) {
    check(typeof m.bin === 'object' && Object.keys(m.bin).length > 0, 'bin is a name to path map');
    for (const [name, rel] of Object.entries(m.bin ?? {})) {
      check(typeof rel === 'string' && rel.startsWith('./dist/'), `bin ${name} points into dist (got ${JSON.stringify(rel)})`);
      const abs = join(pkg.path, String(rel));
      check(isFile(abs), `bin ${name} target ${rel} exists`);
      if (isFile(abs)) check(readFileSync(abs, 'utf8').startsWith('#!/usr/bin/env node\n'), `bin ${name} starts with the node shebang`);
    }
  }

  for (const [field, deps] of [
    ['dependencies', m.dependencies ?? {}],
    ['peerDependencies', m.peerDependencies ?? {}],
    ['optionalDependencies', m.optionalDependencies ?? {}],
  ]) {
    for (const [dep, spec] of Object.entries(deps)) {
      if (dep.startsWith(RULES.scope)) {
        check(names.has(dep), `${field}.${dep} is a workspace package`);
        check(spec === 'workspace:*', `${field}.${dep} is declared workspace:* (got ${JSON.stringify(spec)}); pnpm rewrites it to ${version} on publish`);
      } else {
        check(!/^(workspace|link|file):/.test(String(spec)), `${field}.${dep} is a registry specifier (got ${JSON.stringify(spec)})`);
      }
    }
  }
  check(m.devDependencies === undefined || Object.keys(m.devDependencies).length === 0, 'no devDependencies (the root holds the toolchain)');

  return out;
}

/** Checks that live outside one manifest: the root LICENSE, and the MCP server's reported version. */
export function checkWorkspace(pkgs, version) {
  const out = [];
  const check = (ok, what) => out.push({ ok: Boolean(ok), what });
  const license = isFile(join(root, 'LICENSE')) ? readFileSync(join(root, 'LICENSE'), 'utf8') : '';
  check(license.startsWith('MIT License\n'), 'root LICENSE is the MIT text (pnpm copies it into every tarball without its own)');
  const server = join(root, 'packages/mcp/src/server.ts');
  const src = isFile(server) ? readFileSync(server, 'utf8') : '';
  const m = /export const SERVER_VERSION = '([^']*)';/.exec(src);
  check(m && m[1] === version, `packages/mcp/src/server.ts SERVER_VERSION is ${JSON.stringify(version)} (got ${JSON.stringify(m?.[1])})`);
  const versions = new Set(pkgs.map((p) => p.manifest.version));
  check(versions.size === 1, `one version across the workspace (got ${[...versions].map((v) => JSON.stringify(v)).join(', ')})`);
  return out;
}

function build() {
  const res = spawnSync('pnpm', ['-r', 'run', 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32', encoding: 'utf8' });
  return res.status === 0;
}

export function main(argv) {
  const noBuild = argv.includes('--no-build');
  const started = Date.now();
  let failed = 0;
  const line = (ok, what) => {
    if (!ok) failed++;
    process.stdout.write(`  [${ok ? 'OK  ' : 'FAIL'}] ${what}\n`);
  };

  process.stdout.write(`release-check: ${root}\n`);
  if (noBuild) {
    process.stdout.write('  build skipped (--no-build)\n');
  } else {
    const ok = build();
    line(ok, `pnpm -r run build (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    if (!ok) {
      process.stdout.write('Result: FAIL (build)\n');
      return 1;
    }
  }

  const pkgs = workspacePackages();
  line(pkgs.length > 0, `${pkgs.length} workspace package(s) under packages/`);
  const names = new Set(pkgs.map((p) => p.manifest.name));
  const version = pkgs[0]?.manifest.version;
  for (const pkg of pkgs) {
    process.stdout.write(`\n${pkg.manifest.name ?? pkg.dir} (packages/${pkg.dir})\n`);
    for (const c of checkPackage(pkg, { names, version })) line(c.ok, c.what);
  }
  process.stdout.write('\nworkspace\n');
  for (const c of checkWorkspace(pkgs, version)) line(c.ok, c.what);

  process.stdout.write(`\n${failed === 0 ? 'Result: PASS' : `Result: FAIL (${failed} check${failed === 1 ? '' : 's'} failed)`} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  return failed === 0 ? 0 : 1;
}

/** True when this file is the entry point, compared on real paths (argv[1] may be a symlink or a logical path). */
function isEntryPoint() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return resolve(arg) === fileURLToPath(import.meta.url) || statSync(arg).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
