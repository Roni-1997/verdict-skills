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
bash verdict-skills/skills/verdict/scripts/install.sh --claude-md
```

What the script does, in order: `pnpm install`, `pnpm run build`, writes `verdict` and `verdict-mcp` launchers into `~/.local/bin` (override with `VERDICT_BIN_DIR`), copies `skills/verdict` to `~/.claude/skills/verdict` and saves the clone path in that copy as `.repo-dir`, and, only with `--claude-md`, appends the `## Verdict` routing block below to `~/.claude/CLAUDE.md` after printing it, only if no line is exactly `## Verdict`. Without the flag it leaves `CLAUDE.md` alone. Running it again is safe; `--skip-skill` skips the copy. The script never prompts and never touches keys. Its only network access is `pnpm install --frozen-lockfile`, which fetches the repository's lockfile-pinned npm dependencies from the npm registry (registry.npmjs.org, integrity-checked against `pnpm-lock.yaml`; pnpm 10 runs no dependency install scripts except esbuild, per `pnpm-workspace.yaml`). It fetches no scripts and pipes nothing from the network into a shell. It refuses to replace a launcher or a skill directory it did not write: its launchers carry a marker comment and its skill copy carries `.repo-dir`; anything else at those paths stays and the script exits 1 without changing anything.

From the installed copy (`~/.claude/skills/verdict/scripts/install.sh`) the script finds the clone through `.repo-dir`; if the clone has moved, set `VERDICT_REPO_DIR=<clone>`. `scripts/uninstall.sh` reverses all of it: it removes the launchers that carry its marker comment, the skill copy only when it carries `.repo-dir`, and from `CLAUDE.md` exactly the block below, line for line. Any other text stays, including other headings that start with `## Verdict` and anything added after the block. A launcher without the marker, a skill directory without `.repo-dir`, or a `## Verdict` section that is not the block was not written by `install.sh`: each is left in place and reported with exit 1. One exception to the byte-for-byte restore: when `CLAUDE.md` had no final newline, `install.sh` added one before the block and `uninstall.sh` leaves it.

### Ask before installing

Both scripts write outside the repository. When you are an agent: before running `install.sh`, or editing `~/.claude/CLAUDE.md` by hand, show the user what will be written (the two launcher paths, the skill copy path, that `pnpm install` fetches the lockfile-pinned npm dependencies from the npm registry, and the routing block below when `--claude-md` is in play) and ask. Wait for a yes in a new message. No reply, no, or anything unclear: run nothing. A yes for the CLI alone: run without `--claude-md`.

## Environment

The CLI and the MCP server read these from the process environment. They do not load `.env` files; export the variables in the shell, or put them in the agent's MCP config.

| Variable | Default | Meaning |
|---|---|---|
| `VERDICT_NETWORK` | `testnet` | `testnet` or `mainnet`. Testnet until the owner flips it for a release. |
| `VERDICT_VENUE` | none (all deployers) | Verdict's deployer venue. `at` on testnet. |
| `VERDICT_BUILDER_ADDRESS` | unset | Verdict's builder address, published by the owner. Without it the read commands still work; `builder-status`, `approve-builder-fee-payload` and `build-order` exit 4. |
| `VERDICT_BUILDER_FEE_TENTHS_BP` | `10` | Fee in tenths of a basis point. 10 is 0.01%, 10 cents per $1,000. |
| `HL_AGENT_PRIVATE_KEY` | unset | Optional, only for the caller's own local signing step. The kit never reads it. Export `HL_AGENT_PRIVATE_KEY` only in the shell that runs the signing step, a shell no agent drives: never in the environment of an agent, its exec tool or an MCP server (every command they run inherits it), never on a hosted server, and never written to a file. |

`.env.example` in the repository lists the same variables with the testnet defaults.

## Verify

```bash
verdict --help
verdict markets --venue at --pretty
```

Expect exit 0 and a JSON document with `"network": "testnet"`. Pick an `outcome` from it and run `verdict market <outcome> --pretty`; the `settlementRule` field is the text the market pays on.

## Claude Code routing block

If the skill is active and `~/.claude/CLAUDE.md` has no line that is exactly `## Verdict`, show the user the block below and ask whether to add it. Only after a yes in a new message: run `install.sh --claude-md`, or append the block by hand, unchanged (it is the same text `install.sh` writes, and `uninstall.sh` removes only a verbatim copy). Otherwise leave the file alone.

```markdown
## Verdict

Verdict's HIP-4 outcome markets on Hyperliquid are available through the `verdict` skill (~/.claude/skills/verdict).

### Routing

Load the verdict skill, not web search or memory, when the request involves:

- Verdict, hyperverdict, the Verdict venue or its markets
- HIP-4, outcome market, Hyperliquid prediction market, YES or NO on Hyperliquid
- a settlement rule, order book, quote for a size, or positions on such a market
- "compare to Polymarket" or "compare to Kalshi" for a market that exists on Verdict
- Verdict's builder code, builder fee or builder approval

Do not load it for general blockchain education, Hyperliquid perps or spot, or trading on Polymarket, Kalshi or Deribit themselves.

### Rules the skill enforces

- Read commands (markets, market, book, quote, compare, fair-value, hedges, opportunities, positions, builder-status) run without asking and need no account. A Polymarket or Kalshi comparison is shown with its confidence and reasons, never as a bare number.
- build-order and approve-builder-fee-payload return unsigned payloads. Show the market, the settlement rule text, side, price, size, the fee in cents per $1,000 and the builder address, end the message, and wait for a real reply in a new message before anything is signed. Never fabricate a confirmation.
- Analysis and order building never happen in the same turn.
- Nothing signs on a hosted server; keys stay local and in memory.
```

## Other agents

Codex, OpenClaw, Hermes and any agent that reads `SKILL.md`: copy `skills/verdict` into the agent's skills directory, put the routing block above into its workspace instructions file, and make sure `verdict` is on PATH (the launcher from `install.sh`, or `node <repo>/packages/cli/dist/bin.js`).

## MCP instead of the CLI

The same eight tools are served by `verdict-mcp` over stdio and streamable HTTP. Configurations for Claude Desktop, Cursor, Claude Code and a hosted server are in the repository README under "Use it from an agent".
