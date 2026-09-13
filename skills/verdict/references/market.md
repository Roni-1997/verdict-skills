# market

One market in full: sides, coins, token names, asset ids, the raw onchain description and its keywords, settlement rule, semantic restriction, expiry, quote token, deployer fee scale.

Read only. No account, no key, no confirmation.

| Intent | CLI | MCP tool |
|---|---|---|
| "what does market 1210 settle on", "details of this market", "show me the rule", "when does it expire" | `verdict market <outcome>` | `get_market { "outcome": <outcome> }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<outcome>` | Nonnegative integer market index, from `verdict markets`. |
| `--pretty` | Indent the JSON. |

## Output

Recorded from the mainnet fixtures (outcome 1210) on 2026-09-13.

```json
{
  "outcome": 1210,
  "venue": "out",
  "name": "template:binaryPrice",
  "templateId": "binaryPrice",
  "description": "perp:BTC|priceDescription:BTC-USDC mark|seconds:1|threshold:100000|time:20261001-0000",
  "keywords": { "perp": "BTC", "priceDescription": "BTC-USDC mark", "seconds": "1", "threshold": "100000", "time": "20261001-0000" },
  "sides": [
    { "index": 0, "name": "template:Yes", "coin": "#12100", "tokenName": "+12100", "assetId": 100012100 },
    { "index": 1, "name": "template:No", "coin": "#12101", "tokenName": "+12101", "assetId": 100012101 }
  ],
  "quoteToken": "USDC",
  "deployerFeeScale": "1.0",
  "displayName": "BTC above 100000 at 20261001-0000?",
  "settlementRule": "The market resolves to Yes if the BTC price is above 100000 at 20261001-0000, and otherwise resolves to No. Settlement is according to the 1-second TWAP of BTC-USDC mark price ending at 20261001-0000. If BTC is delisted before this market settles, settlement is instead according to the BTC settlement price at delisting.",
  "semanticRestriction": "This market must refer to the price of a Hyperliquid perp.",
  "expiresAt": "2026-10-01T00:00:00.000Z",
  "underlying": "BTC",
  "threshold": "100000",
  "priceDescription": "BTC-USDC mark",
  "twapSeconds": 1
}
```

| Field | Meaning |
|---|---|
| `name` | Onchain name; `template:<id>` for template markets. |
| `description`, `keywords` | The raw `key:value\|key:value` string and its parsed map. These are the values substituted into the rule. |
| `settlementRule` | Template rule text with the keywords substituted. This is what the market pays on. |
| `semanticRestriction` | What the template is allowed to describe, when the template states one. |
| `sides[].tokenName` | `+<encoding>`; the coin name of that side in spot balances (see `positions`). |
| `quoteToken` | What one token pays if its side wins. |
| `twapSeconds` | Length of the settlement TWAP when the template uses one; `null` otherwise. |
| `expiresAt` | When the market is meant to settle; `null` when the description has no `time` or `expiry`. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input",...}` | `<outcome>` missing or not a nonnegative integer. | Fix the argument. |
| 2 | `{"error":"not_found",...}` | No market with that index on the configured network. | Do not retry. Run `verdict markets` and pick from it. Check `VERDICT_NETWORK`: testnet and mainnet indices differ. |
| 3 | `{"error":"upstream",...}` | Info endpoint failed or drifted. | Retry once, then report the JSON. |

## Notes

- When you present a market to the user, show `displayName`, `settlementRule` verbatim, `expiresAt`, and the network.
- A market with `settlementRule: null` was not deployed from a template the kit knows. Say so; do not invent a rule.
