#!/usr/bin/env bash
# Regression test: loop-fix.sh auto-arms the in-session protect-hook sentinel (.loop/looping)
# for the loop's duration and disarms it on exit. Closes maturity gaps:
#   #5  — the reward-hacking guard was hand-armed → in real in-session loops it was silently OFF.
#   #12 — the verifier machine itself had no tests (this is its first).
#
# Why it matters: the PreToolUse hook (.claude/hooks/protect-during-loop.mjs) only blocks edits to
# verifier-defining files WHILE `.loop/looping` exists. If nothing creates it, an in-session loop
# runs with the guard off. loop-fix.sh must arm it (and, by ownership, only disarm what it armed).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

# Emit FAIL: to STDOUT (not just stderr) so verdict-run captures a DISTINCT failure signature per
# assertion — otherwise every bash selftest collapses to the same generic "command exited 1" verdict
# and the lessons store conflates unrelated failures (a false-recurrence bug found by using the loop).
fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || fail "cannot cd into work dir"
mkdir -p .loop

# 1) absent before any loop runs
[ -e .loop/looping ] && fail "sentinel present before run"

# 2) DURING the loop the verifier must SEE the sentinel — proves loop-fix armed it before verifying.
#    verify-only mode: the ground truth is 'is the sentinel there?'; PASS (exit 0) iff armed.
"$LOOPFIX" --verify 'test -f .loop/looping && echo armed' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "verifier did not see .loop/looping during the loop (auto-arm missing); loop-fix exit=$code"

# 3) AFTER the loop the sentinel must be gone — fail-safe-off (trap cleanup on every exit path).
[ -e .loop/looping ] && fail "sentinel not disarmed after run (trap cleanup missing)"

# 4) a PRE-EXISTING sentinel (outer loop / manual arm) must be left intact — disarm only what we armed.
: > .loop/looping
"$LOOPFIX" --verify 'echo ok' --max-iter 1 >/dev/null 2>&1
[ -e .loop/looping ] || fail "loop-fix removed a pre-existing sentinel it did not arm (ownership bug)"
rm -f .loop/looping

echo "PASS: loop-fix auto-arms/disarms .loop/looping and respects a pre-existing sentinel"
exit 0
