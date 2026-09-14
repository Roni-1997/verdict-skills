# opportunities

The configured venue's live markets ranked by tradeable quality (tight spread, real depth, live probability band; not raw volume), with the engine's trade call, a hedge leg and any cross-venue gap against a Polymarket or Kalshi twin. At most 8 per scan.

Read only. No account, no key, no confirmation. A ranked market is a candidate for the user's judgement, not an order. Polymarket and Kalshi are read, never traded.

| Intent | CLI | MCP tool |
|---|---|---|
| "what looks tradeable on Verdict right now", "scan for opportunities", "which markets have real depth", "any cross-venue gaps today" | `verdict opportunities [--limit <1..8>]` | `opportunities { "limit": 8 }` |

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--limit <1..8>` | `8` | How many ranked markets to return. The engine ranks at most 8 per scan; anything outside 1..8 is a usage error. |
| `--pretty` | off | Indent the JSON. |

The venue comes from `VERDICT_VENUE` (`at` on testnet); unset, blank or `all`, every deployer's live markets are scanned and the output reports `venue: null`. `ODDPOOL_API_KEY` is optional: it routes the engine's Polymarket and Kalshi reads through api.oddpool.com and is sent there on every call, so it is never set on a hosted server.

Books are read for the 40 most-traded live markets (80 book requests); the rest price off Hyperliquid asset contexts. The engine ranks at most 8 markets; it is handed every priced market and only as many unpriced ones as those 8 slots leave free, so an unpriced market never displaces a priced one. With the engine's 20 s venue budget a scan can take about 30 seconds. It is fetching, not waiting for input.

## Output

Recorded on 2026-09-13 by running the CLI against the recorded fixtures (`tests/fixtures/engine`: the Hyperliquid mainnet catalog and books plus the Polymarket and Kalshi payloads recorded at 2026-09-13T21:31:31Z) with an injected fetch and the clock frozen at the recording time, the catalog restricted to the 12 recorded `out`-venue markets (11 scanned: the fallback outcome of the Premier League question is dropped). `verdict opportunities --limit 3`, mainnet, venue `out`. Trimmed to the first two items. Values are as recorded on 2026-09-13 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "network": "mainnet",
  "venue": "out",
  "scanned": 11,
  "booksFetched": 11,
  "count": 3,
  "limit": 3,
  "engineMax": 8,
  "items": [
    {
      "rank": 1,
      "outcome": 1216,
      "venue": "out",
      "displayName": "BTC touches 65000 by 20261001-0000",
      "expiresAt": "2026-10-01T00:00:00.000Z",
      "priced": true,
      "yesMid": 0.088705,
      "spread": 0.000009999999999996123,
      "depthUsd": 56.0584,
      "volumeUsd": 13661,
      "priceSource": "book",
      "unpriced": null,
      "why": "0.0% spread, $56 depth, YES 8.9%",
      "tradeCall": { "label": "Small YES only", "reason": "Visible depth is thin at $56." },
      "actionState": "ticket",
      "crossVenue": null,
      "hedge": null
    },
    {
      "rank": 2,
      "outcome": 1473,
      "venue": "out",
      "displayName": "Arsenal",
      "expiresAt": null,
      "priced": true,
      "yesMid": 0.571325,
      "spread": 0.0001100000000000545,
      "depthUsd": 48.55795,
      "volumeUsd": 59492,
      "priceSource": "book",
      "unpriced": null,
      "why": "0.0% spread, $49 depth, YES 57.1%",
      "tradeCall": { "label": "Watch only", "reason": "Visible depth is just $49 — too thin to trade." },
      "actionState": "research",
      "crossVenue": null,
      "hedge": null
    }
  ],
  "unpricedCount": 0,
  "comparators": [],
  "dataStatus": { "polymarket": "ok", "kalshi": "ok" },
  "bookErrors": [],
  "summary": "Scanned 11 live Verdict markets and ranked the 8 most tradeable by spread, depth, and live odds.",
  "evidence": [
    "Verdict/HL markets scanned: 11",
    "Route: opportunity_scan",
    "Ranked by tradeable quality (tight spread + depth + live prob-band), not raw volume.",
    "Trade ticket handoff available for the surfaced markets."
  ],
  "engine": { "repo": "Roni-1997/verdict", "commit": "79f3ed255dbd9a628b01d9a38eb149f2116cbffb", "route": "opportunity_scan", "generatedAt": "2026-09-13T21:31:31.000Z" }
}
```

An item for a market Verdict has not priced, from the same run over the `skew` venue (five markets, three of them never traded), ranked last:

```json
{
  "rank": 5,
  "outcome": 2899,
  "venue": "skew",
  "displayName": "BTC above 77250 at 20260918-0600?",
  "expiresAt": "2026-09-18T06:00:00.000Z",
  "priced": false,
  "yesMid": null,
  "spread": null,
  "depthUsd": null,
  "volumeUsd": 0,
  "priceSource": null,
  "unpriced": "never_traded_wall_book",
  "why": "unpriced (never traded, wall-only book); no Verdict price, spread or depth to rank on",
  "tradeCall": { "label": "Watch only", "reason": "No live executable price." },
  "actionState": "research",
  "crossVenue": null,
  "hedge": { "symbol": "BTC", "kind": "perp", "directionForYes": "short" }
}
```

That scan's `summary` ends "3 of the 5 shown have no Verdict price (unpriced) and rank last.", its `unpricedCount` is 3, and its `comparators` hold ten Kalshi references tied to outcome 2899, each with `"gap": null` and the tag `verdict_unpriced_never_traded_wall_book`.

| Field | Meaning |
|---|---|
| `scanned`, `booksFetched` | Live markets considered, and how many had both books read (the most traded by 24h notional); the others price off the Hyperliquid mark, labelled `priceSource: "ctx"` and "Verdict price is the HL mark; no two-sided book" in `why`. |
| `items[]` | The ranked markets, priced ones first in the engine's order, then unpriced ones; every priced market the scan found comes before any unpriced one, up to the engine's 8. `count` of them, at most `limit`. |
| `priced`, `yesMid`, `unpriced` | `priced: true` with the YES probability from the kit's snapshot; or `priced: false`, `yesMid: null` and the reason (`never_traded_wall_book`, `never_traded_no_book`, `stale_wall_book`, `stale_no_book`, `no_price_data`). Hyperliquid's 0.5 placeholder and a wall-only book's average are never printed as a price. |
| `spread`, `depthUsd`, `volumeUsd` | Top-of-book YES spread (as a probability) and depth in USD; null when unpriced. 24h notional volume. |
| `why` | The kit's ranking reason from its own price, spread and depth. Starts with `unpriced` for an unpriced market. |
| `tradeCall` | The engine's call (`Small YES only`, `Watch only`, `Watch YES`, ...) with its reason. A call is not an instruction: it is the engine's read on depth and price quality. |
| `actionState` | `ticket` when the engine considers the market executable at visible depth, `research` otherwise. |
| `crossVenue` | The engine's cross-venue edge line, only for a priced market with a high-confidence tradable twin; otherwise null. |
| `hedge` | The engine's hedge leg for holding YES (`hedges.md`), or null when none is mapped. |
| `comparators[]` | Every Polymarket or Kalshi reference the engine found across the scan, in the `compare` comparator shape (`compare.md`), each tied to the ranked outcome it was matched to. Low-confidence and unpriced comparators carry a `caveat` and a `gap` of null. |
| `bookErrors[]` | Books that could not be read (coin and message); those markets price off the mark or are unpriced. |
| `dataStatus` | Per venue: `ok`, `partial`, `unavailable`, or `skipped` when the engine did not query it. |
| `summary`, `evidence` | The sentence to show the user, and the engine's notes including the Deribit reference line when a BTC, ETH or SOL strike market was ranked. |

## Presenting a scan

- Show `summary`, then the items with `displayName`, `outcome`, `why`, `tradeCall.label` and `tradeCall.reason`, and the network. Say when an item is unpriced and why; do not fill in a probability for it.
- A `crossVenue` line or a `comparators[]` entry is presented with its `confidence` and `reasons`, as `compare.md` says. A low-confidence match is presented with its confidence and reasons and never as a bare number, and a null `gap` is reported as no comparable gap, with the `caveat`.
- A high rank is not a recommendation to trade. If the user wants to act on a market, the next steps are `market` (the rule), `quote` (the size) and, in a later turn, `build-order` under the two-message rule.

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"--limit must be an integer, got ..."}` | `--limit` is not an integer. | Fix the flag. |
| 1 | `{"error":"bad_input","message":"limit must be an integer between 1 and 8 (the engine ranks at most 8 markets per scan)"}` | `--limit` outside 1..8. | Use 1 to 8. |
| 1 | usage text | Unknown flag. | Fix the flag and run once more. |
| 3 | `{"error":"upstream","kind":"http" or "schema" or "network",...}` | The Hyperliquid info endpoint failed (for example `info outcomeMeta returned HTTP 503`), timed out, or returned an unexpected shape. | Retry once after a few seconds, then report the JSON. |
| 3 | `{"error":"internal",...}` | The engine failed. | Retry once, then report the JSON. |

A Polymarket or Kalshi failure is not an error exit: the scan returns with that venue `unavailable` or `partial` in `dataStatus` and no comparator priced off it. A single unreadable book lands in `bookErrors`, not in an exit code.

## Notes

- One scan per question. Do not re-run `opportunities` in a loop to watch a market; report the current ranking and ask the user what to do.
- The scan is a live snapshot of the configured venue and network; state both. Testnet indices differ from mainnet.
- Nothing here builds an order. Orders route only to Verdict, and only from `build-order` after the user's confirmation in a new message.
