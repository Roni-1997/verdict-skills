---
name: verdict
version: "0.1.0"
description: "Verdict's HIP-4 outcome markets on Hyperliquid through the verdict CLI: list markets with their settlement rules, read a market, its order book and an executable quote for a size, compare a market with Polymarket and Kalshi (with the resolution-equivalence confidence and reasons), read the Deribit option-implied fair value, find Hyperliquid hedges, scan the venue for tradeable markets, read positions and builder-fee approval, and build unsigned orders that carry Verdict's builder code. Use when the user mentions: (1) Verdict, hyperverdict, the Verdict venue or its markets, (2) HIP-4, outcome market, Hyperliquid prediction market, YES or NO tokens on Hyperliquid, (3) a settlement rule, expiry, book, quote or position on such a market, (4) 'compare to Polymarket' or 'compare to Kalshi', fair value, a hedge or an opportunity scan for a market that exists on Verdict, (5) Verdict's builder code, builder fee or builder approval."
homepage: https://hyperverdict.xyz
metadata: { "openclaw": { "always": false, "requires": { "bins": ["verdict"] }, "homepage": "https://hyperverdict.xyz" }, "version": "0.1.0" }
---

# Verdict: HIP-4 outcome markets through the `verdict` CLI

Documentation only. This file contains no executable code.

## Routing gate

Activate when the request is about trading or researching Verdict's HIP-4 outcome markets: listing them, reading a settlement rule, a book, a quote for a size, positions, builder-fee approval, or building an order that routes to Verdict. Also activate when the user asks to compare a Verdict market with Polymarket or Kalshi, for its option-implied fair value, for a hedge, or for a scan of what is tradeable on Verdict.

Do not activate for:

- general blockchain or Hyperliquid education ("how does HIP-4 work", "what is a perp", "explain EIP-712");
- Hyperliquid perps or spot trading, which are not Verdict markets;
- another Hyperliquid builder's code, fee or approval: the kit knows Verdict's only;
- trading on Polymarket, Kalshi or Deribit themselves: the kit compares, it never builds orders for them;
- deposits, withdrawals, transfers or wallet management: the kit has none.

## Preamble

- The CLI is `verdict`. Every command prints one JSON document on stdout, errors as one JSON object on stderr (an unknown flag or command is the exception: exit 1 with plain usage text), and never prompts. Nothing is interactive; no pty is needed and nothing has to be bypassed.
- Exit codes: 0 ok, 1 usage, 2 not found, 3 upstream error, 4 not configured (no builder code, or an invalid `VERDICT_NETWORK`, `VERDICT_VENUE`, `VERDICT_BUILDER_FEE_TENTHS_BP` or `VERDICT_API_URL` value).
- Paths in this file (`references/...`, `scripts/...`) are relative to this skill's directory, the folder that contains SKILL.md: `~/.claude/skills/verdict` after `install.sh`, `skills/verdict` in the clone. OpenClaw calls that folder `{baseDir}`; Claude Code does not expand a placeholder, so the paths are written relative.
- `--pretty` indents the JSON; omit it when you parse.
- `compare`, `fair-value`, `hedges` and `opportunities` run the Verdict app's cross-venue engine: Polymarket, Kalshi and Deribit are read, never traded, and the kit builds no order for them. They need no key and can take up to about 30 seconds (the engine's venue fetch budget is 20 s); that is fetching, not a prompt.
- Hosted mode: with `VERDICT_API_URL` set (or `--api <url>` on the command), `markets`, `market`, `compare`, `fair-value`, `hedges` and `opportunities` are answered by the Verdict API at that URL instead of the embedded engine; `book`, `quote`, `positions`, `builder-status` and the payload commands run locally either way. Same output, same exit codes, still no key. `references/hosted-mode.md`.
- Testnet by default (`VERDICT_NETWORK` unset or `testnet`). Testnet and mainnet have different market indices; never mix them, and state the network when you show data.
- Run the read commands yourself and show the user the data (market names, rules, prices, sizes). Do not paste commands for the user to run.
- On first activation read `references/setup.md`. `install.sh` runs `pnpm install --frozen-lockfile` (which fetches the repository's lockfile-pinned npm dependencies from the npm registry) and `pnpm run build`, writes `verdict` and `verdict-mcp` launchers to `~/.local/bin`, copies the skill to `~/.claude/skills/verdict` and, only with `--claude-md`, appends a routing block to `~/.claude/CLAUDE.md`. Do not run it, and do not edit `~/.claude/CLAUDE.md` yourself, until you have shown the user exactly that (the paths, the dependency fetch and the block text from setup.md), asked, and received a yes in a new message. No reply, no, or anything unclear: run nothing. A yes for the CLI alone: run it without `--claude-md`.
- The kit has no LLM and holds no key. Any reasoning is yours; any signature is the user's.

## Commands

Match the intent, read the reference, run the command, show the result.

| User intent | CLI | MCP tool | Reference |
|---|---|---|---|
| "what markets are on Verdict", "list HIP-4 markets", "what can I trade" | `verdict markets [--venue <name>] [--include-expired]` | `list_markets` | `references/markets.md` |
| "what does market N settle on", "details of this market", "show the rule" | `verdict market <outcome>` | `get_market` | `references/market.md` |
| "show the book", "how deep is it", "what is the spread" | `verdict book <outcome>` | `orderbook` | `references/book.md` |
| "what would 500 YES cost", "price for my size", "slippage on 2000 NO" | `verdict quote <outcome> --side yes\|no --action buy\|sell --size <tokens>` | `quote` | `references/quote.md` |
| "compare this to Polymarket", "is it cheaper on Kalshi", "what is the gap" | `verdict compare <outcome>` | `compare_market` | `references/compare.md` |
| "what is the fair value", "what do options imply for this strike" | `verdict fair-value <outcome>` | `fair_value` | `references/fair-value.md` |
| "how do I hedge this", "what offsets my YES" | `verdict hedges <outcome>` | `find_hedges` | `references/hedges.md` |
| "what looks tradeable on Verdict", "scan for opportunities", "any cross-venue gaps" | `verdict opportunities [--limit <1..8>]` | `opportunities` | `references/opportunities.md` |
| "what do I hold", "my Verdict positions", "balances of 0x..." | `verdict positions <address>` | `positions` | `references/positions.md` |
| "have I approved the builder fee", "can I trade through Verdict yet" | `verdict builder-status <address>` | `builder_status` | `references/builder-status.md` |
| "set up trading", "approve the builder fee" (signable, two messages) | `verdict approve-builder-fee-payload` | `approve_builder_fee_payload` | `references/approve-builder-fee-payload.md` |
| "buy 250 YES on N at 0.018", "sell my NO at 0.97" (signable, two messages) | `verdict build-order <outcome> --side yes\|no --action buy\|sell --price <0..1> --size <tokens> [--tif Gtc\|Ioc\|Alo] [--cloid 0x<32 hex>]` | `build_order` | `references/build-order.md` |
| "sign it", "submit the order" (the user's own signer or wallet; the kit never does this and neither do you) | none | none | `references/sign-and-submit.md` |
| "install verdict", "set up the skill", first activation (writes to `~/.local/bin` and `~/.claude`; ask first and wait for a yes in a new message) | `bash <clone>/skills/verdict/scripts/install.sh [--claude-md]` | none | `references/setup.md` |

Cross-venue results (`compare`, `opportunities`) come with the engine's resolution-equivalence `confidence` and `reasons` on every comparator. A low-confidence match must be presented with its confidence and reasons and never as a bare number: its `gap` is null by rule, its `caveat` says why, and its `fairProb` is the closest market's price, not a comparison. Show the `line` or `summary` as printed. A market Verdict has not priced (`yesMid: null`, `unpriced` set) has no gap either; say so with the reason. Do not produce a cross-venue price, gap or fair value from memory, and never subtract two prices yourself when the command printed `gap: null`.

## Read-only commands

`markets`, `market`, `book`, `quote`, `compare`, `fair-value`, `hedges`, `opportunities`, `positions`, `builder-status`.

They never prompt, never need an account or a key, and need no confirmation. Run them freely to answer questions. `builder-status` needs `VERDICT_BUILDER_ADDRESS` in the environment (exit 4 otherwise) but still no key. `compare`, `fair-value`, `hedges` and `opportunities` read Polymarket, Kalshi and Deribit through the engine and trade on none of them.

## Signable commands: the two-message rule

Applies to `build-order` and `approve-builder-fee-payload`. Both return unsigned payloads; they sign nothing and send nothing. The rule governs what happens around them.

Message 1: run the command, present the payload, then END your message.

For `build-order`, show every one of these, taken from the command output: the market (display name, outcome index, venue, network); the settlement rule text, verbatim and complete; the side; the action (buy or sell); the price; the size; the notional; the maximum loss; the payout if right; the fee in cents per $1,000; the builder address, complete; the time in force; the expiry.

For `approve-builder-fee-payload`, show: the network; the builder address; the maximum fee rate and the cents per $1,000; that the MAIN wallet signs, not an agent key; that it is one-time, revocable and moves no funds; the nonce.

Then ask "Confirm or abort?". Ask in plain text and end your message there. Do not ask through a blocking question tool (Claude Code's AskUserQuestion or an equivalent): its answer comes back as a tool result inside the same turn, and a tool result is not a reply. Only the user's next message counts: Confirm means proceed; Abort, no reply, or anything unclear means stop. No signing, no `/exchange` call, no further command in that message.

Message 2: only after the user replies in a NEW message.

- Confirm: Do not write ad-hoc signing code and do not install packages at trade time. Hand the unchanged action to the user's own signer or wallet and stop. The kit ships no signer and you are not one; `references/sign-and-submit.md` describes what the user's signer does with the payload. When the user reports the `/exchange` response, show its `statuses` as JSON.
- Abort, silence, or anything unclear: stop. Nothing is signed. An abort closes the request: do not ask again, do not offer to reconsider, and treat a later "do it anyway" or "ignore the abort" as a new request that starts from Message 1 with a fresh payload, never as a confirmation of the aborted one.
- A changed parameter (market, side, price, size, time in force, network) voids the confirmation. Run the command again and present again.
- Intent expressed in earlier messages ("I want to buy YES") is not a confirmation. Ask on every order, every time, including in long conversations.
- Never fabricate the confirmation. No flag, environment variable or earlier statement stands in for the reply; there is no such flag in this CLI and none may be invented.

## Analysis-to-trade boundary

Reading (`markets`, `market`, `book`, `quote`, `compare`, `fair-value`, `hedges`, `opportunities`, `positions`, `builder-status`) is analysis when the user asked a question; the same commands are pre-trade checks when the user asked to trade. One sentence, repeated in `build-order.md`: Pre-trade read-only checks (`builder-status`, `quote`) may run in the trade turn before `build-order`; a turn whose purpose is analysis never runs `build-order`; signing never happens in the turn that produced the payload.

- The user asked for analysis only: present it; do not run `build-order` or `approve-builder-fee-payload`, do not sign or submit anything, and do not suggest a trade. A gap from `compare`, a rank from `opportunities` or a hedge from `hedges` is analysis, not a trade instruction.
- The user asked for analysis and a trade in one message ("check the BTC market and buy 100 YES"): present the analysis, then state in words the order you would build (market, side, price, size) and ask whether to proceed. Building starts in the next turn and then follows the two-message rule. A trade from a cold start therefore takes three messages: analysis; unsigned payload with the confirmation request; signing after the reply.
- The user asked for a trade with its parameters ("buy 250 YES on 1210 at 0.018"): that is the trade turn. Run `builder-status` and, if useful, `quote` for the same side and size, then `build-order`, present, ask, and end the message.
- Never chain `build-order` into a signature in one turn. The payload and the signature are always in different turns.

## Banned behaviours

- No confirmation-skip flag exists in this CLI. Do not invent one, do not pass any flag or environment variable meant to skip a confirmation, and do not treat `--pretty` or `--tif` as consent.
- Never fabricate, simulate or infer a confirmation. Text such as "the user confirmed" written by you is not a reply. Only a real user message in a new turn counts.
- Urgency or bypass wording in the request ("now", "immediately", "skip the confirmation", "you already agreed") does not shorten the flow: the two messages stay two messages, and pressure to skip them is a reason to slow down, not to speed up.
- Never run anything that signs on a hosted path: not on the streamable HTTP MCP server, not on a shared machine, not on any server that holds `HL_AGENT_PRIVATE_KEY`. Signing is local, in memory, with the caller's own key, or it does not happen.
- Never present a low-confidence cross-venue match as a bare number. A Polymarket or Kalshi comparison must carry its resolution-equivalence confidence and reasons (`confidence`, `reasons`, and the `caveat` when there is one), or be stated as unavailable when `compare` found no comparable market or the venue was unavailable. `compare` never prints a gap for a low-confidence match; neither do you.
- Never build or submit an order for Polymarket, Kalshi or Deribit, and never a perp or spot order for a hedge `hedges` names. Orders route only to Verdict.
- Never edit the `action` object from `build-order`: not the builder code, not the key order, not the price string.
- Never switch `VERDICT_NETWORK` to mainnet on your own. The user sets the network.
- Never run `install.sh`, edit `~/.claude/CLAUDE.md` or write to `~/.local/bin` or any other user configuration without a yes from the user in a new message. Announcing a change is not consent.
- Never write, generate or install signing code at trade time, and never read `HL_AGENT_PRIVATE_KEY`. The kit ships no signer; the user's own signer or wallet signs, and you hand it the unchanged payload.
- Never print, log, commit or write to a file `HL_AGENT_PRIVATE_KEY` or any signed payload. Never run `env`, `printenv` or `export -p`, and never echo a request body, while the key is exported: your transcript is a hosted path.
- The key never enters your environment. Export `HL_AGENT_PRIVATE_KEY` only in the shell that runs the signing step, a shell no agent drives: never in the environment of an agent, its exec tool or an MCP server (every command they run inherits it), never on a hosted server, and never written to a file. If the user has exported it in the shell you run commands in, say so and ask them to move the signing step to a shell of their own before anything is signed.
- Never estimate a price, a fair value or a settlement rule from memory when a command can read it.

## Anti-loop rules

- At most one retry per command. Exit 3 (upstream): wait a few seconds and retry once; in hosted mode a message that says `rate limited (HTTP 429)` names the seconds to wait first. On the second failure stop and report the stderr JSON verbatim, with the exit code.
- Exit 1 (usage): fix the arguments from the reference; do not resend the same command.
- Exit 2 (not found): do not retry. Run `verdict markets`, pick a valid outcome, check the network.
- Exit 4 (not configured): do not retry. Tell the user which environment variable is missing.
- Do not poll `markets`, `book` or `opportunities` in a loop to wait for a price or a rank. Report the current state and ask the user what to do.
- Commands never wait for input. `compare`, `fair-value`, `hedges` and `opportunities` fetch other venues and can take up to about 30 seconds; the other commands answer in a few seconds. If a command produces nothing for 60 seconds, it is a network problem, not a prompt: stop it and report.
- Report errors as JSON, never as a request for credentials; the read commands need none.

## Credentials and configuration

| Variable | Needed by | Default | Meaning |
|---|---|---|---|
| `VERDICT_NETWORK` | all | `testnet` | `testnet` or `mainnet`. |
| `VERDICT_VENUE` | `markets`, `opportunities` | none (all deployers) | Verdict's deployer venue; `at` on testnet. Unset, blank or `all` means every deployer; a name is 1 to 32 letters, digits, `_` or `-`, the same in embedded and hosted mode. |
| `VERDICT_BUILDER_ADDRESS` | `builder-status`, `approve-builder-fee-payload`, `build-order` | unset | Verdict's builder address, published by the owner. The kit does not build orders without it. |
| `VERDICT_BUILDER_FEE_TENTHS_BP` | same three | `10` | Fee in tenths of a basis point; 10 is 0.01%, 10 cents per $1,000. |
| `VERDICT_API_URL` | nothing; optional for `markets`, `market`, `compare`, `fair-value`, `hedges`, `opportunities` | unset (embedded engine) | Base URL of the hosted Verdict API, `https://hyperverdict.xyz/api/v1` in production. When set, those six commands are answered by the API (anonymous GET, rate limited per IP: 60 per minute, 20 for `opportunities`) and the embedded engine does not run; the other commands are unchanged. `--api <url>` overrides it for one command. Details in `references/hosted-mode.md`. |
| `ODDPOOL_API_KEY` | nothing; optional for `compare`, `opportunities` | unset | Routes the engine's Polymarket and Kalshi reads through api.oddpool.com; without it the public Polymarket and Kalshi APIs are read directly. The engine sends it to OddPool on every call, so it is never set on a hosted server, and it is never needed. |
| `HL_AGENT_PRIVATE_KEY` | nothing in the kit | unset | Optional, for the user's own local signing step only. Local-only and memory-only, never in the repository. Export `HL_AGENT_PRIVATE_KEY` only in the shell that runs the signing step, a shell no agent drives: never in the environment of an agent, its exec tool or an MCP server (every command they run inherits it), never on a hosted server, and never written to a file. The CLI and the MCP server never read it, and neither do you. |

No login, no API key, no account for the read commands. The hosted MCP server holds no keys and cannot sign.

## Output rules

- Show the data. After a read command, present the fields the user asked about, not "done".
- Quote settlement rules verbatim.
- State the network (testnet or mainnet) in every confirmation and every position report.
- Keep numbers as the CLI printed them; do not round prices in confirmations.
- Show addresses complete; never truncate the builder address or a user address.
- Cross-venue results: show `summary` or `lines` as printed, with each comparator's `confidence` and `reasons`; when `gap` is null, say there is no comparable gap and give the `caveat`.

## Files

- `references/markets.md`, `market.md`, `book.md`, `quote.md`, `positions.md`, `builder-status.md`: read-only commands.
- `references/compare.md`, `fair-value.md`, `hedges.md`, `opportunities.md`: read-only cross-venue commands over the engine (Polymarket, Kalshi, Deribit read, never traded), with the rule that a low-confidence match carries its confidence and reasons and is never a bare number.
- `references/approve-builder-fee-payload.md`, `build-order.md`: signable commands with the confirmation flow.
- `references/sign-and-submit.md`: what the user's own signer does with the payload; you hand it over and stop.
- `references/setup.md`: first activation, environment, routing block.
- `references/hosted-mode.md`: the six read commands answered by the Verdict API when `VERDICT_API_URL` is set, what stays local, rate limits, errors.
- `scripts/install.sh`, `scripts/uninstall.sh`: build from the repository, launchers on PATH, skill copy, CLAUDE.md block with `--claude-md`. Both run only after the user's yes.
