# order-status

One order of an address by order id or client order id: Hyperliquid's lifecycle status, when it was reached, and the order itself.

Read only. No account, no key, no confirmation. Any address can be read.

| Intent | CLI | MCP tool |
|---|---|---|
| "did my order fill", "status of order N", "is order N still open", "what happened to my order with client id 0x..." | `verdict order-status <address> <oid>` | `order_status { "address": "0x...", "oid": 55896593277 }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<address>` | 20-byte hex address (`0x` + 40 hex characters). Checked before any request; a malformed value is exit 1 and is not repeated in the message. |
| `<oid>` | The order id (a whole number, as `fills` and `open-orders` print it), or the client order id the order was placed with (`0x` + 32 hex characters, the `cloid` of `build-order`). |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the testnet fixtures (the maker address of `open-orders`, order 55896593277) on 2026-09-15; the address shown is an illustrative placeholder. Values are as recorded on 2026-09-15 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "address": "0x00000000000000000000000000000000000000a1",
  "oid": 55896593277,
  "status": "open",
  "statusTimestamp": 1783065593537,
  "order": { "outcome": 10474, "side": 0, "coin": "#104740", "oid": 55896593277, "cloid": null, "action": "buy", "price": 0.3, "size": 333, "originalSize": 333, "timestamp": 1783065593537, "orderType": "Limit", "tif": "Gtc", "reduceOnly": false }
}
```

| Field | Meaning |
|---|---|
| `oid` | The id asked for, as given: a number, or the client order id string. |
| `status` | Hyperliquid's word: `open`, `filled`, `canceled`, `triggered`, `rejected`, `marginCanceled` and the other values Hyperliquid documents. Shown as printed. |
| `statusTimestamp` | When that status was reached, milliseconds since the epoch. |
| `order` | The order as `open-orders` prints it: market, side, coin, `action`, limit `price`, `size` still unfilled at the status time (`0` once filled), `originalSize`, placement `timestamp`, `orderType`, `tif`, `cloid`. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | Address missing or malformed (the value is not repeated); `<oid>` missing, not a whole number, and not a `0x` + 32 hex client order id. | Fix the arguments. |
| 2 | `{"error":"not_found",...}` | Hyperliquid answered `unknownOid`: the address never had this order (wrong address, wrong network, or an id from the other network). Or the order exists but is on a perp or spot coin, not an outcome market; the message names the coin. | Check the address, the id and `VERDICT_NETWORK`; do not retry. |
| 3 | `{"error":"upstream",...}` | The orderStatus fetch failed (HTTP 422 is the venue refusing the request) or drifted. | Retry once, then report the JSON. |

## Notes

- After the user submits an order the kit built, this is how to confirm the outcome: run it once with the `oid` from the `/exchange` response (or the `cloid` the order carried) and show `status`, `size` and `originalSize`. Do not poll it in a loop to wait for a fill; report the current status and ask the user what to do.
- A `filled` order's fills, with fees and builder fee, are in `verdict fills <address>` under the same `oid`.
- Order ids are per network; a testnet id looked up on mainnet is `unknownOid`.
