# @verdict/mcp

Explicit `--hosted-execution --connector-config /private/operator/connector.json --http 8789`
adds OAuth, account bindings, signed-in browser approval for single orders or bounded policy
execution, and SDK submission/status/cancel. It requires Node 22.13+ and separately provisioned
private policy brokers. The default research mode below remains keyless. See the
[hosted connector guide](../../docs/hosted-connector.md) for configuration and deployment limits.

`--account-service --connector-config /private/operator/accounts.json --http 8789` adds
the first-party Privy connection, verified wallet enrollment, OAuth and revocation service
for the matching Verdict app route. It combines research and the same SDK execution
lifecycle. See the [account service guide](../../docs/account-service.md). It is locally
tested with fake venues, not deployed or accepted with funded accounts.

The optional private Lighter testnet provisioner adds owner-approved hosted key registration
and bounded buy-IOC authority. `execution_prepare_lighter_intent` prepares a fresh-market
buy from a maximum USDC spend including fees. `execution_submit` then returns the exact
browser review in `per_order` mode, or uses the explicitly reviewed `policy` grant.
The current durable runtime uses local SQLite and private Unix sockets. Running it on
Vercel Functions requires a shared durable store and isolated signer transport.

`verdict-mcp --strategy` serves seven `strategy_*` research/calculation tools, three prompts
(`paired_market_research`, `paper_leg_failure`, `inventory_exposure_check`) and the
`verdict-strategy://capabilities` resource. This separate mode supports HL/Lighter snapshots,
conditional plans, scans, paper fills and reconciliation. Polymarket/Kalshi are reference only.
It holds no keys, builds no orders and submits nothing. `--lighter` and `--strategy` are
mutually exclusive. See the [strategy guide](../../skills/verdict/references/strategy.md).

The Verdict MCP server: seventeen tools over Verdict's HIP-4 outcome markets on Hyperliquid (markets and settlement rules, books, quotes, trades, candles, Polymarket and Kalshi comparison, Deribit fair value, hedges, an opportunity scan, positions, fills, orders, builder-fee status, and two unsigned payload tools), four prompts (`scan_and_compare`, `market_brief`, `hedge_check`, `prepare_order`) and two resources (`verdict://markets`, `verdict://market/{outcome}`). Stdio by default, streamable HTTP with `--http <port>`. The server holds no keys and signs nothing; the payload tools return unsigned Hyperliquid actions carrying Verdict's builder code, and the client shows their confirmation lines and waits for the user.

Not published yet. Once it is, a Claude Desktop, Cursor or `claude mcp add` entry is:

```json
{
  "mcpServers": {
    "verdict": {
      "command": "npx",
      "args": ["-y", "@verdict/mcp"],
      "env": { "VERDICT_NETWORK": "testnet", "VERDICT_VENUE": "at" }
    }
  }
}
```

and a hosted instance is `npx -y @verdict/mcp --http 8787` behind a reverse proxy, with `VERDICT_API_URL=https://hyperverdict.xyz/api/v1` set so the server runs no venue fetches of its own. Until then, build from the repository as the main README describes. Environment: `VERDICT_NETWORK` (default `testnet`), `VERDICT_VENUE`, `VERDICT_BUILDER_ADDRESS`, `VERDICT_BUILDER_FEE_TENTHS_BP`, optional `VERDICT_API_URL`. `verdict-mcp --help` prints the options.

Documentation, rules and the skill file: https://github.com/Roni-1997/verdict-skills#readme
