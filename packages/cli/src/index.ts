// The CLI face: one command per tool, JSON on stdout, never interactive. Agents run this; people can too.
import { parseArgs } from 'node:util';
import { CANDLE_INTERVALS, ToolError, UpstreamError, configFromEnv, parseApiUrl, toolsFromConfig, type KitConfig, type Tools } from '@verdict/core';

export const USAGE = `verdict: Verdict HIP-4 outcome markets from the command line (JSON output, no prompts)

  verdict markets [--venue <name>] [--include-expired]
  verdict market <outcome>
  verdict book <outcome>
  verdict quote <outcome> --side yes|no --action buy|sell --size <tokens>
  verdict recent-trades <outcome> [--side yes|no]
  verdict candles <outcome> --side yes|no --interval <1m|3m|5m|15m|30m|1h|2h|4h|8h|12h|1d|3d|1w|1M> --lookback <minutes>
  verdict compare <outcome>
  verdict fair-value <outcome>
  verdict hedges <outcome>
  verdict opportunities [--limit <1..8>]
  verdict positions <address>
  verdict fills <address>
  verdict open-orders <address>
  verdict order-status <address> <oid>
  verdict builder-status <address>
  verdict approve-builder-fee-payload
  verdict build-order <outcome> --side yes|no --action buy|sell --price <0..1> --size <tokens> [--tif Gtc|Ioc|Alo] [--cloid 0x<32 hex>]

Options: --pretty indents the JSON. --api <url> answers markets, market, compare, fair-value, hedges and opportunities from the hosted Verdict API at <url> (https://hyperverdict.xyz/api/v1 in production; the same as VERDICT_API_URL, which the flag overrides); book, quote, recent-trades, candles, positions, fills, open-orders, order-status, builder-status and the payload commands run locally either way. Without either, the embedded engine runs. A blank --api is refused (exit 1): to run one command on the embedded engine, run it with VERDICT_API_URL unset or blank.
Environment: VERDICT_NETWORK (testnet|mainnet, default testnet), VERDICT_VENUE (a deployer venue; unset, blank or all: every deployer), VERDICT_BUILDER_ADDRESS, VERDICT_BUILDER_FEE_TENTHS_BP, VERDICT_API_URL (hosted mode, see --api).
Optional: ODDPOOL_API_KEY routes the engine's Polymarket and Kalshi reads through api.oddpool.com; the key is sent to OddPool on every compare and opportunities call, so never set it on a hosted server.
Exit codes: 0 ok, 1 usage, 2 not found, 3 upstream error, 4 not configured.
recent-trades reads one side (YES unless --side is given): the YES and NO coins print the same fills at p and 1 - p. candles is exit 2 for a side that has never traded (Hyperliquid keeps no candles for it). <oid> is an order id or a client order id (0x + 32 hex).
compare, fair-value, hedges and opportunities run the Verdict app's cross-venue engine (Polymarket, Kalshi, Deribit are read, never traded).
A low-confidence match is reported with its caveat and reasons; the price gap is omitted, never printed as a bare number.
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
  limit: { type: 'string' },
  interval: { type: 'string' },
  lookback: { type: 'string' },
  api: { type: 'string' },
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

/** Client order id: 16 bytes as 0x + 32 hex characters, the same rule the MCP face applies. Checked here so a bad id fails before the user signs, not after. */
const CLOID = /^0x[0-9a-fA-F]{32}$/;
function cloidArg(v: string | undefined): `0x${string}` | undefined {
  if (v === undefined) return undefined;
  if (!CLOID.test(v)) throw new ToolError(`--cloid must be 0x followed by 32 hex characters (16 bytes), got ${JSON.stringify(v)}`, 'bad_input');
  return v as `0x${string}`;
}

/** Exit code per error class; one JSON object on stderr in every case (see SKILL.md). */
const EXIT: Record<ToolError['code'], number> = { bad_input: 1, not_found: 2, upstream: 3, not_configured: 4 };

function errorResult(code: ToolError['code'], message: string): CliResult {
  return { exitCode: EXIT[code], stdout: '', stderr: `${JSON.stringify({ error: code, message })}\n` };
}

/**
 * Run one command. `config` and `tools` default to the environment; they are resolved after argument parsing and inside
 * the error mapping, so an invalid VERDICT_NETWORK or VERDICT_BUILDER_FEE_TENTHS_BP is reported as the not_configured
 * JSON error with exit 4, never as a stack trace, and `--help` works whatever the environment holds. `--api <url>`
 * overrides the configuration's API URL (hosted mode); a malformed or blank value is bad_input with exit 1 (a blank
 * VERDICT_API_URL means embedded mode, but a flag given without a URL is a mistake, most often an unset shell
 * variable, and must not silently run the engine in process). With the flag present VERDICT_API_URL is not read at
 * all, so a malformed variable cannot stop a command that names its own host. An injected `tools` wins over both,
 * for tests.
 */
export async function runCli(argv: readonly string[], config?: KitConfig, tools?: Tools): Promise<CliResult> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: `${e instanceof Error ? e.message : String(e)}\n\n${USAGE}` };
  }
  const { values, positionals } = parsed;
  const [cmd, arg, arg2] = positionals;
  if (values.help || !cmd) return { exitCode: values.help ? 0 : 1, stdout: values.help ? USAGE : '', stderr: values.help ? '' : USAGE };
  const emit = (v: unknown) => `${values.pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v)}\n`;
  let apiOverride: string | undefined;
  if (values.api !== undefined) {
    if (values.api.trim() === '') return errorResult('bad_input', '--api was given without a URL; pass the API base URL (e.g. --api https://hyperverdict.xyz/api/v1), or run the command with VERDICT_API_URL unset or blank to use the embedded engine');
    try {
      apiOverride = parseApiUrl(values.api, '--api') ?? undefined;
    } catch (e) {
      return errorResult('bad_input', e instanceof Error ? e.message : String(e));
    }
  }
  let resolved: Tools;
  try {
    // --api replaces VERDICT_API_URL rather than layering over it: the variable is dropped from the environment before
    // it is parsed, so the flag wins even when the variable holds a value the kit would refuse.
    const base = config ?? configFromEnv(apiOverride === undefined ? process.env : { ...process.env, VERDICT_API_URL: undefined });
    resolved = tools ?? toolsFromConfig(apiOverride === undefined ? base : { ...base, apiUrl: apiOverride });
  } catch (e) {
    return errorResult('not_configured', e instanceof Error ? e.message : String(e));
  }
  try {
    switch (cmd) {
      case 'markets':
        return { exitCode: 0, stdout: emit(await resolved.list_markets({ venue: values.venue, includeExpired: values['include-expired'] })), stderr: '' };
      case 'market':
        return { exitCode: 0, stdout: emit(await resolved.get_market({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'book':
        return { exitCode: 0, stdout: emit(await resolved.orderbook({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'quote': {
        const size = Number(need(values.size, 'size'));
        return { exitCode: 0, stdout: emit(await resolved.quote({ outcome: outcomeArg(arg), side: need(values.side, 'side'), action: action(values.action), size })), stderr: '' };
      }
      case 'compare':
        return { exitCode: 0, stdout: emit(await resolved.compare_market({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'fair-value':
        return { exitCode: 0, stdout: emit(await resolved.fair_value({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'hedges':
        return { exitCode: 0, stdout: emit(await resolved.find_hedges({ outcome: outcomeArg(arg) })), stderr: '' };
      case 'opportunities': {
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        if (limit !== undefined && !Number.isInteger(limit)) throw new ToolError(`--limit must be an integer, got ${JSON.stringify(values.limit)}`, 'bad_input');
        return { exitCode: 0, stdout: emit(await resolved.opportunities({ limit })), stderr: '' };
      }
      case 'positions':
        return { exitCode: 0, stdout: emit(await resolved.positions({ address: need(arg, 'address') })), stderr: '' };
      case 'recent-trades':
        return { exitCode: 0, stdout: emit(await resolved.recent_trades({ outcome: outcomeArg(arg), side: values.side })), stderr: '' };
      case 'candles': {
        const interval = need(values.interval, 'interval');
        if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) throw new ToolError(`--interval must be one of ${CANDLE_INTERVALS.join(', ')}, got ${JSON.stringify(interval.slice(0, 16))}`, 'bad_input');
        const lookbackRaw = need(values.lookback, 'lookback');
        const lookback = Number(lookbackRaw);
        if (!/^\d+$/.test(lookbackRaw) || !Number.isInteger(lookback)) throw new ToolError(`--lookback must be a whole number of minutes, got ${JSON.stringify(lookbackRaw.slice(0, 16))}`, 'bad_input');
        return { exitCode: 0, stdout: emit(await resolved.candles({ outcome: outcomeArg(arg), side: need(values.side, 'side'), interval, lookbackMinutes: lookback })), stderr: '' };
      }
      case 'fills':
        return { exitCode: 0, stdout: emit(await resolved.fills({ address: need(arg, 'address') })), stderr: '' };
      case 'open-orders':
        return { exitCode: 0, stdout: emit(await resolved.open_orders({ address: need(arg, 'address') })), stderr: '' };
      case 'order-status': {
        if (arg2 === undefined || arg2 === '') throw new ToolError('<oid> is required: an order id, or a client order id as 0x followed by 32 hex characters', 'bad_input');
        const oidRaw = arg2;
        // A run of digits is an order id; anything else is handed over as a client order id and checked by the tool.
        const oid = /^\d+$/.test(oidRaw) ? Number(oidRaw) : oidRaw;
        return { exitCode: 0, stdout: emit(await resolved.order_status({ address: need(arg, 'address'), oid })), stderr: '' };
      }
      case 'builder-status':
        return { exitCode: 0, stdout: emit(await resolved.builder_status({ address: need(arg, 'address') })), stderr: '' };
      case 'approve-builder-fee-payload':
        return { exitCode: 0, stdout: emit(await resolved.approve_builder_fee_payload({})), stderr: '' };
      case 'build-order': {
        const tif = values.tif;
        if (tif !== undefined && tif !== 'Gtc' && tif !== 'Ioc' && tif !== 'Alo') throw new ToolError('--tif must be Gtc, Ioc or Alo', 'bad_input');
        const built = await resolved.build_order({
          outcome: outcomeArg(arg),
          side: need(values.side, 'side'),
          action: action(values.action),
          price: need(values.price, 'price'),
          size: need(values.size, 'size'),
          tif,
          cloid: cloidArg(values.cloid),
        });
        return { exitCode: 0, stdout: emit(built), stderr: '' };
      }
      default:
        return { exitCode: 1, stdout: '', stderr: `unknown command ${JSON.stringify(cmd)}\n\n${USAGE}` };
    }
  } catch (e) {
    if (e instanceof ToolError) return errorResult(e.code, e.message);
    if (e instanceof UpstreamError) return { exitCode: 3, stdout: '', stderr: `${JSON.stringify({ error: 'upstream', kind: e.kind, message: e.message })}\n` };
    return { exitCode: 3, stdout: '', stderr: `${JSON.stringify({ error: 'internal', message: e instanceof Error ? e.message : String(e) })}\n` };
  }
}
