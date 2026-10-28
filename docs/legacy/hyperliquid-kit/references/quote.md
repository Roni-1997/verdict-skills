# quote

The executable price for buying or selling a number of tokens on one side, walked level by level from the live book: average price, worst price, best price, slippage in cents per token, notional, and whether the whole size fills.

Read only. No account, no key, no confirmation. A quote is not an order.

| Intent | CLI | MCP tool |
|---|---|---|
| "what would 500 YES cost me", "price for my size", "how much slippage on 2000 NO", "can I sell 300 YES here" | `verdict quote <outcome> --side yes\|no --action buy\|sell --size <tokens>` | `quote { "outcome": <outcome>, "side": "yes", "action": "buy", "size": 500 }` |

## Flags

| Flag | Values | Meaning |
|---|---|---|
| `<outcome>` | integer | Market index. |
| `--side` | `yes`, `no`, `0`, `1`, or a side name | Which side's book to walk. `yes` is side 0, `no` is side 1. |
| `--action` | `buy`, `sell` | Buys consume asks from the best up; sells consume bids from the best down. |
| `--size` | positive number | Tokens. Each token pays 1 quote unit (USDC) if the side wins. |
| `--pretty` | | Indent the JSON. |

## Output

Recorded from the mainnet fixtures (outcome 1210, buy 10 YES) on 2026-09-13. `market` is the same summary `markets` prints; trimmed here. Values are as recorded on 2026-09-13 and may differ on a later run; numbers appear exactly as the CLI prints them, so `notional` shows the float `10 * 0.0238` comes out as, not a rounded `0.238`.

```json
{
  "side": 0,
  "action": "buy",
  "requestedSize": 10,
  "filledSize": 10,
  "complete": true,
  "averagePrice": 0.0238,
  "worstPrice": 0.0238,
  "bestPrice": 0.0238,
  "slippageCents": 0,
  "notional": 0.23800000000000002,
  "levelsUsed": 1,
  "market": { "outcome": 1210, "venue": "out", "displayName": "BTC above 100000 at 20261001-0000?", "settlementRule": "...", "expiresAt": "2026-10-01T00:00:00.000Z" }
}
```

| Field | Meaning |
|---|---|
| `complete` | `true` when the book can fill the whole size. `false` means only `filledSize` tokens are available at any price; the rest would rest unfilled. |
| `averagePrice` | Size-weighted average of the filled part, quote units per token. `null` when nothing fills. |
| `bestPrice`, `worstPrice` | The touch and the last level used. |
| `slippageCents` | `(average - best) * 100` for buys, `(best - average) * 100` for sells: cents per token worse than the touch. |
| `notional` | Tokens times average price: what a buy costs, or what a sell receives, before fees. |
| `levelsUsed` | Book levels consumed. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | Missing `--side`, `--action` or `--size`; size not positive; action not buy or sell; unknown side. | Fix the flags from the table above. |
| 2 | `{"error":"not_found",...}` | No such market on this network. | Run `verdict markets`; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream",...}` | Book fetch failed or drifted. | Retry once, then report the JSON. |

## Notes

- Report `complete: false` as it is. Never present `averagePrice` as if the whole size filled.
- `--size` accepts decimals here for quoting, but `build-order` takes whole tokens only. Quote the size you would order.
- Quoting is analysis when the user asked a question: if the user then wants to trade, building the order happens in a later turn and follows the two-message rule in `build-order.md`. In a trade turn, `quote` may run as a pre-trade check right before `build-order` (the boundary sentence in SKILL.md).
