import { parseArgs } from 'node:util';
import { ToolError, createLighterTools, type LighterTools } from '@verdict/core';
import type { CliResult } from './index.js';

export const LIGHTER_USAGE = `verdict lighter: Lighter binary outcomes (JSON; no keys, signatures or sends)
  verdict lighter markets [--limit 50] [--cursor N] [--include-expired]
  verdict lighter market <market_id>
  verdict lighter book <market_id> [--limit 100]
  verdict lighter quote <market_id> --side yes|no --action buy|sell --size <shares>
  verdict lighter recent-trades <market_id> [--limit 50]
  verdict lighter positions <account_index>
  verdict lighter fees
  verdict lighter build-order <market_id> --side yes|no --action buy|sell --price <USDC> --size <shares> --client-order-index N [--tif gtc|ioc|post_only]
  verdict lighter build-cancel <market_id> --client-order-index N
Environment: LIGHTER_NETWORK=devnet|mainnet (default devnet), LIGHTER_CREATORS=comma-separated creator account indices.
No creator is enabled for unsigned orders by default; reads list all creators when unset.
--pretty indents output. Exit codes: 0 success, 1 bad input, 2 not found, 3 upstream, 4 not configured.
`;

export async function runLighterCli(argv: readonly string[], injected?: LighterTools): Promise<CliResult> {
  try {
    const { values: v, positionals: [cmd, arg, ...extra] } = parseArgs({ args: [...argv], allowPositionals: true, options: {
      side: { type: 'string' }, action: { type: 'string' }, size: { type: 'string' }, price: { type: 'string' },
      limit: { type: 'string' }, cursor: { type: 'string' }, tif: { type: 'string' }, 'client-order-index': { type: 'string' },
      'include-expired': { type: 'boolean' }, pretty: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (v.help || !cmd) return { exitCode: v.help ? 0 : 1, stdout: v.help ? LIGHTER_USAGE : '', stderr: v.help ? '' : LIGHTER_USAGE };
    if (extra.length) throw new ToolError('Unexpected positional arguments', 'bad_input');
    const tools = injected ?? createLighterTools();
    const id = (s: string | undefined) => s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN;
    const market = id(arg);
    let result: unknown;
    switch (cmd) {
      case 'markets':
        if (arg !== undefined) throw new ToolError('markets takes no positional arguments', 'bad_input');
        result = await tools.list_markets({ ...(v.limit === undefined ? {} : { limit: id(v.limit) }), ...(v.cursor === undefined ? {} : { cursor: id(v.cursor) }), ...(v['include-expired'] === undefined ? {} : { includeExpired: v['include-expired'] }) }); break;
      case 'market': result = await tools.get_market({ market }); break;
      case 'book': result = await tools.orderbook({ market, ...(v.limit === undefined ? {} : { limit: id(v.limit) }) }); break;
      case 'quote': result = await tools.quote({ market, side: v.side, action: v.action, size: v.size }); break;
      case 'recent-trades': result = await tools.recent_trades({ market, ...(v.limit === undefined ? {} : { limit: id(v.limit) }) }); break;
      case 'positions': result = await tools.positions({ account: id(arg) }); break;
      case 'fees':
        if (arg !== undefined) throw new ToolError('fees takes no positional arguments', 'bad_input');
        result = await tools.fee_schedule({}); break;
      case 'build-order': result = await tools.build_order({ market, side: v.side, action: v.action, price: v.price, size: v.size, clientOrderIndex: id(v['client-order-index']), ...(v.tif === undefined ? {} : { tif: v.tif }) }); break;
      case 'build-cancel': result = await tools.build_cancel({ market, clientOrderIndex: id(v['client-order-index']) }); break;
      default: throw new ToolError('Unknown Lighter command; use verdict lighter --help', 'bad_input');
    }
    return { exitCode: 0, stdout: `${JSON.stringify(result, null, v.pretty ? 2 : undefined)}\n`, stderr: '' };
  } catch (e) {
    const code = e instanceof ToolError ? e.code : e instanceof TypeError ? 'bad_input' : 'upstream';
    const exitCode = { bad_input: 1, not_found: 2, upstream: 3, not_configured: 4 }[code];
    return { exitCode, stdout: '', stderr: `${JSON.stringify({ error: code, message: e instanceof ToolError ? e.message : 'Invalid CLI arguments or Lighter request failed; use verdict lighter --help' })}\n` };
  }
}
