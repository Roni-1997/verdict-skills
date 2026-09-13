# book

The two order books of a market: the YES side and the NO side, each with bids, asks, best bid, best ask and mid, straight from Hyperliquid's `l2Book`.

Read only. No account, no key, no confirmation.

| Intent | CLI | MCP tool |
|---|---|---|
| "show the order book", "how deep is market 1210", "what is the spread", "where is the touch" | `verdict book <outcome>` | `orderbook { "outcome": <outcome> }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<outcome>` | Market index. |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the mainnet fixtures (outcome 1210) on 2026-09-13. Levels trimmed to the first two of each side (the recorded YES book had 6 bids and 20 asks; the NO book 20 bids and 6 asks).

```json
{
  "outcome": 1210,
  "sides": [
    {
      "coin": "#12100",
      "bids": [ { "px": 0.0178, "sz": 67, "orders": 1 }, { "px": 0.0145, "sz": 76, "orders": 1 } ],
      "asks": [ { "px": 0.0238, "sz": 67, "orders": 1 }, { "px": 0.027, "sz": 8284, "orders": 2 } ],
      "bestBid": 0.0178, "bestAsk": 0.0238, "mid": 0.0208, "time": 1789330454362
    },
    {
      "coin": "#12101",
      "bids": [ { "px": 0.9762, "sz": 67, "orders": 1 }, { "px": 0.973, "sz": 8284, "orders": 2 } ],
      "asks": [ { "px": 0.9822, "sz": 67, "orders": 1 }, { "px": 0.9855, "sz": 76, "orders": 1 } ],
      "bestBid": 0.9762, "bestAsk": 0.9822, "mid": 0.9792, "time": 1789330454895
    }
  ],
  "sideNames": ["template:Yes", "template:No"]
}
```

| Field | Meaning |
|---|---|
| `sides[0]`, `sides[1]` | The YES book and the NO book, in the order of `sideNames`. |
| `px` | Price in quote units (USDC) per token, between 0 and 1. |
| `sz` | Tokens resting at that level. |
| `orders` | Number of resting orders at that level. |
| `bestBid`, `bestAsk`, `mid` | Touch prices and their midpoint; `null` when that side of the book is empty. |
| `time` | Book timestamp from Hyperliquid, milliseconds. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | `<outcome>` missing or invalid. | Fix the argument. |
| 2 | `{"error":"not_found",...}` | No such market on this network. | Run `verdict markets`; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream",...}` | One of the two book fetches failed or drifted. | Retry once, then report the JSON. |

## Notes

- The two books mirror each other on HIP-4: liquidity to buy YES at p is liquidity to sell NO at 1 - p. Do not read the two mids as two independent probabilities.
- A one-sided book makes `mid` misleading. For an executable price at a size, use `quote`, not `mid`.
- Books move; fetch again before any confirmation rather than reusing an earlier snapshot.
