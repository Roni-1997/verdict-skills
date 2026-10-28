# @verdict/core

The typed SDK behind Verdict's Lighter agent kit. Public tools discover binary outcome markets, read settlement rules, quote executable prices with liquidity and fees, and prepare unsigned official SDK arguments. The execution client connects to a separate authorized broker for preflight, submission, status, and cancellation.

The package is not published yet. Build from the [source repository](https://github.com/Roni-1997/verdict-skills) as described in the root README.

## Research Lighter markets

Run this source-checkout example from the repository root after `pnpm run build`. The package name is not installed at the workspace root and is not available from npm yet.

```sh
node --input-type=module <<'JS'
import { LighterClient, createLighterTools, lighterConfigFromEnv } from './packages/core/dist/index.js';

const config = lighterConfigFromEnv({ LIGHTER_NETWORK: 'testnet' });
const tools = createLighterTools(new LighterClient(config));
const page = await tools.list_markets({ limit: 50 });
const market = page.markets[0];
if (!market) throw new Error('No market on this page; check discovery and its cursor.');
const quote = await tools.quote({
  market: market.market_id, side: 'yes', action: 'buy', size: '10',
});
console.log(quote.network, quote.averagePrice, quote.filledShares, quote.complete);
JS
```

Research defaults to devnet unless `LIGHTER_NETWORK` selects another network. Use testnet explicitly for staging. Follow discovery pagination and keep numeric account, creator, and market IDs on their original network. `LIGHTER_CREATORS` supplies the operator-reviewed allowlist for unsigned order preparation.

Quotes are snapshots, not fill promises or balance checks. Amounts use decimal strings and market tick precision. Public fee estimates can differ from account discounts. Selling is not reduce-only and can open the opposite position.

## Connect authorized execution

`connectExecution()` uses the separately installed operator-owned Python broker. The operator explicitly selects `per_order` or a previously approved bounded `policy` grant. The client holds no venue keys and checks the expected mode on every request.

Start the separately configured operator broker before running this source-checkout example. A missing broker or socket is not a hosted account connection; hosted users connect through the [MCP setup](../../README.md#connect-the-hosted-mcp).

```sh
node --input-type=module <<'JS'
import { connectExecution } from './packages/core/dist/index.js';

const client = await connectExecution({ expectedMode: 'per_order' });
const capabilities = await client.capabilities();
console.log(capabilities);
JS
```

Set `VERDICT_BROKER_SOCKET` or pass the operator's `socketPath`. For a reviewed single-Lighter request, `prepareExecution()` produces the canonical unsigned proposal. Persist it unchanged before calling `preflight()` and `submit()`. Preflight grants no authority. Per-order approval belongs to the operator's terminal, and policy mode requires an existing bounded grant.

An `ExecutionDeliveryUnknownError` retains the original digest. Reconcile the saved proposal with `status()`. Never automatically retry or prepare a replacement. `cancel({ proposal, leg: 0 })` refers to the sole original order and can race fills.

The hosted MCP adds independent signed-in browser review and Lighter-only input schemas over this same broker lifecycle. The consumer staging flow prepares spend-bounded buy IOC orders using the linked account. Owner approval and observed venue reconciliation remain required for each applicable order. Automated fixtures do not establish a user's live venue acceptance.

See [the execution workflow](../../skills/verdict/references/execution.md), [broker operations](../../local-runner/README.md), and [hosted account service](../../docs/account-service.md). Automated tests do not place funded trades.

## Retained compatibility tooling

Generic execution types and older venue, comparison, and engine factories remain for existing internal callers and canonical history. They are historical tooling, not the default agent workflow or an expansion of the active MCP's Lighter-only permissions. Preserve original proposals when reconciling old attempts.
