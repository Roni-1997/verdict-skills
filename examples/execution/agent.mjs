// Run from a built repository with the operator broker already listening.
// node examples/execution/agent.mjs request.json saved-proposal.json
import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { connectExecution, ExecutionMode, prepareExecution, validateExecution } from '../../packages/core/dist/index.js';

const [requestFile, proposalFile] = process.argv.slice(2);
if (!requestFile || !proposalFile) throw new Error('Provide request.json and a durable proposal.json path.');
const expectedMode = ExecutionMode.parse(process.env.VERDICT_EXECUTION_MODE);
const client = await connectExecution({ expectedMode });
let saved;
try { saved = await readFile(proposalFile, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (saved !== undefined) {
  // A previous send may have reached the venue, even if its response was lost.
  console.log(JSON.stringify(await client.status(validateExecution(JSON.parse(saved))), null, 2));
} else {
  const proposal = prepareExecution(JSON.parse(await readFile(requestFile, 'utf8')));
  const file = await open(proposalFile, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(proposal)}\n`); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(proposalFile), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  await client.preflight(proposal);
  console.log(JSON.stringify(await client.submit(proposal), null, 2));
}
