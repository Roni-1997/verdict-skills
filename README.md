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
- `compare_market`: the best Polymarket and Kalshi comparator for a market, with the price gap when the contracts match (exact twin, ladder interpolation to the Verdict strike, or a Black-Scholes reprice to the Verdict settlement time) and always the engine's resolution-equivalence confidence and reasons. A low-confidence match carries a caveat and no gap. A market with no trades in the last 24h and no real quote on its book (never traded, so Hyperliquid's mark is the 0.5 placeholder; or traded on an earlier day, so the mark is stale) has no Verdict price and no gap, and the Deribit reference and evidence say so instead of printing the 0.5 book average; a Verdict price taken from the Hyperliquid mark is labelled as such; an edge the engine rates low or that flips under a vol stress carries no after-spreads gap.
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
packages/engine the Verdict app's cross-venue engine, byte for byte at a pinned commit (UPSTREAM.json)
packages/core   the tool module: Hyperliquid client, schemas, tools, engine snapshot adapter, venue payload schemas
packages/cli    the verdict CLI, --json on every command, non-interactive flags
packages/mcp    the MCP server, stdio and streamable HTTP, thin over core
skills/verdict  SKILL.md, references per command, installer script
docs            design notes and the builder program
scripts         sync-engine, check-engine-drift, build-engine
tests           fixtures recorded from testnet, mainnet and the venues, tool tests
```

## The engine

`packages/engine/src` holds `research-core.ts`, `playbooks.ts` and `hl-shape.ts` from `Roni-1997/verdict`
byte for byte at the commit recorded in `packages/engine/UPSTREAM.json`. Nothing in them is edited and no
engine code is written in the kit: `scripts/sync-engine.mjs` copies them from the GitHub contents API and
records a sha256 per file, `scripts/check-engine-drift.mjs` (`pnpm run check:engine`, part of
`pnpm run check`) recomputes the hashes and, when the network is available, compares them with GitHub at
the pinned commit, and fails on any difference. The engine compiles under its own tsconfig (DOM lib and
bundler resolution, as in the app); the build script rewrites its one extensionless relative import in the
emitted JavaScript so Node can load it. To move the pin: `pnpm run sync:engine -- --commit <sha>`, then
`pnpm run check`.

This pinned-copy-with-drift-check model is the recorded decision (GOAL.md, Decisions, 2026-09-13) in place
of a git submodule or a workspace package pointing at the app: the app is not a library, a submodule would
tie every install of the kit to the app repository, and a published CLI bundles the engine anyway. What
matters, that the engine is never forked and every change is an explicit pin move, is what the drift check
enforces.

`packages/core/src/snapshot.ts` builds the live-state snapshot the engine reads (outcomes, questions,
books, asset contexts, reference mids) from Hyperliquid info calls, using the app's own shape helpers for
descriptions and books. Its mid rule is stricter than the app's: a coin with no trades in the last 24h
(zero `dayNtlVlm`) is priced only off a real quote on a book the kit read, never off the asset context's
`midPx` (a raw book average that prints 0.5 over a wall-only book) or a stale `markPx`; otherwise the market
is unpriced with the reason recorded (`never_traded_*` for the 0.5 placeholder mark, `stale_*` for a mark
from an earlier day). The engine's own market probability for the Deribit reference (`optionsImplied.marketProb`
and the "Options-implied reference" evidence line) is replaced by that price in every tool result.

The engine fetches Polymarket, Kalshi and Deribit itself with the global `fetch` (set `ODDPOOL_API_KEY` to
route through OddPool instead) and reads the bodies as untyped records. The kit runs every engine call under
a validating fetch (`packages/core/src/venues.ts`, `withValidatedVenueFetch`): for `gamma-api.polymarket.com`,
`external-api.kalshi.com`, `www.deribit.com` and `api.oddpool.com` the body is Zod-parsed leniently (every
field the engine reads is typed, unknown fields pass through) before the engine sees it, and a body that does
not match is rejected as an `UpstreamError` of kind `schema`; the engine then reports that venue as
unavailable or partial rather than pricing off it. The wrapper is installed on the global for the duration of
the call only (reference counted across concurrent calls) and restored afterwards. Hyperliquid responses are
validated by `InfoClient` and pass through untouched. Tests replay recorded venue payloads from
`tests/fixtures/engine` with the clock frozen at the recording time (`tests/fixtures/record_engine.py`).

## Toolchain

Node 22, pnpm 10.34.5, strict TypeScript (same flags as the Verdict app), Zod on every input,
output and upstream response, Vitest, Biome lint. `pnpm run check` (engine drift, types, lint,
tests) must be green before any commit that changes code. Live checks against Hyperliquid, the
venues and GitHub run with `VERDICT_LIVE=1 pnpm vitest run tests/live.test.ts`.
