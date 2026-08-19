#!/usr/bin/env bash
# Regression test (issue #14 adversarial review, CRITICAL bypass #3) for verifier-pinned-review.sh:
# it ran `git diff --name-only base...HEAD` without disabling rename detection. If a commit does
# `git mv tools/loop-engine/bin/checker.sh <somewhere-outside-any-sensitive-prefix>` while ALSO
# editing its content (small enough an edit that similarity stays above git's default rename
# threshold), git reports it as a rename and --name-only prints only the NEW path — the old
# sensitive path never appears in the diff output, so the prefix-matching sensitivity scan never
# fires and the pinned-baseline check is silently skipped.
#
# This builds a throwaway fixture repo (never the real repo) reproducing exactly that: `git mv`
# tools/loop-engine/bin/checker.sh to a location outside every sensitive prefix, with a
# ONE-CHARACTER content edit (exit 1 -> exit 0 on the reject branch) chosen specifically to stay
# well above the default ~50% rename-similarity threshold so git auto-detects the rename without
# needing --find-renames. Asserts the old sensitive path is still detected: the pinned-baseline
# check must actually run (not skip) and must FAIL, since the sensitive file the pinned test
# depends on vanished from its watched location.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/verifier-pinned-review.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$SCRIPT" ] || fail "verifier-pinned-review.sh not found at $SCRIPT"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

R="$WORK/repo"
mkdir -p "$R/tools/loop-engine/bin" "$R/tools/loop-engine/test" "$R/.github/workflows"
git -C "$R" init -q -b main >/dev/null
git -C "$R" config user.email test@example.com
git -C "$R" config user.name test

cat > "$R/CODEOWNERS" <<'EOF'
/tools/loop-engine/bin/    @test
/tools/loop-engine/lib/    @test
/tools/loop-engine/test/   @test
/.github/workflows/        @test
/CODEOWNERS                @test
EOF

cat > "$R/tools/loop-engine/test/run.sh" <<'EOF'
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

# The toy "verifier": rejects any input that doesn't contain WIDGET. Sized/worded so a
# one-character edit later keeps similarity well above git's default rename threshold.
cat > "$R/tools/loop-engine/bin/checker.sh" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  *WIDGET*) exit 0 ;;
  *) echo "checker: rejected (no WIDGET)"; exit 1 ;;
esac
EOF

# The pinned baseline test — asserts the reject behaviour, same as the toy verifier's own suite.
cat > "$R/tools/loop-engine/test/checker.test.sh" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HERE/../bin/checker.sh"
bash "$CHECKER" "bad input" && { echo "FAIL: bad input must be rejected"; exit 1; }
bash "$CHECKER" "has WIDGET in it" || { echo "FAIL: WIDGET input must be accepted"; exit 1; }
echo "PASS: checker rejects non-WIDGET input"
EOF

chmod +x "$R/tools/loop-engine/test/run.sh" "$R/tools/loop-engine/bin/checker.sh" "$R/tools/loop-engine/test/checker.test.sh"
git -C "$R" add -A
git -C "$R" commit -q -m "base"
BASE="$(git -C "$R" rev-parse HEAD)"

# `git mv` the sensitive-path verifier out to a location outside every CODEOWNERS prefix, with a
# minimal (one-character) content edit in the SAME commit — small enough that git's default rename
# detection (diff.renames defaults to true; similarity threshold defaults to 50%) auto-detects
# this as a rename rather than a delete+add.
git -C "$R" mv tools/loop-engine/bin/checker.sh relocated-checker.sh
sed -i.bak 's/exit 1$/exit 0/' "$R/relocated-checker.sh" && rm -f "$R/relocated-checker.sh.bak"
git -C "$R" add -A
git -C "$R" commit -q -m "relocate checker.sh outside sensitive prefixes + weaken it"

# Sanity check on the fixture itself: confirm git actually detects this as a rename (i.e. this
# fixture genuinely exercises the bypass and isn't accidentally testing a plain delete+add, which
# --name-only would already handle correctly with no fix needed).
RENAME_CHECK="$(git -C "$R" diff --name-only "${BASE}...HEAD" 2>/dev/null)"
printf '%s\n' "$RENAME_CHECK" | grep -q "tools/loop-engine/bin/checker.sh" \
  && fail "fixture sanity check failed: git's default (rename-detecting) diff already shows the old sensitive path — this fixture no longer reproduces the bypass being regression-tested: $RENAME_CHECK"

OUT="$(bash "$SCRIPT" --base "$BASE" --repo-root "$R" 2>&1)"; RC=$?

printf '%s\n' "$OUT" | grep -q "skipping pinned-baseline check" \
  && fail "the old sensitive path (tools/loop-engine/bin/checker.sh) must still be detected via --no-renames even though it was git-mv'd away in the same commit that edited it: $OUT"
[ "$RC" -eq 1 ] \
  || fail "expected FAIL(1) — the pinned base test depends on a file that no longer exists at its watched location, so the pinned-baseline check must catch it; got rc=$RC: $OUT"
printf '%s\n' "$OUT" | grep -q "broke against this PR's new bin/ code" \
  || fail "expected the pinned-baseline FAIL message confirming the check actually ran: $OUT"

echo "PASS: rename-hides-sensitive-path — git mv'ing a sensitive-path file out while editing its content in the same commit still gets detected via --no-renames"
exit 0
