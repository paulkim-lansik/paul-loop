#!/usr/bin/env bash
# Regression test (issue #14 adversarial review, CRITICAL bypass #2) for the CODEOWNERS →
# verifier-pinned-review.sh sensitivity scan: the original CODEOWNERS only listed
# /tools/loop-engine/{bin,lib,test}/ as prefixes, so a file placed directly under
# /tools/loop-engine/ itself (or under any OTHER new subdirectory of it) matched no prefix —
# verifier-pinned-review.sh reported touched=0 and silently skipped the pinned-baseline check even
# though that file could be the real verification logic, just relocated.
#
# Two throwaway fixture repos (never the real repo) with identical content, differing only in
# CODEOWNERS: one with the OLD narrow-only prefix list (reproduces the pre-fix miss), one with the
# broad parent entry now shipped in this repo's real CODEOWNERS (proves the fix closes it). Also
# asserts the real CODEOWNERS in THIS repo actually carries the broad entry, so removing it from
# the real file (while leaving this fixture's hardcoded copy alone) still fails the suite.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/verifier-pinned-review.sh"
ROOT="$HERE/../../.."

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$SCRIPT" ] || fail "verifier-pinned-review.sh not found at $SCRIPT"

# ---- 0) the real CODEOWNERS in this repo must actually declare the broad parent entry ----
grep -qE '^/tools/loop-engine/[[:space:]]' "$ROOT/CODEOWNERS" \
  || fail "this repo's CODEOWNERS is missing the broad '/tools/loop-engine/' parent entry that closes the subdirectory-indirection bypass"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$TMP_ROOT"' EXIT

NARROW_OWNERS='/tools/loop-engine/bin/    @test
/tools/loop-engine/lib/    @test
/tools/loop-engine/test/   @test
/.github/workflows/        @test
/CODEOWNERS                @test'

BROAD_OWNERS="$NARROW_OWNERS
/tools/loop-engine/        @test"

# $1 = fixture name, $2 = CODEOWNERS content. Prints the repo path on stdout.
new_repo() {
  d="$TMP_ROOT/repo-$1"
  mkdir -p "$d/tools/loop-engine/bin" "$d/tools/loop-engine/test" "$d/.github/workflows"
  git -C "$d" init -q -b main >/dev/null
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name test
  printf '%s\n' "$2" > "$d/CODEOWNERS"

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

  cat > "$d/tools/loop-engine/bin/checker.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$d/tools/loop-engine/test/checker.test.sh" <<'EOF'
#!/usr/bin/env bash
echo "PASS: trivially passing pinned test"
exit 0
EOF

  chmod +x "$d/tools/loop-engine/test/run.sh" "$d/tools/loop-engine/bin/checker.sh" "$d/tools/loop-engine/test/checker.test.sh"
  git -C "$d" add -A
  git -C "$d" commit -q -m "base"
  echo "$d"
}

# ==== scenario A: OLD narrow-only CODEOWNERS — a file placed directly under tools/loop-engine/
# (not under bin/, lib/, or test/) must NOT be detected as touched. This reproduces the pre-fix
# bug so the contrast in scenario B is meaningful, not incidental. ====
RA="$(new_repo indirA "$NARROW_OWNERS")"
BASEA="$(git -C "$RA" rev-parse HEAD)"
echo 'echo "real verification logic hiding here"' > "$RA/tools/loop-engine/checker-impl.sh"
git -C "$RA" add -A && git -C "$RA" commit -q -m "add verification logic directly under tools/loop-engine/"

OUTA="$(bash "$SCRIPT" --base "$BASEA" --repo-root "$RA" 2>&1)"; RCA=$?
[ "$RCA" -eq 0 ] || fail "scenario A (narrow CODEOWNERS, sanity check) expected PASS(0), got rc=$RCA: $OUTA"
printf '%s\n' "$OUTA" | grep -q "skipping pinned-baseline check" \
  || fail "scenario A sanity check failed: with only the OLD narrow prefixes, a file directly under tools/loop-engine/ was expected to be missed (skip) — if it's now caught even with narrow-only CODEOWNERS, this fixture no longer isolates the fix under test: $OUTA"

# ==== scenario B (the fix): BROAD CODEOWNERS — the same relocation must now be detected as
# touched/sensitive, i.e. the pinned-baseline check must actually run (not skip). ====
RB="$(new_repo indirB "$BROAD_OWNERS")"
BASEB="$(git -C "$RB" rev-parse HEAD)"
echo 'echo "real verification logic hiding here"' > "$RB/tools/loop-engine/checker-impl.sh"
git -C "$RB" add -A && git -C "$RB" commit -q -m "add verification logic directly under tools/loop-engine/"

OUTB="$(bash "$SCRIPT" --base "$BASEB" --repo-root "$RB" 2>&1)"; RCB=$?
printf '%s\n' "$OUTB" | grep -q "skipping pinned-baseline check" \
  && fail "scenario B (broad CODEOWNERS) must NOT skip — a file placed directly under tools/loop-engine/ is verification logic and must be detected as touched: $OUTB"
[ "$RCB" -eq 0 ] || fail "scenario B expected the pinned-baseline check to run and PASS (nothing else broke), got rc=$RCB: $OUTB"
printf '%s\n' "$OUTB" | grep -q "still passes against this PR's new bin/ code" \
  || fail "scenario B: expected evidence the pinned-baseline check actually executed (not just skipped silently): $OUTB"

echo "PASS: codeowners-indirection — a verification-logic file placed directly under tools/loop-engine/ (outside bin/lib/test/) is missed under the old narrow-only CODEOWNERS and correctly detected once the broad parent entry is present"
exit 0
