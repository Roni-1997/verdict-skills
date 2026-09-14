# fair-value

The probability implied by the Deribit options chain (Black-Scholes digital at the nearest listed expiry and strike) for a BTC, ETH or SOL price market, next to the Verdict price, or a typed not-available result with the reason.

Read only. No account, no key, no confirmation. Deribit is read, never traded. Reference only: an options-implied probability is not a tradable comparator and not a price on any venue.

| Intent | CLI | MCP tool |
|---|---|---|
| "what is the fair value of market 1210", "what do options imply for this strike", "is Verdict rich or cheap versus the options market" | `verdict fair-value <outcome>` | `fair_value { "outcome": <outcome> }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<outcome>` | Nonnegative integer market index, from `verdict markets`. |
| `--pretty` | Indent the JSON. |

Environment: `VERDICT_NETWORK` only. The Deribit request runs under the engine's 20 s budget.

## Output

Recorded on 2026-09-13 by running the CLI against the recorded fixtures (`tests/fixtures/engine`: the Hyperliquid mainnet catalog and books plus the Deribit BTC options chain recorded at 2026-09-13T21:31:31Z) with an injected fetch and the clock frozen at the recording time. Outcome 1210, venue `out`, mainnet. `market` is the summary `markets` prints and is trimmed here. Values are as recorded on 2026-09-13 and may differ on a later run; numbers appear exactly as the CLI prints them.

Available:

```json
{
  "available": true,
  "market": { "outcome": 1210, "venue": "out", "displayName": "BTC above 100000 at 20261001-0000?", "settlementRule": "...", "expiresAt": "2026-10-01T00:00:00.000Z" },
  "source": "deribit",
  "model": "black_scholes_digital",
  "underlying": "BTC",
  "direction": "above",
  "strike": 100000,
  "expiry": "2026-10-01T00:00:00.000Z",
  "marketProb": 0.0221,
  "impliedProb": 0.004456252503392202,
  "gap": 0.017643747496607798,
  "iv": 45.83,
  "strikeUsed": 95000,
  "spot": 77533.64,
  "optionsExpiryOffsetHours": 32,
  "caveats": [
    "reference_only_not_tradable_comparator",
    "deribit_options_settle_0800_utc",
    "nearest_options_expiry_+32h_from_market_settle",
    "nearest_listed_strike_95000_not_100000"
  ],
  "evidence": "Options-implied reference (BTC options chain): P(BTC above $100,000 at settle) = 0.4% (iv 45.8%, nearest options expiry +32h vs market settle; market YES 2.2%). Derivatives reference only, not a tradable comparator.",
  "engine": { "repo": "Roni-1997/verdict", "commit": "79f3ed255dbd9a628b01d9a38eb149f2116cbffb", "route": null, "generatedAt": "2026-09-13T21:31:31.000Z" }
}
```

Not available (outcome 1473, a Premier League participant market, same run):

```json
{
  "available": false,
  "market": { "outcome": 1473, "venue": "out", "displayName": "Arsenal", "settlementRule": "...", "expiresAt": null },
  "reason": "not_price_market",
  "detail": "Option-implied fair value needs a directional price binary (above or below a strike); this market has no strike or direction the engine recognises.",
  "engine": { "repo": "Roni-1997/verdict", "commit": "79f3ed255dbd9a628b01d9a38eb149f2116cbffb", "route": null, "generatedAt": "2026-09-13T21:31:31.000Z" }
}
```

For a market Verdict has not priced (outcome 2899, never traded on a wall-only book, same run) the result is available with `"marketProb": null`, `"gap": null` and the tag `verdict_unpriced_never_traded_wall_book` in `caveats`; the evidence line says "Verdict has no tradable price (never traded, wall-only book)" in place of a market probability.

| Field | Meaning |
|---|---|
| `available` | `true` with the fields below; `false` with `reason` and `detail`. Both are exit 0. |
| `impliedProb` | The options-implied probability that the market settles YES: a Black-Scholes digital at `strikeUsed` and the nearest Deribit expiry, using the chain's implied volatility `iv` (percent) and `spot`. |
| `marketProb` | Verdict's YES price, the same value `compare` reports as `verdict.yesMid`: book mid, or Hyperliquid's mark when the coin traded today on a wide book (then `caveats` carries `verdict_price_is_hl_mark`). `null` when Verdict has no tradable price (then `caveats` carries `verdict_unpriced_<reason>`). Never the 0.5 placeholder. |
| `gap` | `marketProb - impliedProb`; positive means Verdict prices YES above the option-implied level. `null` when `marketProb` is null. |
| `strikeUsed`, `strike` | The listed Deribit strike the digital was priced at, and the market's strike. When they differ by more than 0.5% the tag `nearest_listed_strike_<used>_not_<strike>` is added. |
| `optionsExpiryOffsetHours` | Hours from the market's settlement to the nearest Deribit expiry (Deribit options settle at 08:00 UTC). Also in `caveats` as `nearest_options_expiry_+Nh_from_market_settle`. |
| `caveats` | Always includes `reference_only_not_tradable_comparator` and `deribit_options_settle_0800_utc`. |
| `evidence` | The one-line reading to show the user. |
| `reason` (not available) | `not_price_market` (no above/below strike), `unsupported_underlying` (Deribit lists BTC, ETH and SOL only), `missing_expiry`, `no_options_chain_near_expiry` (no Deribit expiry within 3 days of settlement, or no priced calls on it), `upstream_unavailable` (the Deribit request failed; `detail` has the message). |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"<outcome> must be a nonnegative integer, got ..."}` | `<outcome>` missing or not a nonnegative integer. | Fix the argument. |
| 1 | usage text | Unknown flag. | Fix the flag and run once more. |
| 2 | `{"error":"not_found","message":"no outcome market with index N on <network>"}` | No market with that index on the configured network. | Do not retry. Run `verdict markets` and pick from it; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream","kind":"http" or "schema" or "network",...}` | The Hyperliquid info endpoint failed, timed out, or returned an unexpected shape. | Retry once after a few seconds, then report the JSON. |
| 3 | `{"error":"internal",...}` | The engine failed. | Retry once, then report the JSON. |

A Deribit failure is not an error exit: it returns `available: false` with `reason: "upstream_unavailable"` and the message in `detail`.

## Notes

- Present `impliedProb` as a reference next to the Verdict price, with the strike and expiry offsets from `caveats`: an options digital priced 32 hours after settlement at a strike 5% away is context, not a fair value to trade against.
- `available: false` is an answer: give the `detail` to the user. Do not estimate an implied probability from memory.
- A gap is not a trade. Building an order is a separate turn under the two-message rule in `build-order.md`.
