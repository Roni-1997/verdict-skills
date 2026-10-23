# Agent kit coverage

Compared on 2026-10-21 against the public [Polymarket agent skills](https://github.com/Polymarket/agent-skills),
[unified Polymarket SDK](https://github.com/Polymarket/py-sdk/tree/7032ed06175b0bbea77b2d9e898bd9f252af2041),
[Lighter agent kit](https://github.com/elliottech/lighter-agent-kit), and
[Lighter Python SDK](https://github.com/elliottech/lighter-python/tree/56b3537cd311117a5a665d74db4c2cce7da155de).
This is a capability comparison, not a performance benchmark or proof of profitable trading.

| Capability | Verdict implementation | Current limit |
|---|---|---|
| Market/rule discovery | HL and Lighter CLI/MCP; public broker snapshots on all three | Polymarket broker snapshot takes a numeric market ID; existing comparison engine supplies broader candidate research |
| Executable size quotes | HL/Lighter CLI quotes; Polymarket `public-quote` book walking with dynamic fee curves, limits and saved replay | Public quotes are not fill promises or net inventory; no automatic market-equivalence claim |
| Proposal-bound public research | Polymarket `public-quote --proposal --leg` binds exact validated terms, size, asset and limit to live or saved public evidence | Only the selected Polymarket leg is assessed; counterpart depth and fee-reserve adequacy are not assessed |
| Single limit orders | Official SDK signing/submission on all three | Operator-owned broker; explicit per-order confirmation or bounded policy; HL execution requires canonical Yes/No labels, not named team or Over/Under outcomes |
| Native order types | HL Ioc/Gtc/Alo; Lighter ioc/gtc/post_only; Polymarket FAK/FOK/GTC/GTD | Exact share/tick grids, no silent size rounding |
| Account preflight | Bound account/network, current rules, balances, fees, depth and permission checks available from each SDK/API | Private funded acceptance is unverified; HL all-in outcome fee cap remains operator-declared |
| Resting-order reservations | HL available balances; Lighter rejects other orders in the market; Polymarket rejects any existing open orders | Conservative clean-account policy, rather than simultaneous market-making inventory management |
| Order lifecycle / cancel | Public/client IDs or authenticated private reads; exact-leg cancellation | Bounded histories and lost Polymarket IDs can require manual reconciliation |
| Paired execution | All three venue combinations, equal-size immediate complementary buys, per-order approval or an exact reviewed pair grant | Sequential full-first, non-atomic; declining the second order can leave exposure; no automatic hedge/unwind |
| Fee/settlement accounting | Fee reserves, explicit limits, actual net inventory and confirmed Polymarket trades | No rebates assumed, no realized P&L inferred from balance changes |
| Restart recovery | Account locks, fsynced attempt-before-send journal, no automatic resubmission | Protect the journal; external account writers invalidate inventory attribution |
| SDK lifecycle | `connectExecution()` preflight, submit, status, cancel over a private local broker; CLI/MCP share the client | Explicit mode assertion on every call; lost delivery requires original-proposal status, never automatic retry |
| Autonomous authority | Operator-issued immutable template grants, expiry, gross debit/order budgets, independent revocation and exact own-order cleanup | No automatic budget refunds, recovery trades, grant issuance or mode changes from tools; unresolved accounts block new policy risk |
| Hosted agents | Explicit OAuth connector, linked accounts, browser approval or operator policy, SDK submission/status/cancel, MCP Apps review link | Operator-provisioned policy broker required; browser mode single orders only; no deployed endpoint, host approval or automated wallet linking |
| Verification | Unit tests, actual CLI/MCP stdio, real SDK signing with temporary keys and mock transports, process-crash recovery, public API reads | No funded orders or private-account verification performed by the suite |

Polymarket's broader suite also covers batch orders, websocket streams, maker heartbeats,
split/merge/redeem and bridges. These are not implemented here. The official Lighter agent
kit's perp/spot workflows are not binary outcome trading; Verdict uses the SDK's binary
event APIs directly. This change closes the single-order and paired-execution lifecycle
gap; it does not claim feature parity with every prediction-market platform.

One local Python broker owns SDK credentials, signing, account locks and recovery. The
TypeScript SDK, CLI and local MCP share one strict proposal schema and one lifecycle client. This avoids separate hosted
and local trading implementations, and uses all three official Python SDKs without
requiring Node 24 for Polymarket's current TypeScript client. SDK commits and transitive
dependencies are pinned in `local-runner/requirements.in` and `requirements.lock`.

Operational instructions and intentionally pinned internal SDK hooks are documented in
[the local runner guide](../local-runner/README.md) and [hosted connector guide](hosted-connector.md). The research scanner remains focused
on HL/Lighter; preparing a trade on Polymarket is a separate explicitly requested workflow.

The integration review used the public [Liquid Co-Invest MCP](https://github.com/liquid-public/coinvest-mcp),
[official Lighter agent kit](https://github.com/elliottech/lighter-agent-kit), and
[official Polymarket agent skills](https://github.com/Polymarket/agent-skills). The useful
patterns are explicit execution modes, bounded authority, fresh preflight and complete
order lifecycle access. Verdict retains its existing official SDK adapters rather than
adding another executor. Provider-hosted features and unsupported product workflows
remain outside this coverage.
