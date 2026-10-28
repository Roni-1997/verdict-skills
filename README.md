# Verdict agent kit

Let an agent research and trade Verdict's binary outcome markets on Lighter through an MCP client, the TypeScript SDK, or the CLI. The kit supplies market rules, executable quotes, trade review, independent approval, SDK execution, and order reconciliation.

The default MCP is Lighter-only. It supports single orders. An agent can help a user choose and manage a trade. A research result or a promising price grants no trading authority.

## What works

The default `verdict-mcp` exposes nine `lighter_*` tools for public research and unsigned SDK arguments. Public research needs no login or key. Explicit execution modes add the order lifecycle through the separate official SDK broker.

| Task | Tool |
|---|---|
| Discover markets and settlement rules | `lighter_list_markets`, `lighter_get_market` |
| Check executable prices, liquidity, and fees | `lighter_orderbook`, `lighter_quote`, `lighter_fee_schedule` |
| Read recent prints and public positions | `lighter_recent_trades`, `lighter_positions` |
| Prepare unsigned official SDK arguments | `lighter_build_order`, `lighter_build_cancel` |
| Prepare a spend-bounded buy using the linked account | `execution_prepare_lighter_intent`, when hosted intents are configured |
| Review an exact proposal | `execution_prepare`, `execution_review`, `execution_preflight` |
| Submit, reconcile, or cancel an original order | `execution_submit`, `execution_status`, `execution_cancel` |

An operator explicitly selects one execution mode:

- `per_order` requires independent approval of each exact order. Hosted approval happens in the user's signed-in browser. Local approval happens in the operator's terminal.
- `policy` uses a previously owner-approved bounded grant. Its account, network, allowed terms, spend, order count, and expiry constrain execution. A model cannot choose this mode or create a grant.

The public MCP process holds no venue signing keys. The separate private signer uses the pinned official Lighter SDK. Account and authority checks run again before signing. A lost response requires reconciliation of the original proposal, never a replacement order.

## Connect the hosted MCP

Add a custom remote MCP server with this URL:

```text
https://verdict-mcp-staging.vercel.app/mcp
```

For Claude Code:

```sh
	claude mcp add --transport http --scope user verdict-hosted https://verdict-mcp-staging.vercel.app/mcp
```

Complete OAuth in the Verdict sign-in page. The hosted pilot uses Lighter testnet. It resumes saved account and key setup, and requests only missing ownership, registration or permission steps. Review any requested wallet signature yourself. A returning user does not need to create another venue account or key.

In hosted `per_order` mode, the agent opens the exact trade review and the signed-in user clicks **Confirm this order**. No additional chat confirmation is required before opening the review. Opening it sends no order. The agent cannot approve it for the user.

A remote connection needs no local SDK build or venue signing key in the MCP client. Clients must support Streamable HTTP MCP and OAuth; the URL alone does not prove a client's directory listing or interactive UI support. This remains a staging pilot, with no claim of mainnet or general availability.

Operators can read [the hosted connector guide](docs/hosted-connector.md), [the account service guide](docs/account-service.md), and [the deployment guide](deploy/README.md). A simulated test or green unit suite is not proof that a user's venue order was accepted.

## Use it from an agent

### Build the local research kit

Nothing is published to npm yet. Build from a clone with Node 22 and pnpm 10.34.5:

```sh
	git clone https://github.com/Roni-1997/verdict-skills.git
	cd verdict-skills
	pnpm install --frozen-lockfile
	pnpm run build
```

### Claude Desktop or Cursor

Use this entry in `claude_desktop_config.json` or `mcp.json`. Replace `<repo>` with the absolute clone path. `LIGHTER_NETWORK=testnet` selects staging explicitly. Without that setting, research defaults to devnet.

```json
{
  "mcpServers": {
    "verdict": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/bin.js"],
      "env": { "LIGHTER_NETWORK": "testnet" }
    }
  }
}
```

Set `LIGHTER_CREATORS` to operator-verified creator account indices to filter discovery and enable unsigned payload preparation. Accounts, creators, and market IDs belong to their selected network. Do not infer them from another network.

### Claude Code

```sh
	claude mcp add verdict -s user -e LIGHTER_NETWORK=testnet -- node <repo>/packages/mcp/dist/bin.js
```

For a SKILL.md agent, use [skills/verdict/SKILL.md](skills/verdict/SKILL.md). The `verdict-lighter` skill is a compatibility entry for the same Lighter workflow.

The optional installer builds the clone, writes marked launchers under `~/.local/bin`, and copies the default skill to `~/.claude/skills/verdict`:

```sh
	bash <repo>/skills/verdict/scripts/install.sh --claude-md
```

Its network access fetches the repository's lockfile-pinned npm dependencies from the npm registry, checked against `pnpm-lock.yaml`. It pipes nothing from the network into a shell. With `--claude-md`, the installer adds the managed routing block or replaces its exact old version. It preserves user-edited sections. Without that flag, it leaves `CLAUDE.md` alone.

`bash <repo>/skills/verdict/scripts/uninstall.sh` removes only recognized managed launchers, the marked skill copy, and an exact managed routing block. Both scripts are idempotent. Ask before changing user configuration unless the user already authorized the install.

### Local research over HTTP

```sh
	LIGHTER_NETWORK=testnet verdict-mcp --http 8787
```

The endpoint is `http://127.0.0.1:8787/mcp`, with `GET /healthz`. This unauthenticated research server holds no keys and signs nothing. Keep it on loopback or use an authenticated gateway. `--lighter` is a compatibility alias for the default. `--strategy` is unavailable in the active MCP kit.

### Authorized execution

`--execution` prepares and reviews unsigned single-Lighter proposals. `--local-execution` connects to an operator-owned local SDK broker. `--hosted-execution` and `--account-service` require a configured hosted service. They are explicit modes, not a way to enable signing on the default research server.

Use the [MCP reference](packages/mcp/README.md) for mode and tool boundaries, and the [execution skill reference](skills/verdict/references/execution.md) for the agent workflow. Local execution can use a separate default MCP connection for research. Do not place signing keys in MCP configuration, tool arguments, or chat.

## Configuration

| Setting | Meaning |
|---|---|
| `LIGHTER_NETWORK` | `devnet`, `testnet`, or `mainnet`. Default `devnet`. Select testnet explicitly for staging. |
| `LIGHTER_CREATORS` | Comma-separated operator-verified creator account indices. Without it, public discovery reads all creators and unsigned payload preparation is disabled. |
| `VERDICT_EXECUTION_MODE` | Explicit local broker mode assertion, `per_order` or `policy`. It grants no authority by itself. |
| `--connector-config <path>` | Operator configuration for hosted execution or account service. Keep private credentials outside the repository. |

Order inputs use decimal strings for USDC per share and share sizes. Quote averages can be numeric and are estimates, while exact executable limit prices remain available separately. The tools enforce market ticks. Quotes report fetched liquidity and estimated market fees. Account-specific discounts and future fills can differ. A sell can open the opposite position because reduce-only is unsupported.

## Develop and verify

```sh
	pnpm run check
	pnpm run bench:static
```

`check` runs engine and API drift checks, types, lint, release checks, broker tests, and the TypeScript suite. Static skill checks verify documentation rules; they do not prove live execution. The [goal](GOAL.md) defines the product and acceptance criteria.

The repository retains legacy adapters and their tests so canonical order history and internal consumers remain intact. Historical documentation is under [docs/legacy/hyperliquid-kit](docs/legacy/hyperliquid-kit/README.md). It describes an earlier product and is outside the installed skill corpus.
