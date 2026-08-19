#!/usr/bin/env bash
# Regression test for verifier-pinned-review.sh — the pinned-baseline check that stops a PR from
# grading itself with its own freshly-edited verifier (issue #14, ADR-0002). Builds fully isolated
# throwaway git repos (mktemp -d, never touches this actual repo) to exercise: skip when nothing
# sensitive is touched, PASS when base tests still hold against new code, the CORE case (a PR that
# weakens bin/ AND loosens its own test in the same PR is still caught by the untouched base test),
# a brand-new HEAD-only test file is left alone (not force-restored from a base where it doesn't
# exist), a deleted base test file is restored and still enforced, and the no-CODEOWNERS PASS.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/verifier-pinned-review.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$SCRIPT" ] || fail "verifier-pinned-review.sh not found at $SCRIPT"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ---- fixture: a fresh throwaway repo with a base commit — CODEOWNERS declaring the same
# sensitive paths as the real repo, a passthrough test/run.sh (same discovery idiom as the real
# tools/loop-engine/test/run.sh), and a toy bin/checker.sh + test/checker.test.sh pair that plays
# the role of "the verifier and the test that pins it". Prints the repo path on stdout.
new_base_repo() {
  d="$TMP_ROOT/repo-$1"
  mkdir -p "$d/tools/loop-engine/bin" "$d/tools/loop-engine/test" "$d/.github/workflows"
  git -C "$d" init -q -b main >/dev/null
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name test

  cat > "$d/CODEOWNERS" <<'EOF'
/tools/loop-engine/bin/    @test
/tools/loop-engine/lib/    @test
/tools/loop-engine/test/   @test
/.github/workflows/        @test
/CODEOWNERS                @test
EOF

  cat > "$d/tools/loop-engine/test/run.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0; total=0
for t in "$HERE"/*.test.sh; do
  [ -e "$t" ] || continue
  total=$((total + 1))
  if ! bash "$t"; then fails=$((fails + 1)); fi
done
echo "fixture selftest: $((total - fails))/$total passed"
[ "$fails" -eq 0 ]
EOF

  # bin/checker.sh: the toy "verifier" — rejects any input that doesn't contain WIDGET.
  cat > "$d/tools/loop-engine/bin/checker.sh" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  *WIDGET*) exit 0 ;;
  *) echo "checker: rejected (no WIDGET)"; exit 1 ;;
esac
EOF

  # test/checker.test.sh: the pinned baseline — asserts the reject behaviour.
  cat > "$d/tools/loop-engine/test/checker.test.sh" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HERE/../bin/checker.sh"
bash "$CHECKER" "bad input" && { echo "FAIL: bad input must be rejected"; exit 1; }
bash "$CHECKER" "has WIDGET in it" || { echo "FAIL: WIDGET input must be accepted"; exit 1; }
echo "PASS: checker rejects non-WIDGET input"
EOF

  echo "irrelevant" > "$d/README.md"
  chmod +x "$d/tools/loop-engine/test/run.sh" "$d/tools/loop-engine/bin/checker.sh" "$d/tools/loop-engine/test/checker.test.sh"
  git -C "$d" add -A
  git -C "$d" commit -q -m "base"
  echo "$d"
}

# ==== scenario 1: only a non-sensitive path (README.md) changes -> PASS, skipped ====
R1="$(new_base_repo s1)"
BASE1="$(git -C "$R1" rev-parse HEAD)"
echo "more text" >> "$R1/README.md"
git -C "$R1" add -A && git -C "$R1" commit -q -m "touch only README"

OUT1="$(bash "$SCRIPT" --base "$BASE1" --repo-root "$R1" 2>&1)"; RC1=$?
[ "$RC1" -eq 0 ] || fail "scenario1 (no sensitive path touched) expected PASS(0), got rc=$RC1: $OUT1"
printf '%s' "$OUT1" | grep -q "skipping pinned-baseline check" \
  || fail "scenario1 must report the skip: $OUT1"

# ==== scenario 2: a sensitive path changes, but base tests still pass on the new code -> PASS ====
R2="$(new_base_repo s2)"
BASE2="$(git -C "$R2" rev-parse HEAD)"
printf '\n# harmless comment, no behaviour change\n' >> "$R2/tools/loop-engine/bin/checker.sh"
git -C "$R2" add -A && git -C "$R2" commit -q -m "harmless comment in bin/checker.sh"

OUT2="$(bash "$SCRIPT" --base "$BASE2" --repo-root "$R2" 2>&1)"; RC2=$?
[ "$RC2" -eq 0 ] || fail "scenario2 (sensitive touch, base tests still pass) expected PASS(0), got rc=$RC2: $OUT2"
printf '%s' "$OUT2" | grep -q "PASS" || fail "scenario2 must report PASS: $OUT2"

# ==== scenario 3 (the core case): the PR breaks bin/checker.sh AND loosens its own test to match
# the broken behaviour in the SAME commit — the new test suite alone would pass trivially, but the
# untouched base test must still catch the regression -> FAIL ====
R3="$(new_base_repo s3)"
BASE3="$(git -C "$R3" rev-parse HEAD)"
cat > "$R3/tools/loop-engine/bin/checker.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$R3/tools/loop-engine/test/checker.test.sh" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HERE/../bin/checker.sh"
bash "$CHECKER" "bad input" || { echo "FAIL: should accept anything now"; exit 1; }
echo "PASS: checker accepts anything (loosened)"
EOF
git -C "$R3" add -A && git -C "$R3" commit -q -m "weaken checker.sh AND loosen its own test to match"

OUT3="$(bash "$SCRIPT" --base "$BASE3" --repo-root "$R3" 2>&1)"; RC3=$?
[ "$RC3" -eq 1 ] \
  || fail "scenario3 (self-weakening PR: bin/ AND its test loosened together) must FAIL(1) — this is the whole point of the mechanism; got rc=$RC3: $OUT3"
printf '%s' "$OUT3" | grep -q "FAIL" || fail "scenario3 must report FAIL: $OUT3"
printf '%s' "$OUT3" | grep -q "bad input must be rejected" \
  || fail "scenario3 FAIL output must show the OLD (pinned) test's own failure message: $OUT3"

# ==== scenario 4: a brand-new HEAD-only test file (didn't exist at base) must be left alone — not
# force-restored from a base where it doesn't exist. It deliberately fails so we can prove it ran
# with its own (unmodified) content, and that no "could not read ... at base" error was raised for it ====
R4="$(new_base_repo s4)"
BASE4="$(git -C "$R4" rev-parse HEAD)"
cat > "$R4/tools/loop-engine/bin/new-thing.sh" <<'EOF'
#!/usr/bin/env bash
echo "new-thing"
EOF
chmod +x "$R4/tools/loop-engine/bin/new-thing.sh"
cat > "$R4/tools/loop-engine/test/new-thing.test.sh" <<'EOF'
#!/usr/bin/env bash
echo "FAIL: new-thing-marker-deliberately-failing"
exit 1
EOF
chmod +x "$R4/tools/loop-engine/test/new-thing.test.sh"
git -C "$R4" add -A && git -C "$R4" commit -q -m "add new-thing.sh + its own new test (absent at base)"

OUT4="$(bash "$SCRIPT" --base "$BASE4" --repo-root "$R4" 2>&1)"; RC4=$?
[ "$RC4" -eq 1 ] \
  || fail "scenario4 (new HEAD-only test must still run, and it deliberately fails) expected rc=1, got rc=$RC4: $OUT4"
printf '%s' "$OUT4" | grep -q "new-thing-marker-deliberately-failing" \
  || fail "scenario4: the new HEAD-only test file must run with its own content (marker must appear): $OUT4"
printf '%s' "$OUT4" | grep -q "could not read" \
  && fail "scenario4: pinning must NOT attempt to restore a test file that is absent at base: $OUT4"

# ==== scenario 5: the PR deletes the base test file OUTRIGHT (instead of loosening it) as a second
# evasion route — the deleted test is restored from base and must still catch the regression -> FAIL ====
R5="$(new_base_repo s5)"
BASE5="$(git -C "$R5" rev-parse HEAD)"
cat > "$R5/tools/loop-engine/bin/checker.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
rm "$R5/tools/loop-engine/test/checker.test.sh"
git -C "$R5" add -A && git -C "$R5" commit -q -m "weaken checker.sh AND delete its base test entirely"

OUT5="$(bash "$SCRIPT" --base "$BASE5" --repo-root "$R5" 2>&1)"; RC5=$?
[ "$RC5" -eq 1 ] \
  || fail "scenario5 (delete the base test to evade detection) must FAIL(1) — the deleted test must be restored and still catch the regression; got rc=$RC5: $OUT5"
printf '%s' "$OUT5" | grep -q "bad input must be rejected" \
  || fail "scenario5: the restored (deleted-then-pinned) test must report its own failure: $OUT5"

# ==== scenario 6: no CODEOWNERS file at all -> PASS(0), nothing declared sensitive ====
R6="$(new_base_repo s6)"
rm "$R6/CODEOWNERS"
git -C "$R6" add -A && git -C "$R6" commit -q -m "fixture setup: remove CODEOWNERS entirely"
BASE6="$(git -C "$R6" rev-parse HEAD)"
cat > "$R6/tools/loop-engine/bin/checker.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
git -C "$R6" add -A && git -C "$R6" commit -q -m "change bin/ with no CODEOWNERS present"

OUT6="$(bash "$SCRIPT" --base "$BASE6" --repo-root "$R6" 2>&1)"; RC6=$?
[ "$RC6" -eq 0 ] || fail "scenario6 (no CODEOWNERS) expected PASS(0), got rc=$RC6: $OUT6"
printf '%s' "$OUT6" | grep -q "no CODEOWNERS sensitive paths" \
  || fail "scenario6 must report the no-CODEOWNERS PASS: $OUT6"

echo "PASS: verifier-pinned-review — skip when nothing sensitive touched, PASS when base tests still hold, FAIL on self-weakening (bin/+test loosened together), new HEAD-only tests left alone, deleted base tests restored and still enforced, and no-CODEOWNERS PASS"
exit 0
