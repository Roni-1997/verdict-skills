import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createStrategyTools, STRATEGY_DOCS, type StrategyTools, ToolError } from '@verdict/core';
import type { CliResult } from './index.js';

export const STRATEGY_USAGE = `verdict strategy: cross-venue research and paper execution (JSON; no signing or sends)
  verdict strategy <command> --input '<JSON>' [--pretty]
  verdict strategy <command> --file <JSON-file> [--pretty]
Commands:
${Object.values(STRATEGY_DOCS).map((d) => `  ${d.command.padEnd(12)} ${d.description}`).join('\n')}
Snapshot example: verdict strategy snapshot --input '{"outcome":42,"market":4555}'
Omit market for the existing HL/Polymarket/Kalshi reference comparison only.
Environment: VERDICT_NETWORK=testnet|mainnet; LIGHTER_NETWORK=devnet|mainnet, independent defaults.
Assess/paper/reconcile replay caller-supplied JSON without network access or account keys.
Plans have liveReady=false. Conditional payoff is a caller assumption, not verified equivalence or guaranteed arbitrage.
Exit codes: 0 report produced (inspect kind/reasons), 1 bad input, 2 not found, 3 upstream, 4 not configured.
`;

export async function runStrategyCli(argv: readonly string[], injected?: StrategyTools): Promise<CliResult> {
  try {
    const { values: v, positionals: [cmd, ...extra] } = parseArgs({ args: [...argv], allowPositionals: true, options: {
      input: { type: 'string' }, file: { type: 'string' }, pretty: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (v.help || !cmd) return { exitCode: v.help ? 0 : 1, stdout: v.help ? STRATEGY_USAGE : '', stderr: v.help ? '' : STRATEGY_USAGE };
    if (extra.length) throw new ToolError('Unexpected positional arguments', 'bad_input');
    if ((v.input === undefined) === (v.file === undefined)) throw new ToolError('Provide exactly one of --input JSON or --file path', 'bad_input');
    let raw = v.input;
    if (v.file !== undefined) {
      try {
        const info = await stat(v.file);
        if (!info.isFile() || info.size > 1_048_576) throw new Error('file size');
        raw = await readFile(v.file, 'utf8');
      } catch { throw new ToolError('Cannot read a regular JSON file of at most 1 MiB (path hidden)', 'bad_input'); }
    }
    if (raw === undefined || Buffer.byteLength(raw) > 1_048_576) throw new ToolError('JSON input is required and must be at most 1 MiB', 'bad_input');
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new ToolError('Invalid JSON input (value hidden)', 'bad_input'); }
    const tools = injected ?? createStrategyTools(); let result: unknown;
    switch (cmd) {
      case 'discover': result = await tools.discover_pairs(input); break;
      case 'snapshot': result = await tools.snapshot(input); break;
      case 'assess': result = await tools.assess_pair(input); break;
      case 'scan': result = await tools.scan_pairs(input); break;
      case 'paper': result = await tools.paper_pair(input); break;
      case 'reconcile': result = await tools.reconcile_pair(input); break;
      case 'health': result = await tools.venue_health(input); break;
      default: throw new ToolError('Unknown strategy command; use verdict strategy --help', 'bad_input');
    }
    return { exitCode: 0, stdout: `${JSON.stringify(result, null, v.pretty ? 2 : undefined)}\n`, stderr: '' };
  } catch (e) {
    const error = e instanceof ToolError ? e.code : e instanceof TypeError ? 'bad_input' : 'upstream';
    const code = { bad_input: 1, not_found: 2, upstream: 3, not_configured: 4 }[error];
    return { exitCode: code, stdout: '', stderr: `${JSON.stringify({ error, message: e instanceof ToolError ? e.message : 'Strategy request failed (details hidden); use verdict strategy --help' })}\n` };
  }
}
