# Agent kit coverage

Compared on 2026-10-21 against the public [Polymarket agent skills](https://github.com/Polymarket/agent-skills),
[unified Polymarket SDK](https://github.com/Polymarket/py-sdk/tree/7032ed06175b0bbea77b2d9e898bd9f252af2041),
[Lighter agent kit](https://github.com/elliottech/lighter-agent-kit), and
[Lighter Python SDK](https://github.com/elliottech/lighter-python/tree/56b3537cd311117a5a665d74db4c2cce7da155de).
This is a capability comparison, not a performance benchmark or proof of profitable trading.

| Capability | Verdict implementation | Current limit |
|---|---|---|
| Market/rule discovery | HL and Lighter CLI/MCP; public broker snapshots on all three | Polymarket broker snapshot takes a numeric market ID; existing comparison engine supplies broader candidate research |
| Executable size quotes | HL/Lighter book walking and curved-fee research | Public snapshots are not fill promises; no automatic market-equivalence claim |
| Single limit orders | Official SDK signing/submission on all three | Operator-owned local shell and separate terminal approval |
| Native order types | HL Ioc/Gtc/Alo; Lighter ioc/gtc/post_only; Polymarket FAK/FOK/GTC/GTD | Exact share/tick grids, no silent size rounding |
| Account preflight | Bound account/network, current rules, balances, fees, depth and permission checks available from each SDK/API | Private funded acceptance is unverified; HL all-in outcome fee cap remains operator-declared |
| Resting-order reservations | HL available balances; Lighter rejects other orders in the market; Polymarket rejects any existing open orders | Conservative clean-account policy, rather than simultaneous market-making inventory management |
| Order lifecycle / cancel | Public/client IDs or authenticated private reads; exact-leg cancellation | Bounded histories and lost Polymarket IDs can require manual reconciliation |
| Paired execution | All three venue combinations, equal-size immediate complementary buys | Sequential full-first, non-atomic; no automatic hedge/unwind after a partial or unknown leg |
| Fee/settlement accounting | Fee reserves, explicit limits, actual net inventory and confirmed Polymarket trades | No rebates assumed, no realized P&L inferred from balance changes |
| Restart recovery | Account locks, fsynced attempt-before-send journal, no automatic resubmission | Protect the journal; external account writers invalidate inventory attribution |
| Hosted agents | Keyless discovery/research/unsigned execution proposals | Hosted MCP cannot sign, submit or record approval |
| Verification | Unit tests, actual CLI/MCP stdio, real SDK signing with temporary keys and mock transports, process-crash recovery, public API reads | No funded orders or private-account verification performed by the suite |

Polymarket's broader suite also covers batch orders, websocket streams, maker heartbeats,
split/merge/redeem and bridges. These are not implemented here. The official Lighter agent
kit's perp/spot workflows are not binary outcome trading; Verdict uses the SDK's binary
event APIs directly. This change closes the single-order and paired-execution lifecycle
gap; it does not claim feature parity with every prediction-market platform.

One local Python broker owns SDK credentials, signing, account locks and recovery. The
TypeScript CLI/MCP share one strict unsigned-intent schema. This avoids separate hosted
and local trading implementations, and uses all three official Python SDKs without
requiring Node 24 for Polymarket's current TypeScript client. SDK commits and transitive
dependencies are pinned in `local-runner/requirements.in` and `requirements.lock`.

Operational instructions and intentionally pinned internal SDK hooks are documented in
[the local runner guide](../local-runner/README.md). The research scanner remains focused
on HL/Lighter; preparing a trade on Polymarket is a separate explicitly requested workflow.
