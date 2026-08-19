#!/usr/bin/env bash
# Regression test (issue #14 adversarial review, CRITICAL bypass #1) for tools/loop-engine/test/run.sh:
# the *.test.sh glob is evaluated once at the top of run.sh, but each file's content is only read
# at execution time via `bash "$t"`. A test file that runs early can overwrite a not-yet-executed
# sibling *.test.sh on disk with always-passing content before run.sh gets around to running that
# sibling — and (pre-fix) run.sh would silently execute whatever content it finds on disk at that
# point, reporting a false pass.
#
# This builds a small throwaway fixture directory (never the real tools/loop-engine/test/) and
# copies the ACTUAL run.sh under test into it verbatim, so a future regression in run.sh's own
# logic is what this test catches — not a reimplementation of it. Two fixture test files:
# "aaa-sabotage" (runs first alphabetically) overwrites its sibling "zzz-victim" on disk with
# always-passing content; "zzz-victim"'s ORIGINAL content deliberately fails, simulating a real
# pinned test that should catch a regression. Without the TOCTOU guard, the overall run falsely
# reports success. With it, run.sh must detect the on-disk tamper and fail that file instead of
# running whatever it now contains.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_SH="$HERE/run.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$RUN_SH" ] || fail "run.sh not found at $RUN_SH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

FIXTURE="$WORK/fixture-test"
mkdir -p "$FIXTURE"
cp "$RUN_SH" "$FIXTURE/run.sh"
chmod +x "$FIXTURE/run.sh"

# "aaa-" sorts before "zzz-" in the glob, so this runs first. It overwrites the sibling victim
# file on disk with always-passing content, then exits 0 itself (the sabotage succeeds from its
# own point of view — this file's own execution is legitimate, it's the side effect that's evil).
cat > "$FIXTURE/aaa-sabotage.test.sh" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'echo "PASS: sabotaged-content-marker"'
  printf '%s\n' 'exit 0'
} > "$HERE/zzz-victim.test.sh"
echo "PASS: sabotage placed"
exit 0
EOF
chmod +x "$FIXTURE/aaa-sabotage.test.sh"

# ORIGINAL content on disk at scan time — deliberately fails, simulating a pinned test that would
# catch a real regression if it actually ran with this content.
cat > "$FIXTURE/zzz-victim.test.sh" <<'EOF'
#!/usr/bin/env bash
echo "FAIL: victim-original-content-marker"
exit 1
EOF
chmod +x "$FIXTURE/zzz-victim.test.sh"

OUT="$(bash "$FIXTURE/run.sh" 2>&1)"; RC=$?

[ "$RC" -ne 0 ] \
  || fail "expected the overall run to FAIL — a sibling tampered with on disk after the scan must not be silently swallowed into a false pass; got rc=0: $OUT"
printf '%s\n' "$OUT" | grep -q "TAMPER DETECTED" \
  || fail "expected a TAMPER DETECTED message for the overwritten sibling: $OUT"
printf '%s\n' "$OUT" | grep -q "zzz-victim.test.sh" \
  || fail "the TAMPER DETECTED message must name the overwritten file: $OUT"
printf '%s\n' "$OUT" | grep -q "sabotaged-content-marker" \
  && fail "the sabotaged (post-scan) content must never actually execute: $OUT"
printf '%s\n' "$OUT" | grep -q "^loop-engine selftest: 1/2 passed$" \
  || fail "expected summary '1/2 passed' (sabotage file legitimately passed, victim counted as a tamper failure): $OUT"

echo "PASS: run.sh detects and fails a sibling *.test.sh file tampered with on disk after the initial scan (TOCTOU)"
exit 0
