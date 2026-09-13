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
- `compare_market`: the best Polymarket and Kalshi comparator for a market, with the price gap when the contracts match (exact twin, ladder interpolation to the Verdict strike, or a Black-Scholes reprice to the Verdict settlement time) and always the engine's resolution-equivalence confidence and reasons. A low-confidence match carries a caveat and no gap. A never-traded market (Hyperliquid's 0.5 placeholder mark over a wall-only book) has no Verdict price and no gap; a Verdict price taken from the Hyperliquid mark is labelled as such; an edge the engine rates low or that flips under a vol stress carries no after-spreads gap.
- `fair_value`: the Deribit option-implied probability for BTC, ETH and SOL price markets, or a typed not-available result with the reason.
- `find_hedges`: Hyperliquid perp and spot hedge candidates for the market underlying, with the hedge direction for YES.
- `opportunities`: the configured venue's live markets ranked by tradeable quality (spread, depth, live odds), with trade call, hedge leg and any cross-venue gap. At most 8 per scan; books are read for the 40 most-traded live markets, the rest price off asset contexts.
- `positions`: outcome-token balances for an address, read only.
- `builder_status`: whether an address has approved Verdict's builder fee, and up to what rate.

Payload tools, signed by the caller, never by the kit:

- `approve_builder_fee_payload`: the typed data for the one-time builder-fee approval. Main wallet signature, not an agent key.
- `build_order`: an unsigned Hyperliquid order action for a Verdict market carrying `builder: {b, f}`, plus the settlement rule and the fee in cents per $1,000, ready for the caller to sign and submit.

## Layout

```
packages/engine a verified copy of the Verdict app's cross-venue engine at a pinned commit (UPSTREAM.json)
packages/core   the tool module: Hyperliquid client, schemas, tools, engine snapshot adapter
packages/cli    the verdict CLI, --json on every command, non-interactive flags
packages/mcp    the MCP server, stdio and streamable HTTP, thin over core
skills/verdict  SKILL.md, references per command, installer script
docs            design notes and the builder program
scripts         sync-engine, check-engine-drift, build-engine
tests           fixtures recorded from testnet, mainnet and the venues, tool tests
```

## The engine

`packages/engine/src` is a verified copy, not an import: it holds `research-core.ts`, `playbooks.ts` and
`hl-shape.ts` from `Roni-1997/verdict` exactly as they are at the commit recorded in
`packages/engine/UPSTREAM.json`. Nothing in them is edited: `scripts/sync-engine.mjs` copies them from the
GitHub contents API and records a sha256 per file, `scripts/check-engine-drift.mjs` (`pnpm run check:engine`,
part of `pnpm run check`) recomputes the hashes and, when the network is available, compares them with
GitHub at the pinned commit. The
engine compiles under its own tsconfig (DOM lib and bundler resolution, as in the app); the build
script rewrites its one extensionless relative import in the emitted JavaScript so Node can load it.
To move the pin: `pnpm run sync:engine -- --commit <sha>`, then `pnpm run check`.

Owner decision pending. GOAL.md's success criterion reads "The engine is imported from the Verdict app,
never copied; its tests keep passing there." A hash-pinned copy with a drift check is a deviation from
that wording: it keeps the kit building without the app's DOM-flavoured toolchain and makes every engine
change an explicit pin move, but it is a copy. The options are (a) amend GOAL.md to bless the
pinned-copy-with-drift-check model, or (b) consume the engine as a git submodule or a workspace package
pointing at `Roni-1997/verdict`, which ties the kit's build to the app's layout. Until the owner chooses,
this section and `packages/engine/package.json` describe the engine as a verified copy.

`packages/core/src/snapshot.ts` builds the live-state snapshot the engine reads (outcomes, questions,
books, asset contexts, reference mids) from Hyperliquid info calls, using the app's own shape helpers,
so probabilities resolve the way they do on hyperverdict.xyz. The engine fetches Polymarket, Kalshi
and Deribit itself with the global `fetch`; set `ODDPOOL_API_KEY` to route through OddPool instead.
Tests replay recorded venue payloads from `tests/fixtures/engine` with the clock frozen at the
recording time (`tests/fixtures/record_engine.py`).

## Toolchain

Node 22, pnpm 10.34.5, strict TypeScript (same flags as the Verdict app), Zod on every input,
output and upstream response, Vitest, Biome lint. `pnpm run check` (engine drift, types, lint,
tests) must be green before any commit that changes code. Live checks against Hyperliquid, the
venues and GitHub run with `VERDICT_LIVE=1 pnpm vitest run tests/live.test.ts`.
