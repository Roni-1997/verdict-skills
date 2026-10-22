import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const sdk = process.argv.includes('--sdk');
const root = fileURLToPath(new URL('../', import.meta.url));
const python = sdk ? resolve(root, process.env.VERDICT_BROKER_PYTHON ?? 'local-runner/.venv/bin/python') : 'python3';
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', sdk ? 'sdk-tests' : 'tests', '-v'], {
  cwd: resolve(root, 'local-runner'), stdio: 'inherit', env: { ...process.env, VERDICT_NODE_BINARY: process.execPath },
});
if (result.error) process.stderr.write(`Broker test runtime unavailable: ${sdk ? 'install the pinned SDK environment first' : 'Python 3.11+ required'}\n`);
process.exit(result.status ?? 1);
