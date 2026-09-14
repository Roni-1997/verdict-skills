# hedges

Hyperliquid perp and spot hedge candidates for the market's underlying, with a live reference mid, and the engine's hedge leg: which direction offsets holding YES (NO is the opposite). A hedge offsets the underlying's price move only; the outcome token still settles on its own rule and can go to zero.

Read only. No account, no key, no confirmation. The command names a hedge; it builds no order for it. The kit builds orders for Verdict outcome markets only, never for a perp or spot market.

| Intent | CLI | MCP tool |
|---|---|---|
| "how do I hedge market 1210", "what offsets my YES position", "is there a perp hedge for this market" | `verdict hedges <outcome>` | `find_hedges { "outcome": <outcome> }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<outcome>` | Nonnegative integer market index, from `verdict markets`. |
| `--pretty` | Indent the JSON. |

Environment: `VERDICT_NETWORK` only.

## Output

Recorded on 2026-09-13 by running the CLI against the recorded fixtures (`tests/fixtures/engine`: the Hyperliquid mainnet catalog, books and mids recorded at 2026-09-13T21:31:31Z) with an injected fetch and the clock frozen at the recording time. Outcome 1210, venue `out`, mainnet. `market` is the summary `markets` prints and is trimmed here. Values are as recorded on 2026-09-13 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "market": { "outcome": 1210, "venue": "out", "displayName": "BTC above 100000 at 20261001-0000?", "settlementRule": "...", "expiresAt": "2026-10-01T00:00:00.000Z" },
  "underlying": "BTC",
  "hedgeable": true,
  "candidates": [
    { "symbol": "BTC", "kind": "perp", "mid": 77367.5, "fundingRate": null, "openInterestUsd": null, "available": true, "reason": "Live Hyperliquid reference mid available." },
    { "symbol": "BTC", "kind": "spot", "mid": 77367.5, "fundingRate": null, "openInterestUsd": null, "available": true, "reason": "Spot/perp exposure can reduce underlying price beta, but not event settlement risk." }
  ],
  "leg": {
    "symbol": "BTC",
    "kind": "perp",
    "directionForYes": "short",
    "directionForNo": "long",
    "mid": 77367.5,
    "rationale": "BTC exposure can be partially hedged with Hyperliquid perp.",
    "limitations": [
      "The hedge will not perfectly match the YES/NO payout.",
      "Funding, timing, and settlement price can move differently.",
      "Near settlement, the outcome price can move much faster than the hedge."
    ]
  },
  "note": "A Hyperliquid perp or spot hedge offsets the underlying price move only; the outcome token still settles on its own rule and can go to zero.",
  "engine": { "repo": "Roni-1997/verdict", "commit": "79f3ed255dbd9a628b01d9a38eb149f2116cbffb", "route": "hedgeability", "generatedAt": "2026-09-13T21:31:31.000Z" }
}
```

For a market with no mapped underlying (outcome 1473, a Premier League participant market, same run) the result is `"underlying": null`, `"hedgeable": false`, one candidate with `"available": false` and reason "No direct Hyperliquid spot/perp hedge mapped to this event.", and a `leg` whose `directionForYes` and `directionForNo` are both `"none"`, `mid` is null and the symbol is a placeholder dash.

| Field | Meaning |
|---|---|
| `underlying` | The perp or spot symbol the market is on (`BTC`, `ETH`, `HYPE`, ...), or `null` when the engine maps none. |
| `hedgeable` | `true` when at least one candidate is available. |
| `candidates[]` | Perp and spot instruments on Hyperliquid for the underlying, each with the live reference `mid`, whether it is `available`, and the `reason`. `fundingRate` and `openInterestUsd` are null in this version. |
| `leg.directionForYes` | `short`, `long` or `none`: the hedge direction for a holder of YES. An "above" market pays YES when the price rises, so shorting the underlying offsets it. |
| `leg.directionForNo` | The opposite direction, for a holder of NO. |
| `leg.limitations` | Why the hedge is partial: payout mismatch, funding and timing, settlement-price differences, speed near settlement. Show them. |
| `note` | The sentence to keep next to any hedge you present. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"<outcome> must be a nonnegative integer, got ..."}` | `<outcome>` missing or not a nonnegative integer. | Fix the argument. |
| 1 | usage text | Unknown flag. | Fix the flag and run once more. |
| 2 | `{"error":"not_found","message":"no outcome market with index N on <network>"}` | No market with that index on the configured network. | Do not retry. Run `verdict markets` and pick from it; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream","kind":"http" or "schema" or "network",...}` | The Hyperliquid info endpoint failed, timed out, or returned an unexpected shape. | Retry once after a few seconds, then report the JSON. |
| 3 | `{"error":"internal",...}` | The engine failed. | Retry once, then report the JSON. |

## Notes

- Present the direction for the side the user holds (`directionForYes` or `directionForNo`), the instrument, the reference mid and every line of `limitations`, with `note`. Sizing a hedge is the user's decision; the command does not size it.
- The kit builds no perp or spot order. Placing the hedge is a Hyperliquid perps or spot trade outside this skill; do not build, sign or submit one, and do not route it through `build-order`, which takes outcome markets only.
- `hedgeable: false` is an answer: say no direct Hyperliquid hedge is mapped for the market.
