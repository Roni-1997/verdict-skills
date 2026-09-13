#!/usr/bin/env bash
# Install the Verdict agent kit for a coding agent, from this repository:
#   1. pnpm install and pnpm run build
#   2. launchers `verdict` and `verdict-mcp` on PATH (nothing is published to npm yet, and pnpm 10
#      has no global link from a package directory, so each launcher is a two-line script that runs
#      node on the built bin of packages/cli and packages/mcp)
#   3. copy skills/verdict to ~/.claude/skills/verdict
#   4. append a `## Verdict` routing block to ~/.claude/CLAUDE.md, after printing it, only if absent
# Downloads nothing from third parties. Touches no keys. Safe to run again.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install.sh [--skip-claude-md] [--skip-skill] [--help]

Environment overrides:
  VERDICT_REPO_DIR   repository root (default: three directories above this script)
  VERDICT_BIN_DIR    where the launchers go (default: ~/.local/bin)
  CLAUDE_HOME        Claude Code home (default: ~/.claude)
USAGE
}

SKIP_CLAUDE_MD=0
SKIP_SKILL=0
for arg in "$@"; do
  case "$arg" in
    --skip-claude-md) SKIP_CLAUDE_MD=1 ;;
    --skip-skill) SKIP_SKILL=1 ;;
    --help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${VERDICT_REPO_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
BIN_DIR="${VERDICT_BIN_DIR:-$HOME/.local/bin}"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
SKILL_SRC="$REPO_DIR/skills/verdict"
SKILL_DST="$CLAUDE_HOME/skills/verdict"
CLAUDE_MD="$CLAUDE_HOME/CLAUDE.md"

if [[ ! -f "$REPO_DIR/pnpm-workspace.yaml" || ! -f "$REPO_DIR/packages/cli/package.json" || ! -f "$SKILL_SRC/SKILL.md" ]]; then
  echo "error: $REPO_DIR is not the verdict-skills repository. Run this script from a clone, or set VERDICT_REPO_DIR." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "error: node not found (Node 22 expected)" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm not found (pnpm 10.34.5 expected; run: corepack enable)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "note: Node $NODE_MAJOR found; the kit targets Node 22 (.nvmrc). Continuing."
fi

echo "==> [1/4] Dependencies and build in $REPO_DIR"
pnpm -C "$REPO_DIR" install --frozen-lockfile
pnpm -C "$REPO_DIR" run build
[[ -f "$REPO_DIR/packages/cli/dist/bin.js" && -f "$REPO_DIR/packages/mcp/dist/bin.js" ]] || { echo "error: build did not produce packages/*/dist/bin.js" >&2; exit 1; }

echo "==> [2/4] Launchers in $BIN_DIR"
mkdir -p "$BIN_DIR"
write_launcher() {
  local target="$BIN_DIR/$1"
  cat > "$target" <<LAUNCHER
#!/usr/bin/env bash
# verdict-skills launcher, written by skills/verdict/scripts/install.sh
exec node "$2" "\$@"
LAUNCHER
  chmod 0755 "$target"
  echo "    $target runs node $2"
}
write_launcher verdict "$REPO_DIR/packages/cli/dist/bin.js"
write_launcher verdict-mcp "$REPO_DIR/packages/mcp/dist/bin.js"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "    note: $BIN_DIR is not on PATH. Add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo "==> [3/4] Skill in $SKILL_DST"
if [[ "$SKIP_SKILL" == 1 ]]; then
  echo "    skipped"
else
  mkdir -p "$CLAUDE_HOME/skills"
  SRC_REAL="$(cd "$SKILL_SRC" && pwd -P)"
  DST_REAL=""
  if [[ -d "$SKILL_DST" ]]; then DST_REAL="$(cd "$SKILL_DST" && pwd -P)"; fi
  if [[ "$SRC_REAL" == "$DST_REAL" ]]; then
    echo "    source and destination are the same directory; nothing to copy"
  else
    rm -rf "$SKILL_DST.tmp"
    cp -R "$SKILL_SRC" "$SKILL_DST.tmp"
    rm -rf "$SKILL_DST"
    mv "$SKILL_DST.tmp" "$SKILL_DST"
    echo "    copied $(find "$SKILL_DST" -type f | wc -l | tr -d ' ') files"
  fi
fi

echo "==> [4/4] Routing block in $CLAUDE_MD"
CLAUDE_MD_BLOCK=$(cat <<'BLOCK'
## Verdict

Verdict's HIP-4 outcome markets on Hyperliquid are available through the `verdict` skill (~/.claude/skills/verdict).

### Routing

Load the verdict skill, not web search or memory, when the request involves:

- Verdict, hyperverdict, the Verdict venue or its markets
- HIP-4, outcome market, Hyperliquid prediction market, YES or NO on Hyperliquid
- a settlement rule, order book, quote for a size, or positions on such a market
- "compare to Polymarket" or "compare to Kalshi" for a market that exists on Verdict
- builder code, builder fee or builder approval on Hyperliquid

Do not load it for general blockchain education, Hyperliquid perps or spot, or trading on Polymarket, Kalshi or Deribit themselves.

### Rules the skill enforces

- Read commands (markets, market, book, quote, positions, builder-status) run without asking and need no account.
- build-order and approve-builder-fee-payload return unsigned payloads. Show the market, the settlement rule text, side, price, size, the fee in cents per $1,000 and the builder address, end the message, and wait for a real reply in a new message before anything is signed. Never fabricate a confirmation.
- Analysis and order building never happen in the same turn.
- Nothing signs on a hosted server; keys stay local and in memory.
BLOCK
)
if [[ "$SKIP_CLAUDE_MD" == 1 ]]; then
  echo "    skipped"
elif [[ -f "$CLAUDE_MD" ]] && grep -q '^## Verdict' "$CLAUDE_MD"; then
  echo "    a '## Verdict' section is already present; left unchanged"
else
  echo "    The following block will be appended to $CLAUDE_MD:"
  echo "    ------------------------------------------------------------"
  printf '%s\n' "$CLAUDE_MD_BLOCK" | sed 's/^/    /'
  echo "    ------------------------------------------------------------"
  mkdir -p "$CLAUDE_HOME"
  if [[ -s "$CLAUDE_MD" ]]; then
    printf '\n%s\n' "$CLAUDE_MD_BLOCK" >> "$CLAUDE_MD"
  else
    printf '%s\n' "$CLAUDE_MD_BLOCK" > "$CLAUDE_MD"
  fi
  echo "    appended"
fi

echo
echo "Done."
echo "  verdict       $BIN_DIR/verdict        (try: verdict --help)"
echo "  verdict-mcp   $BIN_DIR/verdict-mcp    (stdio by default; --http 8787 for streamable HTTP)"
echo "  skill         $SKILL_DST"
echo "  network       ${VERDICT_NETWORK:-testnet} (testnet by default; the owner flips it)"
echo
echo "Next: export the variables from $REPO_DIR/.env.example, then run:"
echo "  verdict markets --venue at --pretty"
