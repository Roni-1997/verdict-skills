# markets

List the live Verdict outcome markets for one venue. Each market carries the settlement rule text substituted from the template it was deployed from.

Read only. No account, no key, no confirmation. Run it yourself and show the user the result.

| Intent | CLI | MCP tool |
|---|---|---|
| "what markets are on Verdict", "list HIP-4 markets", "what can I trade" | `verdict markets` | `list_markets {}` |
| markets of another deployer | `verdict markets --venue <name>` | `list_markets { "venue": "<name>" }` |
| include expired or settled markets | `verdict markets --include-expired` | `list_markets { "includeExpired": true }` |

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--venue <name>` | `VERDICT_VENUE` | Deployer venue to list. Overrides the environment. If neither is set, every deployer's markets are listed. |
| `--include-expired` | off | Keep markets whose `expiresAt` is already in the past. |
| `--pretty` | off | Indent the JSON. |

## Output

Trimmed to one market. Recorded from the mainnet fixtures (venue `out`) on 2026-09-13; testnet output has the same shape. Values are as recorded on 2026-09-13 and may differ on a later run: `count` follows expiries (83 at recording time; the same fixture lists 82 without `--include-expired` once market 2940 expired later that day, 83 with it).

```json
{
  "network": "mainnet",
  "venue": "out",
  "count": 83,
  "markets": [
    {
      "outcome": 1210,
      "venue": "out",
      "displayName": "BTC above 100000 at 20261001-0000?",
      "templateId": "binaryPrice",
      "underlying": "BTC",
      "threshold": "100000",
      "expiresAt": "2026-10-01T00:00:00.000Z",
      "settlementRule": "The market resolves to Yes if the BTC price is above 100000 at 20261001-0000, and otherwise resolves to No. Settlement is according to the 1-second TWAP of BTC-USDC mark price ending at 20261001-0000. If BTC is delisted before this market settles, settlement is instead according to the BTC settlement price at delisting.",
      "sides": [
        { "index": 0, "name": "template:Yes", "coin": "#12100", "assetId": 100012100 },
        { "index": 1, "name": "template:No", "coin": "#12101", "assetId": 100012101 }
      ],
      "deployerFeeScale": "1.0"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `outcome` | Market index. Every other command takes it as `<outcome>`. |
| `settlementRule` | The text the market settles on. Quote it verbatim; never paraphrase it in a confirmation. `null` when the market was not deployed from a known template. |
| `expiresAt` | ISO 8601 UTC, parsed from the market's `time` or `expiry` keyword; `null` when unknown. |
| `sides[].name` | Often prefixed `template:`. `--side yes` and `--side no` still resolve. |
| `sides[].coin` | `#<10 * outcome + side>`; the coin of that side's order book. |
| `sides[].assetId` | `100000000 + 10 * outcome + side`; the `a` field of an order. |
| `deployerFeeScale` | Fee multiplier the deployer set for the venue, as a string. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | usage text | Unknown flag. | Fix the flag and run once more. |
| 3 | `{"error":"upstream","kind":"http" or "schema" or "network","message":...}` | The Hyperliquid info endpoint failed, timed out (10 s), or returned an unexpected shape. | Retry once after a few seconds. Then stop and report the JSON. |

## Notes

- Fallback container outcomes (`template fallback`) are dropped from the list.
- The list is a live snapshot. Run the command again instead of reusing a list from an earlier turn.
- Testnet and mainnet have different market indices. State the network when you show the list.
- Cross-venue comparison (Polymarket, Kalshi, Deribit) is not a command in this CLI version. If asked, say so and offer the Verdict-side facts; do not estimate a gap from memory.
