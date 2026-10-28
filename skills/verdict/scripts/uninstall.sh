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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/routing-block.sh"
# An installed copy removes its own directory in step 2. Retain compatibility text first.
LEGACY_CLAUDE_MD_BLOCK="$(cat "$SCRIPT_DIR/legacy-routing-block.txt")"
PREVIOUS_CLAUDE_MD_BLOCK="$(cat "$SCRIPT_DIR/previous-routing-block.txt")"
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
  START="$(find_exact_routing_block "$BLOCK_FILE" "$CLAUDE_MD")"
  for previous in "$PREVIOUS_CLAUDE_MD_BLOCK" "$LEGACY_CLAUDE_MD_BLOCK"; do
    if [[ "$START" != 0 ]]; then break; fi
    printf '%s\n' "$previous" > "$BLOCK_FILE"
    START="$(find_exact_routing_block "$BLOCK_FILE" "$CLAUDE_MD")"
    COUNT="$(wc -l < "$BLOCK_FILE" | tr -d ' ')"
  done
  MATCHED_BLOCK="$(cat "$BLOCK_FILE")"
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
    printf '%s\n' "$MATCHED_BLOCK" | sed 's/^/    /'
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
