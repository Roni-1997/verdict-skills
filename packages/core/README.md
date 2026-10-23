# @verdict/core

The typed tool module behind the Verdict agent kit: a Hyperliquid info client with Zod schemas on every response, the HIP-4 outcome market catalogue with settlement rules, books and quotes, trade and order data, the cross-venue tools over the Verdict app's engine (Polymarket and Kalshi comparison, Deribit fair value, hedges, opportunity scan), positions and builder-fee status, and the two unsigned payload builders that carry Verdict's builder code. The `@verdict/cli` and `@verdict/mcp` packages are thin faces over this module; a bot can call it directly.

Not published yet. Once it is:

```sh
pnpm add @verdict/core
```

```ts
import { configFromEnv, toolsFromConfig } from '@verdict/core';

const tools = toolsFromConfig(configFromEnv());
const { count, markets } = await tools.list_markets({}); // each market carries its settlementRule
const quote = await tools.quote({ outcome: 1210, side: 'yes', action: 'buy', size: 100 });
console.log(count, markets.length, quote.averagePrice, quote.complete);
```

Every tool is deterministic and typed on input and output. Nothing here signs: `build_order` and `approve_builder_fee_payload` return unsigned payloads for the caller's own signer. Testnet by default.

## Execute through the local broker

`connectExecution()` connects to the separately installed operator-owned Python broker.
The operator explicitly selects `per_order` confirmation or a bounded `policy` grant.
The client holds no keys; its expected mode is checked on every request.

```ts
import { connectExecution, prepareExecution } from '@verdict/core';

const client = await connectExecution({ expectedMode: 'policy' });
const proposal = prepareExecution(request);
// Save this exact proposal before submitting it.
await client.preflight(proposal);
const result = await client.submit(proposal);
const status = await client.status(proposal);
await client.cancel({ proposal, leg: 0 });
```

Set `VERDICT_BROKER_SOCKET` in the client environment, or pass an operator-configured
`socketPath`. Call `capabilities()` to inspect the selected authority and remaining
budget. Preflight grants no authority, and submission always repeats fresh checks.
An `ExecutionDeliveryUnknownError` retains the original digest. Reconcile that saved
proposal with `status`; do not automatically retry or prepare a replacement.

See the [broker setup and policy guide](../../local-runner/README.md) and
[persisted-proposal example](../../examples/execution/agent.mjs). These examples require
operator setup before execution. The test suite uses fake venues and temporary keys;
funded acceptance remains unverified.

Documentation, rules and the skill file: https://github.com/Roni-1997/verdict-skills#readme
