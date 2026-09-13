# setup

First activation. There is nothing to log into; read commands need no account and no key.

## Prerequisites

| Requirement | Note |
|---|---|
| Node 22 | `.nvmrc` in the repository. A newer Node prints an engine warning and works. |
| pnpm 10.34.5 | `corepack enable` or `npm install -g pnpm@10.34.5`. |
| The repository | `Roni-1997/verdict-skills` is private; the user needs access. Nothing is published to npm yet. |

## Install

```bash
git clone git@github.com:Roni-1997/verdict-skills.git
bash verdict-skills/skills/verdict/scripts/install.sh
```

What the script does, in order: `pnpm install`, `pnpm run build`, writes `verdict` and `verdict-mcp` launchers into `~/.local/bin` (override with `VERDICT_BIN_DIR`), copies `skills/verdict` to `~/.claude/skills/verdict`, and appends a `## Verdict` routing block to `~/.claude/CLAUDE.md` after printing it, only if no such section exists. Running it again is safe. `--skip-claude-md` leaves CLAUDE.md alone; `--skip-skill` skips the copy. `scripts/uninstall.sh` reverses all of it. The script downloads nothing from third parties and never touches keys.

## Environment

The CLI and the MCP server read these from the process environment. They do not load `.env` files; export the variables in the shell, or put them in the agent's MCP config.

| Variable | Default | Meaning |
|---|---|---|
| `VERDICT_NETWORK` | `testnet` | `testnet` or `mainnet`. Testnet until the owner flips it for a release. |
| `VERDICT_VENUE` | none (all deployers) | Verdict's deployer venue. `at` on testnet. |
| `VERDICT_BUILDER_ADDRESS` | unset | Verdict's builder address, published by the owner. Without it the read commands still work; `builder-status`, `approve-builder-fee-payload` and `build-order` exit 4. |
| `VERDICT_BUILDER_FEE_TENTHS_BP` | `10` | Fee in tenths of a basis point. 10 is 0.01%, 10 cents per $1,000. |
| `HL_AGENT_PRIVATE_KEY` | unset | Optional, only for the caller's own local signing step. The kit never reads it. Never on a hosted server. |

`.env.example` in the repository lists the same variables with the testnet defaults.

## Verify

```bash
verdict --help
verdict markets --venue at --pretty
```

Expect exit 0 and a JSON document with `"network": "testnet"`. Pick an `outcome` from it and run `verdict market <outcome> --pretty`; the `settlementRule` field is the text the market pays on.

## Claude Code routing block

If the skill is active and `~/.claude/CLAUDE.md` has no `## Verdict` section, tell the user what you are about to add, then append the block below (this is the same text `install.sh` writes):

```markdown
## Verdict

Verdict's HIP-4 outcome markets on Hyperliquid are available through the `verdict` skill (~/.claude/skills/verdict).

### Routing

Load the verdict skill, not web search or memory, when the request involves:

- Verdict, hyperverdict, the Verdict venue or its markets
- HIP-4, outcome market, Hyperliquid prediction market, YES or NO on Hyperliquid
- a settlement rule, order book, quote for a size, or positions on such a market
- "compare to Polymarket" or "compare to Kalshi" for a market that exists on Verdict
- builder code, builder fee or builder approval on Hyperliquid

Do not load it for general blockchain education, Hyperliquid perps or spot, or trading on Polymarket, Kalshi or Deribit themselves.

### Rules the skill enforces

- Read commands (markets, market, book, quote, positions, builder-status) run without asking and need no account.
- build-order and approve-builder-fee-payload return unsigned payloads. Show the market, the settlement rule text, side, price, size, the fee in cents per $1,000 and the builder address, end the message, and wait for a real reply in a new message before anything is signed. Never fabricate a confirmation.
- Analysis and order building never happen in the same turn.
- Nothing signs on a hosted server; keys stay local and in memory.
```

## Other agents

Codex, OpenClaw, Hermes and any agent that reads `SKILL.md`: copy `skills/verdict` into the agent's skills directory, put the routing block above into its workspace instructions file, and make sure `verdict` is on PATH (the launcher from `install.sh`, or `node <repo>/packages/cli/dist/bin.js`).

## MCP instead of the CLI

The same eight tools are served by `verdict-mcp` over stdio and streamable HTTP. Configurations for Claude Desktop, Cursor, Claude Code and a hosted server are in the repository README under "Use it from an agent".
