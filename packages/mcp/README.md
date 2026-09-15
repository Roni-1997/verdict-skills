# @verdict/mcp

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
