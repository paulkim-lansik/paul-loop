#!/usr/bin/env bash
# Regression test for lessons.mjs `recall` — miss must hint (stderr only, ADR-0062) and `--top` is gone.
#
# ADR-0062 named the two recall mechanisms (signature vs semantic, CONTEXT.md) and closed BAC-543's
# residual gaps: a signature-recall miss was totally silent (no way to tell "no lesson recorded" from
# "wrong query shape"), and `--top N` was a dead flag (0 callers, and a key lookup can only ever return
# one lesson so it never actually truncated anything). This locks both down hermetically (pure
# bash+node, temp dir):
#   - a miss (no lesson recorded, or wrong --category) writes ONE stderr line naming the normalized
#     signature key and pointing hand-written natural-language queries at semantic recall instead — but
#     stdout/exit-code stay exactly as before (loop-fix pipes recall through `2>/dev/null`, so this must
#     never leak into the machine path).
#   - a HIT stays silent on stderr (no noise on the success path).
#   - `--top` is a rejected/unknown flag now (deleted, not renamed — ADR-0062 decision 5).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

node "$LESSONS" record --signature-file <(printf '%s\n' "FAIL: widget exploded at boot") --verified --fix "reboot the widget" --title "widget boot fix" --lessons "$DIR" >/dev/null \
  || fail "record failed"

# 1) HIT: stdout has the lesson, stderr is silent (no noise on the success path).
OUT="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"; ERR="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"
node "$LESSONS" recall --signature "FAIL: widget exploded at boot" --lessons "$DIR" >"$OUT" 2>"$ERR"
rc=$?
[ "$rc" = "0" ] || fail "recall hit must exit 0; got rc=$rc"
grep -q "widget boot fix" "$OUT" || fail "recall hit must print the lesson title: $(cat "$OUT")"
[ -s "$ERR" ] && fail "recall hit must NOT write to stderr: $(cat "$ERR")"
rm -f "$OUT" "$ERR"

# 2) MISS (no lesson for this signature): stdout empty + exit 0 (unchanged contract), stderr has the
#    normalized signature key + a semantic-recall routing hint (ADR-0062).
OUT="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"; ERR="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"
node "$LESSONS" recall --signature "FAIL: gadget fizzled at shutdown" --lessons "$DIR" >"$OUT" 2>"$ERR"
rc=$?
[ "$rc" = "0" ] || fail "recall miss must still exit 0; got rc=$rc"
[ -s "$OUT" ] && fail "recall miss must NOT write to stdout (loop-fix pipes this through unchanged): $(cat "$OUT")"
grep -qE '[0-9a-f]{16}' "$ERR" || fail "recall miss stderr must name the normalized signature key: $(cat "$ERR")"
grep -q "semantic recall" "$ERR" || fail "recall miss stderr must route natural-language queries to semantic recall: $(cat "$ERR")"
rm -f "$OUT" "$ERR"

# 3) MISS via --category mismatch: same silent-stdout/exit-0 contract, stderr names the key + mismatch —
#    but NOT the semantic-recall hint (the signature DID match; this isn't the "wrong store" case above).
OUT="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"; ERR="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"
node "$LESSONS" recall --signature "FAIL: widget exploded at boot" --category domain --lessons "$DIR" >"$OUT" 2>"$ERR"
rc=$?
[ "$rc" = "0" ] || fail "recall category-miss must exit 0; got rc=$rc"
[ -s "$OUT" ] && fail "recall category-miss must NOT write to stdout: $(cat "$OUT")"
grep -qE '[0-9a-f]{16}' "$ERR" || fail "recall category-miss stderr must name the normalized signature key: $(cat "$ERR")"
grep -q "domain" "$ERR" || fail "recall category-miss stderr must name the requested category: $(cat "$ERR")"
grep -q "semantic recall" "$ERR" && fail "recall category-miss must NOT route to semantic recall (the signature matched — this isn't a wrong-store query): $(cat "$ERR")"
rm -f "$OUT" "$ERR"

# 4) `--top` is GONE (deleted, not renamed) — must now be an unknown-arg usage error (exit 2).
rc=0
node "$LESSONS" recall --signature "FAIL: widget exploded at boot" --top 1 --lessons "$DIR" >/dev/null 2>/dev/null || rc=$?
[ "$rc" = "2" ] || fail "recall --top must now be rejected as an unknown arg (exit 2); got rc=$rc"

echo "PASS: lessons recall — miss hints on stderr only (key + semantic-recall routing), hit stays silent, --top removed"
exit 0
