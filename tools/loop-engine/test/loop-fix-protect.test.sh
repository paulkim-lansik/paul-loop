#!/usr/bin/env bash
# Regression test (issue #34): --protect detects a fixer that tampers with a protected file (this
# part already worked) AND now reverts it before aborting — turning "detect and stop" into "detect
# and undo". Restoration is byte-for-byte from a backup snapshotted at run start, NOT `git
# checkout` (which would be wrong if a protected file already had a legitimate uncommitted edit
# before this loop-fix run even started). Closes the false-SUCCESS bug: rerunning loop-fix.sh
# against the same workspace after an abort used to see the still-sabotaged bytes and report a
# false PASS.
#
# Round 2 (adversarial review of the round-1 fix above, cases 4-6): closes two CRITICAL bypasses
# and one IMPORTANT gap the round-1 fix left open — a '**' glob false-positiving on the guard's own
# backup dir (case 4), a fixer poisoning the backup copy itself to defeat restore_protected()
# entirely while the log still claims success (case 5, the exact false-SUCCESS bug reopened via the
# guard's own restore path — closed by a post-restore integrity hash check + a fail-closed
# compromise marker that makes a subsequent run refuse to proceed), and a rogue new file matching
# the protect glob that restore_protected() alone never cleans up (case 6).
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

# ── case 4: '**' glob + an INERT fixer must NOT false-positive (round-2 adversarial finding 2) ──
# snapshot_protected() writes byte-backups under .loop/protected-backup/<path>, which itself
# matches a broad glob like '**/*.test.sh' unless excluded. Before the fix, check_protected()'s
# rescan picked up the backup as an extra unmatched entry and false-positived a violation on
# iteration 1 even though the fixer ':' never touches anything — exactly the --protect
# "**/*.test.*" pattern used in this repo's own docs (lessons.md / retrospect SKILL.md).
C="$WORK/c4"; mkdir -p "$C/src"; cd "$C" || fail "cd c4"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'a real pre-existing test\n' > src/real.test.sh

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix ':' --protect '**/*.test.sh' --max-iter 2 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case4: expected exit 1 (MAX-ITER, no violation) with an inert fixer under a '**' glob, got $code"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  && fail "case4: false PROTECTED-VIOLATION — the guard's own backup dir was not excluded from the '**' glob scan (finding 2 regression)"
grep -q "done: MAX-ITER" .loop/history.log || fail "case4: expected a normal MAX-ITER finish, not an aborted run"

# ── case 5: fixer poisons BOTH the live file AND its own backup copy (round-2 finding 1) ───────
# A sufficiently motivated fixer has the same filesystem access loop-fix.sh does, so it chmods the
# backup back to writable (defeating the best-effort step-5 friction) before overwriting it with
# the identical cheat value it wrote to the live file. restore_protected() must detect this via the
# post-restore integrity hash check (NOT just trust a successful `cp`), refuse to claim success,
# write the compromise marker, and still exit 3. A SUBSEQUENT invocation must then refuse to run at
# all (exit 4) rather than silently reporting false SUCCESS against the still-cheated file — this
# is the exact bug issue #34 was filed to close, reproduced through the guard's own restore path.
C="$WORK/c5"; mkdir -p "$C"; cd "$C" || fail "cd c5"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-c5\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-double-poison.sh <<'EOF'
#!/bin/sh
echo "CHEAT-VALUE" > guard-file.txt
chmod +w .loop/protected-backup/guard-file.txt 2>/dev/null
echo "CHEAT-VALUE" > .loop/protected-backup/guard-file.txt
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-double-poison.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case5 run1: expected exit 3 (PROTECTED-VIOLATION) even though the backup was also poisoned, got $code"
grep -q "INTEGRITY CHECK FAILED" .loop/history.log \
  || fail "case5 run1: expected a loud integrity-check-failed line — poisoned backup must not be trusted just because cp succeeded"
grep -q "restored 1 protected file(s) to their pre-run state" .loop/history.log \
  && fail "case5 run1: must NOT log the normal success wording when the backup itself was tampered with"
[ -f .loop/protect-compromised ] || fail "case5 run1: expected a compromise marker file to be written"
grep -q "guard-file.txt" .loop/protect-compromised || fail "case5 run1: compromise marker must name the affected file"

_hist_lines_before_rerun="$(wc -l < .loop/history.log | tr -d ' ')"
"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix ':' --protect 'guard-file.txt' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 4 ] || fail "case5 run2 (rerun): expected exit 4 (refuse to start on a prior compromise marker), got $code — false SUCCESS would mean issue #34's round-2 bug is NOT closed"
_hist_lines_after_rerun="$(wc -l < .loop/history.log | tr -d ' ')"
[ "$_hist_lines_before_rerun" = "$_hist_lines_after_rerun" ] \
  || fail "case5 run2: history.log grew during a refused run — it must exit before any real work/logging starts, not just before claiming success"

# ── case 6: fixer creates a ROGUE new file matching the --protect glob (round-2 finding 3) ─────
# check_protected() correctly flags the violation (the new file is an extra unmatched entry), but
# restore_protected() alone only walks the snapshot-time file list and never deletes a brand-new
# file. cleanup_rogue_protected() must remove it, and must NOT touch the real protected file's
# restore.
C="$WORK/c6"; mkdir -p "$C/src"; cd "$C" || fail "cd c6"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'a real pre-existing test\n' > src/real.test.sh
cp src/real.test.sh src/original-real.test.sh
cat > fake-fix-rogue.sh <<'EOF'
#!/bin/sh
echo "SABOTAGED-c6" > src/real.test.sh
echo "rogue trivially-passing test" > src/rogue-new.test.sh
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-rogue.sh' --protect '**/*.test.sh' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case6: expected exit 3 (PROTECTED-VIOLATION), got $code"
cmp -s src/real.test.sh src/original-real.test.sh \
  || fail "case6: the real pre-existing protected file was not restored to its exact pre-run content"
[ -f src/rogue-new.test.sh ] && fail "case6: the fixer's rogue new protect-glob-matching file was NOT deleted — finding 3 is not closed"
grep -q "removed rogue new file matching --protect" .loop/history.log \
  || fail "case6: expected a log line naming the rogue file that was removed"

# ── case 7: fixer DELETES its own backup copy instead of poisoning it (round-3 adversarial re-check) ──
# round-2's integrity-hash check only ran in the "cp succeeded" branch of restore_protected() — the
# pre-existing "no backup copy" branch set _restore_failed but never wrote the compromise marker.
# Deleting the backup is strictly easier for a fixer than overwriting it with matching content (no
# need to even defeat the step-5 chmod-0444 friction — `rm` only needs directory write access), and
# it used to leave a rerun completely unblocked, silently taking the cheated content as a fresh
# trusted baseline. Any restore failure — missing backup OR hash mismatch — must be equally
# fail-closed.
C="$WORK/c7"; mkdir -p "$C"; cd "$C" || fail "cd c7"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-c7\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-delete-backup.sh <<'EOF'
#!/bin/sh
echo "CHEAT-DELBACKUP" > guard-file.txt
rm -f .loop/protected-backup/guard-file.txt
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-delete-backup.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case7 run1: expected exit 3 (PROTECTED-VIOLATION), got $code"
grep -q "no backup copy" .loop/history.log || fail "case7 run1: expected a 'no backup copy' RESTORE FAILED line"
[ -f .loop/protect-compromised ] \
  || fail "case7 run1: expected a compromise marker even though the failure was a missing backup (not a hash mismatch) — deleting the backup must be just as fail-closed as poisoning it"
grep -q "guard-file.txt" .loop/protect-compromised || fail "case7 run1: compromise marker must name the affected file"

_hist_before_c7="$(wc -l < .loop/history.log | tr -d ' ')"
"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix ':' --protect 'guard-file.txt' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 4 ] || fail "case7 run2 (rerun): expected exit 4 (refuse to start on a prior compromise marker), got $code — deleting the backup instead of overwriting it must not bypass the fail-closed rerun block"
_hist_after_c7="$(wc -l < .loop/history.log | tr -d ' ')"
[ "$_hist_before_c7" = "$_hist_after_c7" ] \
  || fail "case7 run2: history.log grew during a refused run"

# ── case 8: `cp` from backup itself fails (e.g. backup unreadable) — same fail-closed requirement ──
# Skipped under root: chmod-based unreadability is meaningless to a root process (permission checks
# are bypassed), which would make this assertion flaky rather than meaningful in that environment.
if [ "$(id -u)" != "0" ]; then
  C="$WORK/c8"; mkdir -p "$C"; cd "$C" || fail "cd c8"
  cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
  printf 'ORIGINAL-CONTENT-c8\n' > guard-file.txt
  cp guard-file.txt original-guard-file.txt
  cat > fake-fix-break-backup.sh <<'EOF'
#!/bin/sh
echo "CHEAT-BREAKBACKUP" > guard-file.txt
chmod 000 .loop/protected-backup/guard-file.txt 2>/dev/null
EOF

  "$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-break-backup.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
  code=$?
  [ "$code" -eq 3 ] || fail "case8 run1: expected exit 3 (PROTECTED-VIOLATION), got $code"
  grep -q "cp from backup did not succeed" .loop/history.log \
    || fail "case8 run1: expected a 'cp from backup did not succeed' RESTORE FAILED line"
  [ -f .loop/protect-compromised ] \
    || fail "case8 run1: expected a compromise marker even though the failure was an unreadable backup (not a hash mismatch)"
  chmod 644 .loop/protected-backup/guard-file.txt 2>/dev/null   # let the trap's rm -rf clean up
fi

echo "PASS: --protect reverts a tampered/deleted protected file to its exact pre-run bytes, excludes its own backup dir from '**' scans, detects+refuses on backup poisoning OR backup deletion/unreadability via a fail-closed marker, and deletes rogue new protect-glob-matching files before aborting"
exit 0
