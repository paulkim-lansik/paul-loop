#!/usr/bin/env bash
# Regression test for lessons.mjs `category` (BAC-498) — engineering/domain tag on the lesson schema.
#
# The lessons memory (Phase 3) had no way to distinguish engineering-process lessons (the ~95 that
# already exist) from domain/product lessons. This locks: (1) read-time default — legacy/missing
# category coerces to 'engineering' with NO migration of existing files, (2) `record --category domain`
# creates/updates the tag, (3) invalid values are rejected (fail closed), (4) `stats`/`recall` can
# filter and `stats` always reports a by-category breakdown.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
L() { node "$LESSONS" "$@" --lessons "$DIR"; }

# 1) record with no --category defaults to engineering.
L record --signature "FAIL: flaky ci runner timed out" --verified --title "ci timeout" >/dev/null \
  || fail "record (no category) failed"
ID1="$(L promote --min-count 1 2>/dev/null | grep -oE '[0-9a-f]{16}' | head -1)"
[ -n "$ID1" ] || fail "could not extract lesson id (no-category record)"
grep -q '"category": "engineering"' "$DIR/$ID1.json" || fail "default category must be 'engineering': $(cat "$DIR/$ID1.json")"

# 2) record with --category domain sets it on creation.
L record --signature "FAIL: dose calculation off by one unit" --verified --title "dose calc" --category domain >/dev/null \
  || fail "record --category domain failed"
ID2="$(L promote --min-count 1 2>/dev/null | grep -oE '[0-9a-f]{16}' | grep -v "^$ID1$" | head -1)"
[ -n "$ID2" ] || fail "could not extract lesson id (domain record)"
grep -q '"category": "domain"' "$DIR/$ID2.json" || fail "explicit category must be 'domain': $(cat "$DIR/$ID2.json")"

# 3) invalid --category value is rejected (usage error, exit 2) — fail closed, no silent garbage value.
rc=0; L record --signature "FAIL: whatever" --category bogus >/dev/null 2>&1 || rc=$?
[ "$rc" = "2" ] || fail "invalid --category must exit 2 (usage error); got rc=$rc"

# 4) a hand-written legacy lesson file (no category field at all, as all ~95 pre-existing lessons are)
#    coerces to 'engineering' on read — no migration required. Exercise this via `stats`.
cat > "$DIR/legacy0000000000000000.json" <<'EOF'
{ "id": "legacy0000000000000000", "signature": ["legacy lesson pre-category"], "title": "legacy lesson",
  "fix": "some old fix", "source": "manual", "verified": true, "count": 5, "iterations": [1],
  "first_seen": "2026-01-01T00:00:00.000Z", "last_seen": "2026-01-01T00:00:00.000Z" }
EOF
SOUT="$(L stats 2>&1)"
# total lessons now: ID1 (engineering) + ID2 (domain) + legacy (coerced engineering) = 3
printf '%s' "$SOUT" | grep -q "by_category: engineering=2 domain=1" || fail "legacy file must coerce to engineering in by_category: $SOUT"

# 5) `stats --category domain` narrows every metric to just the domain subset (1 lesson: ID2).
DOUT="$(L stats --category domain 2>&1)"
printf '%s' "$DOUT" | grep -q "^total=1 " || fail "stats --category domain must narrow total to 1: $DOUT"
printf '%s' "$DOUT" | grep -q "by_category: engineering=2 domain=1" || fail "by_category breakdown must stay full-set regardless of filter: $DOUT"

# 6) `stats --category engineering` narrows to 2 (ID1 + legacy).
EOUT="$(L stats --category engineering 2>&1)"
printf '%s' "$EOUT" | grep -q "^total=2 " || fail "stats --category engineering must narrow total to 2: $EOUT"

# 7) re-recording an EXISTING lesson with --category updates it even WITHOUT --verified (category is a
#    classification tag, not a trust claim about what fixed the failure — not verified-gated).
L record --signature "FAIL: flaky ci runner timed out" --category domain >/dev/null || fail "re-record with --category (unverified) failed"
grep -q '"category": "domain"' "$DIR/$ID1.json" || fail "unverified re-record must still update category: $(cat "$DIR/$ID1.json")"

# 8) `recall --category` filters: after step 7, ID1's signature is now tagged domain, so recalling it
#    with --category engineering must return nothing on stdout (suppressed — a category mismatch now
#    hints on stderr instead, ADR-0062, so this checks stdout only), and --category domain must return it.
OUT_ENG="$(L recall --signature "FAIL: flaky ci runner timed out" --category engineering 2>/dev/null)"
[ -z "$OUT_ENG" ] || fail "recall --category engineering must suppress a now-domain lesson (stdout): $OUT_ENG"
OUT_DOM="$(L recall --signature "FAIL: flaky ci runner timed out" --category domain 2>&1)"
printf '%s' "$OUT_DOM" | grep -q "ci timeout" || fail "recall --category domain must return the now-domain lesson: $OUT_DOM"

echo "PASS: lessons category — read-time default, record create/update, invalid rejected, stats/recall filter+breakdown"
exit 0
