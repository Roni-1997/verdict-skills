# positions

Outcome-token balances held by an address: which market, which side, how many tokens in total, and how many are on hold behind resting orders.

Read only. No account, no key, no confirmation. Any address can be read.

| Intent | CLI | MCP tool |
|---|---|---|
| "what do I hold on Verdict", "my positions", "outcome tokens of 0x..." | `verdict positions <address>` | `positions { "address": "0x..." }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<address>` | 20-byte hex address (`0x` + 40 hex characters). The MCP tool validates the format; the CLI passes it through and lets Hyperliquid reject garbage. |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the testnet fixtures on 2026-09-13 for an address holding no outcome tokens:

```json
{
  "address": "0x2bd816e68b18d1dd6327266f273f0658f20467dc",
  "positions": []
}
```

Each entry of `positions`, when there are any:

| Field | Meaning |
|---|---|
| `outcome` | Market index, decoded from the token name. |
| `side` | `0` for the first side (YES), `1` for the second (NO). |
| `tokenName` | `+<10 * outcome + side>`, the spot coin name Hyperliquid uses for the token. |
| `total` | Tokens held. Each pays 1 USDC if the side wins. |
| `hold` | Part of `total` locked behind the address's resting sell orders. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"--address is required"}` | No address given. | Ask the user for the address. |
| 3 | `{"error":"upstream",...}` | Endpoint failed, or the address was malformed and rejected upstream. | Check the address format, retry once, then report the JSON. |

## Notes

- Only outcome tokens (`+...` coins) with a positive balance are listed. The USDC balance is not part of this command.
- Pair an entry with `verdict market <outcome>` to show the user the market name and its rule.
- Read from the same public endpoint as any explorer; holding the key is not required.
