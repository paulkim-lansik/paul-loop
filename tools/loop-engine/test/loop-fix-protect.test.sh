#!/usr/bin/env bash
# Regression test (issue #34): --protect detects a fixer that tampers with a protected file (this
# part already worked) AND now reverts it before aborting — turning "detect and stop" into "detect
# and undo". Restoration is byte-for-byte from a backup snapshotted at run start, NOT `git
# checkout` (which would be wrong if a protected file already had a legitimate uncommitted edit
# before this loop-fix run even started). Closes the false-SUCCESS bug: rerunning loop-fix.sh
# against the same workspace after an abort used to see the still-sabotaged bytes and report a
# false PASS.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

# A verify that always fails, so the fixer is invoked on iteration 1 every time.
cat > "$WORK/fake-verify-fail.sh" <<'EOF'
#!/bin/sh
echo "FAILED src/example.test.ts > forcing fixer invocation"
exit 1
EOF

# ── case 1: baseline detect (a) + exact byte-restore after a MODIFY (b) ────────────────────────
C="$WORK/c1"; mkdir -p "$C"; cd "$C" || fail "cd c1"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-v1\nline two\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt   # reference copy, outside the --protect glob
cat > fake-fix-modify.sh <<'EOF'
#!/bin/sh
echo "SABOTAGED-BY-FIXER" > guard-file.txt
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-modify.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case1: expected exit 3 (PROTECTED-VIOLATION) on a modified protected file, got $code"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log || fail "case1: expected the PROTECTED FILE MODIFIED marker in history"
grep -q "done: PROTECTED-VIOLATION" .loop/history.log || fail "case1: expected the PROTECTED-VIOLATION done marker"
grep -q "restored 1 protected file(s) to their pre-run state" .loop/history.log \
  || fail "case1: expected a log line confirming the restore (abort must not be silent about recovery)"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case1: protected file bytes were NOT restored to the exact pre-run content"

# ── case 2: fixer DELETES the protected file → detected, recreated with original content (c) ──
C="$WORK/c2"; mkdir -p "$C"; cd "$C" || fail "cd c2"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-v2\nkeepme\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-delete.sh <<'EOF'
#!/bin/sh
rm -f guard-file.txt
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-delete.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case2: expected exit 3 (PROTECTED-VIOLATION) on a deleted protected file, got $code"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log || fail "case2: a vanished protected file must still be treated as changed"
grep -q "restored 1 protected file(s) to their pre-run state" .loop/history.log \
  || fail "case2: expected a log line confirming the restore"
[ -f guard-file.txt ] || fail "case2: deleted protected file was not recreated from backup"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case2: recreated protected file does not match the exact pre-run content"

# ── case 3: rerun after an abort does NOT see the old sabotage (d) — the false-SUCCESS bug ─────
C="$WORK/c3"; mkdir -p "$C"; cd "$C" || fail "cd c3"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-v3\nline two\nline three\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-modify.sh <<'EOF'
#!/bin/sh
echo "SABOTAGED-BY-FIXER-c3" > guard-file.txt
EOF
"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-modify.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case3 setup: expected exit 3 from the first (sabotaging) run, got $code"
cmp -s guard-file.txt original-guard-file.txt || fail "case3 setup: first run must restore the file before the rerun"

# Rerun loop-fix.sh with the SAME --protect argument against the now-restored (still-uncommitted)
# workspace. A spy verify copies whatever loop-fix.sh finds on disk into seen-by-rerun.txt on its
# very first call — before any new fix attempt — so we can assert the rerun's ground truth was
# never the stale sabotage.
cat > fake-verify-spy.sh <<'EOF'
#!/bin/sh
cp guard-file.txt seen-by-rerun.txt 2>/dev/null
echo "FAILED spy verify — always fails so the captured snapshot can be inspected"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify-spy.sh' --fix ':' --protect 'guard-file.txt' --max-iter 1 >/dev/null 2>&1
[ -f seen-by-rerun.txt ] || fail "case3: rerun's verify never ran (spy file missing)"
cmp -s seen-by-rerun.txt original-guard-file.txt \
  || fail "case3: rerun saw stale sabotaged bytes instead of the restored original — issue #34 false-SUCCESS bug is NOT closed"
grep -q "SABOTAGED" seen-by-rerun.txt && fail "case3: rerun's verify saw sabotaged content"

echo "PASS: --protect reverts a tampered/deleted protected file to its exact pre-run bytes before aborting, closing the false-SUCCESS rerun bug"
exit 0
