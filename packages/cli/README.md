# @verdict/cli

`verdict strategy --help` lists seven shared-core commands for HL/Lighter snapshots, candidate
discovery, bounded scans, conditional plans, paper fills, inventory reconciliation and venue
health. Pass JSON through `--input` or `--file`. Offline assessment, paper and reconciliation
need no account or network. See the [strategy guide](../../skills/verdict/references/strategy.md).
These commands build no orders and grant no execution permission.

The `verdict` command line for Verdict's HIP-4 outcome markets on Hyperliquid: list markets with their settlement rules, read one market, its book, a quote for a size, recent trades and candles, compare it with Polymarket and Kalshi, read the Deribit option-implied fair value and Hyperliquid hedges, scan for tradeable markets, read positions, fills, open orders and one order's status for an address, and build unsigned orders that carry Verdict's builder code. One JSON document per command, no prompts, no keys, testnet by default.

Not published yet. Once it is:

```sh
npx @verdict/cli markets
npx @verdict/cli market 1210
npx @verdict/cli quote 1210 --side yes --action buy --size 250
```

Until then, build from the repository as the main README describes. Environment: `VERDICT_NETWORK` (`testnet` or `mainnet`, default `testnet`), `VERDICT_VENUE`, `VERDICT_BUILDER_ADDRESS`, `VERDICT_BUILDER_FEE_TENTHS_BP`, optional `VERDICT_API_URL` for hosted mode. `verdict --help` prints every command.

The two payload commands, `approve-builder-fee-payload` and `build-order`, print unsigned payloads only; the caller signs with its own key, never this package.

Documentation, rules and the skill file: https://github.com/Roni-1997/verdict-skills#readme
