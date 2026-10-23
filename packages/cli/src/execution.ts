import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectExecution, ExecutionDeliveryUnknownError, ExecutionMode, ExecutionProposal, executionCapabilities, executionConfirmation, prepareExecution, ToolError, validateExecution } from '@verdict/core';
import { z } from 'zod';
import type { CliResult } from './index.js';

export const EXECUTION_USAGE = `verdict execution: proposals and local SDK execution
  verdict execution prepare --input '<request JSON>' | --file request.json
  verdict execution review --input '<proposal JSON>' | --file proposal.json
  verdict execution validate --input '<proposal JSON>' | --file proposal.json
  verdict execution capabilities
  verdict execution broker-capabilities --mode per_order|policy
  verdict execution preflight|submit|status --file proposal.json --mode per_order|policy
  verdict execution cancel --input '{"proposal":<proposal>,"leg":0}' --mode per_order|policy
Local commands require VERDICT_BROKER_SOCKET and an operator-run broker. --mode asserts
its mode; VERDICT_EXECUTION_MODE can supply the same assertion. The broker owns approval,
policy and signing. --pretty indents output. Preparation remains keyless.
`;
export async function runExecutionCli(argv: readonly string[]): Promise<CliResult> {
  try {
    const { values: v, positionals: [command, ...extra] } = parseArgs({ args: [...argv], allowPositionals: true, options: {
      input: { type: 'string' }, file: { type: 'string' }, mode: { type: 'string' }, pretty: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (v.help || !command) return { exitCode: v.help ? 0 : 1, stdout: v.help ? EXECUTION_USAGE : '', stderr: v.help ? '' : EXECUTION_USAGE };
    if (extra.length) throw new ToolError('Unexpected execution argument', 'bad_input');
    const local = ['broker-capabilities', 'preflight', 'submit', 'status', 'cancel'].includes(command);
    if (!local && v.mode !== undefined) throw new ToolError('--mode applies only to local broker commands', 'bad_input');
    const mode = local ? ExecutionMode.safeParse(v.mode ?? process.env.VERDICT_EXECUTION_MODE) : undefined;
    if (mode !== undefined && !mode.success) throw new ToolError('Local commands require explicit --mode per_order|policy or VERDICT_EXECUTION_MODE', 'not_configured');
    const client = mode?.success ? await connectExecution({ expectedMode: mode.data }) : undefined;
    let result: unknown;
    if (command === 'capabilities' || command === 'broker-capabilities') {
      if (v.input !== undefined || v.file !== undefined) throw new ToolError('capabilities takes no input', 'bad_input');
      result = client ? await client.capabilities() : executionCapabilities();
    } else {
      if ((v.input === undefined) === (v.file === undefined)) throw new ToolError('Provide exactly one of --input JSON or --file path', 'bad_input');
      let raw = v.input;
      if (v.file !== undefined) {
        try { const info = await stat(v.file); if (!info.isFile() || info.size > 1_048_576) throw new Error(); raw = await readFile(v.file, 'utf8'); }
        catch { throw new ToolError('Cannot read a regular JSON file of at most 1 MiB (path hidden)', 'bad_input'); }
      }
      if (raw === undefined || Buffer.byteLength(raw) > 1_048_576) throw new ToolError('Execution input exceeds 1 MiB', 'bad_input');
      let input: unknown; try { input = JSON.parse(raw); } catch { throw new ToolError('Invalid JSON (input hidden)', 'bad_input'); }
      switch (command) {
        case 'prepare': result = prepareExecution(input); break;
        case 'review': result = executionConfirmation(input); break;
        case 'validate': result = validateExecution(input); break;
        case 'preflight': if (!client) throw new ToolError('Local broker not configured', 'not_configured'); result = await client.preflight(validateExecution(input)); break;
        case 'submit': if (!client) throw new ToolError('Local broker not configured', 'not_configured'); result = await client.submit(validateExecution(input)); break;
        case 'status': if (!client) throw new ToolError('Local broker not configured', 'not_configured'); result = await client.status(validateExecution(input)); break;
        case 'cancel': {
          if (!client) throw new ToolError('Local broker not configured', 'not_configured');
          const parsed = z.object({ proposal: ExecutionProposal, leg: z.union([z.literal(0), z.literal(1)]) }).strict().safeParse(input);
          if (!parsed.success) throw new ToolError('cancel requires {proposal,leg:0|1}', 'bad_input');
          result = await client.cancel(parsed.data); break;
        }
        default: throw new ToolError('Unknown execution command; use verdict execution --help', 'bad_input');
      }
    }
    return { exitCode: 0, stdout: `${JSON.stringify(result, null, v.pretty ? 2 : undefined)}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof ExecutionDeliveryUnknownError) return { exitCode: 3, stdout: '', stderr: `${JSON.stringify({ error: 'delivery_unknown', message: e.message, digest: e.digest })}\n` };
    const code = e instanceof ToolError ? e.code : 'bad_input';
    return { exitCode: { bad_input: 1, not_found: 2, upstream: 3, not_configured: 4 }[code], stdout: '', stderr: `${JSON.stringify({ error: code, message: e instanceof ToolError ? e.message : 'Execution request failed (details hidden)' })}\n` };
  }
}
