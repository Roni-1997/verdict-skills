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

## Use it from an agent

Nothing is published yet, so build once from a clone: `pnpm install && pnpm run build`. Replace `<repo>` below with the absolute path of the clone. Every face reads the same variables (see `.env.example`): `VERDICT_NETWORK` (default `testnet`), `VERDICT_VENUE` (`at` on testnet), `VERDICT_BUILDER_ADDRESS` and `VERDICT_BUILDER_FEE_TENTHS_BP` (default `10`, which is 0.01%, 10 cents per $1,000). The builder address is published by the owner; without it the read tools other than `builder_status` work, and `builder_status` and the two payload tools return `not_configured`.

| Face | Read tools | Unsigned payloads | Signing |
|---|---|---|---|
| CLI `verdict` | yes | yes | never; the caller signs with its own key ([sign-and-submit](skills/verdict/references/sign-and-submit.md)) |
| Skill `skills/verdict` | yes, via the CLI | yes, with the two-message rule | never |
| MCP stdio | yes | yes | never |
| MCP streamable HTTP (hosted) | yes | yes | never; the server holds no keys |

### Claude Desktop (stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "verdict": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/bin.js"],
      "env": {
        "VERDICT_NETWORK": "testnet",
        "VERDICT_VENUE": "at",
        "VERDICT_BUILDER_ADDRESS": "0x<builder address published by Verdict>",
        "VERDICT_BUILDER_FEE_TENTHS_BP": "10"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "verdict": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/bin.js"],
      "env": {
        "VERDICT_NETWORK": "testnet",
        "VERDICT_VENUE": "at",
        "VERDICT_BUILDER_ADDRESS": "0x<builder address published by Verdict>",
        "VERDICT_BUILDER_FEE_TENTHS_BP": "10"
      }
    }
  }
}
```

### Claude Code

MCP server, user scope:

```bash
claude mcp add verdict -s user \
  -e VERDICT_NETWORK=testnet -e VERDICT_VENUE=at \
  -e VERDICT_BUILDER_ADDRESS=0x<builder address> -e VERDICT_BUILDER_FEE_TENTHS_BP=10 \
  -- node <repo>/packages/mcp/dist/bin.js
```

Skill, one line (builds the CLI, writes `verdict` and `verdict-mcp` launchers to `~/.local/bin`, copies the skill to `~/.claude/skills/verdict`, and with `--claude-md` appends a `## Verdict` routing block to `~/.claude/CLAUDE.md` after printing it, only if no `## Verdict` heading exists; without the flag `CLAUDE.md` is not touched):

```bash
bash <repo>/skills/verdict/scripts/install.sh --claude-md
```

`bash <repo>/skills/verdict/scripts/uninstall.sh` reverses it and removes from `CLAUDE.md` only a verbatim copy of that block. Both are idempotent and never prompt. The installer's only network access is `pnpm install --frozen-lockfile`, which fetches the repository's lockfile-pinned npm dependencies from the npm registry (registry.npmjs.org, integrity-checked against `pnpm-lock.yaml`); it fetches no scripts and pipes nothing from the network into a shell. Neither script replaces or removes a launcher or a skill directory it did not write (its launchers carry a marker comment, its skill copy carries `.repo-dir`). An agent runs either only after the user has said yes ([setup.md](skills/verdict/references/setup.md)).

### Hosted, streamable HTTP

```bash
VERDICT_NETWORK=testnet VERDICT_VENUE=at VERDICT_BUILDER_ADDRESS=0x<builder address> verdict-mcp --http 8787
```

Endpoint `http://127.0.0.1:8787/mcp`, health check `GET /healthz`. Add `--host 0.0.0.0` inside a container. The server is stateless: one transport per request, no sessions. Connect a client with `claude mcp add --transport http verdict https://<host>/mcp`, or the equivalent `"url"` entry in a `mcp.json`.

The hosted server holds no keys and signs nothing. It serves the read tools and the unsigned payloads; signing happens on the caller's machine with the caller's key. The process has no TLS and no access control of its own; put a reverse proxy in front of it and do not set `HL_AGENT_PRIVATE_KEY` in its environment.

## Layout

```
packages/core   the tool module: Hyperliquid client, schemas, tools, engine adapter
packages/cli    the verdict CLI, JSON by default and --pretty to indent, no prompts
packages/mcp    the MCP server, stdio and streamable HTTP, thin over core
skills/verdict  SKILL.md, references per command and for setup and signing, install and uninstall scripts
bench           Crypto Skill Bench: how to run it against the skill, the score to beat, dated reports
scripts         bench.sh runs the benchmark; skill-static-check.mjs is its static pre-flight plus safety-rubric text checks
docs            design notes and the builder program
tests           fixtures recorded from testnet and mainnet, tool tests
```

## Toolchain

Node 22, pnpm 10.34.5, strict TypeScript (same flags as the Verdict app), Zod on every input,
output and upstream response, Vitest, Biome lint. `pnpm run check` must be green before any
commit that changes code.
