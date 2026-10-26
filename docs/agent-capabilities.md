# Verdict agent kit coverage

The active kit helps an agent research and trade Verdict's Lighter binary outcome markets through our SDK and MCP. The default MCP is Lighter-only, and its execution schemas accept one Lighter order. The installed skill follows that same workflow.

## Current capabilities

| Capability | Implementation | Limit |
|---|---|---|
| Market discovery and rules | Paginated binary events, creator identity, full settlement descriptions, trading window, and market precision | Creator text is untrusted data. A partial page does not establish complete coverage. |
| Executable prices and liquidity | Fresh YES book, YES/NO conversion, exact tick handling, and size-aware quotes | Fetched depth is a snapshot. Partial quotes cover only filled shares. |
| Fees | Binary fee curve, enabled market flags, public fee tiers, and conservative reserves | Public reads cannot establish account discounts. No integrator fee is configured. |
| Public account research | Numeric Lighter account positions and available USDC | Recent prints are not a complete account fill history or realized P&L. |
| Unsigned preparation | Official SDK order and cancel arguments | Requires reviewed creator configuration. It grants no execution authority. |
| Hosted account connection | Privy identity, owner proof, exact client permissions, resource-specific OAuth, and disconnect | Staging pilot. Real sign-in resume and complete live account-to-order acceptance remain blocked. |
| Prefilled buy review | Stable intent UUID, linked account, fresh metadata and depth, and maximum USDC spend including fees | Consumer self-service supports testnet buy IOC orders within reviewed creator scope. |
| Single-order SDK lifecycle | Canonical prepare, review, preflight, submit, original-proposal status, and exact cancellation | Lighter-only at active MCP boundaries. Generic broker adapters do not widen these permissions. |
| Explicit execution modes | Independent browser or terminal approval in `per_order`; existing owner-approved bounded grant in `policy` | Agents cannot approve orders, issue grants, change mode, or expand budgets. |
| Native Lighter order types | Broker support for ioc, gtc, and post_only with exact size and price grids | Self-service consumer enrollment permits only buy IOC. Selling is not reduce-only. |
| Fresh account preflight | Account and network binding, rules, balances, permissions, fees, and depth | A conservative clean-account policy rejects conflicting market orders. Checks cannot guarantee fills. |
| Durable recovery | Attempt-before-send journals, account locks, exact original identity, and no automatic resubmission | External account writers can make attribution uncertain. Unknown delivery requires original-proposal reconciliation. |
| Hosting | Local durable storage or configured PostgreSQL public authority with a separate private signer | Hosted infrastructure exists on staging. Automated tests and read probes do not prove funded acceptance. |

## Product limits

The kit has no paired strategy workflow, automatic hedge or unwind, perp or spot trading, bridge, batch market-making service, or guaranteed profit. It does not infer realized P&L from balance changes. There is no claim of execution-speed advantage or complete parity with another provider's hosted product.

The agent supplies conversation and reasoning. Verdict supplies market data, reviewed trading authority, and official SDK execution. A useful end-to-end experience is a market brief followed by an executable quote, prefilled review, independent approval, and a reconciled order result.

The implementation drew on public patterns from [Liquid Co-Invest MCP](https://github.com/liquid-public/coinvest-mcp), [Lighter's agent kit](https://github.com/elliottech/lighter-agent-kit), and [Polymarket agent skills](https://github.com/Polymarket/agent-skills). Useful patterns include explicit modes, bounded authority, fresh preflight, and complete order lifecycle access. This is an implementation description, not a benchmark or a claim about another service's current capabilities.

## Verification and rollout

Tests cover typed inputs, the real CLI and MCP transport, OAuth and ownership checks, independent review, SDK dispatch with inert venues, durable claims, and process recovery. Native signer checks use temporary keys and mock transports. They do not place funded trades.

Staging still needs a complete real login, account registration, reviewed scope, independent approval, and separately authorized testnet order with venue reconciliation. Client-host compatibility and directory approval are separate requirements. Call the hosted product a staging pilot until those acceptance steps succeed.

See [account connection](account-service.md), [hosted execution](hosted-connector.md), and [deployment operations](../deploy/README.md). Earlier multi-venue core and broker adapters remain for compatibility and original history, outside the active product workflow.
