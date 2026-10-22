# Verdict agent kit: goal

The Hyperliquid commands retain their builder routing. The owner-requested Lighter
extension exposes binary outcomes through separate `lighter_*` MCP tools and `verdict lighter`
commands, with devnet defaults and explicit creator allowlists for unsigned SDK arguments.
Hyperliquid's builder fields do not apply to Lighter. No Lighter integrator fee is configured;
these hosted tools return unsigned payloads. See the
[Lighter skill](skills/verdict-lighter/SKILL.md).

The owner-requested strategy workbench adds HL/Lighter candidate discovery, shared book
snapshots, conditional fee/depth/risk analysis, bounded scans, paper fills and absolute
inventory reconciliation. Its CLI is `verdict strategy`, and its MCP mode is `--strategy`.
This workbench's external venue comparisons remain reference only. It builds no orders,
grants no live execution authority and changes no existing confirmation rule.

The owner also authorized local trading on Hyperliquid, Lighter and Polymarket.
`verdict execution` and MCP `--execution` prepare strict unsigned proposals for individual
orders or conditional non-atomic pairs. A separate operator-owned Python broker handles
signing, submission, status and cancellation through pinned official SDKs. It requires
separate exact terminal approval for every order and account bindings. It checks actual
settled net inventory and never automatically resubmits an uncertain attempt. Hosted
processes remain keyless.
Polymarket public depth quotes and proposal-leg research do not verify paired profit or
net acquired shares. See [the local broker guide](local-runner/README.md) and
[current coverage and limits](docs/agent-capabilities.md). Funded venue acceptance remains
unverified; this extension does not claim complete parity with every external kit.

The kit is not a chatbot and it is not a wallet.

Its purpose is to let any agent, bot or front end trade Verdict's HIP-4 outcome markets well,
with orders that carry Verdict's builder code:

- one typed tool module over the cross-venue engine that already exists in the Verdict app,
- shipped three ways from the same code: a `verdict` CLI, a `SKILL.md` for coding agents, and
  an MCP server over stdio and streamable HTTP,
- read tools that answer "what markets exist, what does this one settle on, what is the same
  market on Polymarket and Kalshi, what is the gap, what is the option-implied fair value,
  what hedges it, what is the executable price for my size",
- one tool that builds an unsigned Hyperliquid order carrying `builder: {b, f}`, and one that
  builds the one-time builder-fee approval payload,
- nothing that signs on a hosted path.

## Primary objective

```
Orders routed to Verdict under the builder code, from clients we did not build
```

Measured from Hyperliquid's daily builder-fills files, by client, on testnet first.

## Do not optimize for

- conversation quality or prose,
- number of tools,
- perp, spot, bridge or other products outside the supported binary-outcome workflows,
- our own front end's volume (that is the app's job, not the kit's).

## Success criteria

- A bot with no prior knowledge of Verdict can install the kit, list markets, compare one to
  Polymarket and Kalshi, get a quote for its size, build an order and submit it with its own
  key, on testnet, following the README alone.
- The skill passes Crypto Skill Bench safety and scores above the Hyperliquid skills already in
  the cryptoskill.org registry (63, failing safety, on 2026-09-13).
- Every tool is deterministic and schema-typed on input, output and every upstream response.
- The engine is imported from the Verdict app, never copied; its tests keep passing there.
  A byte-for-byte copy pinned to a Verdict commit and verified by check:engine counts as imported; a
  hand-edited copy does not.
- At least one external operator routes a testnet order through the kit.

## Hard rules

- **The hosted server holds no keys and signs nothing.** Tools return data and unsigned
  payloads. Local mode may sign with the caller's own agent key, held in memory only.
- **Two-message rule for anything signable.** Show the market, settlement rule, side,
  price, size, fee reserves and caps, account, network and applicable Hyperliquid builder
  code, then stop and wait for a real reply. Local execution also requires the operator's
  separate exact terminal approval for each order, including every leg of a pair. Never
  fabricate confirmation, reuse one order's approval for another or add a yes flag.
- **Public discovery and standalone quotes require no account or credentials.** Proposal
  research uses an account-bound unsigned intent. Private account reads stay in the local broker.
- **Every Hyperliquid order carries the builder code.** Hyperliquid builder fields do not
  apply to Lighter or Polymarket. No Lighter integrator fee is configured.
- **Execution is limited to the three authorized venues.** The local broker supports
  Hyperliquid, Lighter binary outcomes and Polymarket. Kalshi and Deribit remain comparison
  sources, with no order-building or execution path.
- **No LLM in the kit.** Any prose layer is a client of the kit, not part of it.
- **HL and Lighter public tools default to testnet and devnet respectively.** Local
  execution proposals bind explicit networks. Polymarket supports polygon only.
- **This repository is public** (the owner made it public on 2026-09-14). Nothing in it may ever hold a key, a credential or a signed payload.

## Claude's role

Claude writes the code, the tests and the documents, runs the benchmark, and prepares
releases. The owner decides the builder fee, the builder address, the network flip and
when the repository goes public, and signs nothing on Claude's behalf.
