# verdict-skills

Verdict's agent kit. One typed tool module over the cross-venue engine from the Verdict app,
shipped three ways from the same code:

| Face | Package | For |
|---|---|---|
| CLI | `packages/cli` (`verdict` on npm) | scripts, bots, and the skill file below |
| Skill | `skills/verdict/SKILL.md` | Claude Code, Codex, OpenClaw, Hermes and any SKILL.md agent |
| MCP server | `packages/mcp` | Claude Desktop, Cursor, hosted agents, over stdio or streamable HTTP |

Every face calls the same functions in `packages/core`. The goal, the rules and the success
criteria are in [GOAL.md](GOAL.md). The milestone that this repository implements is Phase 11
of the Verdict app's plan (`.planning/phases/11-cross-venue-engine/` in `Roni-1997/verdict`).

## Status

Private, in development, testnet only. Nothing here is released.

## What the tools do

Read tools, no account needed:

- `list_markets`: live Verdict outcome markets for the configured venue, with the settlement rule text taken from the template each market was deployed from.
- `get_market`: one market in full: sides, coins, asset ids, settlement rule, expiry, fee scale.
- `orderbook`: the YES and NO books for a market.
- `quote`: the executable price for a side and a size, walked from the book, with slippage.
- `compare_market`: the same market on Polymarket and Kalshi, the price gap, and the resolution-equivalence confidence and reasons.
- `fair_value`: the option-implied probability from Deribit for price markets on BTC, ETH and SOL.
- `find_hedges`: hedge legs for a market.
- `opportunities`: ranked cross-venue gaps across the live board.
- `positions`: outcome-token balances for an address, read only.
- `builder_status`: whether an address has approved Verdict's builder fee, and up to what rate.

Payload tools, signed by the caller, never by the kit:

- `approve_builder_fee_payload`: the typed data for the one-time builder-fee approval. Main wallet signature, not an agent key.
- `build_order`: an unsigned Hyperliquid order action for a Verdict market carrying `builder: {b, f}`, plus the settlement rule and the fee in cents per $1,000, ready for the caller to sign and submit.

## Layout

```
packages/core   the tool module: Hyperliquid client, schemas, tools, engine adapter
packages/cli    the verdict CLI, --json on every command, non-interactive flags
packages/mcp    the MCP server, stdio and streamable HTTP, thin over core
skills/verdict  SKILL.md, references per command, installer script
docs            design notes and the builder program
tests           fixtures recorded from testnet and mainnet, tool tests
```

## Toolchain

Node 22, pnpm 10.34.5, strict TypeScript (same flags as the Verdict app), Zod on every input,
output and upstream response, Vitest, Biome lint. `pnpm run check` must be green before any
commit that changes code.
