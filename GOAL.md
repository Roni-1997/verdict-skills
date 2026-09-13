# Verdict agent kit: goal

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
- chains, venues or products other than Verdict outcome markets,
- our own front end's volume (that is the app's job, not the kit's).

## Success criteria

- A bot with no prior knowledge of Verdict can install the kit, list markets, compare one to
  Polymarket and Kalshi, get a quote for its size, build an order and submit it with its own
  key, on testnet, following the README alone.
- The skill passes Crypto Skill Bench safety and scores above the Hyperliquid skills already in
  the cryptoskill.org registry (63, failing safety, on 2026-09-13).
- Every tool is deterministic and schema-typed on input, output and every upstream response.
- The engine is the Verdict app's, never forked: `packages/engine` holds its files byte for byte at a
  commit pinned in `UPSTREAM.json`, checked by hash on every `pnpm run check`; no engine code is written
  in the kit, and the engine's tests keep passing in the app. (Amended 2026-09-13; see Decisions.)
- At least one external operator routes a testnet order through the kit.

## Hard rules

- **The hosted server holds no keys and signs nothing.** Tools return data and unsigned
  payloads. Local mode may sign with the caller's own agent key, held in memory only.
- **Two-message rule for anything signable.** Show the market, the settlement rule text, the
  side, price, size, the fee in cents per $1,000 and the builder code, then stop and wait for
  a real reply. Never fabricate the confirmation. Never add a yes flag.
- **Read-only tools never prompt and never require an account.**
- **Every order carries the builder code.** No tool builds an order without it.
- **Orders route only to Verdict.** The kit compares Polymarket, Kalshi and Deribit; it never
  builds orders for them.
- **No LLM in the kit.** Any prose layer is a client of the kit, not part of it.
- **Testnet by default** until the owner flips the network for a release.
- **This repository stays private** until the owner makes it public.

## Claude's role

Claude writes the code, the tests and the documents, runs the benchmark, and prepares
releases. The owner decides the builder fee, the builder address, the network flip and
when the repository goes public, and signs nothing on Claude's behalf.

## Decisions

- **2026-09-13, engine sourcing.** The criterion above first read "imported from the Verdict app,
  never copied". The kit consumes the engine as a hash-pinned, byte-for-byte copy with a drift check
  (`packages/engine`, `scripts/check-engine-drift.mjs`) rather than a git submodule or a workspace
  package pointing at `Roni-1997/verdict`: the app is a web app, not a library, so a submodule would
  tie every install and CI run of the kit to the app repository's credentials, layout and DOM-flavoured
  toolchain, and a published `verdict` CLI has to bundle the engine into its own artifact in any case.
  What the criterion protects, that the kit never forks or edits the engine and that every engine change
  is an explicit pin move, is what the drift check enforces. The criterion was reworded to say that.
  Reversible: moving to a submodule needs only `packages/engine` and `scripts/` to change.
