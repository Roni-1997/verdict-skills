#!/usr/bin/env node
// Build @verdict/engine: compile the byte-for-byte upstream sources with the engine's own
// tsconfig (DOM lib, bundler resolution, exactly as the Verdict app compiles them), then make
// the emitted files loadable by Node ESM. The upstream source imports './playbooks' without an
// extension, which the app's bundler resolves but Node does not; the rewrite happens on the
// emitted JS and d.ts only, so the source copies stay verifiable by check-engine-drift.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(root, 'packages/engine');
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');

const res = spawnSync(process.execPath, [tsc, '-p', resolve(engine, 'tsconfig.json')], { stdio: 'inherit' });
if (res.status !== 0) process.exit(res.status ?? 1);

const REWRITES = [
  { file: 'dist/research-core.js', from: /from '\.\/playbooks';/g, to: "from './playbooks.js';", required: true },
  { file: 'dist/research-core.d.ts', from: /from '\.\/playbooks';/g, to: "from './playbooks.js';", required: false },
];
for (const r of REWRITES) {
  const path = resolve(engine, r.file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(r.from, r.to);
  if (r.required && before === after && !before.includes(r.to)) {
    process.stderr.write(`build-engine: expected an extensionless './playbooks' import in ${r.file}; upstream changed shape, review the rewrite\n`);
    process.exit(1);
  }
  if (after !== before) writeFileSync(path, after);
}
process.stdout.write('engine built: packages/engine/dist\n');
