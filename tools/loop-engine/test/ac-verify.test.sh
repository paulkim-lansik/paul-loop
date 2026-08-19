#!/usr/bin/env bash
# Regression tests for ac-verify.sh (issue #23, ADR-0104) — the AC-level success contract gate.
# Covers: zero-AC/zero-contract fail-closed (require-tests.sh precedent), independent
# verify:/artifacts:/expect: checks, mixed contracted+uncontracted aggregation, mixed pass+fail
# aggregation, and the emitted block's Verdict Contract shape.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AC_VERIFY="$HERE/../bin/ac-verify.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$AC_VERIFY" ] || fail "ac-verify.sh not found/executable at $AC_VERIFY"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
ORIG_PWD="$(pwd)"

run_ac_verify() { "$AC_VERIFY" "$1" --log-dir "$2"; }   # $1 = plan file (cwd-relative)  $2 = log-dir name

# ==== (a) zero AC lines at all -> FAIL, contracted count 0 ====
SUB="$DIR/a"; mkdir -p "$SUB"; cd "$SUB" || fail "cd a"
printf '# plan\nno AC lines here at all\n' > plan.md
OUT_A="$(run_ac_verify plan.md .loop 2>&1)"; CODE_A=$?
[ "$CODE_A" -eq 1 ] || fail "(a): expected exit 1, got $CODE_A: $OUT_A"
printf '%s' "$OUT_A" | grep -q '^VERDICT: FAIL$' || fail "(a): expected VERDICT: FAIL: $OUT_A"
printf '%s' "$OUT_A" | grep -qE '^SUMMARY: passed=0 failed=0 skipped=0 ' || fail "(a): expected an all-zero summary: $OUT_A"
printf '%s' "$OUT_A" | grep -q '^FAIL: .*ZERO AC lines' || fail "(a): expected a FAIL line naming ZERO AC lines: $OUT_A"
printf '%s' "$OUT_A" | grep -q 'require-tests.sh' || fail "(a): expected the FAIL line to reference require-tests.sh's fail-closed precedent: $OUT_A"

# ==== (b) AC lines present but none carry any contract field -> FAIL ====
SUB="$DIR/b"; mkdir -p "$SUB"; cd "$SUB" || fail "cd b"
printf -- '- AC: first thing, no contract\n- AC: second thing, no contract\n' > plan.md
OUT_B="$(run_ac_verify plan.md .loop 2>&1)"; CODE_B=$?
[ "$CODE_B" -eq 1 ] || fail "(b): expected exit 1, got $CODE_B: $OUT_B"
printf '%s' "$OUT_B" | grep -q '^VERDICT: FAIL$' || fail "(b): expected VERDICT: FAIL: $OUT_B"
printf '%s' "$OUT_B" | grep -qE '^SUMMARY: passed=0 failed=0 skipped=2 ' || fail "(b): expected skipped=2 (both uncontracted): $OUT_B"
printf '%s' "$OUT_B" | grep -q '^FAIL: .*ZERO carry a machine-checkable contract' || fail "(b): expected a FAIL line naming zero contracts: $OUT_B"
printf '%s' "$OUT_B" | grep -q 'require-tests.sh' || fail "(b): expected the FAIL line to reference require-tests.sh: $OUT_B"

# ==== (c) one AC with a verify: command that exits 0 -> overall PASS ====
SUB="$DIR/c"; mkdir -p "$SUB"; cd "$SUB" || fail "cd c"
printf -- '- AC: server starts | verify: true\n' > plan.md
OUT_C="$(run_ac_verify plan.md .loop 2>&1)"; CODE_C=$?
[ "$CODE_C" -eq 0 ] || fail "(c): expected exit 0, got $CODE_C: $OUT_C"
printf '%s' "$OUT_C" | grep -q '^VERDICT: PASS$' || fail "(c): expected VERDICT: PASS: $OUT_C"
printf '%s' "$OUT_C" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=0 ' || fail "(c): expected passed=1: $OUT_C"

# ==== (d) one AC with a verify: command that exits nonzero -> overall FAIL, named FAIL: line ====
SUB="$DIR/d"; mkdir -p "$SUB"; cd "$SUB" || fail "cd d"
printf -- '- AC: broken build | verify: exit 7\n' > plan.md
OUT_D="$(run_ac_verify plan.md .loop 2>&1)"; CODE_D=$?
[ "$CODE_D" -eq 1 ] || fail "(d): expected exit 1, got $CODE_D: $OUT_D"
printf '%s' "$OUT_D" | grep -q '^VERDICT: FAIL$' || fail "(d): expected VERDICT: FAIL: $OUT_D"
printf '%s' "$OUT_D" | grep -qE '^SUMMARY: passed=0 failed=1 skipped=0 ' || fail "(d): expected failed=1: $OUT_D"
printf '%s' "$OUT_D" | grep -q '^FAIL: AC "broken build":.*verify exited 7' || fail "(d): expected a FAIL line naming the AC and its real exit code 7: $OUT_D"

# ==== (e) artifacts: — an existing path passes; a missing path FAILs even if verify: exits 0 ====
SUB="$DIR/e"; mkdir -p "$SUB"; cd "$SUB" || fail "cd e"
: > exists.txt
printf -- '- AC: artifact present | verify: true | artifacts: exists.txt\n' > plan-ok.md
OUT_E1="$(run_ac_verify plan-ok.md .loop 2>&1)"; CODE_E1=$?
[ "$CODE_E1" -eq 0 ] || fail "(e-present): expected exit 0, got $CODE_E1: $OUT_E1"
printf '%s' "$OUT_E1" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=0 ' || fail "(e-present): expected passed=1: $OUT_E1"

printf -- '- AC: artifact missing | verify: true | artifacts: does-not-exist.txt\n' > plan-missing.md
OUT_E2="$(run_ac_verify plan-missing.md .loop2 2>&1)"; CODE_E2=$?
[ "$CODE_E2" -eq 1 ] || fail "(e-missing): expected exit 1 even though verify: exits 0, got $CODE_E2: $OUT_E2"
printf '%s' "$OUT_E2" | grep -q '^FAIL: AC "artifact missing":.*missing artifact(s): does-not-exist.txt' || fail "(e-missing): expected a FAIL line naming the missing artifact: $OUT_E2"

# ==== (f) expect: — substring present passes; substring absent FAILs ====
SUB="$DIR/f"; mkdir -p "$SUB"; cd "$SUB" || fail "cd f"
printf -- '- AC: greets correctly | verify: echo hello-world | expect: hello-world\n' > plan-present.md
OUT_F1="$(run_ac_verify plan-present.md .loop 2>&1)"; CODE_F1=$?
[ "$CODE_F1" -eq 0 ] || fail "(f-present): expected exit 0, got $CODE_F1: $OUT_F1"

printf -- '- AC: greets correctly | verify: echo hello-world | expect: goodbye\n' > plan-absent.md
OUT_F2="$(run_ac_verify plan-absent.md .loop2 2>&1)"; CODE_F2=$?
[ "$CODE_F2" -eq 1 ] || fail "(f-absent): expected exit 1, got $CODE_F2: $OUT_F2"
printf '%s' "$OUT_F2" | grep -q '^FAIL: AC "greets correctly":.*expect substring not found' || fail "(f-absent): expected a FAIL line naming the missing expect substring: $OUT_F2"

# ==== (g) one contracted AC (passes) + one uncontracted AC -> overall PASS, uncontracted counted under skipped= ====
SUB="$DIR/g"; mkdir -p "$SUB"; cd "$SUB" || fail "cd g"
printf -- '- AC: contracted one | verify: true\n- AC: uncontracted human check\n' > plan.md
OUT_G="$(run_ac_verify plan.md .loop 2>&1)"; CODE_G=$?
[ "$CODE_G" -eq 0 ] || fail "(g): expected exit 0, got $CODE_G: $OUT_G"
printf '%s' "$OUT_G" | grep -q '^VERDICT: PASS$' || fail "(g): expected VERDICT: PASS: $OUT_G"
printf '%s' "$OUT_G" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=1 ' || fail "(g): expected passed=1 skipped=1: $OUT_G"

# ==== (h) one passing + one failing contracted AC -> overall FAIL, exactly one FAIL: line ====
SUB="$DIR/h"; mkdir -p "$SUB"; cd "$SUB" || fail "cd h"
printf -- '- AC: good one | verify: true\n- AC: bad one | verify: false\n' > plan.md
OUT_H="$(run_ac_verify plan.md .loop 2>&1)"; CODE_H=$?
[ "$CODE_H" -eq 1 ] || fail "(h): expected exit 1, got $CODE_H: $OUT_H"
printf '%s' "$OUT_H" | grep -qE '^SUMMARY: passed=1 failed=1 skipped=0 ' || fail "(h): expected passed=1 failed=1: $OUT_H"
FAIL_LINES_H="$(printf '%s\n' "$OUT_H" | grep -c '^FAIL: ')"
[ "$FAIL_LINES_H" -eq 1 ] || fail "(h): expected exactly 1 FAIL: line, got $FAIL_LINES_H: $OUT_H"
printf '%s' "$OUT_H" | grep -q '^FAIL: AC "bad one":' || fail "(h): expected the FAIL line to name 'bad one': $OUT_H"
printf '%s' "$OUT_H" | grep -q '^FAIL: AC "good one":' && fail "(h): the passing AC must NOT produce a FAIL line: $OUT_H"

# ==== (i) sanity-check the emitted block's delimiters + the VERDICT line matches the actual exit code ====
SUB="$DIR/i"; mkdir -p "$SUB"; cd "$SUB" || fail "cd i"
printf -- '- AC: sanity check | verify: true\n' > plan.md
OUT_I="$(run_ac_verify plan.md .loop 2>&1)"; CODE_I=$?
[ "$(printf '%s\n' "$OUT_I" | head -n1)" = "=== VERDICT ===" ] || fail "(i): block must start with '=== VERDICT ===': $OUT_I"
[ "$(printf '%s\n' "$OUT_I" | tail -n1)" = "=== END VERDICT ===" ] || fail "(i): block must end with '=== END VERDICT ===': $OUT_I"
if [ "$CODE_I" -eq 0 ]; then
  printf '%s' "$OUT_I" | grep -q '^VERDICT: PASS$' || fail "(i): exit 0 must correspond to VERDICT: PASS: $OUT_I"
else
  printf '%s' "$OUT_I" | grep -q '^VERDICT: FAIL$' || fail "(i): a nonzero exit must correspond to VERDICT: FAIL: $OUT_I"
fi

# ==== (j) FIX 1 regression: shared verdict-state.json must reflect ac-verify.sh's own aggregate,
# not whichever per-AC verdict-run.sh sub-call happened to write it last. A failing AC listed
# BEFORE a passing AC would, pre-fix, leave the LAST (passing) sub-call's own PASS/exit-0 write in
# the state file — even though the true aggregate, and ac-verify.sh's own printed VERDICT block,
# is FAIL. LOOP_DIR is exported explicitly (matching --log-dir) so the state file's location is
# known, not assumed to be literally './.loop' by coincidence. ====
SUB="$DIR/j"; mkdir -p "$SUB"; cd "$SUB" || fail "cd j"
printf -- '- AC: fails first | verify: false\n- AC: passes second | verify: true\n' > plan.md
export LOOP_DIR=".loop"
OUT_J="$(run_ac_verify plan.md .loop 2>&1)"; CODE_J=$?
unset LOOP_DIR
[ "$CODE_J" -eq 1 ] || fail "(j): expected exit 1 (ac-verify.sh's own aggregate is FAIL — one AC failed), got $CODE_J: $OUT_J"
printf '%s' "$OUT_J" | grep -q '^VERDICT: FAIL$' || fail "(j): expected ac-verify.sh's own printed VERDICT: FAIL: $OUT_J"
STATE_FILE_J="$SUB/.loop/verdict-state.json"
[ -f "$STATE_FILE_J" ] || fail "(j): expected verdict-state.json at $STATE_FILE_J (dir listing: $(ls -la "$SUB/.loop" 2>&1))"
STATE_CONTENT_J="$(cat "$STATE_FILE_J")"
printf '%s' "$STATE_CONTENT_J" | grep -q '"verdict":"FAIL"' || fail "(j): expected verdict-state.json's own verdict field to be FAIL (a last-writer-wins bug would show PASS, from the last-processed passing AC's own sub-call), got: $STATE_CONTENT_J"
printf '%s' "$STATE_CONTENT_J" | grep -q '"exit":1' || fail "(j): expected verdict-state.json's own exit field to be 1, matching ac-verify.sh's own aggregate exit code, got: $STATE_CONTENT_J"

# ==== (k) FIX 2(a) regression: a capitalized `Verify:` field must resolve as a real verify:
# contract (not silently fold into the description) — a failing command must FAIL the gate. ====
SUB="$DIR/k"; mkdir -p "$SUB"; cd "$SUB" || fail "cd k"
printf -- '- AC: capitalized field | Verify: exit 7\n' > plan.md
OUT_K="$(run_ac_verify plan.md .loop 2>&1)"; CODE_K=$?
[ "$CODE_K" -eq 1 ] || fail "(k): expected exit 1 ('Verify:' must be treated as a real contract), got $CODE_K: $OUT_K"
printf '%s' "$OUT_K" | grep -qE '^SUMMARY: passed=0 failed=1 skipped=0 ' || fail "(k): expected failed=1 (not silently folded into skipped=): $OUT_K"
printf '%s' "$OUT_K" | grep -q '^FAIL: AC "capitalized field":.*verify exited 7' || fail "(k): expected a FAIL line naming the AC and its real exit code 7: $OUT_K"

# ==== (l) FIX 2(a) regression: same as (k) but for markdown-bold `**verify:**`. ====
SUB="$DIR/l"; mkdir -p "$SUB"; cd "$SUB" || fail "cd l"
printf -- '- AC: bold field | **verify:** exit 7\n' > plan.md
OUT_L="$(run_ac_verify plan.md .loop 2>&1)"; CODE_L=$?
[ "$CODE_L" -eq 1 ] || fail "(l): expected exit 1 ('**verify:**' must be treated as a real contract), got $CODE_L: $OUT_L"
printf '%s' "$OUT_L" | grep -qE '^SUMMARY: passed=0 failed=1 skipped=0 ' || fail "(l): expected failed=1 (not silently folded into skipped=): $OUT_L"
printf '%s' "$OUT_L" | grep -q '^FAIL: AC "bold field":.*verify exited 7' || fail "(l): expected a FAIL line naming the AC and its real exit code 7: $OUT_L"

# ==== (n) FIX 2(b) regression: a genuine typo (`verfy:`, not one of the normalized variants above)
# must still fall into skipped= as before (it is NOT a recognized field), but must now print a
# warning naming it, instead of vanishing with zero trace. A second, correctly-contracted passing
# AC isolates skipped=1 to the typo'd AC specifically (avoids conflating with the separate
# zero-contracts-in-the-whole-plan fail-closed path already covered by test (b) above). ====
SUB="$DIR/n"; mkdir -p "$SUB"; cd "$SUB" || fail "cd n"
printf -- '- AC: typo field | verfy: exit 7\n- AC: real contract | verify: true\n' > plan.md
OUT_N="$("$AC_VERIFY" plan.md --log-dir .loop 2>"$DIR/n-stderr.log")"; CODE_N=$?
ERR_N="$(cat "$DIR/n-stderr.log")"
[ "$CODE_N" -eq 0 ] || fail "(n): expected exit 0 (the one real contract passes; the typo'd AC is skipped, not failed), got $CODE_N: $OUT_N"
printf '%s' "$OUT_N" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=1 ' || fail "(n): expected passed=1 skipped=1 (typo'd field unrecognized, folded into description as before): $OUT_N"
printf '%s' "$ERR_N" | grep -q 'unrecognized field-like segment' || fail "(n): expected a warning on stderr naming the unrecognized segment, got stderr: $ERR_N"
printf '%s' "$ERR_N" | grep -q 'verfy: exit 7' || fail "(n): expected the warning to name the unrecognized segment verbatim ('verfy: exit 7'), got stderr: $ERR_N"

# ==== (o) FIX 1 round-2 regression: an EARLY exit (verdict-run.sh's own exit-2 usage-error
# refusal, hit for a LATER AC) must not leave an EARLIER AC's own stale PASS sitting in
# verdict-state.json. Reproduces the round-2 adversarial finding directly: pre-create a directory
# at the SECOND AC's expected per-AC log path so verdict-run.sh's own write-check for that AC
# fails with exit 2 — after the FIRST AC already ran and its own sub-call already wrote
# verdict-state.json with verdict:PASS. Before the EXIT-trap fix, this exit-2 path bypassed the
# single manually-placed corrective sync call entirely, leaving that stale PASS in place with no
# aggregate-sync.log ever created. ====
SUB="$DIR/o"; mkdir -p "$SUB"; cd "$SUB" || fail "cd o"
mkdir -p .loop/ac-verify
mkdir -p .loop/ac-verify/ac-2.log   # a directory here forces verdict-run.sh's write-check to fail for AC #2
printf -- '- AC: first passes | verify: true\n- AC: second explodes | verify: true\n' > plan.md
OUT_O="$("$AC_VERIFY" plan.md --log-dir .loop 2>"$DIR/o-stderr.log")"; CODE_O=$?
ERR_O="$(cat "$DIR/o-stderr.log")"
[ "$CODE_O" -eq 2 ] || fail "(o): expected exit 2 (verdict-run.sh's own usage error propagated), got $CODE_O: $OUT_O / stderr: $ERR_O"
printf '%s' "$ERR_O" | grep -q 'usage error (exit 2)' || fail "(o): expected the exit-2 stderr message, got: $ERR_O"
STATE_FILE_O="$SUB/.loop/verdict-state.json"
[ -f "$STATE_FILE_O" ] || fail "(o): expected verdict-state.json at $STATE_FILE_O (the EXIT trap should have synced it even on this early-abort path)"
STATE_CONTENT_O="$(cat "$STATE_FILE_O")"
printf '%s' "$STATE_CONTENT_O" | grep -q '"verdict":"PASS"' && fail "(o): verdict-state.json must NOT read PASS on this abort path (that would be AC #1's own stale leftover leaking through), got: $STATE_CONTENT_O"
printf '%s' "$STATE_CONTENT_O" | grep -q '"verdict":"FAIL"' || fail "(o): expected verdict-state.json's own verdict field to be FAIL (the trap's fail-closed default), got: $STATE_CONTENT_O"
[ -f "$SUB/.loop/ac-verify/aggregate-sync.log" ] || fail "(o): expected the trap's corrective sync call to have run (aggregate-sync.log missing)"

# ==== (p) FIX 2 round-2 regression: --log-dir and verdict-run.sh's own ${LOOP_DIR:-.loop} default
# must be coupled by construction (an explicit `export LOOP_DIR="$LOG_DIR"`), not by accidental
# default-value coincidence. Two DIFFERENT --log-dir values, with NO LOOP_DIR exported beforehand
# (exercises the previously-broken default-unset case — not the already-covered case where a
# caller manually keeps them in sync): one plan that FAILs, one that PASSes. Each run's OWN
# verdict-state.json (under ITS OWN --log-dir) must reflect THAT run's own result — not the other
# run's, and not some unrelated shared default './.loop/verdict-state.json'. ====
SUB="$DIR/p"; mkdir -p "$SUB"; cd "$SUB" || fail "cd p"
unset LOOP_DIR
printf -- '- AC: will fail | verify: false\n' > plan-fail.md
printf -- '- AC: will pass | verify: true\n' > plan-pass.md
"$AC_VERIFY" plan-fail.md --log-dir logdir-a >/dev/null 2>&1; CODE_P1=$?
"$AC_VERIFY" plan-pass.md --log-dir logdir-b >/dev/null 2>&1; CODE_P2=$?
[ "$CODE_P1" -eq 1 ] || fail "(p): expected the plan-fail.md run (logdir-a) to exit 1, got $CODE_P1"
[ "$CODE_P2" -eq 0 ] || fail "(p): expected the plan-pass.md run (logdir-b) to exit 0, got $CODE_P2"
STATE_A="$SUB/logdir-a/verdict-state.json"
STATE_B="$SUB/logdir-b/verdict-state.json"
[ -f "$STATE_A" ] || fail "(p): expected verdict-state.json under logdir-a (dir listing: $(ls -la "$SUB" 2>&1))"
[ -f "$STATE_B" ] || fail "(p): expected verdict-state.json under logdir-b (dir listing: $(ls -la "$SUB" 2>&1))"
[ -e "$SUB/.loop/verdict-state.json" ] && fail "(p): no verdict-state.json should land under the unrelated default .loop/ — both runs must use their own --log-dir exclusively, got: $(cat "$SUB/.loop/verdict-state.json" 2>&1)"
grep -q '"verdict":"FAIL"' "$STATE_A" || fail "(p): logdir-a's verdict-state.json must reflect ITS OWN FAIL result, got: $(cat "$STATE_A")"
grep -q '"verdict":"PASS"' "$STATE_B" || fail "(p): logdir-b's verdict-state.json must reflect ITS OWN PASS result (not clobbered by the other run's FAIL), got: $(cat "$STATE_B")"

# ==== (q) FIX 3 round-2 regression: a colon-OMITTED typo of a reserved field name (`verify exit 9`
# — no colon after "verify") must still fall into skipped= (NOT silently become a real contract
# just because a warning now fires), but a warning must now fire on stderr naming the unrecognized
# segment — matching the existing warning-format convention already used for the colon-containing
# typo case (test (n) above). Before this fix, the colon-based heuristic alone (a `:` within the
# segment's first ~20 chars) never fired here since there is no colon anywhere in the segment, so
# this exact intended-but-broken contract vanished with zero trace. A second, correctly-contracted
# passing AC isolates skipped=1 to the colon-less typo'd AC specifically. ====
SUB="$DIR/q"; mkdir -p "$SUB"; cd "$SUB" || fail "cd q"
printf -- '- AC: colonless typo | verify exit 9\n- AC: real contract | verify: true\n' > plan.md
OUT_Q="$("$AC_VERIFY" plan.md --log-dir .loop 2>"$DIR/q-stderr.log")"; CODE_Q=$?
ERR_Q="$(cat "$DIR/q-stderr.log")"
[ "$CODE_Q" -eq 0 ] || fail "(q): expected exit 0 (the one real contract passes; the colon-less typo'd AC is skipped, not failed), got $CODE_Q: $OUT_Q"
printf '%s' "$OUT_Q" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=1 ' || fail "(q): expected passed=1 skipped=1 (colon-less typo'd field still unrecognized, folded into description as before): $OUT_Q"
printf '%s' "$ERR_Q" | grep -q 'unrecognized field-like segment' || fail "(q): expected a warning on stderr naming the unrecognized segment even without a colon, got stderr: $ERR_Q"
printf '%s' "$ERR_Q" | grep -q 'verify exit 9' || fail "(q): expected the warning to name the unrecognized segment verbatim ('verify exit 9'), got stderr: $ERR_Q"

cd "$ORIG_PWD" || true
echo "PASS: ac-verify.sh (issue #23) — zero-AC/zero-contract fail-closed, independent verify:/artifacts:/expect: checks, mixed pass+fail and contracted+uncontracted aggregation, Verdict Contract block shape, verdict-state.json aggregate-sync via an EXIT trap covering early-exit paths too (not last-writer-wins, not just the normal-completion path), --log-dir/LOOP_DIR coupling (isolated verdict-state.json per --log-dir), case/markdown-emphasis-tolerant field parsing, unrecognized-field-like-segment warning (both colon-containing and colon-omitted typos)"
exit 0
