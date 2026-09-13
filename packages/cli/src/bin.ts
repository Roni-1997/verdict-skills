#!/usr/bin/env node
import { runCli } from './index.js';

// Set the exit code and let the process end on its own: calling process.exit() right after a large
// stdout write to a pipe truncates the output (stdout to pipes is asynchronous in Node).
const result = await runCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
