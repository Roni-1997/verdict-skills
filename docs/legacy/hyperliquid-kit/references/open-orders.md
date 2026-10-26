# open-orders

Resting orders of an address on outcome markets, newest first: market and side, buy or sell, limit price, remaining and original size, order type, time in force, client order id.

Read only. No account, no key, no confirmation. Any address can be read.

| Intent | CLI | MCP tool |
|---|---|---|
| "my open orders", "what is resting for 0x...", "is my bid still on the book" | `verdict open-orders <address>` | `open_orders { "address": "0x..." }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<address>` | 20-byte hex address (`0x` + 40 hex characters). Checked before any request; a malformed value is exit 1 and is not repeated in the message. |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the testnet fixtures (a public maker address taken from recentTrades output, one resting order on the YES side of outcome 10474 and one on a spot pair, which is filtered out) on 2026-09-15; the address shown is an illustrative placeholder. Values are as recorded on 2026-09-15 and may differ on a later run; numbers appear exactly as the CLI prints them.

```json
{
  "address": "0x00000000000000000000000000000000000000a1",
  "source": "frontendOpenOrders",
  "count": 1,
  "orders": [
    { "outcome": 10474, "side": 0, "coin": "#104740", "oid": 55896593277, "cloid": null, "action": "buy", "price": 0.3, "size": 156, "originalSize": 333, "timestamp": 1783065593537, "orderType": "Limit", "tif": "Gtc", "reduceOnly": false }
  ]
}
```

| Field | Meaning |
|---|---|
| `source` | `frontendOpenOrders` normally. `openOrders` when that endpoint answered an HTTP error or a shape the kit's schema refused and the plain list was read instead; then `orderType`, `tif`, `reduceOnly` and `cloid` are `null`, not unknown values invented. |
| `count` | Outcome-market orders kept; orders on perps and spot pairs are filtered out. |
| `outcome`, `side`, `coin` | Market index, side (`0` YES, `1` NO) and the Hyperliquid coin. |
| `action` | `buy` or `sell` of the side's token. |
| `price` | Limit price, quote units (USDC) per token. |
| `size`, `originalSize` | Tokens still resting, and tokens the order was placed with; the difference has filled. |
| `timestamp` | Placement time, milliseconds since the epoch. |
| `orderType`, `tif` | `Limit` and `Gtc`, `Ioc` or `Alo` for the orders the kit builds. |
| `cloid` | Client order id when the order had one. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"--address is required"}` | No address given. | Ask the user for the address. |
| 1 | `{"error":"bad_input","message":"address must be 0x followed by 40 hex characters ..."}` | Malformed address; the value is not repeated. | Check the address with the user. |
| 3 | `{"error":"upstream",...}` | Both order endpoints failed, or the first failed on the network (a network failure is not retried on the second). | Retry once, then report the JSON. |

## Notes

- `count: 0` means nothing is resting on any outcome market for this address; it says nothing about positions (`positions`) or past trades (`fills`).
- The kit builds orders and reads them; it cancels nothing. A cancel is the user's own signed action, outside the kit, with the same two-message rule as any signature.
- An order that has left this list has filled, been cancelled or been rejected: `verdict order-status <address> <oid>` says which.
