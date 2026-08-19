#!/usr/bin/env bash
# Regression test (issue #14 adversarial review, CRITICAL bypass #1) for tools/loop-engine/test/run.sh:
# the *.test.sh glob is evaluated once at the top of run.sh, but (pre-fix) each file's content was
# only read at execution time via `bash "$t"`. A test file that runs early could overwrite a
# not-yet-executed sibling *.test.sh on disk with always-passing content before run.sh got around
# to running that sibling — and run.sh would silently execute whatever content it finds on disk at
# that point, reporting a false pass.
#
# The current fix (round 2, see run.sh's own comment) reads every file's content into memory in a
# pass that completes for all files before any test executes, then runs each file from that
# captured in-memory string via `bash -c`, never reopening the path. This means a sibling's
# on-disk overwrite has zero effect on what actually runs — not because it gets "detected", but
# because the runner never looks at the file again after its one, upfront read. This test proves
# that property: the victim's ORIGINAL content is what actually executes (its own real failure
# marker shows up), the sabotaged content that lands on disk afterward never runs, and the overall
# tally reflects the victim's true, original result.
#
# This builds a small throwaway fixture directory (never the real tools/loop-engine/test/) and
# copies the ACTUAL run.sh under test into it verbatim, so a future regression in run.sh's own
# logic is what this test catches — not a reimplementation of it. The content is read via
# `git show HEAD:...` rather than the live sibling path ($HERE/run.sh): during a pinned-baseline
# run (verifier-pinned-review.sh), run.sh is a pre-existing file at the PR's base that this test's
# own PR modifies, so the pinning mechanism restores the on-disk sibling to its OLD base content
# for the duration of that run — reading the live path would then test the wrong (old, pre-fix)
# run.sh regardless of what this PR actually changed. `git show HEAD:...` always resolves to this
# PR's own current run.sh, from the git object store, unaffected by what the pinning step does to
# the working tree.
#
# Two fixture test files: "aaa-sabotage" (runs first alphabetically) overwrites its sibling
# "zzz-victim" on disk with always-passing content; "zzz-victim"'s ORIGINAL content deliberately
# fails, simulating a real pinned test that should catch a regression. Without the TOCTOU guard,
# the overall run falsely reports success. With it, run.sh must run zzz-victim's true original
# content (captured before aaa-sabotage ever ran) and report that legitimate failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

fail() { echo "FAIL: $1"; exit 1; }

REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "could not resolve repo root via git from $HERE"
RUN_SH_CONTENT="$(git -C "$REPO_ROOT" show HEAD:tools/loop-engine/test/run.sh 2>/dev/null)" \
  || fail "could not read HEAD:tools/loop-engine/test/run.sh via git show"
[ -n "$RUN_SH_CONTENT" ] || fail "HEAD:tools/loop-engine/test/run.sh via git show came back empty"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

FIXTURE="$WORK/fixture-test"
mkdir -p "$FIXTURE"
printf '%s\n' "$RUN_SH_CONTENT" > "$FIXTURE/run.sh"
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
  || fail "expected the overall run to FAIL — the victim's true original content deliberately fails, and a sibling tampering with it on disk after the scan must not turn that into a false pass; got rc=0: $OUT"
printf '%s\n' "$OUT" | grep -q "victim-original-content-marker" \
  || fail "expected the victim's ORIGINAL (pre-sabotage, captured-before-any-execution) content to actually run: $OUT"
printf '%s\n' "$OUT" | grep -q "sabotaged-content-marker" \
  && fail "the sabotaged (post-scan) content must never actually execute: $OUT"
printf '%s\n' "$OUT" | grep -q "^loop-engine selftest: 1/2 passed$" \
  || fail "expected summary '1/2 passed' (sabotage file legitimately passed, victim's true original content legitimately failed): $OUT"

echo "PASS: run.sh runs each sibling *.test.sh file's content as captured before any test executes, immune to a sibling tampering with it on disk afterward (TOCTOU)"
exit 0
