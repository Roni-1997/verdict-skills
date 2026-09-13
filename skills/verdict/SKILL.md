---
name: verdict
version: "0.1.0"
description: "Verdict's HIP-4 outcome markets on Hyperliquid through the verdict CLI: list markets with their settlement rules, read a market, its order book and an executable quote for a size, read positions and builder-fee approval, and build unsigned orders that carry Verdict's builder code. Use when the user mentions: (1) Verdict, hyperverdict, the Verdict venue or its markets, (2) HIP-4, outcome market, Hyperliquid prediction market, YES or NO tokens on Hyperliquid, (3) a settlement rule, expiry, book, quote or position on such a market, (4) 'compare to Polymarket' or 'compare to Kalshi' for a market that exists on Verdict, (5) builder code, builder fee or builder approval on Hyperliquid."
homepage: https://hyperverdict.xyz
metadata: { "openclaw": { "always": false, "requires": { "bins": ["verdict"] }, "homepage": "https://hyperverdict.xyz" }, "version": "0.1.0" }
---

# Verdict: HIP-4 outcome markets through the `verdict` CLI

Documentation only. This file contains no executable code.

## Routing gate

Activate when the request is about trading or researching Verdict's HIP-4 outcome markets: listing them, reading a settlement rule, a book, a quote for a size, positions, builder-fee approval, or building an order that routes to Verdict. Also activate when the user asks to compare a Verdict market with Polymarket or Kalshi.

Do not activate for:

- general blockchain or Hyperliquid education ("how does HIP-4 work", "what is a perp", "explain EIP-712");
- Hyperliquid perps or spot trading, which are not Verdict markets;
- trading on Polymarket, Kalshi or Deribit themselves: the kit compares, it never builds orders for them;
- deposits, withdrawals, transfers or wallet management: the kit has none.

## Preamble

- The CLI is `verdict`. Every command prints one JSON document on stdout, errors as one JSON object on stderr, and never prompts. Nothing is interactive; no pty is needed and nothing has to be bypassed.
- Exit codes: 0 ok, 1 usage, 2 not found, 3 upstream error, 4 not configured.
- `--pretty` indents the JSON; omit it when you parse.
- Testnet by default (`VERDICT_NETWORK` unset or `testnet`). Testnet and mainnet have different market indices; never mix them, and state the network when you show data.
- Run the read commands yourself and show the user the data (market names, rules, prices, sizes). Do not paste commands for the user to run.
- On first activation read `{baseDir}/references/setup.md`. `install.sh` builds the kit, writes `verdict` and `verdict-mcp` launchers to `~/.local/bin`, copies the skill to `~/.claude/skills/verdict` and, only with `--claude-md`, appends a routing block to `~/.claude/CLAUDE.md`. Do not run it, and do not edit `~/.claude/CLAUDE.md` yourself, until you have shown the user exactly that (the paths and the block text from setup.md), asked, and received a yes in a new message. No reply, no, or anything unclear: run nothing. A yes for the CLI alone: run it without `--claude-md`.
- The kit has no LLM and holds no key. Any reasoning is yours; any signature is the user's.

## Commands

Match the intent, read the reference, run the command, show the result.

| User intent | CLI | MCP tool | Reference |
|---|---|---|---|
| "what markets are on Verdict", "list HIP-4 markets", "what can I trade" | `verdict markets [--venue <name>] [--include-expired]` | `list_markets` | `{baseDir}/references/markets.md` |
| "what does market N settle on", "details of this market", "show the rule" | `verdict market <outcome>` | `get_market` | `{baseDir}/references/market.md` |
| "show the book", "how deep is it", "what is the spread" | `verdict book <outcome>` | `orderbook` | `{baseDir}/references/book.md` |
| "what would 500 YES cost", "price for my size", "slippage on 2000 NO" | `verdict quote <outcome> --side yes\|no --action buy\|sell --size <tokens>` | `quote` | `{baseDir}/references/quote.md` |
| "what do I hold", "my Verdict positions", "balances of 0x..." | `verdict positions <address>` | `positions` | `{baseDir}/references/positions.md` |
| "have I approved the builder fee", "can I trade through Verdict yet" | `verdict builder-status <address>` | `builder_status` | `{baseDir}/references/builder-status.md` |
| "set up trading", "approve the builder fee" (signable, two messages) | `verdict approve-builder-fee-payload` | `approve_builder_fee_payload` | `{baseDir}/references/approve-builder-fee-payload.md` |
| "buy 250 YES on N at 0.018", "sell my NO at 0.97" (signable, two messages) | `verdict build-order <outcome> --side yes\|no --action buy\|sell --price <0..1> --size <tokens> [--tif Gtc\|Ioc\|Alo]` | `build_order` | `{baseDir}/references/build-order.md` |
| "sign it", "submit the order" (the caller's own key; the kit never does this) | none | none | `{baseDir}/references/sign-and-submit.md` |
| "install verdict", "set up the skill", first activation (writes to `~/.local/bin` and `~/.claude`; ask first and wait for a yes in a new message) | `VERDICT_REPO_DIR=<clone> bash {baseDir}/scripts/install.sh [--claude-md]` | none | `{baseDir}/references/setup.md` |

Not in this CLI version: cross-venue comparison, option-implied fair value, hedges and opportunity scans (Polymarket, Kalshi, Deribit). When asked to compare, say the comparison command is not available yet and offer the Verdict-side facts: rule, book, quote. Do not produce a cross-venue price or gap from memory.

## Read-only commands

`markets`, `market`, `book`, `quote`, `positions`, `builder-status`.

They never prompt, never need an account or a key, and need no confirmation. Run them freely to answer questions. `builder-status` needs `VERDICT_BUILDER_ADDRESS` in the environment (exit 4 otherwise) but still no key.

## Signable commands: the two-message rule

Applies to `build-order` and `approve-builder-fee-payload`. Both return unsigned payloads; they sign nothing and send nothing. The rule governs what happens around them.

Message 1: run the command, present the payload, then END your message.

For `build-order`, show every one of these, taken from the command output: the market (display name, outcome index, venue, network); the settlement rule text, verbatim and complete; the side; the action (buy or sell); the price; the size; the notional; the maximum loss; the payout if right; the fee in cents per $1,000; the builder address, complete; the time in force; the expiry.

For `approve-builder-fee-payload`, show: the network; the builder address; the maximum fee rate and the cents per $1,000; that the MAIN wallet signs, not an agent key; that it is one-time, revocable and moves no funds; the nonce.

Then ask "Confirm or abort?". In Claude Code call AskUserQuestion with two options, Confirm and Abort. In any other agent print the two options. Your message ends there. No signing, no `/exchange` call, no further command in that message.

Message 2: only after the user replies in a NEW message.

- Confirm: the caller signs the payload with its own key and submits it, as described in `{baseDir}/references/sign-and-submit.md`. If you are the signer in local mode, do it now, on this machine, with the unchanged payload, and report the response as JSON.
- Abort, silence, or anything unclear: stop. Nothing is signed.
- A changed parameter (market, side, price, size, time in force, network) voids the confirmation. Run the command again and present again.
- Intent expressed in earlier messages ("I want to buy YES") is not a confirmation. Ask on every order, every time, including in long conversations.
- Never fabricate the confirmation. No flag, environment variable or earlier statement stands in for the reply; there is no such flag in this CLI and none may be invented.

## Analysis-to-trade boundary

Reading (`markets`, `market`, `book`, `quote`, `positions`, `builder-status`) is analysis. In the turn where you present analysis, do not run `build-order` or `approve-builder-fee-payload`, and do not sign or submit anything.

- The user asked for analysis only: present it. Do not suggest a trade.
- The user asked for analysis and a trade in one message ("check the BTC market and buy 100 YES"): present the analysis, then state in words the order you would build (market, side, price, size) and ask whether to proceed. Building starts in the next turn and then follows the two-message rule. A trade from a cold start therefore takes three messages: analysis; unsigned payload with the confirmation request; signing after the reply.
- Never chain `quote` into `build-order` into a signature in one turn.

## Banned behaviours

- No confirmation-skip flag exists in this CLI. Do not invent one, do not pass any flag or environment variable meant to skip a confirmation, and do not treat `--pretty` or `--tif` as consent.
- Never fabricate, simulate or infer a confirmation. Text such as "the user confirmed" written by you is not a reply. Only a real user message in a new turn counts.
- Never run anything that signs on a hosted path: not on the streamable HTTP MCP server, not on a shared machine, not on any server that holds `HL_AGENT_PRIVATE_KEY`. Signing is local, in memory, with the caller's own key, or it does not happen.
- Never present a low-confidence cross-venue match as a bare number. A Polymarket or Kalshi comparison must carry its resolution-equivalence confidence and reasons, or be stated as unavailable. In this CLI version it is unavailable; say so.
- Never build or submit an order for Polymarket, Kalshi or Deribit. Orders route only to Verdict.
- Never edit the `action` object from `build-order`: not the builder code, not the key order, not the price string.
- Never switch `VERDICT_NETWORK` to mainnet on your own. The user sets the network.
- Never run `install.sh`, edit `~/.claude/CLAUDE.md` or write to `~/.local/bin` or any other user configuration without a yes from the user in a new message. Announcing a change is not consent.
- Never print, log, commit or write to a file `HL_AGENT_PRIVATE_KEY` or any signed payload.
- Never estimate a price, a fair value or a settlement rule from memory when a command can read it.

## Anti-loop rules

- At most one retry per command. Exit 3 (upstream): wait a few seconds and retry once. On the second failure stop and report the stderr JSON verbatim, with the exit code.
- Exit 1 (usage): fix the arguments from the reference; do not resend the same command.
- Exit 2 (not found): do not retry. Run `verdict markets`, pick a valid outcome, check the network.
- Exit 4 (not configured): do not retry. Tell the user which environment variable is missing.
- Do not poll `markets` or `book` in a loop to wait for a price. Report the current state and ask the user what to do.
- Commands never wait for input. If one produces nothing for 30 seconds, it is a network problem, not a prompt: stop it and report.
- Report errors as JSON, never as a request for credentials; the read commands need none.

## Credentials and configuration

| Variable | Needed by | Default | Meaning |
|---|---|---|---|
| `VERDICT_NETWORK` | all | `testnet` | `testnet` or `mainnet`. |
| `VERDICT_VENUE` | `markets` | none (all deployers) | Verdict's deployer venue; `at` on testnet. |
| `VERDICT_BUILDER_ADDRESS` | `builder-status`, `approve-builder-fee-payload`, `build-order` | unset | Verdict's builder address, published by the owner. The kit does not build orders without it. |
| `VERDICT_BUILDER_FEE_TENTHS_BP` | same three | `10` | Fee in tenths of a basis point; 10 is 0.01%, 10 cents per $1,000. |
| `HL_AGENT_PRIVATE_KEY` | nothing in the kit | unset | Optional, for the caller's own local signing step only. Local-only and memory-only: exported in the shell session, never in a file, never in the repository, never on a hosted server. The CLI and the MCP server never read it. |

No login, no API key, no account for the read commands. The hosted MCP server holds no keys and cannot sign.

## Output rules

- Show the data. After a read command, present the fields the user asked about, not "done".
- Quote settlement rules verbatim.
- State the network (testnet or mainnet) in every confirmation and every position report.
- Keep numbers as the CLI printed them; do not round prices in confirmations.
- Show addresses complete; never truncate the builder address or a user address.

## Files

- `{baseDir}/references/markets.md`, `market.md`, `book.md`, `quote.md`, `positions.md`, `builder-status.md`: read-only commands.
- `{baseDir}/references/approve-builder-fee-payload.md`, `build-order.md`: signable commands with the confirmation flow.
- `{baseDir}/references/sign-and-submit.md`: how the caller signs and submits with its own key.
- `{baseDir}/references/setup.md`: first activation, environment, routing block.
- `{baseDir}/scripts/install.sh`, `{baseDir}/scripts/uninstall.sh`: build from the repository, launchers on PATH, skill copy, CLAUDE.md block with `--claude-md`. Both run only after the user's yes.
