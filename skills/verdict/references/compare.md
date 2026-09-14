# compare

The same market on Polymarket and Kalshi, through the Verdict app's cross-venue engine: the best comparator per venue with its price, the gap to Verdict when the contracts match, and always the engine's resolution-equivalence confidence and reasons. Includes the Deribit options-implied probability for BTC, ETH and SOL price markets.

Read only. No account, no key, no confirmation. Polymarket, Kalshi and Deribit are read, never traded: the kit builds no order for them.

| Intent | CLI | MCP tool |
|---|---|---|
| "compare market 1210 to Polymarket", "is this cheaper on Kalshi", "what is the gap to Kalshi", "does the same market exist elsewhere" | `verdict compare <outcome>` | `compare_market { "outcome": <outcome> }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<outcome>` | Nonnegative integer market index, from `verdict markets`. |
| `--pretty` | Indent the JSON. |

Environment: the usual `VERDICT_NETWORK`. `ODDPOOL_API_KEY` is optional: it routes the engine's Polymarket and Kalshi reads through api.oddpool.com and is sent there on every call, so it is never set on a hosted server. The command needs no key of any kind without it.

The engine fetches the venues with a 20 s budget; a compare can take that long. It is fetching, not waiting for input.

## Output

Recorded on 2026-09-13 by running the CLI against the recorded fixtures (`tests/fixtures/engine`: the Hyperliquid mainnet catalog and books plus the Polymarket, Kalshi and Deribit payloads recorded at 2026-09-13T21:31:31Z) with an injected fetch and the clock frozen at the recording time. Outcome 1210, venue `out`, mainnet. `market` is the summary `markets` prints and is trimmed here; `evidence` is trimmed to its last line. Values are as recorded on 2026-09-13 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "market": { "outcome": 1210, "venue": "out", "displayName": "BTC above 100000 at 20261001-0000?", "settlementRule": "...", "expiresAt": "2026-10-01T00:00:00.000Z" },
  "verdict": {
    "yesMid": 0.0221,
    "priceSource": "book",
    "unpriced": null,
    "title": "BTC closes above $100,000",
    "yesBid": 0.0191,
    "yesAsk": 0.0251,
    "spread": 0.006000000000000002,
    "depthUsd": 1.2796999999999998,
    "volumeUsd": 9629,
    "underlying": "BTC",
    "direction": "above",
    "strike": 100000,
    "expiry": "2026-10-01T00:00:00.000Z"
  },
  "comparators": {
    "polymarket": null,
    "kalshi": {
      "venue": "kalshi",
      "method": "reference",
      "confidence": "low",
      "edgeConfidence": null,
      "reasons": ["strike_mismatch"],
      "caveats": ["reference_not_tradable_twin", "strike $82,000 vs $100,000 · settles Sep 18 vs Oct 1"],
      "caveat": "Low-confidence match (strike_mismatch): strike $82,000 vs $100,000 · settles Sep 18 vs Oct 1. The price difference is not a comparable gap and is not reported.",
      "title": "BTC price on Sep 18, 2026 at 5pm EDT? · $82,000 or above",
      "url": "https://kalshi.com/markets/kxbtcd",
      "fairProb": 0.1,
      "yesBid": 0.09,
      "yesAsk": 0.11,
      "spread": 0.020000000000000004,
      "depthUsd": 516.06,
      "volumeUsd": 2519,
      "expiry": "2026-09-18T21:00:00Z",
      "gap": null,
      "spreadAdjustedGap": null,
      "expiryAdjusted": null,
      "mismatchNote": "strike $82,000 vs $100,000 · settles Sep 18 vs Oct 1",
      "tradeCall": null,
      "legs": [
        { "id": "kalshi:KXBTCD-26SEP1817-T81999.99", "title": "BTC price on Sep 18, 2026 at 5pm EDT? · $82,000 or above", "url": "https://kalshi.com/markets/kxbtcd", "yesMid": 0.1, "strike": null, "expiry": "2026-09-18T21:00:00Z" }
      ],
      "line": "Kalshi: low-confidence match (strike_mismatch); no comparable price gap. Closest market: \"BTC price on Sep 18, 2026 at 5pm EDT? · $82,000 or above\"."
    }
  },
  "optionsImplied": { "prob": 0.004456252503392202, "iv": 45.83, "strikeUsed": 95000, "spot": 77533.64, "offsetHours": 32, "marketProb": 0.0221, "baseTitle": "BTC closes above $100,000" },
  "dataStatus": { "polymarket": "ok", "kalshi": "ok" },
  "errors": {},
  "summary": "BTC above 100000 at 20261001-0000?: Verdict YES 2.2%. Polymarket: no comparable market found. Kalshi: low-confidence match (strike_mismatch); no comparable price gap. Closest market: \"BTC price on Sep 18, 2026 at 5pm EDT? · $82,000 or above\". Deribit options-implied: 0.4% (iv 45.8%, nearest expiry +32h from settle); reference only, not a tradable comparator.",
  "lines": [
    "Polymarket: no comparable market found.",
    "Kalshi: low-confidence match (strike_mismatch); no comparable price gap. Closest market: \"BTC price on Sep 18, 2026 at 5pm EDT? · $82,000 or above\".",
    "Deribit options-implied: 0.4% (iv 45.8%, nearest expiry +32h from settle); reference only, not a tradable comparator."
  ],
  "evidence": [
    "Options-implied reference (BTC options chain): P(BTC above $100,000 at settle) = 0.4% (iv 45.8%, nearest options expiry +32h vs market settle; market YES 2.2%). Derivatives reference only, not a tradable comparator."
  ],
  "engine": { "repo": "Roni-1997/verdict", "commit": "79f3ed255dbd9a628b01d9a38eb149f2116cbffb", "route": "cross_venue_scanner", "generatedAt": "2026-09-13T21:31:31.000Z" }
}
```

The same run for outcome 2899 (venue `skew`, never traded, wall-only book: bid 0.00001, ask 0.99999) gives a medium-confidence Kalshi ladder interpolation and no gap, because Verdict has no price to compare against. Trimmed to what differs:

```json
{
  "verdict": { "yesMid": null, "priceSource": null, "unpriced": "never_traded_wall_book", "yesBid": 0.00001, "yesAsk": 0.99999, "strike": 77250, "expiry": "2026-09-18T06:00:00.000Z" },
  "comparators": {
    "polymarket": null,
    "kalshi": {
      "method": "ladder_interpolation",
      "confidence": "medium",
      "edgeConfidence": "low",
      "reasons": ["title_similarity_0.20", "same_underlying", "same_contract_type", "same_direction", "strike_exact", "expiry_near", "rules_available"],
      "caveats": ["interpolated_between_ladder_strikes", "settlement_offset_15h", "verdict_book_thin", "verdict_unpriced_never_traded_wall_book"],
      "caveat": "Verdict has no tradable price (never traded, wall-only book); no gap is reported. The comparator's price at the Verdict contract is shown for reference. Model-based comparator (ladder_interpolation): a relative-value read, not a locked arbitrage; it carries vol and settlement risk.",
      "fairProb": 0.5099988000000006,
      "gap": null,
      "spreadAdjustedGap": null,
      "mismatchNote": "Kalshi lists no market at $77,250; interpolated between $77,000 (54.0%) and $77,500 (48.0%), settling ~15h apart",
      "line": "Kalshi: 51.0% at the Verdict contract (medium confidence: title_similarity_0.20, same_underlying, same_contract_type, same_direction, strike_exact, expiry_near, rules_available; ladder_interpolation). Verdict has no tradable price (never traded, wall-only book); comparator shown for reference."
    }
  },
  "optionsImplied": { "prob": 0.5109581549670171, "iv": 39.46, "strikeUsed": 77000, "spot": 77413.27, "offsetHours": 2, "marketProb": null, "baseTitle": "BTC closes above $77,250" },
  "summary": "BTC above 77250 at 20260918-0600?: Verdict has no tradable price (never traded, wall-only book). Polymarket: no comparable market found. Kalshi: 51.0% at the Verdict contract (medium confidence: title_similarity_0.20, same_underlying, same_contract_type, same_direction, strike_exact, expiry_near, rules_available; ladder_interpolation). Verdict has no tradable price (never traded, wall-only book); comparator shown for reference. Deribit options-implied: 51.1% (iv 39.5%, nearest expiry +2h from settle); reference only, not a tradable comparator."
}
```

| Field | Meaning |
|---|---|
| `verdict.yesMid` | Verdict's YES probability: the robust mid of the book (`priceSource: "book"`) or Hyperliquid's mark when the coin traded today but the book is wide or one-sided (`priceSource: "ctx"`, labelled "Verdict price is the HL mark" in every line). `null` when Verdict has no tradable price. |
| `verdict.unpriced` | Why `yesMid` is null: `never_traded_wall_book`, `never_traded_no_book`, `stale_wall_book`, `stale_no_book` (no trades in 24h) or `no_price_data`. Hyperliquid's 0.5 placeholder mark and a wall-only book's average are never printed as a price. |
| `comparators.polymarket`, `comparators.kalshi` | The best comparator the engine found on that venue, or `null` when none is comparable ("no comparable market found"). |
| `method` | `exact_twin`: same contract, the gap is comparable. `ladder_interpolation`: priced between two ladder strikes at the Verdict strike. `maturity_adjusted_digital`: repriced from the comparator's settlement time to Verdict's (Black-Scholes). `reference`: the closest listed market, not the same contract. |
| `confidence`, `reasons` | The engine's resolution-equivalence confidence (`low`, `medium`, `high`) and the reasons behind it (`strike_exact`, `strike_mismatch`, `expiry_near`, `expiry_mismatch`, `same_underlying`, `title_similarity_0.20`, ...). Whether the two contracts settle the same question. |
| `edgeConfidence` | The engine's confidence in the edge itself; `low` means the gap sits inside the model band or flips sign under a vol stress, so `spreadAdjustedGap` is null. `null` for a reference comparator. |
| `caveat`, `caveats` | Always set when `confidence` is low, when Verdict is unpriced, or when the edge is rated low: says what is not reported and why. `caveats` holds the tags (`reference_not_tradable_twin`, `verdict_unpriced_*`, `verdict_price_is_hl_mark`, `strike_offset_*`, `edge_flips_under_vol_stress`, ...). |
| `fairProb` | The comparator's YES probability at the Verdict contract: its raw mid for a twin or reference, the model price otherwise. On its own it is not a comparison. |
| `gap` | Verdict YES minus comparator YES, only when the engine deems the pair comparable and Verdict has a price. `null` for a low-confidence match or an unpriced Verdict market, by rule. |
| `spreadAdjustedGap` | The gap net of both spreads (and the model band); `null` when the engine rates the edge low or does not provide it. |
| `expiryAdjusted` | For `maturity_adjusted_digital`: raw and adjusted probability, shift, hours between settlements, iv, spot. |
| `legs` | The comparator markets used: one for a twin or reference, two for an interpolation. |
| `line` | The one-line reading of the comparator. A low-confidence match is always described here, never reduced to a number. |
| `optionsImplied` | Deribit options-implied probability (`prob`), the iv, strike and spot used, hours between the nearest options expiry and the market's settlement, and Verdict's price (`marketProb`, null when unpriced). Reference only; `fair-value.md` has the dedicated command. `null` for markets that are not BTC, ETH or SOL price binaries. |
| `dataStatus`, `errors` | Per venue: `ok`, `partial` or `unavailable`, and any fetch error text. A venue that fails is reported here, not priced. |
| `summary`, `lines` | The sentence to show the user and its parts: Verdict price (or that there is none), one line per venue, the Deribit line. |
| `engine` | The pinned Verdict app engine commit that produced the result and the route it ran. |

## Presenting a comparison

- Show `summary` or `lines` as printed. Every comparator carries its `confidence` and `reasons`; keep them next to any number you show.
- A low-confidence match (`confidence: "low"`) is presented with its confidence and reasons, never as a bare number. `gap` is null by rule; `fairProb` is the closest market's price, not a comparison. Say "low-confidence match (strike_mismatch); no comparable price gap", as `line` does. Do not subtract `fairProb` from `verdict.yesMid` yourself.
- `verdict.yesMid: null` means Verdict has no tradable price. Say so with the reason (`caveat` spells it out); a comparator's `fairProb` is then a reference at the Verdict contract, not a gap.
- `priceSource: "ctx"` means the Verdict price is Hyperliquid's mark on a wide or one-sided book; the lines say so. Repeat the label; it is not an executable price.
- `comparators.<venue>: null` means no comparable market was found on that venue; say that rather than looking one up from memory.
- A gap is not a trade. Building an order is a separate turn under the two-message rule in `build-order.md`, and only ever on Verdict.

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"<outcome> must be a nonnegative integer, got ..."}` | `<outcome>` missing or not a nonnegative integer. | Fix the argument. |
| 1 | usage text | Unknown flag. | Fix the flag and run once more. |
| 2 | `{"error":"not_found","message":"no outcome market with index N on <network>"}` | No market with that index on the configured network. | Do not retry. Run `verdict markets` and pick from it; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream","kind":"http" or "schema" or "network",...}` | The Hyperliquid info endpoint failed (for example `info outcomeMeta returned HTTP 503`), timed out, or returned an unexpected shape. | Retry once after a few seconds, then report the JSON. |
| 3 | `{"error":"internal",...}` | The engine failed. | Retry once, then report the JSON. |

A Polymarket, Kalshi or Deribit failure is not an error exit: the command returns with that venue `unavailable` or `partial` in `dataStatus` and the reason in `errors`, and prices nothing off it. A venue body that fails the kit's schema validation counts as unavailable too.

## Notes

- Testnet and mainnet have different market indices; the comparators come from live Polymarket and Kalshi either way, so a testnet compare is a comparison of a testnet market with real venues. State the network.
- Same-strike daily markets share one engine title (for example three "BTC closes above $77,250" dailies); the kit ties the result to the outcome you asked for, so read `market.outcome` and `verdict.expiry`, not the title, when several exist.
- The kit never builds an order for Polymarket, Kalshi or Deribit. If the user wants to act on a gap, the order is a Verdict order and starts a new turn.
