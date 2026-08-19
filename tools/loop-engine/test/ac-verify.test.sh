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

cd "$ORIG_PWD" || true
echo "PASS: ac-verify.sh (issue #23) — zero-AC/zero-contract fail-closed, independent verify:/artifacts:/expect: checks, mixed pass+fail and contracted+uncontracted aggregation, Verdict Contract block shape"
exit 0
