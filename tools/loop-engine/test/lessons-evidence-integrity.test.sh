#!/usr/bin/env bash
# Regression test for lessons.mjs `record` evidence integrity (issue #9, ported from glucofit-partners
# Linear BAC-627).
#
# verdict-run.sh already implements the full-output → LOG(untruncated) evidence contract. The remaining
# gap was `record`: it accepted --verified with a hand-typed --signature string and NO --signature-file
# — i.e. a "verified" lesson backed by no evidence file at all, just whatever text was typed on the
# command line. This locks the fail-closed fix: --verified without --signature-file is a usage error
# (exit 2), while unverified records (no --verified) are unaffected — the constraint applies only to the
# VERIFIED claim, not to record() in general.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
L() { node "$LESSONS" "$@" --lessons "$DIR"; }

# 1) --signature (hand-typed text, no --signature-file) + --verified must be REFUSED — fail closed,
#    exit 2, and the error must name --signature-file so the fix is discoverable.
rc=0; ERR1="$(L record --signature "FAIL: evidence integrity probe" --verified --title "should be refused" 2>&1 >/dev/null)" || rc=$?
[ "$rc" = "2" ] || fail "--signature + --verified (no --signature-file) must exit 2 (fail closed); got rc=$rc"
printf '%s' "$ERR1" | grep -q -- "--signature-file" || fail "refusal must name --signature-file so the fix is discoverable: $ERR1"
# and it must not have written a lesson file at all.
[ -z "$(find "$DIR" -maxdepth 1 -name '*.json' 2>/dev/null)" ] || fail "a refused --verified record must not write a lesson file: $(ls "$DIR")"

# 2) --signature-file + --verified succeeds (real evidence file on disk) — exit 0.
SIGF="$DIR/verdict.txt"
printf 'FAIL: evidence integrity probe\n' > "$SIGF"
OUT2="$(L record --signature-file "$SIGF" --verified --title "backed by a real file" 2>&1)"
rc=$?
[ "$rc" = "0" ] || fail "--signature-file + --verified must succeed; got rc=$rc: $OUT2"
printf '%s' "$OUT2" | grep -q "verified=true" || fail "the successful record must be marked verified: $OUT2"

# 3) --signature (hand-typed) WITHOUT --verified must still be allowed — this constraint is on the
#    VERIFIED claim only, not on record() in general (unverified/self-reported records are unchanged).
OUT3="$(L record --signature "FAIL: unverified hand-typed probe" --title "unverified is fine" 2>&1)"
rc=$?
[ "$rc" = "0" ] || fail "--signature without --verified must still succeed (unverified records unaffected); got rc=$rc: $OUT3"
printf '%s' "$OUT3" | grep -q "verified=false" || fail "an unverified record must report verified=false: $OUT3"

echo "PASS: lessons record evidence integrity (issue #9) — --verified without --signature-file is refused fail-closed, --signature-file + --verified succeeds, unverified hand-typed records are unaffected"
exit 0
