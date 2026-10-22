# Replay a fictional pair

`assessment.json` is synthetic demonstration data, not a captured quote or a real equivalent
market pair. Its fixed clock allows deterministic offline replay without any venue requests.

After building, run from the repository root:

```sh
node packages/cli/dist/bin.js strategy assess --file examples/strategy/assessment.json --pretty
```

The maximum per-leg loss is $5, so the planner reduces the ten-share request to nine matched
shares. The result is conditional paper research and has `liveReady:false`.

To compare complete and missed-leg scenarios through the core API:

```js
import { readFile } from 'node:fs/promises';
import { createStrategyTools } from '@verdict/core';

const request = JSON.parse(await readFile('examples/strategy/assessment.json', 'utf8'));
const tools = createStrategyTools();
const both = await tools.paper_pair({ ...request, direction: 'hl_yes', fills: { hl: '9', lighter: '9' } });
const missed = await tools.paper_pair({ ...request, direction: 'hl_yes', fills: { hl: '9', lighter: '0' } });
```

The second result exposes nine HL YES shares and reports a negative conditional floor P&L.
Neither call signs, sends orders or moves funds.
