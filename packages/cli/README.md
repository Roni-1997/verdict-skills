# @verdict/cli

The `verdict lighter` commands provide JSON research and unsigned SDK preparation for Verdict's Lighter binary outcome markets. They read settlement rules, books, executable quotes, recent prints, public positions, and binary fee tiers. Read commands need no login or key.

The package is not published yet. Build from the [source repository](https://github.com/Roni-1997/verdict-skills) as described in the root README, then run:

```sh
	LIGHTER_NETWORK=testnet verdict lighter markets --pretty
	LIGHTER_NETWORK=testnet verdict lighter market <market_id>
	LIGHTER_NETWORK=testnet verdict lighter quote <market_id> --side yes --action buy --size 10
```

`verdict lighter --help` lists all active Lighter research commands. Each command returns one JSON document. Prices are USDC per share, and sizes are decimal strings. Market and account IDs are numeric and network-specific.

## Configuration and unsigned payloads

`LIGHTER_NETWORK` selects devnet, testnet, or mainnet. Research defaults to devnet. Use testnet explicitly for staging. `LIGHTER_CREATORS` is a comma-separated list of operator-verified creator account indices. It filters discovery and enables unsigned preparation for those creators.

`verdict lighter build-order` and `verdict lighter build-cancel` return unsigned official SDK arguments. They never sign or send. Review the exact account, network, market, settlement rule, action, side, price, size, spend, and fees before handing an order to an authorized signer. A sell is not reduce-only and can open the opposite position.

For the agent trading lifecycle, use the default [Verdict skill](../../skills/verdict/SKILL.md) and the explicitly configured [MCP execution connection](../mcp/README.md). Independent per-order approval or an existing operator-selected bounded policy authorizes SDK execution. A research result, unsigned payload, or mode flag grants no authority.

## Errors and discovery

Follow `nextCursor` rather than treating one page as the full venue. CLI exit codes are 1 for invalid input, 2 for not found, 3 for upstream failure, and 4 for missing configuration. Retry a transient read at most once, respect rate limits, and never apply read retries to financial submission.

## Retained historical commands

The broader CLI still contains earlier venue research, cross-venue strategy, and generic execution commands for existing internal operators and compatibility. Those routes are historical tooling. They do not define the current Lighter agent kit, and the active MCP rejects other venues and paired proposals. Historical instructions are under [the legacy archive](../../docs/legacy/hyperliquid-kit/README.md), outside the installed skill corpus.
