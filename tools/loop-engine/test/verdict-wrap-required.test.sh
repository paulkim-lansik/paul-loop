#!/usr/bin/env bash
# BAC-745: ship-flow's ship-feature/hotfix must never instruct running a consuming repo's raw
# verifyCommand directly — that skips loop-engine's verdict contract (=== VERDICT === block,
# .loop/verdict-state.json, the verdict.passed/failed ledger event) entirely, which is exactly what
# left 92 real runs (glucofit-partners, 2026-08-20) at with-verdict=0. Both skills must wrap the
# verify step through this plugin's own verdict-run.sh instead. This is a text-level regression
# guard on the skill prose, not a runtime check — it can't prove an agent actually follows the
# instruction, only that the instruction itself hasn't quietly reverted to raw execution.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."

fail() { echo "FAIL: $1"; exit 1; }

REQUIRED_FILES=(
  "tools/ship-flow/skills/ship-feature/SKILL.md"
  "tools/ship-flow/skills/hotfix/SKILL.md"
)

for rel in "${REQUIRED_FILES[@]}"; do
  f="$ROOT/$rel"
  [ -f "$f" ] || fail "$rel not found"
  grep -q "verdict-run\.sh -- <verifyCommand>" "$f" \
    || fail "$rel does not wrap verifyCommand through verdict-run.sh — a raw verify-command instruction would skip the verdict contract (block/state-file/ledger event) entirely"
  grep -q "VERDICT:.*EXIT:" "$f" \
    || fail "$rel does not instruct reading the gate off VERDICT:/EXIT: — a bare shell exit code check would skip the verdict contract just as much as running verifyCommand raw"
done

# setup's interview must not point verifyCommand itself AT verdict-run.sh (that would double-wrap
# and also break the field's contract as "the raw command", which ship-feature/hotfix already wrap).
SETUP="$ROOT/tools/ship-flow/skills/setup/SKILL.md"
[ -f "$SETUP" ] || fail "tools/ship-flow/skills/setup/SKILL.md not found"
grep -q "Record the \*\*raw\*\*" "$SETUP" && grep -q "Don't write \`verdict-run.sh\`" "$SETUP" \
  || fail "setup/SKILL.md's verify-command interview step no longer documents the raw-command convention (BAC-745)"

echo "PASS: ship-feature/hotfix wrap verifyCommand via verdict-run.sh; setup keeps the field raw"
