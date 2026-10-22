# Setup and unsigned signing contract

Build the existing Verdict workspace as described in the [repository README](../../../README.md).
The Lighter adapter adds no dependency and does not install the upstream Python kit or run its installer.

## MCP

Replace `/absolute/path/to/verdict-skills` with the clone path:

```json
{
  "mcpServers": {
    "verdict-lighter": {
      "command": "node",
      "args": ["/absolute/path/to/verdict-skills/packages/mcp/dist/bin.js", "--lighter"],
      "env": { "LIGHTER_NETWORK": "devnet" }
    }
  }
}
```

Use that server entry in an MCP-capable client such as Codex, Claude Desktop or Cursor.
For clients configured through a UI, use the same command, arguments and environment values.
Streamable HTTP uses `node packages/mcp/dist/bin.js --lighter --http 8788`, binding loopback by default.
The server has no authentication: any remote deployment needs an authenticated gateway.
The existing Hyperliquid server remains available without `--lighter`.

To make this skill discoverable, register this `skills/verdict-lighter` directory with the agent's
skill mechanism. The existing Verdict install script installs the Hyperliquid skill only.
Do not run Lighter's upstream installer to install this adapter; it installs a different skill.

| Setting | Meaning |
|---|---|
| `LIGHTER_NETWORK` | `devnet` (default, chain 300) or `mainnet` (chain 304). Never infer it from Hyperliquid configuration. |
| `LIGHTER_CREATORS` | Comma-separated creator account indices. When absent, discovery reads all creators but unsigned order/cancel preparation is disabled. When configured, discovery filters that page and payload tools enforce the same allowlist. An empty filtered page can still have a next cursor. |

Use creator indices verified by the operator on the selected network. No mainnet Verdict
creator or integrator-fee agreement is assumed by this kit. It adds no Hyperliquid builder code.
`VERDICT_API_URL` affects only the Hyperliquid tools; Lighter reads its fixed official REST hosts directly.
No private key or authentication token is configured in the kit.

## Prepare an order

1. Read the current market and its settlement rule; request a quote for the intended side, action and shares.
2. Build an order with the side's USDC price and a unique client order index, from 0 through `2^48−1`.
3. Show the returned confirmation, including network, rule, side, price, shares, market fee estimate and the sell warning. Wait for the user's explicit reply.
4. Hand the unchanged `sdkArgs` to the caller's local Lighter signer. The signer must match the returned network/chain and its own account/key, recheck market state, available collateral, all open orders and actual fee multiplier, and reserve a fresh nonce just before signing. The unsigned kit has not proved account solvency or execution eligibility.

The official Python SDK accepts these arguments through `SignerClient.create_order(**sdkArgs)`.
Its binary examples require current binary-capable SDK/signer versions; see the
[official binary trading guide](https://apidocs.lighter.xyz/docs/binary-options-trading-and-fees).
The SDK performs signing/submission; that step belongs entirely to the caller's local signer, not an agent-driven shell or hosted MCP process.
Do not pass network IDs from one tool result into a signer for another network.
`order_expiry=-1` is the SDK's default 28-day sentinel; IOC uses `0`. The market's trading window still governs acceptance.

`sdkMethod=cancel_order` uses `sdkArgs.order_index` equal to the **original client order index**.
Do not substitute an exchange order ID: those can exceed JavaScript's exact number range.
The caller must verify the order and account before signing. Cancels remain possible outside the trading window.

The fee estimate includes market fees at multiplier 1, not configured integrator fees. It does
not imply a commercial revenue share. Authenticated open-order history, full account fills,
settlement P&L, amendments and cross-venue comparisons are not implemented by this adapter.

## Upstream basis

Reviewed [elliottech/lighter-agent-kit](https://github.com/elliottech/lighter-agent-kit) at
`9798b37230d631b4a09a5a28d2436f5405a00992` on October 21, 2026. Its scripts support perps/spot;
their asset discovery and paper fills do not support binary outcomes. This adapter follows
its human-unit input convention and official SDK contract, but uses `/events` for binaries,
never the upstream kit's perp/spot order discovery. No upstream script is vendored or executed.
Public fixtures and endpoint provenance are in the repository's `tests/fixtures/lighter` directory.
