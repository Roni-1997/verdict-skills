import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { verifyPrivatePythonProject } from './private-python-project.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const template = join(repository, 'deploy/private');
const pythonModules = ['__init__', '__main__', 'adapters', 'authority', 'core', 'postgres_store', 'private_vault', 'provisioner', 'public', 'quotes', 'rpc', 'signer_http'];
const esbuildVersion = '0.28.2';
const builtins = new Set(builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name : `node:${name}`]));

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function regular(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Expected regular build input: ${path}`);
  return entry;
}

async function copy(source, destination) {
  await regular(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o644);
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(path, name));
    else if (entry.isFile()) files.push({ path: name, bytes: (await lstat(path)).size, sha256: await digest(path) });
    else throw new Error(`Unexpected nonregular package output: ${name}`);
  }
  return files;
}

async function nodeRuntime(input, output) {
  const expected = JSON.parse(await readFile(join(template, 'node-runtime.json'), 'utf8'));
  const supplied = JSON.parse(await readFile(join(input, 'node-runtime.json'), 'utf8'));
  if (Object.keys(supplied).sort().join() !== Object.keys(expected).sort().join()
      || Object.entries(expected).some(([key, value]) => supplied[key] !== value)) throw new Error('Node runtime metadata differs from the committed official distribution');
  const binary = join(input, 'node-linux-x64');
  const archive = join(input, `node-${expected.version}-linux-x64.tar.xz`);
  const info = await regular(binary);
  await regular(archive);
  if (info.size !== expected.binaryBytes || await digest(binary) !== expected.binarySha256
      || await digest(archive) !== expected.archiveSha256) throw new Error('Official Node runtime checksum mismatch');
  const handle = await open(binary, 'r');
  try {
    const elf = Buffer.alloc(20); await handle.read(elf, 0, 20, 0);
    if (elf.subarray(0, 4).toString('hex') !== '7f454c46' || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== 62) throw new Error('Expected Linux ELF64 x86_64 Node binary');
  } finally { await handle.close(); }
  await copy(binary, join(output, 'runtime/node'));
  await chmod(join(output, 'runtime/node'), 0o755);
  await copy(join(template, 'node-runtime.json'), join(output, 'runtime/node-runtime.json'));
  const license = execFileSync('tar', ['-xOf', archive, `node-${expected.version}-linux-x64/LICENSE`], { maxBuffer: 2_000_000 });
  await mkdir(join(output, 'licenses'), { recursive: true });
  await writeFile(join(output, 'licenses/node.txt'), license);
  return expected;
}

async function dependencyLicenses(inputs, cli, output) {
  const packages = new Map();
  for (const input of inputs) {
    let directory = dirname(resolve(cli, input));
    while (directory !== dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
          if (!packages.has(metadata.name)) packages.set(metadata.name, { directory, version: metadata.version });
          break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = dirname(directory);
    }
  }
  const notices = [];
  for (const [name, entry] of [...packages].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Unexpected bundled dependency identity');
    const licenses = (await readdir(entry.directory)).filter((file) => /^licen[sc]e(?:\..*)?$/i.test(file)).sort();
    for (const file of licenses) await copy(join(entry.directory, file), join(output, 'licenses', `${name.replace(/[@/]/g, '_')}-${file}`));
    notices.push({ name, version: entry.version, licenses });
  }
  await copy(join(repository, 'LICENSE'), join(output, 'licenses/verdict.txt'));
  return notices;
}

function verifyCli(path) {
  const input = { legs: [{ venue: 'lighter', network: 'testnet', account: 42, apiKeyIndex: 5, market: 9001, creator: 7,
    title: 'Synthetic packaging validation', settlementRule: 'Local validation only; no venue transport.',
    side: 'yes', action: 'buy', shares: '10', limitPrice: '0.4', feeReserveUSDC: '0.1', tif: 'ioc' }],
    policy: { maxTotalDebitUSDC: '5', maxLegDebitUSDC: '5' }, settlementReview: null };
  const run = (operation, value) => {
    const result = spawnSync(process.execPath, [path, 'execution', operation, '--input', JSON.stringify(value)], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin' } });
    if (result.status !== 0 || result.error) throw new Error(`Packaged CLI ${operation} failed: ${(result.stderr ?? '').slice(0, 1000)}`);
    return JSON.parse(result.stdout);
  };
  const prepared = run('prepare', input);
  const validated = run('validate', prepared);
  if (!/^[a-f0-9]{64}$/.test(prepared.digest) || JSON.stringify(validated) !== JSON.stringify(prepared)) throw new Error('Packaged CLI canonical proposal check failed');
}

export async function packagePrivateVercel({ cli, node, out }) {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Use Node22 to build the private Vercel artifact');
  const require = createRequire(import.meta.url);
  if (require('esbuild/package.json').version !== esbuildVersion) throw new Error('Install the pinned esbuild version before packaging');
  try { await lstat(out); throw new Error('Output already exists; choose a new clean deployment directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(out), { recursive: true });
  const temporary = await mkdtemp(join(dirname(out), '.verdict-private-build-'));
  try {
    const entrypoint = await readFile(join(template, 'api/signer.py'), 'utf8');
    if (!/^class handler\(VercelHandler\):$/m.test(entrypoint)) throw new Error('Vercel Python discovery requires the top-level class handler(VercelHandler); an assignment alias is not detected');
    await verifyPrivatePythonProject();
    for (const file of ['vercel.json', '.vercelignore', '.python-version', 'api/signer.py', 'pyproject.toml', 'uv.lock']) await copy(join(template, file), join(temporary, file));
    for (const name of pythonModules) await copy(join(repository, `local-runner/verdict_broker/${name}.py`), join(temporary, `local-runner/verdict_broker/${name}.py`));
    const requirements = join(repository, 'local-runner/requirements.lock');
    await copy(requirements, join(temporary, 'requirements.txt'));
    const runtime = await nodeRuntime(node, temporary);
    const result = await build({ absWorkingDir: cli, entryPoints: ['dist/bin.js'], outfile: join(temporary, 'packages/cli/dist/bin.js'),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'bundle', metafile: true, sourcemap: false, legalComments: 'eof',
      banner: { js: "import { createRequire as __verdictCreateRequire } from 'node:module'; const require = __verdictCreateRequire(import.meta.url);" } });
    const external = Object.values(result.metafile.outputs).flatMap((value) => value.imports.filter((entry) => entry.external).map((entry) => entry.path));
    if (external.some((name) => !builtins.has(name))) throw new Error(`CLI bundle has unexpected external modules: ${external.join(', ')}`);
    await writeFile(join(temporary, 'packages/cli/package.json'), `${JSON.stringify({ name: 'verdict-private-cli-runtime', private: true, type: 'module' }, null, 2)}\n`);
    const dependencies = await dependencyLicenses(Object.keys(result.metafile.inputs), cli, temporary);
    verifyCli(join(temporary, 'packages/cli/dist/bin.js'));
    const files = await inventory(temporary);
    if (files.some((file) => /(?:^|\/)(?:node_modules|\.env[^/]*|\.git|\.vercel|__pycache__)(?:\/|$)/.test(file.path))) throw new Error('Unexpected private deployment content');
    const manifest = { format: 'verdict-private-vercel/1', runtime, esbuildVersion, dependencies, canonicalCliValidated: true, files };
    await writeFile(join(temporary, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, out);
    return { output: out, files: files.length + 1, bytes: files.reduce((sum, file) => sum + file.bytes, 0), canonicalCliValidated: true };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { cli: { type: 'string' }, 'node-runtime': { type: 'string' }, out: { type: 'string' } }, strict: true, allowPositionals: false });
  if (!values.cli || !values['node-runtime'] || !values.out) throw new Error('Usage: node scripts/package-private-vercel.mjs --cli DIR --node-runtime DIR --out NEW_DIR');
  const paths = { cli: resolve(values.cli), node: resolve(values['node-runtime']), out: resolve(values.out) };
  if (paths.out === repository || repository.startsWith(paths.out + sep) || paths.out === paths.cli || paths.out === paths.node) throw new Error('Output must be a new dedicated directory');
  process.stdout.write(`${JSON.stringify(await packagePrivateVercel(paths))}\n`);
}
