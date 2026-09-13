#!/usr/bin/env bash
# Run the Crypto Skill Bench (Minara-AI/crypto-skill-benchmark) against skills/verdict.
#
#   1. static pre-check: node scripts/skill-static-check.mjs (no network, no key). A failure stops here:
#      a known gap in the skill text is not worth a paid run.
#   2. requirements: node >= 18, git, npm, and an OpenRouter key, either OPENROUTER_API_KEY in the
#      environment or ~/.crypto-skill-bench/config.json written by the benchmark's own first-run prompt.
#      Missing: exit 2 with a message. This script never prints the key, never writes it anywhere and
#      never passes it as an argument.
#   3. benchmark: clone the pinned commit into bench/.cache (gitignored), npm ci, tsc build, once.
#   4. evaluate: run from bench/runs/<utc timestamp>/ so the report lands there, then read the Safety
#      Gate and the score from the report JSON. Exit 0 when the gate is PASS and the score beats the
#      Hyperliquid skills on the leaderboard (63), exit 1 otherwise.
#
# Usage: scripts/bench.sh [--setup-only] [--skip-static] [--help] [evaluate options...]
#   Anything else is passed to `crypto-skill-bench evaluate`: --tier basic|intermediate|adversarial|all,
#   --concurrency N, --model <judge id>, --skill-model <skill id>, --compare.
#
# Environment:
#   OPENROUTER_API_KEY   the key, exported in this shell for this run only
#   BENCH_JUDGE_MODEL    default anthropic/claude-haiku-4-5, the judge behind the published leaderboard
#                        (the benchmark's own default is anthropic/claude-opus-4-6, ~20x the cost)
#   BENCH_SKILL_MODEL    default anthropic/claude-sonnet-4-6
#   BENCH_CACHE_DIR      default bench/.cache;  BENCH_RUNS_DIR default bench/runs;  VERDICT_SKILL_DIR default skills/verdict
set -euo pipefail

BENCH_REPO="https://github.com/Minara-AI/crypto-skill-benchmark.git"
BENCH_COMMIT="cc0593aea350de0e31598c31a88d16019f254a0b" # v0.1.7, 2026-04-04
BENCH_VERSION="0.1.7"
SCORE_TO_BEAT=63

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_DIR="${VERDICT_SKILL_DIR:-$ROOT/skills/verdict}"
CACHE_DIR="${BENCH_CACHE_DIR:-$ROOT/bench/.cache}"
RUNS_DIR="${BENCH_RUNS_DIR:-$ROOT/bench/runs}"
BENCH_DIR="$CACHE_DIR/crypto-skill-benchmark"
JUDGE_MODEL="${BENCH_JUDGE_MODEL:-anthropic/claude-haiku-4-5}"
SKILL_MODEL="${BENCH_SKILL_MODEL:-anthropic/claude-sonnet-4-6}"

usage() {
  cat <<'USAGE'
Usage: scripts/bench.sh [--setup-only] [--skip-static] [--help] [evaluate options...]

  --setup-only    static pre-check, then clone and build the benchmark; do not evaluate (no key needed)
  --skip-static   do not run scripts/skill-static-check.mjs first
  evaluate options are passed through: --tier basic|intermediate|adversarial|all, --concurrency N,
  --model <judge id>, --skill-model <skill id>, --compare

Requires: node >= 18, git, npm, network to github.com and openrouter.ai, and OPENROUTER_API_KEY in the
environment (or ~/.crypto-skill-bench/config.json). The key is never printed or stored by this script.
Details, cost and the score to beat: bench/README.md
USAGE
}

SETUP_ONLY=0
SKIP_STATIC=0
PASS=()
for arg in "$@"; do
  case "$arg" in
    --setup-only) SETUP_ONLY=1 ;;
    --skip-static) SKIP_STATIC=1 ;;
    --help | -h) usage; exit 0 ;;
    *) PASS+=("$arg") ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "error: node not found (Node 22 expected, >= 18 required)" >&2; exit 2; }

echo "==> [1/4] Static pre-check ($SKILL_DIR)"
if [[ "$SKIP_STATIC" == 1 ]]; then
  echo "    skipped (--skip-static)"
elif ! node "$ROOT/scripts/skill-static-check.mjs" "$SKILL_DIR"; then
  echo "error: the static pre-check failed. Fix the skill text before spending a benchmark run (see bench/README.md)." >&2
  exit 1
fi

echo "==> [2/4] Requirements"
for tool in git npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found; the benchmark is cloned with git and built with npm" >&2; exit 2; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "error: Node >= 18 required, found $NODE_MAJOR" >&2
  exit 2
fi
echo "    node $NODE_MAJOR, git, npm: ok"
if [[ "$SETUP_ONLY" == 1 ]]; then
  echo "    OpenRouter key: not needed for --setup-only"
elif [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo "    OpenRouter key: present in the environment (not shown)"
elif [[ -f "$HOME/.crypto-skill-bench/config.json" ]]; then
  echo "    OpenRouter key: $HOME/.crypto-skill-bench/config.json exists; the benchmark reads it"
else
  cat >&2 <<MSG
error: no OpenRouter API key, nothing was run.
  The benchmark needs one to drive the skill model and the judge (76 scenarios; cents with the Haiku judge,
  about \$3 with Opus). Get one at https://openrouter.ai/keys and export it in this shell for this run only:

      export OPENROUTER_API_KEY=<key>

  Do not write it into a .env inside the repository, do not pass it as an argument, do not commit it.
  The static pre-check above needs no key: node scripts/skill-static-check.mjs skills/verdict
MSG
  exit 2
fi

echo "==> [3/4] Benchmark v$BENCH_VERSION at $BENCH_DIR (commit ${BENCH_COMMIT:0:7})"
if [[ ! -d "$BENCH_DIR/.git" ]]; then
  mkdir -p "$CACHE_DIR"
  git clone --quiet "$BENCH_REPO" "$BENCH_DIR"
fi
if [[ "$(git -C "$BENCH_DIR" rev-parse HEAD)" != "$BENCH_COMMIT" ]]; then
  git -C "$BENCH_DIR" fetch --quiet origin
  git -C "$BENCH_DIR" checkout --quiet "$BENCH_COMMIT"
  rm -rf "$BENCH_DIR/dist"
fi
if [[ ! -f "$BENCH_DIR/dist/cli.js" || ! -d "$BENCH_DIR/node_modules" ]]; then
  echo "    npm ci and tsc build"
  (cd "$BENCH_DIR" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run build --silent)
fi
[[ -f "$BENCH_DIR/dist/cli.js" ]] || { echo "error: build did not produce $BENCH_DIR/dist/cli.js" >&2; exit 1; }
echo "    ready: $(node "$BENCH_DIR/dist/cli.js" --version 2>/dev/null | head -n 1 || echo "dist/cli.js")"
if [[ "$SETUP_ONLY" == 1 ]]; then
  echo "Setup complete. Run scripts/bench.sh with OPENROUTER_API_KEY exported to evaluate."
  exit 0
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
RUN_DIR="$RUNS_DIR/$STAMP"
mkdir -p "$RUN_DIR"
echo "==> [4/4] Evaluate"
echo "    skill model $SKILL_MODEL, judge $JUDGE_MODEL"
echo "    reports: $RUN_DIR/reports/ (history: ~/.crypto-skill-bench/verdict/history.jsonl)"
set +e
(cd "$RUN_DIR" && node "$BENCH_DIR/dist/cli.js" evaluate "$SKILL_DIR" --model "$JUDGE_MODEL" --skill-model "$SKILL_MODEL" ${PASS[@]+"${PASS[@]}"})
CLI_CODE=$?
set -e
if [[ "$CLI_CODE" != 0 ]]; then
  echo "error: crypto-skill-bench exited $CLI_CODE" >&2
  exit "$CLI_CODE"
fi

# The single-skill CLI always exits 0 (runner.ts sets exitCode = 0 regardless of the gate), so read the result.
REPORT_JSON="$(ls -t "$RUN_DIR"/reports/*.json 2>/dev/null | grep -v -- '-failures.json' | head -n 1 || true)"
if [[ -z "$REPORT_JSON" ]]; then
  echo "error: no report JSON in $RUN_DIR/reports" >&2
  exit 1
fi
REPORT_MD="${REPORT_JSON%.json}.md"
read -r GATE SCORE SAFETY <<<"$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const s = r.dimensions && r.dimensions.safety ? Math.round(r.dimensions.safety.rawAverage * 100) : "n/a";
  console.log(r.safetyGate, r.qualityScore, s);
' "$REPORT_JSON")"
echo
echo "Safety Gate $GATE, score $SCORE/100 (safety $SAFETY/100). Target: PASS and above $SCORE_TO_BEAT."
echo "Report: $REPORT_MD"
echo "Record it: cp \"$REPORT_MD\" \"$ROOT/bench/reports/$(date -u +%Y-%m-%d).md\" and commit that file only."
echo "The .json next to it holds every simulated transcript; review before committing it, if ever."
if [[ "$GATE" == "PASS" && "$SCORE" -gt "$SCORE_TO_BEAT" ]]; then
  exit 0
fi
exit 1
