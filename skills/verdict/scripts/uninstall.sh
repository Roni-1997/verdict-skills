#!/usr/bin/env bash
# Reverse install.sh: remove the launchers it wrote (the ones carrying its marker comment), the skill
# copy it wrote (the directory carrying .repo-dir, which install.sh writes into its copy), and, from
# ~/.claude/CLAUDE.md, exactly the `## Verdict` block install.sh --claude-md appended (matched line for
# line, printed before removal). Any other text, including other headings that start with "## Verdict"
# and anything added after the block, stays. A launcher without the marker, a skill directory without
# .repo-dir, or a `## Verdict` section that is not that block was not written by install.sh: each is
# left in place, reported, and makes the exit code 1. One byte cannot come back: when CLAUDE.md had no
# final newline, install.sh added one before the block and it stays.
# Leaves the repository and every other file alone. Touches no keys. Never prompts. Safe to run when
# nothing is installed. No network access.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: uninstall.sh [--keep-claude-md] [--keep-skill] [--help]

Environment overrides:
  VERDICT_BIN_DIR    where the launchers are (default: ~/.local/bin)
  CLAUDE_HOME        Claude Code home (default: ~/.claude)
USAGE
}

KEEP_CLAUDE_MD=0
KEEP_SKILL=0
for arg in "$@"; do
  case "$arg" in
    --keep-claude-md) KEEP_CLAUDE_MD=1 ;;
    --keep-skill) KEEP_SKILL=1 ;;
    --help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

BIN_DIR="${VERDICT_BIN_DIR:-$HOME/.local/bin}"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
SKILL_DST="$CLAUDE_HOME/skills/verdict"
CLAUDE_MD="$CLAUDE_HOME/CLAUDE.md"
# Same string as MARKER in install.sh; every launcher install.sh writes carries it as a comment line.
MARKER="verdict-skills launcher, written by skills/verdict/scripts/install.sh"
# Set when something at a path install.sh uses was not written by install.sh and therefore stays.
LEFT_IN_PLACE=0

# The block install.sh writes. Must match install.sh and references/setup.md byte for byte;
# tests/skill.test.ts checks this. Only a verbatim copy of it is ever removed.
CLAUDE_MD_BLOCK=$(cat <<'BLOCK'
## Verdict

Verdict's HIP-4 outcome markets on Hyperliquid are available through the `verdict` skill (~/.claude/skills/verdict).

### Routing

Load the verdict skill, not web search or memory, when the request involves:

- Verdict, hyperverdict, the Verdict venue or its markets
- HIP-4, outcome market, Hyperliquid prediction market, YES or NO on Hyperliquid
- a settlement rule, order book, quote for a size, or positions on such a market
- "compare to Polymarket" or "compare to Kalshi" for a market that exists on Verdict
- Verdict's builder code, builder fee or builder approval

Do not load it for general blockchain education, Hyperliquid perps or spot, or trading on Polymarket, Kalshi or Deribit themselves.

### Rules the skill enforces

- Read commands (markets, market, book, quote, compare, fair-value, hedges, opportunities, positions, builder-status) run without asking and need no account. A Polymarket or Kalshi comparison is shown with its confidence and reasons, never as a bare number.
- build-order and approve-builder-fee-payload return unsigned payloads. Show the market, the settlement rule text, side, price, size, the fee in cents per $1,000 and the builder address, end the message, and wait for a real reply in a new message before anything is signed. Never fabricate a confirmation.
- Analysis and order building never happen in the same turn.
- Nothing signs on a hosted server; keys stay local and in memory.
BLOCK
)

echo "==> [1/3] Launchers in $BIN_DIR"
for name in verdict verdict-mcp; do
  target="$BIN_DIR/$name"
  if [[ -f "$target" ]] && grep -q "$MARKER" "$target"; then
    rm -f "$target"
    echo "    removed $target"
  elif [[ -e "$target" || -L "$target" ]]; then
    echo "    $target was not written by install.sh (no marker comment); left in place"
    LEFT_IN_PLACE=1
  else
    echo "    $target not present"
  fi
done

echo "==> [2/3] Skill in $SKILL_DST"
if [[ "$KEEP_SKILL" == 1 ]]; then
  echo "    kept"
elif [[ -d "$SKILL_DST" && -f "$SKILL_DST/.repo-dir" ]]; then
  rm -rf "$SKILL_DST"
  echo "    removed (it carried .repo-dir, which install.sh writes into its copy)"
elif [[ -e "$SKILL_DST" ]]; then
  echo "    $SKILL_DST was not written by install.sh (no .repo-dir file); left in place"
  LEFT_IN_PLACE=1
else
  echo "    not present"
fi

echo "==> [3/3] Routing block in $CLAUDE_MD"
if [[ "$KEEP_CLAUDE_MD" == 1 ]]; then
  echo "    kept"
elif [[ -f "$CLAUDE_MD" ]] && grep -q '^## Verdict$' "$CLAUDE_MD"; then
  BLOCK_FILE="$(mktemp)"
  printf '%s\n' "$CLAUDE_MD_BLOCK" > "$BLOCK_FILE"
  COUNT="$(wc -l < "$BLOCK_FILE" | tr -d ' ')"
  # First line of a run of lines equal to the block, line for line; 0 when the file has no verbatim copy.
  START="$(awk '
    NR == FNR { block[++n] = $0; next }
    { line[++m] = $0 }
    END {
      for (i = 1; i + n - 1 <= m; i++) {
        if (line[i] != block[1]) continue
        ok = 1
        for (j = 2; j <= n; j++) if (line[i + j - 1] != block[j]) { ok = 0; break }
        if (ok) { print i; exit }
      }
      print 0
    }' "$BLOCK_FILE" "$CLAUDE_MD")"
  rm -f "$BLOCK_FILE"
  if [[ "$START" == 0 ]]; then
    echo "    a '## Verdict' section is present but it is not the block install.sh writes; left in place:"
    echo "    ------------------------------------------------------------"
    awk 'BEGIN { inside = 0 } /^##? / { inside = ($0 == "## Verdict") } inside { print }' "$CLAUDE_MD" | sed 's/^/    /'
    echo "    ------------------------------------------------------------"
    echo "    Edit $CLAUDE_MD by hand if that section should go."
    LEFT_IN_PLACE=1
  else
    echo "    The following block will be removed from $CLAUDE_MD (lines $START to $((START + COUNT - 1))):"
    echo "    ------------------------------------------------------------"
    printf '%s\n' "$CLAUDE_MD_BLOCK" | sed 's/^/    /'
    echo "    ------------------------------------------------------------"
    TMP="$(mktemp)"
    # Drop exactly those lines, plus the one blank separator line install.sh put in front of them when
    # the file already had content, and nothing else: text before and after the block stays as it is.
    # (A final newline install.sh added to a file that had none stays; awk cannot know it was absent.)
    awk -v start="$START" -v count="$COUNT" '
      NR == start - 1 && $0 ~ /^[[:space:]]*$/ { next }
      NR >= start && NR < start + count { next }
      { print }' "$CLAUDE_MD" > "$TMP"
    cat "$TMP" > "$CLAUDE_MD"
    rm -f "$TMP"
    echo "    removed"
  fi
else
  echo "    no '## Verdict' section present"
fi

echo
if [[ "$LEFT_IN_PLACE" == 1 ]]; then
  echo "Done, except what was left in place (see above): it was not written by install.sh, so remove it by hand if it should go. The repository clone and its node_modules were not touched."
  exit 1
fi
echo "Done. The repository clone and its node_modules were not touched."
