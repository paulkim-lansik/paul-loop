#!/usr/bin/env bash
# Regression test (issue #9 mark-clean wiring): loop-fix.sh's PASS branch must actually call
# `lessons mark-clean --gate "$VERIFY"` — before BAC-9's fix there was no call site anywhere in the
# codebase, so clean_pass_count could never move off 0. This proves the wiring end-to-end by reading
# the lesson JSON directly:
#   (a) a fail-then-converge run records a verified lesson (count=1, clean_pass_count=0 — new lesson).
#   (b) a later, fully-clean run (no failure at all) bumps that SAME lesson's clean_pass_count 0 -> 1
#       via mark-clean alone (record is never called — no FIRST_VERDICT was captured this run).
#   (c) a THIRD run where the same failure recurs and converges again bumps clean_pass_count to 2 via
#       mark-clean, but record's existing-lesson merge (fail-recurrence reset) then resets it back to
#       0 for the SAME iteration — mark-clean must fire BEFORE record, or the just-recurred lesson
#       would be miscounted as a clean pass.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

# clean_pass_count is only written to the JSON file once something has actually bumped/reset it
# (a brand-new lesson's literal never sets the key at all — it defaults to 0 at READ time via
# lessons.mjs's coerce()). Read it back the same way rather than grepping for a literal key/value,
# so this test doesn't depend on that write-time implementation detail.
read_clean_pass_count() {
  node -e '
    const fs = require("fs")
    const l = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const v = Number.isInteger(l.clean_pass_count) && l.clean_pass_count >= 0 ? l.clean_pass_count : 0
    process.stdout.write(String(v))
  ' "$1"
}

C="$WORK/c1"; mkdir -p "$C"; cd "$C" || fail "cd c1"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
if [ -f converged ]; then
  echo ok
  exit 0
fi
echo "FAILED src/example.test.ts > mark-clean wiring test"
exit 1
EOF

# ── (a) fail then converge: records a NEW verified lesson, count=1, clean_pass_count=0 ─────────
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch converged' --max-iter 3 --stall 5 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "(a): expected PASS on first (fail-then-converge) run, got exit $code"
[ "$(ls lessons/*.json 2>/dev/null | wc -l | tr -d ' ')" -eq 1 ] || fail "(a): expected exactly 1 lesson file"
f="$(ls lessons/*.json)"
grep -q '"count": 1' "$f" || fail "(a): expected count=1 after first convergence"
grep -q '"verified": true' "$f" || fail "(a): expected verified=true after first convergence"
[ "$(read_clean_pass_count "$f")" -eq 0 ] || fail "(a): expected clean_pass_count=0 on a brand-new lesson"

# ── (b) a later fully-clean run (no failure this run) bumps clean_pass_count via mark-clean alone ──
"$LOOPFIX" --verify 'sh fake-verify.sh' --max-iter 1 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "(b): expected PASS on the clean run, got exit $code"
[ "$(ls lessons/*.json 2>/dev/null | wc -l | tr -d ' ')" -eq 1 ] || fail "(b): expected still exactly 1 lesson file (no new lesson created)"
f2="$(ls lessons/*.json)"
[ "$f" = "$f2" ] || fail "(b): expected the same lesson id to be reused"
grep -q '"count": 1' "$f2" || fail "(b): a clean pass must NOT bump count (record is not called)"
[ "$(read_clean_pass_count "$f2")" -eq 1 ] || fail "(b): expected clean_pass_count to bump 0 -> 1 via mark-clean"

# ── (c) the same failure recurs and converges again: clean_pass_count resets to 0 ───────────────
rm -f converged
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch converged' --max-iter 3 --stall 5 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "(c): expected PASS on the recur-then-converge run, got exit $code"
[ "$(ls lessons/*.json 2>/dev/null | wc -l | tr -d ' ')" -eq 1 ] || fail "(c): expected still exactly 1 lesson file"
f3="$(ls lessons/*.json)"
[ "$f" = "$f3" ] || fail "(c): expected the same lesson id to be reused"
grep -q '"count": 2' "$f3" || fail "(c): expected count to increase to 2 after the recurrence"
[ "$(read_clean_pass_count "$f3")" -eq 0 ] || fail "(c): expected clean_pass_count reset to 0 — the recurrence must not be counted clean, even though mark-clean fired first this run"

echo "PASS: mark-clean is wired into loop-fix.sh's PASS branch — clean_pass_count bumps on clean passes and resets on recurrence"
exit 0
