# Local trading broker

Agents prepare unsigned orders through `verdict execution` or `verdict-mcp --execution`.
The operator runs this separate Python process in their own terminal. It uses the official
SDKs to read accounts, sign, submit, reconcile and cancel individual orders on Hyperliquid,
Lighter binary outcomes and Polymarket. Hosted CLI/MCP processes never receive credentials.

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

The agent shows every confirmation line, ends its message and waits for a real new human
reply. Then it hands the unchanged proposal to the operator. It does not drive the terminal
that holds keys or answer the terminal's approval prompt. A digest identifies content; it
is not proof of consent.

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

Every order requires its own interactive approval, including each leg of a pair. Submit
shows the full proposal and identifies the one order being approved. Type the exact
`APPROVE <digest>:leg:<index>` token for that order. Approving the first order never
authorizes the second. An account's signing key never substitutes for per-order approval.
There is no bypass flag.
Cancellation asks separately for `APPROVE <digest>` and targets only the specified leg.
Acknowledgement is not terminal cancellation: read status afterward. `account` runs the
same read-only preflight and can block when the proposed order is no longer valid.

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
the user is asked to approve the second order. Its fresh preflight runs after that approval,
so a changed book or an expired proposal blocks sending. Declining the second approval can
leave the first position exposed; the runner does not automatically undo it.
Partial fills, unknown outcomes, fee-short shares,
adverse depth or a second-leg failure leave exposure. Recovery is a new separately confirmed
proposal. The runner never automatically resizes, unwinds or retries an order.

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
reports inventory changes, assumes no external writers, and makes no realized P&L claim.

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
