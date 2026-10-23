# Local trading broker

Agents prepare unsigned orders through `verdict execution` or `verdict-mcp --execution`.
The TypeScript SDK exposes `connectExecution()` for preflight, submission, status and
cancellation through this separate operator-owned Python process. The broker uses the
official SDKs on Hyperliquid, Lighter binary outcomes and Polymarket. The operator selects
`per_order` confirmation or a bounded `policy` grant. Hosted CLI/MCP processes stay keyless.

Requires a clone of this repository, Node 22, Python 3.11, `uv`, and macOS or Linux. Install
dependencies before a trading session, review the SDK pins, and build the Node packages:

```sh
pnpm install --frozen-lockfile
pnpm run build
uv venv --python 3.11 local-runner/.venv
uv pip sync --python local-runner/.venv/bin/python local-runner/requirements.lock
cd local-runner
.venv/bin/python -m verdict_broker doctor
```

The example in `examples/execution/request.json` is synthetic and cannot pass live market
checks. Replace all identities, accounts, current titles/rules, limits and fee reserves.
Obtain actual market details using the existing `market` / `lighter market` commands or
the credential-free `public-market` command (all three venues). Polymarket uses the official
SDK `PublicClient.get_market(id=...)` / `get_order_book(asset_id=...)`.
Use the Gamma numeric market ID; match the exact YES/NO token ID, or V2 position ID.
Compare resolution sources, windows, cancellation/void behavior and payout rules manually.
Matching titles or an apparent spread do not establish equivalent contracts.

From the repository root, with **no secrets** in the agent's environment:

```sh
node packages/cli/dist/bin.js execution prepare --file examples/execution/request.json > proposal.json
node packages/cli/dist/bin.js execution review --file proposal.json --pretty
```

In per-order mode, the agent shows every confirmation line and waits for a real new human
reply. The operator confirms each exact order in their separate terminal. In policy mode,
the operator approves a bounded grant before starting the service. The agent cannot issue
a grant, select another grant, change modes or answer terminal prompts. A proposal digest
identifies content; it is not proof of authority.

In the operator's dedicated local shell only, configure credentials using their existing
secret-management workflow. Do not write keys into examples, `.env` files, transcripts,
proposals, MCP configuration or journals.

| Venue | Operator environment | Requirements |
|---|---|---|
| HL | `VERDICT_HL_AGENT_PRIVATE_KEY` | Dedicated agent approved for the proposal account/network; existing builder approval. Main wallet keys are refused. `allInFeeBpsCap` is operator-declared: the kit cannot verify the HIP-4 all-in rate from perp/spot tiers. |
| Lighter | `VERDICT_LIGHTER_API_PRIVATE_KEY` | API key matching the confirmed account and key index; creator is explicitly bound in the proposal. Devnet chain 300 and mainnet 304 are passed explicitly. |
| Polymarket | `VERDICT_POLYMARKET_PRIVATE_KEY`, `VERDICT_POLYMARKET_DEPOSIT_WALLET`, `VERDICT_POLYMARKET_API_KEY`, `VERDICT_POLYMARKET_API_PASSPHRASE`, `VERDICT_POLYMARKET_API_SECRET` | Existing deployed deposit wallet and pre-existing API credentials/allowances. No automatic wallet deployment, credential creation, approvals or deposits. Owner/session keys retain the SDK's own order visibility rules. |

Optional `VERDICT_NODE_BINARY` specifies an absolute Node 22 executable. Public Node child
processes receive only explicitly selected non-secret configuration. Never export operator
credentials into the shell that runs an agent or a hosted server.

In the operator shell, from `local-runner`:

```sh
.venv/bin/python -m verdict_broker review --proposal ../proposal.json
.venv/bin/python -m verdict_broker public-market --venue polymarket --network polygon --market-id 123
.venv/bin/python -m verdict_broker public-quote --venue polymarket --network polygon --market-id 123 --side yes --action buy --shares 10
.venv/bin/python -m verdict_broker account --proposal ../proposal.json --leg 0
.venv/bin/python -m verdict_broker submit --proposal ../proposal.json
.venv/bin/python -m verdict_broker status --proposal ../proposal.json
.venv/bin/python -m verdict_broker cancel --proposal ../proposal.json --leg 0
```

The one-shot `submit` and `cancel` commands use per-order mode. Every order requires its
own interactive approval, including each leg of a pair. Submit
shows the full proposal and identifies the one order being approved. Type the exact
`APPROVE <digest>:leg:<index>` token for that order. Approving the first order never
authorizes the second. An account's signing key never substitutes for per-order approval.
There is no bypass flag.
Cancellation asks separately for `APPROVE <digest>` and targets only the specified leg.
Acknowledgement is not terminal cancellation: read status afterward. `account` runs the
same read-only preflight and can block when the proposed order is no longer valid.

## Connect an agent through the SDK

Create a private directory for the socket. From `local-runner`, start the broker in the
operator terminal, with credentials available only there:

```sh
mkdir -m 700 -p /tmp/verdict-agent
.venv/bin/python -m verdict_broker serve --mode per_order --socket /tmp/verdict-agent/broker.sock
```

In the agent process, configure only `VERDICT_BROKER_SOCKET=/tmp/verdict-agent/broker.sock`
and `VERDICT_EXECUTION_MODE=per_order`. The mode is checked on every request. A mismatch
fails; the client cannot change the service's authority.

```ts
import { connectExecution, prepareExecution } from '@verdict/core';

const client = await connectExecution({ expectedMode: 'per_order' });
const proposal = prepareExecution(request);
// Persist this exact proposal before submit; reuse it for status and cancellation.
await client.preflight(proposal);
const result = await client.submit(proposal);
const status = await client.status(proposal);
await client.cancel({ proposal, leg: 0 });
```

Preflight never grants authority or reserves budget. Submit repeats fresh checks. An
`ExecutionDeliveryUnknownError` means the request may have reached the broker. Call
`status` with the saved proposal. Do not prepare a replacement or retry automatically.
The example at `examples/execution/agent.mjs` persists proposals before submission and
uses status on subsequent runs.

The CLI uses the same SDK methods:

```sh
verdict execution broker-capabilities --mode per_order
verdict execution preflight --file proposal.json --mode per_order
verdict execution submit --file proposal.json --mode per_order
verdict execution status --file proposal.json --mode per_order
verdict execution cancel --input '{"proposal":<saved proposal>,"leg":0}' --mode per_order
```

For local agent tools, launch `verdict-mcp --local-execution` with those two non-secret
environment variables. It exposes prepare, review, capabilities, preflight, submit,
status and cancel. `--local-execution --http` is refused. `--execution` stays keyless even
when a broker socket is configured.

Policy SDK callers can additionally set `expectedGrantId` to the operator-issued grant
UUID. It is asserted on every request, including mutations, and never selects a grant.
The hosted connector always uses this assertion from its private binding. A different
broker grant at the same socket is refused before reservation or signing.

## Approve a bounded autonomous policy

Review one or more canonical proposal templates. Each template binds the exact ordered
venues, networks, accounts, market identifiers, complete titles/rules, actions, sides,
TIFs, key indices, creators and builder fields. Shares and fee reserves can only decrease.
A buy limit can only decrease; a sell limit can only increase. Proposal debit limits may
only tighten. A pair needs its own reviewed template and exact rule orientation; two
single-order templates do not authorize a pair.

From `local-runner`, create a grant in the operator terminal:

```sh
.venv/bin/python -m verdict_broker grant-create --template ../proposal.json --max-debit-usdc 100 --max-orders 20 --expires-at <Unix-milliseconds> --cancel-own-orders
.venv/bin/python -m verdict_broker grant-inspect --grant-id <issued-grant-id>
.venv/bin/python -m verdict_broker serve --mode policy --grant-id <issued-grant-id> --socket /tmp/verdict-agent/broker.sock
```

The terminal displays the full templates, budget, order count, expiry and cleanup
permission before requiring exact approval. Repeat `--template` to approve additional
contracts. Select `expectedMode: 'policy'` in the SDK, or `VERDICT_EXECUTION_MODE=policy`
for the CLI/MCP. No agent request can issue a grant or alter its scope.

The broker durably reserves the whole proposal's gross buy notional plus all fee
reserves and order slots before signing its first leg. Budgets never refund
automatically, including failed attempts and an unsent second leg. A crash after a
reservation but before an attempt halts that proposal for operator review. A partial,
unknown or net-short execution blocks new policy risk on the account across grants.
An incomplete pair also fences both accounts when its first order filled but its second
order was never sent or filled zero. Individually terminal legs do not prove a hedge.
Definitive settled observations are saved, so subsequent trades cannot change historical
completion. Use the same state directory for every process controlling those accounts.

```sh
.venv/bin/python -m verdict_broker grant-revoke --grant-id <issued-grant-id>
```

Revocation and expiry block new sends, including a final check after signing. They cannot
recall a transport already sent. Status remains available. If the grant included
`--cancel-own-orders`, exact cancellation of its recorded attempts remains available
after expiry or revocation. No cleanup permission authorizes a replacement trade.

The [hosted connector](../docs/hosted-connector.md) uses a separate provisioned policy
broker for each linked subject. Its gateway `per_order` mode adds independent browser
consent for single orders inside that policy; it does not forward terminal prompts.
Explicit gateway `policy` mode uses the same grant for autonomous SDK execution.

The service uses a same-user Unix socket, an owned 0700 parent and a 0600 socket. It
refuses an existing socket path; investigate a stale path before removing it. This does
not isolate credentials from malicious code running as the same OS user. Use separate
OS principals when that isolation is required. A disconnected client does not cancel an
in-progress broker operation. Per-order prompts can occupy the serial service; a client
timeout still requires status with the original proposal.

`public-quote` is credential-free Polymarket research, alongside the existing HL/Lighter
`verdict quote` / `verdict lighter quote` commands. It walks the chosen outcome's actual
asks or bids, with an optional `--limit-price`, and reports complete/partial/blocked depth,
walked notional, average/worst price, mid/spread and the current CLOB fee curve. Partial
notionals cover only `filledShares`; no price is extrapolated over missing depth. Closed,
expired or disabled books, subminimum size and stale evidence block the quote. The default
age budget is 5000 ms; `--max-age-ms` permits explicit research budgets up to 60000 ms and
does not relax the execution broker's own deadline.

Save `public-market` JSON and use `public-quote --snapshot public.json --side yes --action
buy --shares 10` to evaluate it at the current clock. `--at <Unix milliseconds>` explicitly
replays a saved capture at a historical time; it is refused for live quotes. Output labels
the source and evaluation modes. Saved snapshots need `enableOrderBook` from the current
capture format; recapture older files rather than assuming an unknown book is active.

To check the exact Polymarket leg of an existing unsigned proposal, pass the proposal and
an explicit zero-based index. The command derives the market, asset, side, action, shares
and limit from the validated proposal. It rejects order-field overrides and mismatched
market identities, titles or settlement rules. The proposal must be within its validity
window at the quote's evaluation time. Historical replay does not renew an expired intent.

```sh
.venv/bin/python -m verdict_broker public-quote --proposal ../proposal.json --leg 1
.venv/bin/python -m verdict_broker public-quote --proposal ../proposal.json --leg 1 --snapshot public.json --at 1792638000000
```

The report includes the original digest and selected leg index, without account details.
Only that Polymarket leg's public depth is assessed. `otherLegs` remains `not_assessed`
and `authorization` remains `none`. This command does not check private permissions,
balances, fee-reserve adequacy, paired profit or net acquired inventory. It does not alter
the proposal, create broker state or replace the operator's execution approval.

`curveFeeUSDC` is unrounded `shares × rate × [price × (1-price)]^exponent`, summed at the
prices actually walked, using current CLOB parameters rather than category defaults.
Integer exponents 0..8 and bounded decimal/string fee parameters are supported; unsupported
parameters fail closed. The [official fee guide](https://docs.polymarket.com/trading/fees)
documents five-place rounding, but execution fragmentation, rounding ties, rebates and
cash/token collection are not inferred here. The quoted plus/minus fee amounts are model
economics, not guaranteed cash requirements. `netSharesReceived` stays null and
`inventoryVerified` stays false; this command cannot authorize a trade or verify a hedge.

Single orders support HL Ioc/Gtc/Alo, Lighter ioc/gtc/post_only and Polymarket
FAK/FOK/GTC/GTD. Polymarket GTD needs a Unix-second expiration at least three minutes
ahead at signing. SDK tick rounding that changes shares or worsens the limit is refused.
Polymarket sizes must fit the pinned SDK's 0.01-share grid. Sells require available holdings;
naked sells are disabled. Polymarket preflight requires no existing open orders, because
raw balances do not subtract their reservations. On Lighter, existing opposite
inventory or other open orders in the market block execution rather than silently netting
or double-reserving them. Use dedicated accounts with **no external writers**.

Pairs support all three combinations, with equal requested shares, immediate buy orders,
explicit rule orientation and positive worst-limit conditional payoff after reserves.
Every leg passes initial preflight before either order is attempted; each is refreshed
again before its own send. A send deadline is checked after SDK signing/nonce reads,
immediately before transport. Execution is sequential and non-atomic: first leg must reach a definitive terminal full
fill, settlement confirmation where applicable, and the exact net inventory change before
the second order is authorized by its own terminal approval or the existing policy. Its
fresh preflight runs after that authority check,
so a changed book or an expired proposal blocks sending. Declining the second approval can
leave the first position exposed; the runner does not automatically undo it.
Partial fills, unknown outcomes, fee-short shares,
adverse depth or a second-leg failure leave exposure. Recovery is a new separately confirmed
proposal under operator authority. The runner never automatically resizes, unwinds or retries an order.

Fee reserves are estimates, not venue-enforced ceilings. Lighter uses the undiscounted
curve's global maximum across prices; Polymarket conservatively reserves `shares × rate`
for a nonnegative exponent, using current CLOB metadata. These can exceed fees at the
quoted limit. Rebates are never assumed. Polymarket BUY fees may reduce received shares;
gross matched shares never count as net acquired inventory. MATCHED/MINED/RETRYING do not
prove settlement. Both net balances must reconcile before a pair is reported complete.
This initial policy does not automatically gross up a Polymarket BUY to offset fees paid
in shares: a fee-short fill halts and requires a new confirmed recovery proposal.

State defaults to `~/.local/state/verdict-broker`, or `--state-dir <private directory>`.
It must be owned by the operator with mode 0700. Files are 0600, symlinks are refused,
and accounts are locked across proposals. An unsigned intent and an attempt fence are
fsynced before signing/transport. Journals contain public identifiers and normalized
receipts, never signatures or auth. Protect and retain them: deleting state removes
duplicate-attempt protection. A truncated/corrupt journal fails closed.

Once an attempt exists, re-running submit only reconciles; it never sends either leg,
even if the first filled and the second was never sent. Lighter's private lookup has
bounded retention (10,000 active / 1,000 inactive within 24 hours). Missing orders remain
unknown. A lost Polymarket response without an order ID cannot be resolved automatically:
inspect the official account UI/history. Do not infer rejection or submit again. Status
retains definitive settled observations and reconciles unresolved attempts against account
inventory. It assumes no external writers and makes no realized P&L claim.

SDK internals used deliberately at the pins: HL `sign_l1_action`; Polymarket `_create`
with supplied credentials and `validate_credentials=False`, followed by a read-only
active-key check, to avoid automatic credential creation and wallet deployment; and the
SDK's `/clob-markets` fee schema. Polymarket `SignedOrder.order_type` is an unsigned POST
policy, so FAK/FOK replace only that field on the public dataclass; signed fields remain
unchanged. Contract tests exercise the real pinned SDKs. Review these hooks before upgrading.

HL local execution accepts markets with explicit `Yes`, `No` labels in canonical order.
It binds the selected side's name, index, coin and native asset to the proposal outcome.
Named team and Over/Under outcomes are refused by this yes/no-only proposal format.

The lock is generated with `uv pip compile local-runner/requirements.in --overrides
local-runner/security-overrides.in --python 3.11 --universal --generate-hashes --output-file
local-runner/requirements.lock`. The override pins urllib3 2.8.0 to fix published advisories
despite the Lighter SDK's stale `<2.1` metadata constraint. That SDK uses aiohttp for network
transport and urllib3 for header construction; the installed-SDK contracts verify the
supported paths with the override. Keep the override explicit when regenerating the lock.

Verification from the repository root:

```sh
pnpm run check
VERDICT_BROKER_PYTHON=local-runner/.venv/bin/python pnpm run check:broker:sdk
```

The suite covers real CLI/MCP preparation, ephemeral-key SDK signing against mocks,
partial/unknown execution, restart fences, locks, exact payloads and settlement/net-share
accounting. It does **not** prove funded venue acceptance, private account permissions,
geographic eligibility or profitable trading. No funded orders are placed by these tests.
