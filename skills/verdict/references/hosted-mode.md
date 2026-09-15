# hosted mode

The six read commands the Verdict API serves can be answered by the API instead of the embedded engine. With `VERDICT_API_URL` set (or `--api <url>` on the command), `markets`, `market`, `compare`, `fair-value`, `hedges` and `opportunities` each become one anonymous HTTPS GET to `https://hyperverdict.xyz/api/v1`; the output shape, the exit codes and the rules for presenting a comparison do not change, and `<outcome>`, `--venue` and `--limit` are read by the same rules in both modes (below). Everything else runs locally as before.

Read only. No account, no key, no confirmation. Nothing about the two-message rule changes: `approve-builder-fee-payload` and `build-order` run locally in both modes and return unsigned payloads.

## When to use which

| Situation | Mode | Why |
|---|---|---|
| Your own machine, one user, occasional commands | embedded (default, `VERDICT_API_URL` unset) | No dependency on the API; the engine reads Hyperliquid, Polymarket, Kalshi and Deribit itself. |
| A hosted MCP server (`verdict-mcp --http`) | hosted | The server runs no venue fetches of its own; every `compare` or `opportunities` is one GET. The API caches one answer per route, network and venue for 15 to 30 s, so a burst of agents costs one engine run; every agent on the server still shares the server's one per-IP request budget (Rate limits, below). |
| No network path to hyperverdict.xyz, or the API is down | embedded | There is no fallback inside the kit: unset the variable and the engine runs in process. |

## Configuration

| Setting | Value | Meaning |
|---|---|---|
| `VERDICT_API_URL` | unset | Embedded engine, the default. |
| `VERDICT_API_URL` | `https://hyperverdict.xyz/api/v1` | Hosted mode against production. https only, written in normal form (lowercase scheme and host, no default port, no `.` or `..` segments); no trailing slash, query or fragment. `http://` on the loopback interface (`localhost`, `127.0.0.1`, `[::1]`) is accepted for tests only. A malformed value is exit 4 `not_configured`; the message names the variable and the rule it failed and shows the value as `[value hidden]`, never any part of it, so a token pasted into the variable does not reach a log. The kit follows no redirect from that host. |
| `--api <url>` | same rules | CLI flag, one command; overrides the variable. A malformed value is exit 1 `bad_input`, and so is a blank one (a flag without a URL is most often an unset shell variable): to run one command on the embedded engine, run it with `VERDICT_API_URL` unset or blank instead. |

The kit puts `net` (from `VERDICT_NETWORK`) on every request and `venue` (from `VERDICT_VENUE`, `all` when unset) on `markets` and `opportunities`, the two routes whose contract takes it, so the API's own defaults (mainnet, every deployer) never apply. A `markets` or `opportunities` body must then carry the `network` and `venue` that were sent, and a `market`, `compare`, `fair-value` or `hedges` body must be about the `<outcome>` sent and, with `VERDICT_VENUE` set, about a market of that venue (to read another deployer's market in hosted mode, leave the venue unset or `all`); otherwise the command exits 3 with `"kind":"schema"`. The per-outcome bodies carry no network field in the pinned contract, so on those four routes a host that ignores `net` (a proxy that drops the query string, a copy of the app with other defaults) could still answer from the other network when the venue matches; pin `VERDICT_API_URL` to Verdict's own host, `https://hyperverdict.xyz/api/v1`. Testnet stays the default. The API holds no keys, takes no credentials, and the kit sends none: no header, no token, no account.

Venue, read the same way in both modes: `VERDICT_VENUE` or `--venue` unset, blank or `all` (any case) means every deployer, and `markets` and `opportunities` then report `venue: null`; a name is 1 to 32 letters, digits, `_` or `-` (the API's rule), checked before any request. A name outside the rule is exit 1 `bad_input` from `--venue` and exit 4 `not_configured` from `VERDICT_VENUE`, in embedded mode too, so the engine never answers what the API would refuse.

## What is served remotely

| Command | Hosted mode | Embedded mode |
|---|---|---|
| `markets [--venue] [--include-expired]` | `GET /markets?net=&venue=&includeExpired=` | Hyperliquid info in process |
| `market <outcome>` | `GET /market?net=&outcome=` | Hyperliquid info in process |
| `compare <outcome>` | `GET /compare?net=&outcome=` | the engine in process (Hyperliquid, Polymarket, Kalshi, Deribit) |
| `fair-value <outcome>` | `GET /fair-value?net=&outcome=` | the engine in process |
| `hedges <outcome>` | `GET /hedges?net=&outcome=` | the engine in process |
| `opportunities [--limit <1..8>]` | `GET /opportunities?net=&venue=&limit=` | the engine in process |
| `book`, `quote`, `recent-trades`, `candles`, `positions`, `fills`, `open-orders`, `order-status`, `builder-status` | local: Hyperliquid info, unchanged | the same |
| `approve-builder-fee-payload`, `build-order` | local: the unsigned payload is built in process, unchanged | the same |

Every body is validated against the same result schemas the embedded commands return through. A body that does not match is exit 3 with `"kind":"schema"`, never shown as data; so is a body that breaks what its route documents: `markets` with a `count` that is not the number of markets or a market of another venue in a filtered list, `opportunities` with more items than `--limit` or a `limit` other than the one sent, a `count` or `unpricedCount` that does not match its items, ranks that are not 1 to n in order, or an unpriced market before a priced one. `<outcome>`, `--venue` and `--limit` are checked before any request, with the same messages as in embedded mode: `<outcome>` is a nonnegative integer of at most 9 digits (the API's rule; a longer index can name no market and is exit 1 `bad_input` in both modes, never exit 2), `--limit` is 1 to 8.

## Rate limits and timing

| Commands | Budget per IP, per minute | Cold answer | Cached answer |
|---|---|---|---|
| `markets`, `market` | 60, one bucket shared by both commands | about 1 s | under 1 s |
| `compare`, `fair-value`, `hedges` | 60, one bucket shared by the three | 2 to 4 s | under 1 s |
| `opportunities` | 20, its own bucket | about 4 s | under 1 s |

Budgets are per route family, not per command: forty `markets` calls and twenty-one `market` calls in one minute put both on 429, and so do sixty-one calls spread over `compare`, `fair-value` and `hedges`. The API's `/coverage` route, which the kit does not call, has its own 20 per minute bucket. Cold times are the app's own measurements of 2026-09-14 against live Hyperliquid testnet. The limit is per client IP as the API sees it: every agent behind one hosted MCP server draws on that server's budgets, and a request the API answers from its own cache still counts (only a CDN hit for the same URL inside its cache window does not), so twenty-one `opportunities` calls in one minute from all agents on one server put every one of them on 429 until the minute turns. Size the server, or put a caching proxy in front of it, for the agents it serves. Over budget the API answers 429 and the command exits 3 with `{"error":"upstream","kind":"http","message":"api opportunities rate limited (HTTP 429); retry after N s"}`: wait N seconds and retry once, as the anti-loop rules say. N is read from the API's `Retry-After` header, whether it is a number of seconds or an HTTP date (turned into seconds from now, at least 1); without a readable header the message ends at `(HTTP 429)`, so wait a few seconds. Each request has a 30 s budget; past it the command exits 3 with `"kind":"network"`. A Polymarket, Kalshi or Deribit failure is not an error exit in either mode: the body reports a `dataStatus` other than `ok` for that venue. The engine emits four values: `ok`, `partial`, `unavailable`, and `skipped` when it did not query the venue for that market.

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":...}` | Bad `<outcome>` (not a nonnegative integer, or over 9 digits), `--venue` (outside 1 to 32 letters, digits, `_` or `-`), `--limit` or `--api` value, all checked before any request, or the API refused a parameter (its message is passed through). | Fix the argument. |
| 2 | `{"error":"not_found","message":"no outcome market with index N on <network>"}` | The API knows no market with that index on that network. | Do not retry. Run `verdict markets` and pick from it; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream","kind":"http","message":...}` | 429 (rate limited; the message names the wait), a 5xx from the API, a 404 that is not the API's own body (a wrong base URL; the message names it), or a redirect (never followed; the message names the target host: set the URL to the final address). | Retry once after a few seconds (after N s on a 429; not at all on a redirect), then stop and report the JSON. |
| 3 | `{"error":"upstream","kind":"schema","message":...}` | The API answered with a body that is not JSON, does not match the result schema, is about another network, venue or outcome than the one requested, breaks what its route documents (counts, ranks, the limit, priced before unpriced, one venue in a filtered list), or is over 16 MiB. With `VERDICT_VENUE` set, a `market`, `compare`, `fair-value` or `hedges` body about another deployer's market is refused the same way. | Retry once, then report the JSON; if it repeats, check `VERDICT_API_URL` (the message names it), or unset `VERDICT_VENUE` to read another deployer's market. |
| 3 | `{"error":"upstream","kind":"network","message":...}` | Connection failure, or the 30 s budget ran out. | Retry once, then report the JSON. |
| 4 | `{"error":"not_configured","message":"VERDICT_API_URL must be ..."}` or `"VERDICT_VENUE venue must be ..."` | Malformed `VERDICT_API_URL` or `VERDICT_VENUE`. | Do not retry. Tell the user how the value must look. |

## Notes

- The hosted MCP server holds no keys and signs nothing in either mode. Hosted mode removes its venue fetches; it never had a key to remove.
- `ODDPOOL_API_KEY` plays no part in hosted mode: the API reads Polymarket and Kalshi itself and does not read OddPool.
- The API's contract (its OpenAPI document) is pinned in the repository under `packages/core/api-contract` at the app commit it was recorded from, and `pnpm run check` fails when the copy drifts from the app repository. `engine.commit` in every cross-venue body is the app commit that served it.
- A testnet `compare` is still a comparison of a testnet market with the real Polymarket and Kalshi. State the network.
