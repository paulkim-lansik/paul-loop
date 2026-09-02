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

# ==== (r) FIX round-3 regression: the EXIT trap must be armed BEFORE argument parsing itself, not
# just after it. Pre-fix, the trap was registered AFTER the flag-parsing while-loop, so a usage
# error DURING parsing (an unknown flag, `--log-dir` with no following value, an extra stray
# positional argument) called `exit 2` before the trap was ever armed — leaving a stale earlier
# verdict-state.json completely untouched (last-writer-wins from a PRIOR, unrelated normal run).
# For each of the three shapes: seed a real PASS via a normal prior run in the same log-dir, then
# re-run with the bad arguments and assert (a) exit 2, (b) the seeded PASS is corrected to FAIL by
# the now-earlier-armed trap — proving there is no exit path, from the very first line onward,
# that can occur before the trap has already been registered. ====
SUB="$DIR/r"; mkdir -p "$SUB"; cd "$SUB" || fail "cd r"
printf -- '- AC: seed pass | verify: true\n' > plan.md
STATE_FILE_R="$SUB/.loop/verdict-state.json"

# ---- (r1) unknown/bogus flag ----
rm -rf .loop
run_ac_verify plan.md .loop >/dev/null 2>&1; SEED_CODE_R1=$?
[ "$SEED_CODE_R1" -eq 0 ] || fail "(r1): seed run expected exit 0, got $SEED_CODE_R1"
grep -q '"verdict":"PASS"' "$STATE_FILE_R" || fail "(r1): expected the seed run to leave verdict-state.json at PASS, got: $(cat "$STATE_FILE_R" 2>&1)"
OUT_R1="$("$AC_VERIFY" plan.md --log-dir .loop --bogus-flag 2>&1)"; CODE_R1=$?
[ "$CODE_R1" -eq 2 ] || fail "(r1): expected exit 2 (unknown flag), got $CODE_R1: $OUT_R1"
[ -f "$STATE_FILE_R" ] || fail "(r1): expected verdict-state.json to still exist at $STATE_FILE_R"
STATE_CONTENT_R1="$(cat "$STATE_FILE_R")"
printf '%s' "$STATE_CONTENT_R1" | grep -q '"verdict":"PASS"' && fail "(r1): the seeded PASS must NOT survive an unknown-flag usage error (the EXIT trap must already be armed during argument parsing), got: $STATE_CONTENT_R1"
printf '%s' "$STATE_CONTENT_R1" | grep -q '"verdict":"FAIL"' || fail "(r1): expected verdict-state.json to be corrected to FAIL by the trap, got: $STATE_CONTENT_R1"

# ---- (r2) --log-dir given with no following value ----
rm -rf .loop
run_ac_verify plan.md .loop >/dev/null 2>&1; SEED_CODE_R2=$?
[ "$SEED_CODE_R2" -eq 0 ] || fail "(r2): seed run expected exit 0, got $SEED_CODE_R2"
grep -q '"verdict":"PASS"' "$STATE_FILE_R" || fail "(r2): expected the seed run to leave verdict-state.json at PASS, got: $(cat "$STATE_FILE_R" 2>&1)"
OUT_R2="$("$AC_VERIFY" plan.md --log-dir .loop --log-dir 2>&1)"; CODE_R2=$?
[ "$CODE_R2" -eq 2 ] || fail "(r2): expected exit 2 (--log-dir with no value), got $CODE_R2: $OUT_R2"
[ -f "$STATE_FILE_R" ] || fail "(r2): expected verdict-state.json to still exist at $STATE_FILE_R"
STATE_CONTENT_R2="$(cat "$STATE_FILE_R")"
printf '%s' "$STATE_CONTENT_R2" | grep -q '"verdict":"PASS"' && fail "(r2): the seeded PASS must NOT survive a missing-value --log-dir usage error (the EXIT trap must already be armed during argument parsing), got: $STATE_CONTENT_R2"
printf '%s' "$STATE_CONTENT_R2" | grep -q '"verdict":"FAIL"' || fail "(r2): expected verdict-state.json to be corrected to FAIL by the trap, got: $STATE_CONTENT_R2"

# ---- (r3) extra stray positional argument after the plan file ----
rm -rf .loop
run_ac_verify plan.md .loop >/dev/null 2>&1; SEED_CODE_R3=$?
[ "$SEED_CODE_R3" -eq 0 ] || fail "(r3): seed run expected exit 0, got $SEED_CODE_R3"
grep -q '"verdict":"PASS"' "$STATE_FILE_R" || fail "(r3): expected the seed run to leave verdict-state.json at PASS, got: $(cat "$STATE_FILE_R" 2>&1)"
OUT_R3="$("$AC_VERIFY" plan.md extra-arg --log-dir .loop 2>&1)"; CODE_R3=$?
[ "$CODE_R3" -eq 2 ] || fail "(r3): expected exit 2 (extra positional argument), got $CODE_R3: $OUT_R3"
[ -f "$STATE_FILE_R" ] || fail "(r3): expected verdict-state.json to still exist at $STATE_FILE_R"
STATE_CONTENT_R3="$(cat "$STATE_FILE_R")"
printf '%s' "$STATE_CONTENT_R3" | grep -q '"verdict":"PASS"' && fail "(r3): the seeded PASS must NOT survive an extra-positional-argument usage error (the EXIT trap must already be armed during argument parsing), got: $STATE_CONTENT_R3"
printf '%s' "$STATE_CONTENT_R3" | grep -q '"verdict":"FAIL"' || fail "(r3): expected verdict-state.json to be corrected to FAIL by the trap, got: $STATE_CONTENT_R3"

# ==== (t) issue #74: `expect:` had exactly one corpus — the verify: log — so an `artifacts:` +
# `expect:` contract with no verify: was STRUCTURALLY unpassable: it grepped an empty log and
# reported "expect substring not found", which reads as an implementation defect rather than a
# contract that cannot hold. The pressure that creates is the dangerous direction: drop the
# `expect:` to make the AC pass, and the contract quietly checks nothing.
#
# Fixed semantics, in precedence order:
#   verify: present            -> expect greps the verify log (UNCHANGED — nothing that passed before changes)
#   no verify:, artifacts:     -> expect greps the artifact files' contents (the natural reading)
#   neither                    -> usage error, exit 2 (there is no corpus to search; not a violation)
SUB="$DIR/t"; mkdir -p "$SUB"; cd "$SUB" || fail "cd t"

# ---- (t1) artifacts: + expect:, no verify: — substring present in the artifact -> PASS ----
printf 'alpha\nfork appears here\nomega\n' > doc.md
printf -- '- AC: the doc states the fork rule | artifacts: doc.md | expect: fork\n' > plan-t1.md
OUT_T1="$(run_ac_verify plan-t1.md .loop-t1 2>&1)"; CODE_T1=$?
[ "$CODE_T1" -eq 0 ] || fail "(t1): artifacts+expect with no verify: must search the ARTIFACT, not an empty log — expected exit 0, got $CODE_T1: $OUT_T1"
printf '%s' "$OUT_T1" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=0 ' || fail "(t1): expected passed=1: $OUT_T1"

# ---- (t2) same shape, substring genuinely absent from the artifact -> FAIL (still fails closed) ----
printf -- '- AC: the doc states the fork rule | artifacts: doc.md | expect: nowhere-in-this-file\n' > plan-t2.md
OUT_T2="$(run_ac_verify plan-t2.md .loop-t2 2>&1)"; CODE_T2=$?
[ "$CODE_T2" -eq 1 ] || fail "(t2): a substring genuinely absent from the artifact must still FAIL, got $CODE_T2: $OUT_T2"
printf '%s' "$OUT_T2" | grep -q '^FAIL: AC "the doc states the fork rule":.*expect substring not found' || fail "(t2): expected the expect reason to name the missing substring: $OUT_T2"

# ---- (t3) expect: with NEITHER verify: nor artifacts: -> usage error (exit 2), not a violation ----
printf -- '- AC: nothing to search | expect: something\n' > plan-t3.md
OUT_T3="$(run_ac_verify plan-t3.md .loop-t3 2>&1)"; CODE_T3=$?
[ "$CODE_T3" -eq 2 ] || fail "(t3): expect: with no verify: and no artifacts: has no corpus to search — that is a contract error (exit 2), not an AC violation (exit 1); got $CODE_T3: $OUT_T3"
printf '%s' "$OUT_T3" | grep -q 'expect:' || fail "(t3): the error must name the offending field: $OUT_T3"
printf '%s' "$OUT_T3" | grep -q '^FAIL: ' && fail "(t3): a usage error must NOT be reported as an AC violation line: $OUT_T3"

# ---- (t4) verify: present -> the verify log stays the corpus. A substring that appears in the
# artifact but NOT in the verify output must still FAIL: this fix widens where expect can look
# only when there was no corpus at all, it never quietly makes an existing contract easier. ----
printf -- '- AC: verify log is still the corpus | verify: echo unrelated-output | artifacts: doc.md | expect: fork\n' > plan-t4.md
OUT_T4="$(run_ac_verify plan-t4.md .loop-t4 2>&1)"; CODE_T4=$?
[ "$CODE_T4" -eq 1 ] || fail "(t4): with verify: present, expect must still grep the verify log only (the artifact contains 'fork', the log does not) — expected exit 1, got $CODE_T4: $OUT_T4"
printf '%s' "$OUT_T4" | grep -q 'expect substring not found' || fail "(t4): expected the expect reason: $OUT_T4"

# ---- (t5) several artifacts: a match in any one of them satisfies expect ----
printf 'nothing here\n' > first.md
printf 'the needle is in the second file\n' > second.md
printf -- '- AC: any artifact may carry it | artifacts: first.md, second.md | expect: needle\n' > plan-t5.md
OUT_T5="$(run_ac_verify plan-t5.md .loop-t5 2>&1)"; CODE_T5=$?
[ "$CODE_T5" -eq 0 ] || fail "(t5): a match in any listed artifact must satisfy expect, got $CODE_T5: $OUT_T5"

# ---- (t6) a missing artifact still fails on its own terms, and expect is reported honestly
# alongside it rather than being silently skipped ----
printf -- '- AC: artifact gone | artifacts: absent.md | expect: anything\n' > plan-t6.md
OUT_T6="$(run_ac_verify plan-t6.md .loop-t6 2>&1)"; CODE_T6=$?
[ "$CODE_T6" -eq 1 ] || fail "(t6): expected exit 1, got $CODE_T6: $OUT_T6"
printf '%s' "$OUT_T6" | grep -q 'missing artifact(s): absent.md' || fail "(t6): expected the missing-artifact reason: $OUT_T6"

cd "$ORIG_PWD" || true

# ==== (s) FIX round-5 regression: --log-dir's LOG_DIR/LOOP_DIR coupling must be applied INLINE the
# instant --log-dir itself is parsed, not deferred to a step after the whole argument-parsing loop
# finishes. Pre-fix, a LATER usage error in the same invocation (after a non-default --log-dir had
# already been parsed) exited before that deferred coupling step ran, so the EXIT trap's corrective
# sync silently targeted the unrelated default `.loop/` instead of the just-parsed --log-dir target
# — the exact stale/wrong-target failure mode every prior round exists to prevent, just relocated
# to a value that had been parsed but not yet "applied". (s1) proves the target directory a
# non-default --log-dir names is the one that actually gets corrected, even when a later argument
# in the same command line errors out — not the unrelated default. (s2) proves a flag-shaped
# --log-dir value (a plausible operator slip: forgetting the directory and typing another flag
# right after --log-dir) is now rejected up front with a clear error, instead of being silently
# accepted and failing opaquely later inside mkdir/verdict-run.sh's own state write. ====
SUB_S="$DIR/s"; mkdir -p "$SUB_S"; cd "$SUB_S" || fail "cd s"
printf -- '- AC: seed pass | verify: true\n' > plan.md

# ---- (s1) non-default --log-dir + a later bad flag must correct THAT target, not the default ----
rm -rf custom-dir .loop
run_ac_verify plan.md custom-dir >/dev/null 2>&1; SEED_CODE_S1=$?
[ "$SEED_CODE_S1" -eq 0 ] || fail "(s1): seed run expected exit 0, got $SEED_CODE_S1"
CUSTOM_STATE_S1="custom-dir/verdict-state.json"
grep -q '"verdict":"PASS"' "$CUSTOM_STATE_S1" || fail "(s1): expected the seed run to leave custom-dir/verdict-state.json at PASS, got: $(cat "$CUSTOM_STATE_S1" 2>&1)"
OUT_S1="$(env -u LOOP_DIR "$AC_VERIFY" plan.md --log-dir custom-dir --bogus-flag 2>&1)"; CODE_S1=$?
[ "$CODE_S1" -eq 2 ] || fail "(s1): expected exit 2 (bogus flag after --log-dir), got $CODE_S1: $OUT_S1"
[ -f "$CUSTOM_STATE_S1" ] || fail "(s1): expected custom-dir/verdict-state.json to still exist"
STATE_CONTENT_S1="$(cat "$CUSTOM_STATE_S1")"
printf '%s' "$STATE_CONTENT_S1" | grep -q '"verdict":"PASS"' && fail "(s1): the seeded PASS in custom-dir must NOT survive a later usage error in the same invocation (LOG_DIR/LOOP_DIR coupling must already be applied the instant --log-dir was parsed, before the later bad flag was even reached), got: $STATE_CONTENT_S1"
printf '%s' "$STATE_CONTENT_S1" | grep -q '"verdict":"FAIL"' || fail "(s1): expected custom-dir/verdict-state.json to be corrected to FAIL, got: $STATE_CONTENT_S1"
[ -f ".loop/verdict-state.json" ] && fail "(s1): the unrelated default .loop/verdict-state.json must not be created/touched by a run that named a different --log-dir target"

# ---- (s2) a flag-shaped --log-dir value must be rejected up front, not silently accepted ----
OUT_S2="$(env -u LOOP_DIR "$AC_VERIFY" plan.md --log-dir --weird 2>&1)"; CODE_S2=$?
[ "$CODE_S2" -eq 2 ] || fail "(s2): expected exit 2 (flag-shaped --log-dir value), got $CODE_S2: $OUT_S2"
printf '%s' "$OUT_S2" | grep -qi 'requires a directory path' || fail "(s2): expected a clear error naming --log-dir's value as flag-shaped, got: $OUT_S2"

# ==== (u) BAC-837/BAC-1010 regression: a `verify:` command that EXITS 0 but actually ran zero
# tests (e.g. `vitest run -t "<pattern>"` whose -t filter matches zero test titles — vitest's
# default is "0 run"/all-skipped, exit 0) must FAIL the AC, not silently PASS. verdict-run.sh's own
# best-effort passed=/failed=/skipped= count extraction is reused as the signal — no re-parsing of
# test-runner output inside ac-verify.sh itself. Fake test runners (`printf`) stand in for real
# vitest/jest here so this stays fast and dependency-free, matching this suite's existing style. ====
SUB="$DIR/u"; mkdir -p "$SUB"; cd "$SUB" || fail "cd u"

# ---- (u1) jest/vitest colon-style zero-match line: "Tests: 0 failed, 0 passed, N skipped, N total" ----
printf -- '- AC: t-filter zero match (jest-style) | verify: printf "Tests: 0 failed, 0 passed, 5 skipped, 5 total\\n"\n' > plan-u1.md
OUT_U1="$(run_ac_verify plan-u1.md .loop-u1 2>&1)"; CODE_U1=$?
[ "$CODE_U1" -eq 1 ] || fail "(u1): a verify: command that exits 0 but ran zero tests must FAIL the AC (not silently PASS), got $CODE_U1: $OUT_U1"
printf '%s' "$OUT_U1" | grep -qE '^SUMMARY: passed=0 failed=1 skipped=0 ' || fail "(u1): expected failed=1 at the ac-verify.sh aggregate level: $OUT_U1"
printf '%s' "$OUT_U1" | grep -q '^FAIL: AC "t-filter zero match (jest-style)":.*0 tests executed' || fail "(u1): expected a FAIL line naming '0 tests executed': $OUT_U1"

# ---- (u2) vitest's actual colon-less summary shape: "Tests  5 skipped (5)" (no "passed"/"failed"
# words at all — only verdict-run.sh's pytest-style fallback pattern can see this one) ----
printf -- '- AC: t-filter zero match (vitest-style) | verify: printf "     Tests  5 skipped (5)\\n"\n' > plan-u2.md
OUT_U2="$(run_ac_verify plan-u2.md .loop-u2 2>&1)"; CODE_U2=$?
[ "$CODE_U2" -eq 1 ] || fail "(u2): vitest's colon-less all-skipped summary must also FAIL the AC, got $CODE_U2: $OUT_U2"
printf '%s' "$OUT_U2" | grep -q '^FAIL: AC "t-filter zero match (vitest-style)":.*0 tests executed' || fail "(u2): expected a FAIL line naming '0 tests executed': $OUT_U2"

# ---- (u3) control: a REAL passing run (skipped=0) must NOT be flagged — proves this is not a
# blanket rejection of every test-runner-shaped SUMMARY line, only the all-skipped/zero-run one ----
printf -- '- AC: real tests actually ran | verify: printf "Tests: 0 failed, 5 passed, 0 skipped, 5 total\\n"\n' > plan-u3.md
OUT_U3="$(run_ac_verify plan-u3.md .loop-u3 2>&1)"; CODE_U3=$?
[ "$CODE_U3" -eq 0 ] || fail "(u3): a verify: command reporting real passes (skipped=0) must still PASS, got $CODE_U3: $OUT_U3"
printf '%s' "$OUT_U3" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=0 ' || fail "(u3): expected passed=1 at the ac-verify.sh aggregate level: $OUT_U3"

# ---- (u4) control: an ordinary non-test-runner verify: command (no passed=/failed=/skipped=
# signal at all) must be completely unaffected by this check — proves no false positive on the
# common case (verify: true / a shell one-liner) ----
printf -- '- AC: ordinary non-test verify | verify: true\n' > plan-u4.md
OUT_U4="$(run_ac_verify plan-u4.md .loop-u4 2>&1)"; CODE_U4=$?
[ "$CODE_U4" -eq 0 ] || fail "(u4): an ordinary verify: command with no test-runner-shaped output must still PASS, got $CODE_U4: $OUT_U4"
printf '%s' "$OUT_U4" | grep -qE '^SUMMARY: passed=1 failed=0 skipped=0 ' || fail "(u4): expected passed=1: $OUT_U4"

cd "$ORIG_PWD" || true
echo "PASS: ac-verify.sh (issue #23) — zero-AC/zero-contract fail-closed, independent verify:/artifacts:/expect: checks, mixed pass+fail and contracted+uncontracted aggregation, Verdict Contract block shape, verdict-state.json aggregate-sync via an EXIT trap covering early-exit paths too (not last-writer-wins, not just the normal-completion path, and now armed BEFORE argument parsing itself), --log-dir/LOOP_DIR coupling applied inline the instant --log-dir is parsed (isolated verdict-state.json per --log-dir, correct even when a later argument errors), flag-shaped --log-dir values rejected up front, case/markdown-emphasis-tolerant field parsing, unrecognized-field-like-segment warning (both colon-containing and colon-omitted typos), zero-executed/all-skipped verify: commands FAIL instead of fake-greening (BAC-837/BAC-1010)"
exit 0
