# Execution verification

Verified locally on 2026-10-21 using Node 22 and Python 3.11, with SDKs installed from the
universal lock. No funded orders, private account reads or production credentials were used.

| Check | Result |
|---|---|
| Full TypeScript suite, public venue reads and installer E2E | 453 passed, zero skipped |
| Local broker and public quote suite, including the real built Node validation boundary | 60 passed |
| Installed official SDK contract suite | 28 passed |
| Types, lint, engine/API provenance and release checks | Passed |
| Both static skill checks | Passed |
| Public Polymarket discovery and both outcome books through the official SDK | Passed, market 559651, V1 |

Reproduce the full checks from the repository root:

```sh
VERDICT_LIVE=1 VERDICT_LIGHTER_LIVE=1 VERDICT_STRATEGY_LIVE=1 VERDICT_E2E_INSTALL=1 pnpm run check
VERDICT_BROKER_PYTHON=local-runner/.venv/bin/python pnpm run check:broker:sdk
pnpm run bench:static
```

The SDK tests generate temporary keys in memory. HL signs the unchanged native action and
recovers the signing address; Lighter runs its native signer with exact integer ticks and
explicit devnet chain; Polymarket signs and posts to a mock transport using its owner
deposit-wallet signature wrapper and both V1/V2 asset namespaces. These checks exercise
real SDK code, but they do not establish funded acceptance or account-specific permission.

Broker tests include partial fills, fee-short net shares, matched-but-unsettled trades,
unknown responses, all-leg initial preflight, adverse second-leg changes, stale snapshots,
fee/balance caps, account lock contention, precise cancellation, truncated journals,
credential isolation and an actual process crash after the fsynced attempt fence. A
restarted process reconciles without sending another order.

Two independent read-only reviewers found and verified fixes for: second-leg prerequisites
checked too late; unsupported Polymarket share precision; resting-order reservations;
submission after slow SDK reads; automatic credential-creation fallback; incomplete
terminal statuses; and missing identifiers in the terminal approval. Their preferred model
families were unavailable, so GPT-6.1 Sol and GPT-6 Sol reviewed the source and test artifacts.
This was a code/integration review, not a comprehensive audit or a review of private accounts.

A further regression reproduced cancellation being blocked by an unrelated balance endpoint
failure. Order identity validation now serves status and cancellation independently; cancel
does not await balances or settlement. The regression failed before the change and passes after it.

The public Polymarket quote batch adds 19 behavioral tests: actual outcome depth, buy/sell
limits, partial liquidity, per-level fee curves, SDK string/numeric fee parameters, book
eligibility, source clocks and saved-snapshot CLI replay. Two independent reviewers verified
fixes for string fee exponents and disabled order books. A real credential-free live quote
completed for 10 YES shares on market 559651. Its fee schedule was zero; positive fee curves
are covered by fixtures, not funded acceptance. Quotes report unrounded research economics
and never claim verified net inventory or authorize execution.

Proposal-bound quotes add 10 tests for exact asset and terms binding, canonical digest
validation, explicit leg selection, immutable limits, validity windows, partial depth,
conflicting CLI overrides and public-only replay. Review reproduced a saved JSON `null`
file unexpectedly selecting live capture. Non-object saved files now fail before any
public request, with regressions for both standalone and proposal quote modes. The other
leg's executable depth, net inventory and fee-reserve adequacy remain unassessed.

Remaining acceptance work requires an operator-owned funded account on each venue. The
runner intentionally halts on any fee-short net inventory, unknown history or unresolved
settlement; paired fills are non-atomic. The [capability matrix](agent-capabilities.md)
records features not implemented by this batch.

Per-order approval adds six broker regressions. A pair requires two distinct approvals,
and rejecting the second sends only the first order. The first approval token cannot
authorize another leg. Each order is rechecked after the human wait; changed preflight or
expiry blocks sending. A restart still reconciles instead of resuming an unattempted leg.
The focused regressions failed before the change because one approval sent both orders.

The pre-merge security pass reproduced and fixed HL named outcomes being treated as
YES/NO execution. SDK regressions now require canonical labels and bind the selected
native asset to the approved outcome. A real HTTP regression verifies oversized declared
and chunked requests receive 413 before opening a session, with subsequent requests still
served. Updated JavaScript and Python locks had zero published advisories in the scans
performed on 2026-10-22. This does not establish absence of unknown vulnerabilities or
funded acceptance. The explicit urllib3 metadata override is documented in the runner guide.
