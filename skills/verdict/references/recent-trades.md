# recent-trades

Hyperliquid's most recent prints on one side of a market, newest first: time, price, size, whether the taker bought, the transaction hash and the trade id.

Read only. No account, no key, no confirmation.

| Intent | CLI | MCP tool |
|---|---|---|
| "what traded recently on N", "show me the tape", "last prints on the NO side", "when did market N last trade" | `verdict recent-trades <outcome> [--side yes\|no]` | `recent_trades { "outcome": <outcome>, "side": "no" }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<outcome>` | Market index. |
| `--side` | `yes`, `no`, `0`, `1` or a side name. Optional: the YES side (0) is read when omitted. |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the testnet fixtures (outcome 10474, the NO side) on 2026-09-15; trimmed to the first two of nine prints, and each `hash` shortened here (the CLI prints it complete, `0x` plus 64 hex characters). Values are as recorded on 2026-09-15 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "outcome": 10474,
  "side": 1,
  "coin": "#104741",
  "count": 9,
  "trades": [
    { "time": 1789409230191, "price": 0.7, "size": 15, "isBuy": true, "hash": "0xf21c...6d37", "tid": 477941137467299 },
    { "time": 1789407928732, "price": 0.7, "size": 15, "isBuy": true, "hash": "0xc713...e354", "tid": 271412161702148 }
  ]
}
```

| Field | Meaning |
|---|---|
| `side`, `coin` | The side read (`0` YES, `1` NO) and its Hyperliquid coin, `#<10 * outcome + side>`. |
| `count` | Prints returned; `0` when the side has not traded yet. |
| `time` | Milliseconds since the epoch. |
| `price` | Quote units (USDC) per token, between 0 and 1. |
| `size` | Tokens. |
| `isBuy` | `true` when the taker bought this side's token, `false` when the taker sold it. |
| `hash` | Transaction hash, complete in the CLI output. |
| `tid` | Hyperliquid's trade id, unique per print. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | `<outcome>` missing or invalid, or an unknown `--side`. | Fix the argument. |
| 2 | `{"error":"not_found",...}` | No such market on this network. | Run `verdict markets`; check `VERDICT_NETWORK`. |
| 3 | `{"error":"upstream",...}` | The recentTrades fetch failed, drifted, or answered about another coin. | Retry once, then report the JSON. |

## Notes

- One side is read on purpose. The YES and NO coins print the same fills: same hash and size, price p on YES and 1 - p on NO, taker side flipped (verified on testnet #104740 and #104741 and on mainnet #12100 and #12101 on 2026-09-15, every hash shared). Do not add the two sides' prints together and do not present the NO list as a second set of trades.
- `count: 0` is a side that has not traded, not an error. Hyperliquid keeps a short window of recent prints; for history use `candles`, for one address's own trades use `fills`.
- Quiet is not a prompt: do not poll this command to wait for a trade. Report the last print and its time.
