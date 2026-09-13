// The CLI face: one command per tool, JSON on stdout, never interactive. Agents run this; people can too.
import { parseArgs } from 'node:util';
import { ToolError, UpstreamError, configFromEnv, createTools, type KitConfig, type Tools } from '@verdict/core';

export const USAGE = `verdict: Verdict HIP-4 outcome markets from the command line (JSON output, no prompts)

  verdict markets [--venue <name>] [--include-expired]
  verdict market <outcome>
  verdict book <outcome>
  verdict quote <outcome> --side yes|no --action buy|sell --size <tokens>
  verdict positions <address>
  verdict builder-status <address>
  verdict approve-builder-fee-payload
  verdict build-order <outcome> --side yes|no --action buy|sell --price <0..1> --size <tokens> [--tif Gtc|Ioc|Alo]

Environment: VERDICT_NETWORK (testnet|mainnet, default testnet), VERDICT_VENUE, VERDICT_BUILDER_ADDRESS, VERDICT_BUILDER_FEE_TENTHS_BP.
Exit codes: 0 ok, 1 usage, 2 not found, 3 upstream error, 4 not configured.
approve-builder-fee-payload and build-order print UNSIGNED payloads. Show the confirmation lines and wait for an explicit yes before signing.
`;

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const OPTIONS = {
  venue: { type: 'string' },
  'include-expired': { type: 'boolean', default: false },
  side: { type: 'string' },
  action: { type: 'string' },
  size: { type: 'string' },
  price: { type: 'string' },
  tif: { type: 'string' },
  cloid: { type: 'string' },
  pretty: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const;

function need(v: string | undefined, name: string): string {
  if (v === undefined || v === '') throw new ToolError(`--${name} is required`, 'bad_input');
  return v;
}

function outcomeArg(v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n) || n < 0) throw new ToolError(`<outcome> must be a nonnegative integer, got ${JSON.stringify(v)}`, 'bad_input');
  return n;
}

function action(v: string | undefined): 'buy' | 'sell' {
  const a = need(v, 'action').toLowerCase();
  if (a !== 'buy' && a !== 'sell') throw new ToolError(`--action must be buy or sell, got ${JSON.stringify(v)}`, 'bad_input');
  return a;
}

export async function runCli(argv: readonly string[], config: KitConfig = configFromEnv(), tools: Tools = createTools(config)): Promise<CliResult> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: `${e instanceof Error ? e.message : String(e)}\n\n${USAGE}` };
  }
  const { values, positionals } = parsed;
  const [cmd, arg] = positionals;
  if (values.help || !cmd) return { exitCode: values.help ? 0 : 1, stdout: values.help ? USAGE : '', stderr: values.help ? '' : USAGE };
  const emit = (v: unknown) => `${values.pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v)}\n`;
  try {
    switch (cmd) {
      case 'markets':
        return { exitCode: 0, stdout: emit(await tools.list_markets({ venue: values.venue, includeExpired: values['include-expired'] })), stderr: '' };
      case 'market':
        return { exitCode: 0, stdout: emit(await tools.get_market({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'book':
        return { exitCode: 0, stdout: emit(await tools.orderbook({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'quote': {
        const size = Number(need(values.size, 'size'));
        return { exitCode: 0, stdout: emit(await tools.quote({ outcome: outcomeArg(arg), side: need(values.side, 'side'), action: action(values.action), size })), stderr: '' };
      }
      case 'positions':
        return { exitCode: 0, stdout: emit(await tools.positions({ address: need(arg, 'address') })), stderr: '' };
      case 'builder-status':
        return { exitCode: 0, stdout: emit(await tools.builder_status({ address: need(arg, 'address') })), stderr: '' };
      case 'approve-builder-fee-payload':
        return { exitCode: 0, stdout: emit(await tools.approve_builder_fee_payload({})), stderr: '' };
      case 'build-order': {
        const tif = values.tif;
        if (tif !== undefined && tif !== 'Gtc' && tif !== 'Ioc' && tif !== 'Alo') throw new ToolError('--tif must be Gtc, Ioc or Alo', 'bad_input');
        const built = await tools.build_order({
          outcome: outcomeArg(arg),
          side: need(values.side, 'side'),
          action: action(values.action),
          price: need(values.price, 'price'),
          size: need(values.size, 'size'),
          tif,
          cloid: values.cloid as `0x${string}` | undefined,
        });
        return { exitCode: 0, stdout: emit(built), stderr: '' };
      }
      default:
        return { exitCode: 1, stdout: '', stderr: `unknown command ${JSON.stringify(cmd)}\n\n${USAGE}` };
    }
  } catch (e) {
    if (e instanceof ToolError) {
      const code = e.code === 'bad_input' ? 1 : e.code === 'not_found' ? 2 : e.code === 'not_configured' ? 4 : 3;
      return { exitCode: code, stdout: '', stderr: `${JSON.stringify({ error: e.code, message: e.message })}\n` };
    }
    if (e instanceof UpstreamError) return { exitCode: 3, stdout: '', stderr: `${JSON.stringify({ error: 'upstream', kind: e.kind, message: e.message })}\n` };
    return { exitCode: 3, stdout: '', stderr: `${JSON.stringify({ error: 'internal', message: e instanceof Error ? e.message : String(e) })}\n` };
  }
}
