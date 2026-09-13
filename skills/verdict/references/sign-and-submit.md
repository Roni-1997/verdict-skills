# sign-and-submit: done by the caller, never by the kit

What `build-order` and `approve-builder-fee-payload` leave to you. No `verdict` command signs anything or talks to `/exchange`. The MCP server has no signing tool. The CLI and the MCP server never read `HL_AGENT_PRIVATE_KEY`; that variable is a convention for the caller's own local signing step.

Where signing may happen: on the user's machine, in memory, with the user's own key, after a real confirmation in a new message. Never on a hosted MCP server, never in a shared process, never after a confirmation you wrote yourself.

If you are an agent following SKILL.md, you are not the signer either. Do not write ad-hoc signing code and do not install packages at trade time. Hand the unchanged action to the user's own signer or wallet and stop. This page describes what the user's signer (their own script, SDK or wallet) does with the payload, so that you can explain it and read its response.

## Endpoints

| Network | `/exchange` | `hyperliquidChain` | `signatureChainId` |
|---|---|---|---|
| testnet (default) | `https://api.hyperliquid-testnet.xyz/exchange` | `Testnet` | `0x66eee` (Arbitrum Sepolia, 421614) |
| mainnet | `https://api.hyperliquid.xyz/exchange` | `Mainnet` | `0xa4b1` (Arbitrum One, 42161) |

Use the network the payload was built for. The chain fields inside an approval payload already say which.

## Nonce

- Milliseconds since the epoch at signing time (`Date.now()`).
- Must be unique per signing address and inside the window Hyperliquid accepts: not older than about two days, not more than about a day in the future. A reused or stale nonce is rejected.
- `build-order` returns no nonce; you add one when you sign. `approve-builder-fee-payload` includes `action.nonce`; submit with that same value, or rebuild the payload if it is stale.

## A. Orders: agent key, L1 action

Prerequisites: an agent key approved for the user's account (the `approveAgent` action, done once in the Verdict app or any Hyperliquid front end), the account has approved the builder fee (`verdict builder-status` shows `approved: true`), spot USDC for a buy or the outcome tokens for a sell.

1. Take `action` from `build-order` exactly as returned. Do not reorder keys, do not add or remove fields, do not reformat the price string. msgpack encodes map keys in insertion order and the hash depends on it.
2. Compute the action hash: `keccak256( msgpack(action) || nonce as 8 bytes big-endian || 0x00 )`. The trailing byte `0x00` means no vault address. (If you ever set `expiresAfter`, it is appended as 8 bytes big-endian after that byte; the kit does not use it.)
3. Sign this EIP-712 message with the agent private key:

| Part | Value |
|---|---|
| domain | `{ "name": "Exchange", "version": "1", "chainId": 1337, "verifyingContract": "0x0000000000000000000000000000000000000000" }` (1337 on both networks) |
| types | `Agent: [ { "name": "source", "type": "string" }, { "name": "connectionId", "type": "bytes32" } ]` |
| primaryType | `Agent` |
| message | `{ "source": "a" on mainnet or "b" on testnet, "connectionId": <the hash from step 2> }` |

4. Split the 65-byte signature into `{ r, s, v }`.
5. POST JSON to `/exchange`:

```json
{ "action": <action from build-order>, "nonce": <nonce>, "signature": { "r": "0x...", "s": "0x...", "v": 27 }, "vaultAddress": null }
```

6. Read the response. `status: "ok"` is the envelope; the per-order result is inside:

```json
{ "status": "ok", "response": { "type": "order", "data": { "statuses": [ { "resting": { "oid": 123456 } } ] } } }
```

`statuses[i]` is one of `{ "resting": { "oid" } }`, `{ "filled": { "totalSz", "avgPx", "oid" } }` or `{ "error": "..." }`. An `ok` envelope can still carry an `error` status. Report it as JSON.

Do not write ad-hoc signing code and do not install packages at trade time. Hand the unchanged action to the user's own signer or wallet and stop. The steps above are what the user's existing signer or SDK does with `action`; they are not a recipe for you to implement at trade time.

## B. Builder fee approval: main wallet, user-signed action

1. Take `typedData` from `approve-builder-fee-payload` and have the MAIN wallet sign it (`signTypedData` or `eth_signTypedData_v4`). Agent and API wallet signatures are rejected for this action type.
2. POST to `/exchange`:

```json
{ "action": <action from the payload>, "nonce": <action.nonce>, "signature": { "r": "0x...", "s": "0x...", "v": 27 } }
```

3. Verify with `verdict builder-status <address>`.

## Typical rejections (wording varies)

| Cause | Fix |
|---|---|
| Builder fee not approved, or approved below `f` | `verdict builder-status`, then the approval flow |
| Agent key not approved for this account, or approved on the other network | approve the agent on the same network as `VERDICT_NETWORK` |
| Nonce reused or outside the window | new `Date.now()` and sign again |
| Not enough spot USDC (buy) or tokens (sell) | `verdict positions`; reduce the size |
| Price not on the tick | rebuild with at most 5 decimals |
| Market expired or settled | `verdict markets` without `--include-expired` |

## Key handling

- Export `HL_AGENT_PRIVATE_KEY` in the shell session that runs your signing step. Do not put it in a `.env` inside the repository, do not paste it into a chat, do not commit it, never set it on a hosted server.
- Use an agent key for orders, not the main wallet's key. An agent can trade; it cannot withdraw or transfer funds.
- Rotate by approving a new agent; the old one stops working.
- Never log or store a signed payload. A signed order is a spendable instruction until its nonce expires.
- Do not run `env`, `printenv` or `export -p`, and do not echo, log or print a request body, while the key is exported. An agent transcript is a hosted path: whatever a command prints leaves the machine.
