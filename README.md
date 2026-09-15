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

Public, in development, testnet only. Nothing is published to npm yet; install from a clone as shown below.

## What the tools do

Read tools, no account needed:

- `list_markets`: live Verdict outcome markets for the configured venue, with the settlement rule text taken from the template each market was deployed from.
- `get_market`: one market in full: sides, coins, asset ids, settlement rule, expiry, fee scale.
- `orderbook`: the YES and NO books for a market.
- `quote`: the executable price for a side and a size, walked from the book, with slippage.
- `compare_market`: the best Polymarket and Kalshi comparator for a market, with the price gap when the contracts match (exact twin, ladder interpolation to the Verdict strike, or a Black-Scholes reprice to the Verdict settlement time) and always the engine's resolution-equivalence confidence and reasons. A low-confidence match carries a caveat and no gap. A market with no trades in the last 24h and no real quote on its book (never traded, so Hyperliquid's mark is the 0.5 placeholder; or traded on an earlier day, so the mark is stale) has no Verdict price and no gap, and the Deribit reference and evidence say so instead of printing the 0.5 book average; a Verdict price taken from the Hyperliquid mark is labelled as such; an edge the engine rates low or that flips under a vol stress carries no after-spreads gap.
- `fair_value`: the Deribit option-implied probability for BTC, ETH and SOL price markets, or a typed not-available result with the reason.
- `find_hedges`: Hyperliquid perp and spot hedge candidates for the market underlying, with the hedge direction for YES.
- `opportunities`: the configured venue's live markets ranked by tradeable quality (spread, depth, live odds), with trade call, hedge leg and any cross-venue gap. At most 8 per scan; books are read for the 40 most-traded live markets, the rest price off asset contexts. A market with no Verdict price is carried as `priced: false` with a null probability, the reason, and a `why` that starts with `unpriced`; it ranks after every priced market (the engine is handed every priced market and only as many unpriced ones as its 8 slots leave free, so its own selection can never drop a priced market for an unpriced one), and the engine never sees its book (so nothing averages a wall-only book to 50%). Cross-venue references and the Deribit line are tied to the ranked market by outcome id, not by the engine's title (same-strike dailies share one).
- `positions`: outcome-token balances for an address, read only.
- `recent_trades`: Hyperliquid's most recent prints on one side of a market (YES unless a side is given), newest first, with time, price, size, taker side, hash and trade id. One side is read because the YES and NO coins print the same fills (same hash, p and 1 - p).
- `candles`: OHLCV candles for one side over a lookback in minutes at one of Hyperliquid's intervals (`1m` to `1M`, the exact set the venue accepts), oldest first. A side that has never traded has no candles on Hyperliquid, and the tool says so as `not_found` rather than printing an empty series.
- `fills`: the outcome-market fills of an address, newest first, out of Hyperliquid's most recent 2,000 fills across every coin, with buy or sell, price, size, fee, builder fee when the order carried a builder code, order id, client order id and hash; lifecycle events Hyperliquid books as fills (`Split Outcome`, `Settlement`, ...) keep their word.
- `open_orders`: resting orders of an address on outcome markets, with type, time in force and client order id; falls back to the plain `openOrders` list, and says so, when `frontendOpenOrders` is unavailable.
- `order_status`: one order of an address by order id or client order id, with Hyperliquid's lifecycle status and the order; an unknown id, or an order on a perp or spot coin, is `not_found` with the reason.
- `builder_status`: whether an address has approved Verdict's builder fee, and up to what rate.

The five trade and order tools read Hyperliquid directly in both modes and were shaped against live testnet and mainnet answers on 2026-09-15 (`tests/fixtures`, each fixture dated with its request in `README.json`): candles exist for outcome coins on both networks once the coin has traded (testnet `#104741`, mainnet `#12100`) and a never-traded coin answers `[]`; the accepted intervals are `1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M` (anything else is HTTP 422); a window returns about the most recent 5,000 candles at most; `userFills` holds 2,000 fills across every coin; `orderStatus` takes an integer id or a `0x` + 32 hex client id and answers `unknownOid` for an id the address never had. Addresses are checked before any request and a malformed one is never repeated in the error, since a key pasted where an address belongs looks exactly like one.

Payload tools, signed by the caller, never by the kit:

- `approve_builder_fee_payload`: the typed data for the one-time builder-fee approval. Main wallet signature, not an agent key.
- `build_order`: an unsigned Hyperliquid order action for a Verdict market carrying `builder: {b, f}`, plus the settlement rule and the fee in cents per $1,000, ready for the caller to sign and submit.

## Use it from an agent

Nothing is published to npm yet, so build once from a clone:

```sh
git clone https://github.com/Roni-1997/verdict-skills.git && cd verdict-skills && pnpm install --frozen-lockfile && pnpm run build
```

Replace `<repo>` below with the absolute path of that clone. Every face reads the same variables (see `.env.example`): `VERDICT_NETWORK` (default `testnet`), `VERDICT_VENUE` (`at` on testnet; unset, blank or `all` means every deployer, and a name is 1 to 32 letters, digits, `_` or `-`), `VERDICT_BUILDER_ADDRESS` and `VERDICT_BUILDER_FEE_TENTHS_BP` (default `10`, which is 0.01%, 10 cents per $1,000), and optionally `VERDICT_API_URL` for [hosted mode](#hosted-mode). The builder address is published by the owner; without it the read tools other than `builder_status` work, and `builder_status` and the two payload tools return `not_configured`.

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

Endpoint `http://127.0.0.1:8787/mcp`, health check `GET /healthz` (network, venue, `mode`: `embedded` or `hosted`, and the API base URL in hosted mode). Add `--host 0.0.0.0` inside a container. The server is stateless: one transport per request, no sessions. Connect a client with `claude mcp add --transport http verdict https://<host>/mcp`, or the equivalent `"url"` entry in a `mcp.json`.

The hosted server holds no keys and signs nothing. It serves the read tools and the unsigned payloads; signing happens on the caller's machine with the caller's key. The process has no TLS and no access control of its own; put a reverse proxy in front of it and do not set `HL_AGENT_PRIVATE_KEY` in its environment. Set `VERDICT_API_URL` on it so the read tools the Verdict API serves come from the API and the server runs no venue fetches of its own (next section).

### Hosted mode

The Verdict app serves the cross-venue engine as a public, anonymous, read-only JSON API at `https://hyperverdict.xyz/api/v1` (`GET /markets`, `/market`, `/compare`, `/fair-value`, `/hedges`, `/opportunities`; bodies match the kit's tool results field for field). With `VERDICT_API_URL` set, or `--api <url>` on a CLI command, the kit answers `list_markets`, `get_market`, `compare_market`, `fair_value`, `find_hedges` and `opportunities` from the API instead of running the embedded engine (`packages/core/src/remote.ts`): one GET per call, `net` sent on every request and `venue` on `/markets` and `/opportunities` (the routes whose contract takes it), both from the kit's own configuration (so the API's production defaults of mainnet and every deployer never apply; `all` is the wire spelling of every deployer, and both modes read a blank or `all` venue that way and check a venue name against the API's rule of 1 to 32 letters, digits, `_` or `-` before any request), every body validated with the same Zod result schemas the embedded tools return through, and the API's error slugs mapped back to the kit's errors: `bad_input` and `not_found` as `ToolError`, 429, 5xx, a redirect (never followed), a non-JSON body and a network or timeout failure (30 s per request) as `UpstreamError`. An outcome index over 9 digits is `bad_input` in both modes, the API's rule. A body is then checked against the request: on `/markets` and `/opportunities` the `network` and `venue` fields must be the ones sent, and on `/market`, `/compare`, `/fair-value` and `/hedges` the market's `outcome` must be the one sent and, with `VERDICT_VENUE` set, its `venue` must be that venue (so in hosted mode another deployer's market is read with the venue unset or `all`). The per-outcome bodies carry no network field in the pinned contract, so on those four routes a host that ignores `net` could still answer from the other network; pin `VERDICT_API_URL` to Verdict's own host, `https://hyperverdict.xyz/api/v1`. A body about anything else, or one that breaks what its route documents (a `count` that is not the number of rows, more items than the limit or another `limit` than the one sent, ranks that are not 1 to n in order, an unpriced market before a priced one, a market of another venue in a filtered list), is an `UpstreamError` of kind `schema`, never the kit's result. `orderbook`, `quote`, `positions`, `recent_trades`, `candles`, `fills`, `open_orders`, `order_status`, `builder_status`, `approve_builder_fee_payload` and `build_order` keep running locally in both modes, unchanged.

```bash
VERDICT_NETWORK=testnet VERDICT_VENUE=at VERDICT_API_URL=https://hyperverdict.xyz/api/v1 verdict-mcp --http 8787
VERDICT_API_URL=https://hyperverdict.xyz/api/v1 verdict compare 12891
verdict opportunities --limit 2 --api https://hyperverdict.xyz/api/v1
```

`VERDICT_API_URL` must be an `https://` URL in normal form (lowercase scheme and host, no default port, no `.` or `..` segments) without a trailing slash, query or fragment (`http://` on the loopback interface, `localhost`, `127.0.0.1` or `[::1]`, is accepted for tests); unset or blank, the embedded engine runs, which stays the default. A blank `--api` is refused instead of silently running the engine. The API is rate limited per IP with one budget per route family, not per route: `/markets` and `/market` share one bucket of 60 requests per minute, `/compare`, `/fair-value` and `/hedges` share another 60, and `/opportunities` and `/coverage` (which the kit does not call) each have their own 20; it caches one answer per route, network and venue for 15 to 30 s. The limit is per client IP, so every agent behind one hosted MCP server shares that server's budgets and a cached answer still counts. A malformed `VERDICT_API_URL`, `--api` or `VERDICT_VENUE` is reported by the setting's name and the rule it failed, with the value replaced by `[value hidden]` whatever it was, so a token pasted into the wrong setting does not reach a log. The hosted server holds no keys in either mode; hosted mode removes its venue fetches and its need for the engine's budget, nothing else changes. `ODDPOOL_API_KEY` plays no part in it.

The API's contract is pinned the way the engine is: `packages/core/api-contract/openapi.json` is `docs/api/openapi.json` from `Roni-1997/verdict` byte for byte at the commit recorded in `packages/core/api-contract/UPSTREAM.json` (sha256, git blob sha, size), with a generated `API_CONTRACT` constant in `packages/core/src/api-contract.ts`. `scripts/check-api-contract.mjs` (`pnpm run check:api`, part of `pnpm run check`) recomputes the hashes, checks that the document describes a GET with a 200 JSON body for every route the hosted tools call, and compares the copy with the file GitHub serves at the pinned commit, failing closed like the engine drift check (`CHECK_ENGINE_OFFLINE=1` skips only the gh-unavailable class). To move the pin: `pnpm run sync:api -- --commit <sha>`, then `pnpm run check`. The tests check the contract in both directions: the kit's result schemas accept the production bodies recorded in `tests/fixtures/api-v1` (`tests/fixtures/record_api_v1.mjs`, public data, nothing redacted, dated in its `README.json`), and the embedded tools' results on the engine fixtures validate against the pinned OpenAPI response schemas through a dependency-free JSON Schema subset validator (`tests/_json-schema.ts`, which throws on any keyword it does not implement). `VERDICT_LIVE=1 pnpm vitest run tests/live.test.ts` also runs the hosted tools against production on testnet and checks that the live `/openapi` document equals the pinned one.

## Layout

```
packages/engine the Verdict app's cross-venue engine, byte for byte at a pinned commit (UPSTREAM.json)
packages/core   the tool module: Hyperliquid client, schemas, tools, trade and order data, engine snapshot adapter, venue payload schemas, hosted-mode tools over the API
packages/core/api-contract  the Verdict API's OpenAPI document, byte for byte at a pinned app commit (UPSTREAM.json)
packages/cli    the verdict CLI, JSON by default and --pretty to indent, no prompts
packages/mcp    the MCP server, stdio and streamable HTTP, thin over core
skills/verdict  SKILL.md, references per command and for setup and signing, install and uninstall scripts
bench           Crypto Skill Bench: how to run it against the skill, the score to beat, dated reports
scripts         sync-engine, check-engine-drift and build-engine for the pinned engine; sync-api-contract and check-api-contract for the pinned API contract; bench.sh runs the benchmark and skill-static-check.mjs is its static pre-flight plus safety-rubric text checks
tests           fixtures recorded from testnet, mainnet, the venues and the production API, tool tests, contract tests, skill and bench tests
```

## The engine

`packages/engine/src` holds `research-core.ts`, `playbooks.ts` and `hl-shape.ts` from `Roni-1997/verdict`
byte for byte at the commit recorded in `packages/engine/UPSTREAM.json`. Nothing in them is edited and no
engine code is written in the kit: `scripts/sync-engine.mjs` copies them from the GitHub contents API and
records a sha256 per file, `scripts/check-engine-drift.mjs` (`pnpm run check:engine`, part of
`pnpm run check`) recomputes the hashes and compares every file with the copy GitHub serves at the pinned
commit (`gh api`), failing on any difference; it also fails when a source file under `packages/engine/src`
(other than the kit's `index.ts` and the generated `upstream.ts`) is not recorded in `UPSTREAM.json`, or when the
record does not list exactly the files `sync-engine.mjs` syncs, so the pin record cannot be shrunk to hide a
file. It fails closed: a GitHub comparison that cannot run is a
failure, unless `CHECK_ENGINE_OFFLINE=1` is set, which skips only the "gh not installed, not authenticated or
offline" class and prints the skip; a 404 (wrong commit or path) or a hash mismatch fails whatever the flag
says. The engine compiles under its own tsconfig (DOM lib and bundler resolution, as in the app); the build
script rewrites its one extensionless relative import in the emitted JavaScript so Node can load it. To move
the pin: `pnpm run sync:engine -- --commit <sha>`, then `pnpm run check`.

GOAL.md's success criterion reads "imported from the Verdict app, never copied" and states that a byte-for-byte
copy pinned to a Verdict commit and verified by `check:engine` counts as imported while a hand-edited copy does
not. The drift check is what makes this copy count: the engine is never forked or edited in the kit, and every
engine change is an explicit pin move.

`packages/core/src/snapshot.ts` builds the live-state snapshot the engine reads (outcomes, questions,
books, asset contexts, reference mids) from Hyperliquid info calls, using the app's own shape helpers for
descriptions and books. `InfoClient` retries a request once, after a backoff (the `Retry-After` header when
present, else 1 s), when Hyperliquid answers HTTP 429; its limit is 1,200 request weight per minute per IP.
The snapshot's mid rule is stricter than the app's: a coin with no trades in the last 24h (zero `dayNtlVlm`)
is priced only off a real quote on a book the kit read, never off the asset context's `midPx` (a raw book
average that prints 0.5 over a wall-only book) or a stale `markPx`; otherwise the market is unpriced with the
reason recorded (`never_traded_*` for the 0.5 placeholder mark, `stale_*` for a mark from an earlier day).
The engine's own market probability for the Deribit reference (`optionsImplied.marketProb` and the
"Options-implied reference" evidence line) is replaced by that price in every tool result. For the
`opportunities` scan the engine is handed the snapshot without the books of unpriced markets
(`withoutUnpricedBooks`), since it averages any top of book it is given when the mid is null, and with the
unpriced markets cut to the slots left after the priced ones (`opportunitiesEngineInput`): the engine scores a
bookless market at a flat floor but a thin priced market far outside its 5-95% band lower still, so over the
whole snapshot it would drop the priced market first. The scan's `summary` and "markets scanned" evidence line
carry the kit's count of live markets, not the engine's count of what it was handed.

The engine fetches Polymarket, Kalshi and Deribit itself with the global `fetch` and reads the bodies as
untyped records. Optionally, `ODDPOOL_API_KEY` routes its Polymarket and Kalshi reads through OddPool: the
engine reads the key from the environment at call time and sends it to `api.oddpool.com` on every
`compare_market` and `opportunities` call, so it must never be set on a hosted server; the path is not covered
by the recorded fixtures. The kit runs every engine call under
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
output and upstream response, Vitest, Biome lint. `pnpm run check` (engine drift, API contract, types,
lint, tests) must be green before any commit that changes code. Live checks against Hyperliquid, the
venues and GitHub run with `VERDICT_LIVE=1 pnpm vitest run tests/live.test.ts`.
