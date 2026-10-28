# fills

The outcome-market fills of an address, newest first, out of Hyperliquid's most recent fills across every coin: market and side, buy or sell, price, size, fee and builder fee, order id and client order id, transaction hash.

Read only. No account, no key, no confirmation. Any address can be read; the data is public, the same any explorer shows.

| Intent | CLI | MCP tool |
|---|---|---|
| "my fills", "what did 0x... trade on Verdict", "did my order fill", "what fees did I pay" | `verdict fills <address>` | `fills { "address": "0x..." }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<address>` | 20-byte hex address (`0x` + 40 hex characters). Checked before any request; a malformed value is exit 1 and is not repeated in the message. |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the testnet fixtures (a public trader address taken from recentTrades output) on 2026-09-15; trimmed to the first two of 56 fills, the address shown is an illustrative placeholder, and each `hash` is shortened here (the CLI prints it complete, `0x` plus 64 hex characters). Values are as recorded on 2026-09-15 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "address": "0x00000000000000000000000000000000000000a1",
  "scanned": 328,
  "count": 56,
  "fills": [
    { "outcome": 10474, "side": 1, "coin": "#104741", "time": 1789409230191, "action": "buy", "dir": "Buy", "price": 0.7, "size": 15, "fee": 0, "feeToken": "USDC", "builderFee": null, "crossed": true, "oid": 60123639947, "cloid": "0xa638f7c5c92a6ac186872360e3086040", "hash": "0xf21c...6d37", "tid": 477941137467299 },
    { "outcome": 10474, "side": 1, "coin": "#104741", "time": 1789407928732, "action": "buy", "dir": "Buy", "price": 0.7, "size": 15, "fee": 0, "feeToken": "USDC", "builderFee": null, "crossed": true, "oid": 60122408144, "cloid": "0x0846ca4dcfd742829de6a361e419dcae", "hash": "0xc713...e354", "tid": 271412161702148 }
  ]
}
```

| Field | Meaning |
|---|---|
| `scanned` | Fills Hyperliquid returned for the address across every coin (perps, spot, outcome) before the outcome filter. Hyperliquid returns at most 2,000; at 2,000 the window is full and older outcome fills may exist beyond it. |
| `count` | Outcome-market fills kept. |
| `outcome`, `side`, `coin` | Market index, side (`0` YES, `1` NO) and the Hyperliquid coin, decoded from `#<10 * outcome + side>`. |
| `action` | `buy` when the address bought the side's token, `sell` when it sold. |
| `dir` | Hyperliquid's own word: `Buy` or `Sell` for a trade; `Split Outcome`, `Merge Outcome`, `Negate Outcome`, `Merge Question` or `Settlement` for a mint, merge, negation or settlement that Hyperliquid also books as a fill. Only `Buy` and `Sell` are trades on the book. |
| `price`, `size` | Quote units (USDC) per token, and tokens. |
| `fee`, `feeToken` | Fee paid in `feeToken`; negative under a maker rebate. |
| `builderFee` | Builder fee paid on this fill, in `feeToken`; `null` when the order carried no builder code. Orders built by the kit carry Verdict's code, so their fills show it. |
| `crossed` | `true` when the address was the taker. |
| `oid`, `cloid` | Order id, and the client order id when the order had one (`null` otherwise). |
| `hash`, `tid` | Transaction hash (complete in the CLI output) and Hyperliquid's trade id. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"--address is required"}` | No address given. | Ask the user for the address. |
| 1 | `{"error":"bad_input","message":"address must be 0x followed by 40 hex characters ..."}` | Malformed address; the value is not repeated. | Check the address with the user. |
| 3 | `{"error":"upstream",...}` | The userFills fetch failed or drifted. | Retry once, then report the JSON. |

## Notes

- Show `dir` next to `action`: a `Split Outcome` fill is a mint of a YES and a NO token against USDC, not a purchase on the book.
- Pair a fill with `verdict market <outcome>` to show the market name and its rule, and with `verdict order-status <address> <oid>` for the order it came from.
- Sum `builderFee` over the fills of an order to see what the builder code cost; the kit prints the rate in cents per $1,000 when it builds the order.
