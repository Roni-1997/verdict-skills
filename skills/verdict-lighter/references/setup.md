# Install or connect the Verdict kit

Use Node 22 and pnpm 10.34.5. Build a clone with `pnpm install --frozen-lockfile` and `pnpm run build`.

## Connect research

Register `node <clone>/packages/mcp/dist/bin.js` as your MCP command. Set `LIGHTER_NETWORK=testnet` for staging. The default is devnet. `--lighter` is a compatibility alias for the default Lighter server.

Use `LIGHTER_CREATORS` for operator-verified creator account indices on the selected network. Public discovery needs no credentials. Unsigned SDK argument preparation requires a creator allowlist.

For local HTTP, run `LIGHTER_NETWORK=testnet verdict-mcp --http 8787`. The loopback endpoint is `http://127.0.0.1:8787/mcp`. This research server has no authentication and holds no keys. Use an authenticated gateway before exposing it remotely.

## Install the skill and launchers

The installer writes user configuration. If the user has not already authorized the installation, wait for a yes in a new message before running it:

```sh
	bash <clone>/skills/verdict/scripts/install.sh --claude-md
```

It fetches the repository's lockfile-pinned npm dependencies from the npm registry and checks `pnpm-lock.yaml`. It pipes nothing from the network into a shell. It builds the clone, writes marked `verdict` and `verdict-mcp` launchers, and copies the default `verdict` skill with a `.repo-dir` marker that remembers the clone path.

Without `--claude-md`, the installer leaves `CLAUDE.md` alone. With the flag, it appends the block below or upgrades an exact copy of the previous managed routing block. Repeated runs preserve the current block. A user-edited or unrecognized section remains unchanged, with instructions to review it by hand.

```markdown
## Verdict

Verdict's agentic trading kit for Lighter binary outcome markets is available through the `verdict` skill (~/.claude/skills/verdict).

### Routing

Load the verdict skill when the request involves:

- Verdict markets or Lighter binary outcomes
- settlement rules, executable quotes, liquidity, fees, recent prints, or public positions
- connecting an agent, reviewing a trade, approving an exact order, or SDK execution
- original order status, reconciliation, or cancellation

Perps, spot, and paired trading are outside this skill.

### Rules the skill enforces

- Public research needs no key. State the network and use numeric Lighter account and market IDs.
- Review the account, network, creator, market, full settlement rule, action, side, price, size, spend, fees, and expiry before execution. Never fabricate confirmation.
- In per_order mode, show the exact terms and open the independent review. Hosted approval belongs to the signed-in user in the browser; local approval belongs to the operator's terminal. No extra chat yes is required before opening the hosted review. The agent cannot approve.
- Policy mode requires an explicitly selected, existing owner-approved bounded grant. The agent cannot change mode, issue grants, or expand limits.
- Only the separate SDK broker or private hosted signer signs. The public MCP and agent hold no venue keys.
- After uncertain delivery, reconcile the unchanged original proposal. Never automatically retry or replace the order.
```

`bash <clone>/skills/verdict/scripts/uninstall.sh` needs no build, Node process, or network. It removes only marked launchers, a skill copy carrying `.repo-dir`, and an exact current or previous managed routing block. Unrecognized files stay in place and produce exit 1. A final newline added to a file that previously lacked one remains after removal.

## Connect execution

The default research server signs nothing. `--execution` prepares and reviews unsigned single-Lighter proposals. `--local-execution` requires `VERDICT_BROKER_SOCKET` and an explicit `VERDICT_EXECUTION_MODE=per_order|policy`. Use a separate default research connection if needed.

Hosted execution and account service require operator-managed connector configuration. Their public MCP process is keyless; the separate private signer uses the official SDK under reviewed authority. See `references/execution.md` for approval and reconciliation rules. Never put signing keys or login tokens in agent configuration.

The hosted staging endpoint exists at `https://verdict-mcp-staging.vercel.app/mcp`. Connect with that URL through client OAuth and Verdict login. Saved account/key setup resumes; owner signatures and order approval remain explicit. This is a Lighter testnet pilot, not general availability or mainnet acceptance.
