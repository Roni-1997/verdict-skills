# Execution proposals and local broker

Use `verdict execution` for a specifically requested single order or paired trade on HL,
Lighter or Polymarket. Preparation/review are keyless. `verdict-mcp --execution` exposes
`execution_prepare`, `execution_review`, `execution_capabilities`; it has no submission,
signing, account credential or approval tool.

Read the repository's `local-runner/README.md` for the separate operator-owned SDK runner,
installation, credential names, account reads, submission, cancellation and recovery.
The local runner requires a repository clone and separately installed Python dependencies;
it is not bundled into the npm CLI or installed automatically by a skill.

For Polymarket size/depth research, the installed local runner also provides credential-free
`public-quote` (live capture or saved `public-market` JSON), alongside existing HL/Lighter
CLI quote commands. It reports partial depth, current curve fees, source clocks and
limits, without claiming net received shares. See the runner guide for replay flags and
fee-model limits. A quote is analysis, never permission to prepare or submit an order.
For an existing unsigned proposal, `public-quote --proposal proposal.json --leg N` checks
its exact selected Polymarket leg without hand-copying size, asset or limit. An explicit
index is required. The other leg, net inventory and fee-reserve adequacy remain unassessed.

```sh
verdict execution prepare --file request.json > proposal.json
verdict execution review --file proposal.json --pretty
verdict execution validate --file proposal.json
verdict execution capabilities
```

`examples/execution/request.json` is a synthetic HL/Polymarket pair, not tradeable market
data. Provide exact current rules/titles and account/network identifiers. Reserve fees
explicitly; do not assume rebates, equal expiry or title matches establish equivalent
contracts. Lighter uses a market ID, creator and API key index. Polymarket uses a Gamma
numeric `marketId` and exact CLOB `assetId` (V1 token ID or V2 position ID).

In per-order mode, show every review line, end the message and wait for a real new human reply. A digest is
not consent. Hand the unchanged proposal to the operator's dedicated local terminal.
The agent never handles credentials, drives that terminal or answers its approval prompt.
Every order needs its own operator approval, including both legs of a pair. Approval of
one leg cannot authorize the next. Declining a later leg can leave an existing position
exposed; recovery needs a new separately authorized proposal. These rules apply to
per-order mode. The operator may instead explicitly start bounded policy mode as described
below.
In per-order mode, no signing or submission occurs in the turn that prepared the proposal. Do not install
SDKs at trade time. Setup is a separate operator task.

Single orders support native limit TIFs. Pairs require two immediate buys, equal requested
shares, distinct venues, compatible environments and a manually reviewed rule orientation.
The broker sends the second only after the first's terminal full fill, confirmed settlement
and exact net inventory change. Execution is non-atomic; a partial/uncertain leg stops.
Never call this guaranteed arbitrage. Recovery requires a new separately authorized proposal.

Local status reconciles real account state and normalized order lifecycle. Re-running an
attempted proposal never resubmits. Lost responses and bounded-history misses stay unknown;
do not classify them as rejection. Polymarket MATCHED is not settled, and gross fill size
is not net received shares. Account inventory changes assume dedicated accounts without
external writers. No realized P&L is inferred from balances alone.

Illustrative capability output, as recorded on 2026-10-21 and may differ:

```json
{"version":1,"hostedSigning":false,"pairs":["hl/lighter","hl/polymarket","lighter/polymarket"],"pairMode":"sequential_full_first"}
```


## Local agent lifecycle

An operator-configured `verdict-mcp --local-execution` adds `execution_preflight`,
`execution_submit`, `execution_status` and `execution_cancel`. It uses the same SDK
`connectExecution()` client as CLI lifecycle commands. `VERDICT_BROKER_SOCKET` and
`VERDICT_EXECUTION_MODE=per_order|policy` are operator configuration, never tool inputs.
Local execution is stdio only; hosted `--execution` stays keyless.

In `per_order`, each order prompts in the operator terminal. In `policy`, a previously
issued grant binds exact reviewed proposal templates, numeric limits, cumulative gross
debit, order count and expiry. Only the operator can create or revoke grants. The agent
cannot select a grant, change mode or supply approval. Do not ask for per-order approval
when a matching policy already authorizes the order. Present remaining authority from
`execution_capabilities` and respect all broker blocks.

Persist the unchanged proposal before submission. If delivery is unknown, call status
with that proposal; never prepare a replacement or retry automatically. Status and
authorized exact-own-order cancellation remain available after expiry/revocation.
Partial/unknown/net-short results stop the pair and block further autonomous account
risk pending operator reconciliation. No automatic unwind or recovery trade exists.

## Errors

CLI exit 1: invalid/oversized JSON, unknown fields, bad precision, modified digest,
incompatible pair, missing rule review, insufficient fee reserve or debit/profit cap.
Values are hidden in validation errors. Fix inputs and prepare a fresh proposal.
An expired proposal may be reviewed/reconciled; the broker refuses new submission.
Broker errors never imply an attempted order failed: use status and official history.
