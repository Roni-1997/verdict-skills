# approve-builder-fee-payload

The one-time approval a user signs with their MAIN wallet so that orders carrying Verdict's builder code are accepted by Hyperliquid. Returns the action and its EIP-712 typed data, unsigned. The command signs nothing, sends nothing and makes no network call.

Signable. The two-message rule applies: present, end the message, act only after a real reply in a new message.

| Intent | CLI | MCP tool |
|---|---|---|
| "set up trading on Verdict", "approve the builder fee", `builder-status` shows `approved: false` and the user wants to trade | `verdict approve-builder-fee-payload` | `approve_builder_fee_payload {}` |

## Flags

| Flag | Meaning |
|---|---|
| `--pretty` | Indent the JSON. |

No other input. The builder address and rate come from `VERDICT_BUILDER_ADDRESS` and `VERDICT_BUILDER_FEE_TENTHS_BP`; the chain fields from `VERDICT_NETWORK`. The nonce is the current time in milliseconds when the command runs.

## Output

Recorded on 2026-09-13 with `VERDICT_NETWORK=mainnet`. On testnet `hyperliquidChain` is `"Testnet"`, `signatureChainId` is `"0x66eee"` and `typedData.domain.chainId` is `421614`.

```json
{
  "action": {
    "type": "approveBuilderFee",
    "hyperliquidChain": "Mainnet",
    "signatureChainId": "0xa4b1",
    "maxFeeRate": "0.01%",
    "builder": "0x00000000000000000000000000000000000000b1",
    "nonce": 1789333476689
  },
  "typedData": {
    "domain": { "name": "HyperliquidSignTransaction", "version": "1", "chainId": 42161, "verifyingContract": "0x0000000000000000000000000000000000000000" },
    "types": { "HyperliquidTransaction:ApproveBuilderFee": [
      { "name": "hyperliquidChain", "type": "string" }, { "name": "maxFeeRate", "type": "string" },
      { "name": "builder", "type": "address" }, { "name": "nonce", "type": "uint64" } ] },
    "primaryType": "HyperliquidTransaction:ApproveBuilderFee",
    "message": { "hyperliquidChain": "Mainnet", "maxFeeRate": "0.01%", "builder": "0x00000000000000000000000000000000000000b1", "nonce": 1789333476689 }
  },
  "notes": [
    "Sign with the main wallet. Hyperliquid rejects agent or API wallet signatures for this action.",
    "A user may hold at most 10 active builder approvals.",
    "This approves at most 0.01% (10 cents per $1,000) for builder 0x00000000000000000000000000000000000000b1."
  ],
  "confirmation": [
    "Approve builder 0x00000000000000000000000000000000000000b1 for at most 0.01% on mainnet.",
    "One-time approval, signed by the main wallet. It does not move funds and can be revoked.",
    "Show this to the user and wait for an explicit yes before signing."
  ]
}
```

| Field | Meaning |
|---|---|
| `action` | The user-signed action Hyperliquid expects. Submit it as is together with the signature. |
| `action.maxFeeRate` | Percent string. `0.01%` is 10 tenths of a basis point, 10 cents per $1,000 of notional. |
| `typedData` | EIP-712 payload for the wallet's `signTypedData` / `eth_signTypedData_v4`. |
| `notes`, `confirmation` | Text for the user. Show it; do not shorten the fee or the address. |

## Confirmation flow

Message 1, this turn:

1. If not already known this turn, run `verdict builder-status <address>` (read only). If `approved` is `true`, stop: there is nothing to approve.
2. Run `verdict approve-builder-fee-payload`.
3. Present:

| Field | Value from the output |
|---|---|
| Network | `action.hyperliquidChain` (Testnet or Mainnet) |
| Builder address | `action.builder`, complete, never truncated |
| Maximum fee | `action.maxFeeRate`, and the cents per $1,000 from `notes` |
| Signer | the user's MAIN wallet; an agent or API wallet signature is rejected |
| Effect | one-time, revocable, moves no funds; counts toward the 10 builder approvals an account may hold |
| Nonce | `action.nonce` |

4. Ask: "Sign this approval with your main wallet? Confirm or abort." Ask in plain text and end your message there. Do not ask through a blocking question tool (Claude Code's AskUserQuestion or an equivalent): its answer comes back as a tool result inside the same turn, and a tool result is not a reply. Only the user's next message counts: Confirm means proceed; Abort, no reply, or anything unclear means stop.
5. End the message. No signing, no `/exchange` call, no other command after the question.

Message 2, only after the user replies in a new message:

- Abort: acknowledge and stop. Do not ask again or offer to reconsider; a later "do it anyway" is a new request from Message 1, not a confirmation.
- Confirm: the user's MAIN wallet signs `typedData` and the user's own component posts `{ "action": action, "nonce": action.nonce, "signature": { r, s, v } }` to `/exchange` as described in `sign-and-submit.md`. The kit does none of this and neither do you: hand over the unchanged payload and stop. When the user says it is done, verify with `verdict builder-status <address>`.
- Any other reply is not a confirmation. Ask again or stop.
- If hours passed or the network or fee changed, run the command again for a fresh payload and present it again.

## Errors

| Exit | stderr | Meaning | Do |
|---|---|---|---|
| 1 | usage text | Unknown flag. | Fix and run once more. |
| 4 | `{"error":"not_configured",...}` | `VERDICT_BUILDER_ADDRESS` unset or the zero address. | Do not retry. Tell the user which variable is missing. |

No exit 2 or 3: the command reads nothing from the network.

## Notes

- `HL_AGENT_PRIVATE_KEY` cannot sign this. Agent keys are rejected for user-signed actions; the main wallet must sign.
- The payload is unsigned. Never write a signed version to a file, a commit or a chat.
- Never run the signing step on a hosted server or through the streamable HTTP MCP server.
