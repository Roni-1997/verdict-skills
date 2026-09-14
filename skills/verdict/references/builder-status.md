# builder-status

Whether an address has approved Verdict's builder fee, and up to what maximum rate. Hyperliquid accepts an order carrying `builder: { b, f }` only from accounts that approved builder `b` for at least rate `f`. This has to happen once per address.

Read only. No key, no confirmation. Needs `VERDICT_BUILDER_ADDRESS` in the environment (exit 4 otherwise).

| Intent | CLI | MCP tool |
|---|---|---|
| "have I approved the builder fee", "can I trade through Verdict yet", "check builder approval for 0x..." | `verdict builder-status <address>` | `builder_status { "address": "0x..." }` |

## Arguments

| Argument | Meaning |
|---|---|
| `<address>` | The user's main account address (not the agent key's address). |
| `--pretty` | Indent the JSON. |

## Output

Recorded on 2026-09-13 with builder `0x...b1` at 10 tenths of a basis point. Values are as recorded on 2026-09-13 and may differ on a later run; numbers appear exactly as the CLI prints them. Approved:

```json
{
  "address": "0x00000000000000000000000000000000000000a1",
  "builder": "0x00000000000000000000000000000000000000b1",
  "approvedMaxTenthsBp": 10,
  "requiredTenthsBp": 10,
  "approved": true,
  "nextStep": "Approved. Orders built by the kit can be signed and submitted by this address."
}
```

Not approved:

```json
{
  "address": "0x00000000000000000000000000000000000000a2",
  "builder": "0x00000000000000000000000000000000000000b1",
  "approvedMaxTenthsBp": 0,
  "requiredTenthsBp": 10,
  "approved": false,
  "nextStep": "Not approved yet. Call approve_builder_fee_payload, show it to the user, and have the MAIN wallet sign it once."
}
```

| Field | Meaning |
|---|---|
| `approvedMaxTenthsBp` | Hyperliquid's `maxBuilderFee` for this user and builder, in tenths of a basis point. 10 means 0.01%, which is 10 cents per $1,000 of notional. |
| `requiredTenthsBp` | `VERDICT_BUILDER_FEE_TENTHS_BP`, the rate every order the kit builds carries. |
| `approved` | `approvedMaxTenthsBp >= requiredTenthsBp`. |
| `nextStep` | What to do next, in words. |

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | `{"error":"bad_input","message":"--address is required"}` | No address given. | Ask for the address. |
| 3 | `{"error":"upstream",...}` | Info endpoint failed. | Retry once, then report the JSON. |
| 4 | `{"error":"not_configured",...}` | `VERDICT_BUILDER_ADDRESS` unset or the zero address. | Do not retry. Tell the user which variable to set; the owner publishes the address. |

## Notes

- Check this before `build-order`. An order from an unapproved address is rejected by Hyperliquid after signing, which wastes the confirmation.
- If `approved` is false and the user wants to trade, go to `approve-builder-fee-payload.md`. That command is signable and follows the two-message rule; do not run it in the same turn as this check unless the user has asked to set up trading.
