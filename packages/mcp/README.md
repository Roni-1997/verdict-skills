# @verdict/mcp

[Source repository](https://github.com/Roni-1997/verdict-skills).

`@verdict/mcp` exposes Verdict's Lighter binary outcome tools over stdio or streamable HTTP. The default server needs no account and holds no keys. `--lighter` selects the same default. `--strategy` is unavailable in the active kit.

## Modes

| Mode | Authority and tools |
|---|---|
| Default | Nine `lighter_*` research and unsigned SDK preparation tools. |
| `--execution` | Keyless preparation, exact review, and capabilities for a single Lighter order. |
| `--local-execution` | Preparation, review, preflight, submission, status, and cancellation through the operator-owned broker. The operator explicitly configures `per_order` or `policy`. |
| `--hosted-execution` | Authenticated research and the same single-order lifecycle through a configured private signer. |
| `--account-service` | Hosted mode with first-party login, account connection, reviewed client permissions, OAuth, and disconnect. |

Execution modes cannot be combined. Use the default server as a separate research connection when local execution has its own server entry. No tool issues grants, changes execution mode, or approves an order.

## Research

The tools are `lighter_list_markets`, `lighter_get_market`, `lighter_orderbook`, `lighter_quote`, `lighter_recent_trades`, `lighter_positions`, `lighter_fee_schedule`, `lighter_build_order`, and `lighter_build_cancel`. The resource `verdict-lighter://markets` returns one page of market discovery. Follow `nextCursor`.

`LIGHTER_NETWORK` selects `devnet`, `testnet`, or `mainnet`. Research defaults to devnet. `LIGHTER_CREATORS` filters discovery and permits unsigned payload preparation for those creators. Every result reports its network. No other venue's configuration determines Lighter's network or identifiers.

`lighter_build_order` and `lighter_build_cancel` return unsigned official SDK arguments. They never sign or submit. Selling is not reduce-only and can open the opposite side.

## Execution

The active execution schemas accept one Lighter leg. They reject other venues and paired proposals before dispatch. Cancellation uses `leg: 0` from the original proposal.

| Tool | Effect |
|---|---|
| `execution_prepare` | Build an unsigned canonical proposal for the exact account and network. |
| `execution_prepare_lighter_intent` | When configured on the hosted service, derive a buy proposal from a stable intent UUID and maximum USDC spend including fees. Uses the linked account, reviewed creator scope, and fresh public depth. |
| `execution_review` | Verify unchanged content and render the full trade terms. |
| `execution_preflight` | Check fresh account, market, fee, balance, and authority constraints. Grants no approval or reservation. |
| `execution_submit` | Submit under the existing authority or return an independent review URL in hosted `per_order` mode. |
| `execution_status` | Reconcile the original proposal after a known or uncertain attempt, including after proposal expiry. |
| `execution_cancel` | Request exact cancellation of the sole originally attempted order. Cancellation can race fills. |
| `execution_capabilities` | Report the active Lighter capability and actual configured execution boundaries. |

Hosted services also report linked accounts and connection status when configured. A review URL, digest, model statement, or MCP tool result is never consent. In hosted `per_order` mode, only the independently signed-in user can approve the exact order. Local per-order approval uses the operator's terminal. Explicit `policy` mode requires a previously owner-approved bounded grant.

Persist proposals unchanged. Reusing a hosted intent UUID returns its original proposal. After `delivery_unknown`, call `execution_status` with that same proposal. Never automatically reprepare or resubmit an uncertain order.

## Transport and hosting

```sh
	LIGHTER_NETWORK=testnet verdict-mcp
	LIGHTER_NETWORK=testnet verdict-mcp --http 8787
```

The local HTTP server binds loopback by default and has no built-in authentication. `GET /healthz` identifies its active mode. Use an authenticated gateway before exposing it remotely.

The hosted staging endpoint is [verdict-mcp-staging.vercel.app/mcp](https://verdict-mcp-staging.vercel.app/mcp). Hosted execution requires OAuth, configured identity, reviewed account provisioning, durable storage, and a separate private signer. Real sign-in resume and full staging order acceptance remain blocked. See [the deployment guide](../../deploy/README.md).
