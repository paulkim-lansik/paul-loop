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
#
# Round 3 (adversarial review, cases 9-10): closes a CRITICAL, complete, SILENT bypass of the
# entire guard — .loop/protected.sha (the detection ground truth) was a plain file the --fix
# subprocess could write to just like any other file: overwriting it with the hash of its own
# sabotaged content made check_protected() agree with itself ("unchanged"), and simply `rm -f`ing
# it was treated as "nothing to protect" — either way, exit 0, false SUCCESS, in a SINGLE run, with
# NO PROTECTED FILE MODIFIED log line and no restore attempt at all. Root-cause fix: the detection
# hash (and the parallel file-list/mode-list bookkeeping) now lives ONLY in bash variables held in
# loop-fix.sh's own process memory (PROTECT_SNAP_DATA / PROTECT_FILES_DATA / PROTECT_MODES_DATA),
# never written to a file — a --fix child subprocess structurally cannot write into its parent
# shell's variables, so there is nothing left on disk to forge or delete.
#
# Round 4 (independent adversarial review of the round-3 fix, case 11): closes a separate,
# pre-existing, CRITICAL, 100%-reliable bypass that predates round 3 — check_protected() was only
# ever invoked on the FAIL path (right before looping back to the next verify), never on the path
# that declares PASS and exits 0. A fixer could background a detached mutation of a protected file
# timed to land AFTER that FAIL-path check but BEFORE the next verify call: the poisoned bytes are
# what the next verify reads, verify reports PASS, and the loop declared SUCCESS with the protected
# file left cheated — no PROTECTED FILE MODIFIED line, no restore, no compromise marker. Fixed by
# also calling check_protected() on the PASS path, immediately before declaring success.
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
LOOP_PROTECT_GRACE_SEC=0.2 "$LOOPFIX" --verify 'sh fake-verify-spy.sh' --fix ':' --protect 'guard-file.txt' --max-iter 1 >/dev/null 2>&1
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

LOOP_PROTECT_GRACE_SEC=0.2 "$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix ':' --protect '**/*.test.sh' --max-iter 2 >/dev/null 2>&1
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

# ── case 9: fixer sabotages the live file AND FORGES .loop/protected.sha to match (round-3) ────
# Before the fix, the sha256 ground truth lived in a plain file (.loop/protected.sha) the fixer
# subprocess had the same filesystem write access to as loop-fix.sh itself. Overwriting it with the
# hash of the fixer's OWN sabotaged content made check_protected()'s diff agree with itself — no
# violation ever detected, no restore, no compromise marker, loop just continues to MAX-ITER/STALL
# (or PASS, if the sabotaged content happened to satisfy verify) having never noticed. After the
# round-3 fix, the ground truth lives only in an in-process bash variable the fixer cannot reach, so
# forging the on-disk file (if the fixer even still bothers to write one) has zero effect — the next
# check_protected() recomputes the hash fresh and compares in memory.
C="$WORK/c9"; mkdir -p "$C"; cd "$C" || fail "cd c9"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-c9\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-forge-sha.sh <<'EOF'
#!/bin/sh
echo "CHEAT-FORGE-SHA-c9" > guard-file.txt
shasum -a 256 guard-file.txt > .loop/protected.sha 2>/dev/null \
  || sha256sum guard-file.txt > .loop/protected.sha 2>/dev/null
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-forge-sha.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case9: expected exit 3 (PROTECTED-VIOLATION) even though the fixer forged a matching .loop/protected.sha, got $code — the on-disk hash file must have zero effect on detection (round-3 bypass NOT closed)"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  || fail "case9: expected the PROTECTED FILE MODIFIED marker — forging the (now-vestigial) hash file must not suppress detection"
grep -q "restored 1 protected file(s) to their pre-run state" .loop/history.log \
  || fail "case9: expected a log line confirming the restore"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case9: protected file bytes were NOT restored to the exact pre-run content"

# ── case 10: fixer just `rm -f`s .loop/protected.sha instead of forging it (round-3) ───────────
# Before the fix, check_protected() started with `[ -s "$PROTECT_SNAP" ] || return 0` — a
# missing/empty on-disk snapshot was silently treated as "nothing to protect", an even simpler
# bypass than case 9 (no need to compute a matching hash at all). After the round-3 fix there is no
# on-disk snapshot file to delete in the first place — the equivalent fixer action is inert.
C="$WORK/c10"; mkdir -p "$C"; cd "$C" || fail "cd c10"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-c10\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-rm-sha.sh <<'EOF'
#!/bin/sh
echo "CHEAT-RM-SHA-c10" > guard-file.txt
rm -f .loop/protected.sha 2>/dev/null
EOF

"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-rm-sha.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case10: expected exit 3 (PROTECTED-VIOLATION) even though the fixer deleted .loop/protected.sha, got $code — a missing on-disk hash file must not be read as 'nothing to protect' (round-3 bypass NOT closed)"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  || fail "case10: expected the PROTECTED FILE MODIFIED marker — deleting the (now-vestigial) hash file must not suppress detection"
grep -q "restored 1 protected file(s) to their pre-run state" .loop/history.log \
  || fail "case10: expected a log line confirming the restore"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case10: protected file bytes were NOT restored to the exact pre-run content"

# ── case 11: fixer backgrounds a delayed mutation timed to land AFTER the FAIL-path check but ──
# BEFORE the next verify reads the file (round-4 adversarial finding) ───────────────────────────
# check_protected() used to run ONLY on the FAIL path (right before looping back to the next
# verify) — never on the PASS path. A fixer that returns immediately without touching the protected
# file synchronously (so the FAIL-path check right after it sees no violation), but backgrounds a
# detached job that mutates the file a little later, gets the poisoned bytes in place by the time
# the NEXT verify call reads them. If that verify does not care about the file's content (as here —
# it just reports PASS on its second invocation), the loop used to declare SUCCESS with the
# protected file left corrupted, no PROTECTED FILE MODIFIED line, no restore, no compromise marker.
# The synthetic verify sleeps briefly on its PASS call to give the backgrounded mutation (a much
# shorter delay) reliable margin to land before the new PASS-path check_protected() call runs —
# widening the window on the test side rather than relying on a hair-trigger race, so this assertion
# is not flaky. (Round-5 note: with the grace-period recheck now on the FAIL path too, this scenario
# is typically caught right there on iteration 1 rather than needing to reach the PASS path at all —
# still a valid regression check either way, since the assertions below only require SOME
# PROTECTED-VIOLATION catch, not which path caught it. A small grace override keeps this fast while
# staying comfortably above the fixer's 0.05s mutation delay.)
C="$WORK/c11"; mkdir -p "$C"; cd "$C" || fail "cd c11"
printf 'ORIGINAL-CONTENT-c11\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-verify-race.sh <<'EOF'
#!/bin/sh
if [ -f .verify-called-once ]; then
  # Second+ call: sleep briefly so the fixer's backgrounded mutation (a much shorter delay) has
  # landed well before this verify — and therefore the loop's PASS-path check — completes.
  sleep 0.2
  echo "PASS on iteration >=2 (delayed on purpose, see case11 comment)"
  exit 0
else
  touch .verify-called-once
  echo "FAILED forcing fixer invocation"
  exit 1
fi
EOF
cat > fake-fix-race.sh <<'EOF'
#!/bin/sh
( sleep 0.05; printf 'CHEAT-STRING-c11\n' >> guard-file.txt ) &
true
EOF

LOOP_PROTECT_GRACE_SEC=0.2 "$LOOPFIX" --verify 'sh fake-verify-race.sh' --fix 'sh fake-fix-race.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case11: expected exit 3 (PROTECTED-VIOLATION) for a mutation backgrounded to land after the FAIL-path check but before the next verify, got $code — round-4 PASS-path gap is NOT closed"
grep -q "done: SUCCESS" .loop/history.log \
  && fail "case11: must NOT report false SUCCESS — the protected file was left corrupted by a timed background mutation"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  || fail "case11: expected the PROTECTED FILE MODIFIED marker (FAIL-path or PASS-path, either is a valid catch)"
grep -q "done: PROTECTED-VIOLATION" .loop/history.log || fail "case11: expected the PROTECTED-VIOLATION done marker"
grep -q "restored 1 protected file(s) to their pre-run state" .loop/history.log \
  || fail "case11: expected a log line confirming the restore"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case11: protected file bytes were NOT restored to the exact pre-run content"

# ── Round 5 (independent adversarial review of the round-4 fix): the PASS-path check_protected()
# call round 4 added is still a SINGLE, IMMEDIATE check — it only proves "clean at the instant it
# ran". A fixer invoked via `sh -c "$FIX"` can return immediately while a `(sleep D; corrupt) &`
# subshell it backgrounded is NOT waited on by that `sh -c` wrapper: any D longer than roughly
# "however long loop-fix.sh takes to run its own check and exit" lands the corruption strictly AFTER
# every check_protected() call in the run has already completed. Root cause: no single check, placed
# ANYWHERE, can see a mutation that has not happened yet — this is a structural property of a
# short-lived supervisor process, not a fixable logic bug. The round-5 fix does not claim to close
# this (nothing can); it raises the bar with a bounded grace-period recheck (Part 1) and closes a
# separate, secondary hygiene gap on non-protect abort paths (Part 2).

# ── case 12: Part 1 — the grace-period recheck catches a short delay an immediate-only check ───
# (round-4's bare check_protected(), reproduced here via LOOP_PROTECT_GRACE_SEC=0, which collapses
# check_protected_with_grace() to two back-to-back instant checks — functionally the same "clean at
# the instant it ran" guarantee the old bare call had) would miss. Same fixer/verify shape, same
# mutation delay D, run twice with only the grace period differing — isolating the recheck itself as
# the variable under test rather than relying on incidental timing of an unrelated verify call.
#
# case 12a: grace=0 (old-code-equivalent) — a D=0.4s backgrounded mutation is NOT caught; the run
# reaches MAX-ITER (exit 1) with no PROTECTED FILE MODIFIED line, because the FAIL-path check runs
# and completes in low milliseconds, long before D elapses.
C="$WORK/c12a"; mkdir -p "$C"; cd "$C" || fail "cd c12a"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-c12\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-short-delay.sh <<'EOF'
#!/bin/sh
( sleep 0.4; printf 'CHEAT-STRING-c12\n' >> guard-file.txt ) &
true
EOF

LOOP_PROTECT_GRACE_SEC=0 "$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-short-delay.sh' --protect 'guard-file.txt' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case12a: expected exit 1 (MAX-ITER, no violation caught) with grace=0 simulating an immediate-only check, got $code"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  && fail "case12a: an immediate-only check (grace=0) should NOT have caught a mutation still 0.4s away — if it did, this test's premise about the old code's blind spot is wrong"
grep -q "done: MAX-ITER" .loop/history.log || fail "case12a: expected a normal MAX-ITER finish"

# case 12b: same shape, grace=0.5s (> D=0.15s this time) — the recheck DOES catch it. Uses a smaller
# D than 12a purely so this case finishes quickly; the two cases are independent, not a before/after
# pair on the same D.
C="$WORK/c12b"; mkdir -p "$C"; cd "$C" || fail "cd c12b"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'ORIGINAL-CONTENT-c12b\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-fix-short-delay.sh <<'EOF'
#!/bin/sh
( sleep 0.15; printf 'CHEAT-STRING-c12b\n' >> guard-file.txt ) &
true
EOF

LOOP_PROTECT_GRACE_SEC=0.5 "$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-short-delay.sh' --protect 'guard-file.txt' --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case12b: expected exit 3 (PROTECTED-VIOLATION) — the grace-period recheck must catch a 0.15s delay under a 0.5s grace period, got $code"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log || fail "case12b: expected the PROTECTED FILE MODIFIED marker from the grace-period recheck"
grep -q "done: PROTECTED-VIOLATION" .loop/history.log || fail "case12b: expected the PROTECTED-VIOLATION done marker"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case12b: protected file bytes were NOT restored to the exact pre-run content"

# ── case 13: Part 1 boundary, honestly disclosed — a delay LONGER than the grace period is NOT a ──
# false positive, it is the documented, expected limit (see the round-5 Guard-scope comment in
# loop-fix.sh). A clean run whose fixer backgrounds a mutation past the grace window must still
# report ordinary SUCCESS — the grace-period recheck must never cry wolf on a mutation it structurally
# cannot see yet.
C="$WORK/c13"; mkdir -p "$C"; cd "$C" || fail "cd c13"
printf 'ORIGINAL-CONTENT-c13\n' > guard-file.txt
cat > fake-verify-pass-once.sh <<'EOF'
#!/bin/sh
echo "PASS immediately"
exit 0
EOF
cat > fake-fix-long-delay.sh <<'EOF'
#!/bin/sh
( sleep 2; printf 'CHEAT-STRING-c13-TOO-LATE\n' >> guard-file.txt ) &
true
EOF
# Fixer is never actually invoked here (verify PASSes on iteration 1), so this exercises the
# PASS-path grace recheck directly against a clean, untouched file — confirming the recheck itself
# adds no false positives on an ordinary clean run.
LOOP_PROTECT_GRACE_SEC=0.3 "$LOOPFIX" --verify 'sh fake-verify-pass-once.sh' --fix 'sh fake-fix-long-delay.sh' --protect 'guard-file.txt' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "case13: expected exit 0 (ordinary SUCCESS, no fixer even invoked) got $code"
grep -q "done: SUCCESS" .loop/history.log || fail "case13: expected a normal SUCCESS finish"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  && fail "case13: grace-period recheck must not false-positive on a clean run"

# ── case 14: Part 2 — an EARLIER iteration's still-pending delayed background job must still be ──
# caught (restored + warned about) by a LATER abort path that isn't itself a protect check — here,
# STALLED — without changing that path's own exit code (round-5 secondary finding). Timeline:
# iteration 1's fixer backgrounds a D=1.5s mutation and returns instantly; iteration 1's own FAIL-path
# grace recheck (grace=1s) still sees it clean (D > grace) and lets the run continue; iteration 2
# repeats the IDENTICAL failure fingerprint, tripping --stall 2 BEFORE iteration 2's own fixer would
# ever run. By the time check_protected_on_abort() runs for that STALL abort (after ~2x the grace
# period has elapsed since the mutation was scheduled), D has elapsed and the mutation is now visible
# — proving the fix without needing to touch the STALL-detection code path itself.
C="$WORK/c14"; mkdir -p "$C"; cd "$C" || fail "cd c14"
printf 'ORIGINAL-CONTENT-c14\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-verify-stall.sh <<'EOF'
#!/bin/sh
echo "FAILED src/example.test.ts > case14 stall fingerprint (always identical)"
exit 1
EOF
cat > fake-fix-stall-delay.sh <<'EOF'
#!/bin/sh
if [ ! -f .fixer-ran-once ]; then
  touch .fixer-ran-once
  ( sleep 1.5; printf 'CHEAT-STRING-c14\n' >> guard-file.txt ) &
fi
true
EOF

LOOP_PROTECT_GRACE_SEC=1 "$LOOPFIX" --verify 'sh fake-verify-stall.sh' --fix 'sh fake-fix-stall-delay.sh' --protect 'guard-file.txt' --stall 2 --max-iter 10 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case14: expected exit 1 (STALLED's own code, NOT 0 and NOT 3) got $code"
grep -q "done: STALLED" .loop/history.log || fail "case14: expected the run to still report its own STALLED reason, unchanged by the protect hygiene check"
grep -q "done: PROTECTED-VIOLATION" .loop/history.log \
  && fail "case14: must NOT reclassify the exit reason to PROTECTED-VIOLATION — STALLED stays STALLED (workspace hygiene, not re-diagnosis)"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  || fail "case14: expected a protect-violation warning logged even though STALLED (not a protect check) is what actually aborted the run"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case14: protected file bytes from an earlier iteration's pending background job were NOT restored on a STALLED abort"

# ── case 15: round-6 — VERDICT-RUN-ERROR (exit 2) is a seventh abort point that used to skip ────
# check_protected_on_abort() entirely (adversarial review found six call sites had it, this one
# didn't). Fixer synchronously destroys the git worktree in the SAME iteration it backgrounds a
# protected-file mutation waiting for the next guard rejection; --guard-mutation hits verdict-run's own
# fail-closed rejection ("needs a git worktree") before the mutation would otherwise be noticed by
# anything else. Must still restore + warn, while VERDICT-RUN-ERROR (2) stays 2, not 0 or 3.
C="$WORK/c15"; mkdir -p "$C"; cd "$C" || fail "cd c15"
git init -q . || fail "case15: git init failed"
git config user.email t@t; git config user.name t
printf 'ORIGINAL-CONTENT-c15\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
git add guard-file.txt && git commit -q -m init
cat > fake-verify-fail.sh <<'EOF'
#!/bin/sh
echo "FAILED forcing fixer"
exit 1
EOF
cat > fake-fix-delay-and-break-git.sh <<'EOF'
#!/bin/sh
if [ ! -f armed.marker ]; then
  touch armed.marker
  (
    # Order against the actual rejection, not process-startup latency: durable checkpoints and
    # the runner's loader can legitimately make a fixed sleep fire at the earlier fixer check.
    # The stderr observation appears before check_protected_on_abort's grace-period recheck.
    tries=0
    until grep -q 'needs a git worktree' .loop/verdict-run.err 2>/dev/null; do
      tries=$((tries + 1)); [ "$tries" -lt 1000 ] || exit 1
      sleep 0.01
    done
    printf 'CHEAT-STRING-c15\n' > guard-file.txt
    touch mutation-observed.marker
  ) &
  rm -rf .git
fi
EOF

LOOP_PROTECT_GRACE_SEC=0.2 "$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-delay-and-break-git.sh' --protect 'guard-file.txt' --guard-mutation --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 2 ] || fail "case15: expected exit 2 (VERDICT-RUN-ERROR, its own reason — the missing git worktree) got $code"
[ -f mutation-observed.marker ] || fail "case15: protected mutation did not occur after the observed guard rejection"
grep -q "done: VERDICT-RUN-ERROR" .loop/history.log || fail "case15: expected the run to still report VERDICT-RUN-ERROR, unchanged by the protect hygiene check"
grep -q "done: PROTECTED-VIOLATION" .loop/history.log \
  && fail "case15: must NOT reclassify the exit reason — VERDICT-RUN-ERROR stays VERDICT-RUN-ERROR"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log \
  || fail "case15: expected a protect-violation warning logged even though VERDICT-RUN-ERROR (not a protect check) is what actually aborted the run"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case15: protected file bytes were NOT restored on a VERDICT-RUN-ERROR abort"

# ── case 16: round-6 — the watchdog's descendant-killer must not defeat the grace-period recheck ──
# start_watchdog() sends SIGTERM/SIGKILL to every child process of loop-fix.sh when idle/progress
# times out — including the grace sleep itself if the configured watchdog timeout is shorter than
# PROTECT_GRACE_SEC (a real, demonstrated interaction, not hypothetical). Fixer backgrounds a single
# delayed mutation; a 1s idle-timeout fires the watchdog mid-run. check_protected_with_grace() must
# survive its sleep being killed and still complete the recheck (via the signal-exit-code retry),
# not silently truncate the grace period and let the mutation slip through.
C="$WORK/c16"; mkdir -p "$C"; cd "$C" || fail "cd c16"
printf 'ORIGINAL-CONTENT-c16\n' > guard-file.txt
cp guard-file.txt original-guard-file.txt
cat > fake-verify-fail.sh <<'EOF'
#!/bin/sh
echo "FAILED forcing fixer"
exit 1
EOF
cat > fake-fix-delay.sh <<'EOF'
#!/bin/sh
if [ ! -f armed.marker ]; then
  touch armed.marker
  ( sleep 2; printf 'CHEAT-STRING-c16\n' > guard-file.txt ) &
fi
EOF

# LOOP_PROTECT_GRACE_SEC is pinned here rather than left at its 1.5s default (issue #71). The
# behaviour under test is the ORDERING — watchdog timeout (1s) shorter than the grace period, and a
# mutation delayed (2s) past the watchdog — not the specific numbers. At the default the recheck
# window closed ~0.5s after the mutation was due to land, so on a loaded machine the case flipped
# red for reasons unrelated to the guard. That misattribution already happened once (PR #70 blamed
# an unrelated new test), and the pressure it creates points at weakening this case — which is the
# exact behaviour this file exists to prevent. Pinning grace to 5s keeps every ordering the case
# proves (1 < 2 < 1+5) and buys ~5s of margin instead of ~0.5s.
LOOP_PROTECT_GRACE_SEC=5 "$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-delay.sh' --protect 'guard-file.txt' --idle-timeout-sec 1 --max-iter 5 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case16: expected exit 3 (PROTECTED-VIOLATION) — a watchdog timeout shorter than the grace period must not let the mutation escape detection, got $code"
grep -q "PROTECTED FILE MODIFIED" .loop/history.log || fail "case16: expected the PROTECTED FILE MODIFIED marker"
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case16: protected file bytes were NOT restored — the watchdog killing the grace-period sleep defeated the recheck"
# Settle past the corruption's original 2s delay and confirm restore held — proves this isn't a
# timing accident where the corruption just hadn't landed yet when we happened to check.
sleep 2
cmp -s guard-file.txt original-guard-file.txt \
  || fail "case16: file drifted from the restored content after settling — a residual write landed post-restore"

# ── case 17: a directory-scoped '**' glob must not protect — or DELETE — files outside it ──────────
# protect_files() reduced a '**' pattern to its basename and ran `find . -name <basename>`, throwing
# the directory part away: `sub/**/*.test.ts` protected EVERY *.test.ts in the tree. That is not a
# harmless over-approximation, because cleanup_rogue_protected() `rm -f`s any protect-matching file
# that was absent at run start — so an unrelated test file created anywhere during a run was deleted.
#
# One case, both directions:
#   (a) `other/b.test.ts` is created by the fixer and is OUTSIDE the glob -> must survive.
#   (b) `sub/c.test.ts` sits directly under `sub/` and IS inside it (`/**/` matches zero directories)
#       -> must still be detected and byte-restored. Without (b) the fix could "pass" by narrowing
#       the glob to require at least one intermediate directory, which would silently unprotect files.
C="$WORK/c17"; mkdir -p "$C/sub/nested" "$C/other"; cd "$C" || fail "cd c17"
cp "$WORK/fake-verify-fail.sh" fake-verify-fail.sh
printf 'PROTECTED-ZERO-DIR\n' > sub/c.test.ts
printf 'PROTECTED-NESTED\n'   > sub/nested/a.test.ts
cp sub/c.test.ts original-c.test.ts   # reference copy, outside the glob
cat > fake-fix-c17.sh <<'EOF'
#!/bin/sh
printf 'SABOTAGED\n' > sub/c.test.ts
printf 'a brand new, unrelated test file\n' > other/b.test.ts
EOF
"$LOOPFIX" --verify 'sh fake-verify-fail.sh' --fix 'sh fake-fix-c17.sh' --protect 'sub/**/*.test.ts' --max-iter 2 >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case17: expected exit 3 — 'sub/**/*.test.ts' must still cover sub/c.test.ts (zero intermediate directories), got $code"
cmp -s sub/c.test.ts original-c.test.ts \
  || fail "case17(b): sub/c.test.ts was not restored — '/**/' stopped matching zero directories, silently unprotecting files directly under the glob's root"
[ -f other/b.test.ts ] \
  || fail "case17(a): other/b.test.ts was DELETED — a glob scoped to sub/ reached outside it, and the rogue-file cleanup turned that over-match into data loss"
echo "  case17 ok: directory-scoped '**' protects inside (incl. zero-dir) and does not delete outside"

echo "PASS: --protect reverts a tampered/deleted protected file to its exact pre-run bytes, excludes its own backup dir from '**' scans, detects+refuses on backup poisoning OR backup deletion/unreadability via a fail-closed marker, deletes rogue new protect-glob-matching files before aborting, cannot be defeated by forging or deleting the on-disk hash bookkeeping (round-3: ground truth now lives in-process, not on disk), catches a mutation backgrounded to land after the FAIL-path check but before the next verify (round-4: check_protected() runs on the PASS path too), raises the bar with a bounded grace-period recheck on both paths while honestly not claiming to catch delays past that window (round-5), and now (round-6) also covers the VERDICT-RUN-ERROR abort point and survives the watchdog's own descendant-killer trying to defeat the grace-period sleep, plus restores/warns-but-preserves-exit-code on STALLED/BUDGET/watchdog/INFRA/VERDICT-RUN-ERROR aborts that used to leave an earlier iteration's pending corruption unflagged"
exit 0
