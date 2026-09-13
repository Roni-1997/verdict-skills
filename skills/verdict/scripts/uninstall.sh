#!/usr/bin/env bash
# Reverse install.sh: remove the launchers it wrote, the skill copy, and the `## Verdict` section of
# ~/.claude/CLAUDE.md (after printing what will be removed). Leaves the repository and every other
# file alone. Touches no keys. Safe to run when nothing is installed.
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
MARKER="verdict-skills launcher, written by skills/verdict/scripts/install.sh"

echo "==> [1/3] Launchers in $BIN_DIR"
for name in verdict verdict-mcp; do
  target="$BIN_DIR/$name"
  if [[ -f "$target" ]] && grep -q "$MARKER" "$target"; then
    rm -f "$target"
    echo "    removed $target"
  elif [[ -e "$target" ]]; then
    echo "    $target was not written by install.sh; left in place"
  else
    echo "    $target not present"
  fi
done

echo "==> [2/3] Skill in $SKILL_DST"
if [[ "$KEEP_SKILL" == 1 ]]; then
  echo "    kept"
elif [[ -d "$SKILL_DST" ]]; then
  rm -rf "$SKILL_DST"
  echo "    removed"
else
  echo "    not present"
fi

echo "==> [3/3] Routing block in $CLAUDE_MD"
if [[ "$KEEP_CLAUDE_MD" == 1 ]]; then
  echo "    kept"
elif [[ -f "$CLAUDE_MD" ]] && grep -q '^## Verdict' "$CLAUDE_MD"; then
  echo "    The following section will be removed from $CLAUDE_MD:"
  echo "    ------------------------------------------------------------"
  awk 'BEGIN { inside = 0 } /^## / { inside = ($0 ~ /^## Verdict( |$)/) } inside { print }' "$CLAUDE_MD" | sed 's/^/    /'
  echo "    ------------------------------------------------------------"
  TMP="$(mktemp)"
  # Drop the section, then trailing blank lines, so the file ends as it did before install.sh appended.
  awk 'BEGIN { skip = 0 } /^## / { skip = ($0 ~ /^## Verdict( |$)/) } !skip { print }' "$CLAUDE_MD" \
    | awk '{ lines[NR] = $0 } END { n = NR; while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }' > "$TMP"
  cat "$TMP" > "$CLAUDE_MD"
  rm -f "$TMP"
  echo "    removed"
else
  echo "    no '## Verdict' section present"
fi

echo
echo "Done. The repository clone and its node_modules were not touched."
