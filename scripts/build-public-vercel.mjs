#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build, version } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Usage: pnpm run build:vercel:public [output-directory]');
const output = resolve(root, args[0] ?? 'dist/vercel-public');
const fromOutput = relative(output, root);
if (!fromOutput || (!fromOutput.startsWith(`..${sep}`) && fromOutput !== '..')) throw new Error('The output must not contain or overwrite the source checkout.');
const inside = relative(root, output);
if (!inside.startsWith(`..${sep}`) && inside !== '..' && !inside.startsWith(`dist${sep}`)) throw new Error('Generated artifacts must be outside the source checkout or under dist/.');
await mkdir(resolve(output, 'api'), { recursive: true });
const file = resolve(output, 'api/index.mjs');
const optionalColor = 'module.exports = false;';
const result = await build({ absWorkingDir: root, entryPoints: [resolve(root, 'packages/mcp/dist/vercel.js')], outfile: file,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'bundle', external: ['pg-native'],
  banner: { js: "import { createRequire as __verdictCreateRequire } from 'node:module'; const require = __verdictCreateRequire(import.meta.url);" },
  legalComments: 'linked', sourcemap: false, metafile: true, logLevel: 'warning',
  plugins: [{ name: 'omit-optional-terminal-color', setup(context) {
    // debug treats supports-color as optional. A serverless function has no terminal color capability.
    context.onResolve({ filter: /^supports-color$/ }, () => ({ path: 'supports-color', namespace: 'optional-terminal' }));
    context.onLoad({ filter: /.*/, namespace: 'optional-terminal' }, () => ({ contents: optionalColor, loader: 'js' }));
  } }] });
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const imports = [...new Set(Object.values(result.metafile.outputs).flatMap(value => value.imports.filter(item => item.external).map(item => item.path)))].sort();
if (imports.some(name => name !== 'pg-native' && !builtins.has(name))) throw new Error('The public bundle contains an unexpected runtime dependency.');
for (const name of ['package.json', 'vercel.json']) await writeFile(resolve(output, name), await readFile(resolve(root, 'deploy/public', name)));
await writeFile(resolve(output, '.vercelignore'), 'node_modules\nruntime\n.env*\nbuild-report.json\n');
const code = await readFile(file);
const inputDigests = await Promise.all(Object.keys(result.metafile.inputs).sort().map(async name => ({ name,
  sha256: createHash('sha256').update(name === 'optional-terminal:supports-color' ? optionalColor : await readFile(resolve(root, name))).digest('hex') })));
const report = { version: 1, esbuild: version, entrypoint: 'api/index.mjs', bytes: code.length,
  sha256: createHash('sha256').update(code).digest('hex'), inputs: inputDigests, externalImports: imports,
  runtimeDependenciesBundled: true, includesCredentials: false };
await writeFile(resolve(output, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
// This subprocess imports the ACTUAL generated artifact from its own directory, without project dependencies or secrets.
const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { createServer } from 'node:http';
  const { default: handler } = await import(${JSON.stringify(pathToFileURL(file).href)});
  if (typeof handler !== 'function') throw new Error('Missing public handler');
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const { port } = server.address();
    const response = await fetch('http://127.0.0.1:'+port+'/mcp');
    if (response.status !== 503 || (await response.json()).error !== 'hosted_service_unavailable') throw new Error('The unconfigured artifact did not fail closed');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
`], { cwd: dirname(file), env: { PATH: process.env.PATH ?? '', NODE_PATH: '' }, encoding: 'utf8', timeout: 20_000 });
if (smoke.status !== 0) throw new Error(`The generated public handler failed its isolated smoke check: ${(smoke.stderr ?? String(smoke.error ?? 'unknown error')).slice(0, 2000)}`);
console.log(JSON.stringify({ output, entrypoint: report.entrypoint, bytes: report.bytes, sha256: report.sha256, esbuild: version,
  runtimeDependenciesBundled: true, isolatedArtifactSmoke: 'passed' }));
