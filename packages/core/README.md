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

Documentation, rules and the skill file: https://github.com/Roni-1997/verdict-skills#readme
