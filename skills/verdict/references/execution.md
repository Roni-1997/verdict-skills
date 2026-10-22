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

Show every review line, end the message and wait for a real new human reply. A digest is
not consent. Hand the unchanged proposal to the operator's dedicated local terminal.
The agent never handles credentials, drives that terminal or answers its approval prompt.
No signing or submission occurs in the turn that prepared the proposal. Do not install
SDKs at trade time. Setup is a separate operator task.

Single orders support native limit TIFs. Pairs require two immediate buys, equal requested
shares, distinct venues, compatible environments and a manually reviewed rule orientation.
The broker sends the second only after the first's terminal full fill, confirmed settlement
and exact net inventory change. Execution is non-atomic; a partial/uncertain leg stops.
Never call this guaranteed arbitrage. Recovery is a new separately confirmed proposal.

Local status reconciles real account state and normalized order lifecycle. Re-running an
attempted proposal never resubmits. Lost responses and bounded-history misses stay unknown;
do not classify them as rejection. Polymarket MATCHED is not settled, and gross fill size
is not net received shares. Account inventory changes assume dedicated accounts without
external writers. No realized P&L is inferred from balances alone.

Illustrative capability output, as recorded on 2026-10-21 and may differ:

```json
{"version":1,"hostedSigning":false,"pairs":["hl/lighter","hl/polymarket","lighter/polymarket"],"pairMode":"sequential_full_first"}
```

## Errors

CLI exit 1: invalid/oversized JSON, unknown fields, bad precision, modified digest,
incompatible pair, missing rule review, insufficient fee reserve or debit/profit cap.
Values are hidden in validation errors. Fix inputs and prepare a fresh proposal.
An expired proposal may be reviewed/reconciled; the broker refuses new submission.
Broker errors never imply an attempted order failed: use status and official history.
