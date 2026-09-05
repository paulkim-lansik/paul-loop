#!/usr/bin/env bash
# Regression test for lessons.mjs corpus hygiene (issue #6, ported from glucofit-partners Linear
# BAC-571): `invalid_at`/`superseded_by` invalidation vs the pre-existing `retired` (right-but-unused),
# `clean_pass_count` (an exit-code-derived counter via the new `mark-clean` command), and promote's
# informational retirement-candidate annotation.
#
# The core fail-closed invariant this locks down: an INVALIDATED lesson (marked WRONG, as opposed to
# `retired` which means right-but-superseded) must never surface from recall (even if verified) nor from
# promote (candidates listing / --codify) nor inflate stats' "open_candidates" (loop-doctor's "승격 후보"
# count) beyond what promote would actually list.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
DIR2="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
DIR3="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR" "$DIR2" "$DIR3"' EXIT
L() { node "$HERE/helpers/lessons-fixture.mjs" "$LESSONS" "$@" --lessons "$DIR"; }
L2() { node "$HERE/helpers/lessons-fixture.mjs" "$LESSONS" "$@" --lessons "$DIR2"; }
L3() { node "$HERE/helpers/lessons-fixture.mjs" "$LESSONS" "$@" --lessons "$DIR3"; }
# extract the 16-hex id from a `promote` listing line naming a specific title (avoids brittle "seen ids"
# bookkeeping — each lesson below gets a unique title instead).
id_for() { # $1 = lessons dir  $2 = title substring
  node "$HERE/helpers/lessons-fixture.mjs" "$LESSONS" promote --min-count 1 --lessons "$1" 2>/dev/null | grep -F "$2" | grep -oE '[0-9a-f]{16}' | head -1
}

# ==== 1) coerce-time hygiene: malformed invalid_at/invalid_reason/superseded_by/invalidated_by/
#         clean_pass_count on a hand-edited/merge-corrupted file must all coerce to safe defaults
#         (fail closed — a non-string invalid_at must NOT be treated as invalidated). ====
cat > "$DIR/aaaa000000000001.json" <<'EOF'
{ "id": "aaaa000000000001", "signature": ["coerce hygiene probe"], "title": "coerce hygiene probe",
  "fix": "", "source": "manual", "category": "engineering", "verified": true, "count": 5,
  "iterations": [], "gate_history": {},
  "invalid_at": true, "invalid_reason": 123, "superseded_by": 456, "invalidated_by": ["x"],
  "clean_pass_count": -3,
  "first_seen": "2026-01-01T00:00:00.000Z", "last_seen": "2026-01-01T00:00:00.000Z" }
EOF
SOUT1="$(L stats 2>&1)"
printf '%s' "$SOUT1" | grep -q "invalidated=0" || fail "malformed (non-string) invalid_at must coerce to NOT invalidated: $SOUT1"
printf '%s' "$SOUT1" | grep -q "^total=1 " || fail "coerce probe must still count as a normal lesson: $SOUT1"
POUT1="$(L promote --min-count 1 --include-unverified 2>&1)"
printf '%s' "$POUT1" | grep -q "coerce hygiene probe" || fail "coerced-clean lesson must still appear as an open candidate: $POUT1"
printf '%s' "$POUT1" | grep -q "RETIREMENT CANDIDATE" && fail "negative clean_pass_count must coerce to 0, not trip the >=5 retirement annotation: $POUT1"

# ==== 2) invalidate: usage errors (fail closed) ====
rc=0; L invalidate >/dev/null 2>&1 || rc=$?
[ "$rc" = "2" ] || fail "invalidate with no --id must exit 2; got rc=$rc"

rc=0; ERR="$(L invalidate --id doesnotexist1234 2>&1 >/dev/null)" || rc=$?
[ "$rc" = "2" ] || fail "invalidate on a nonexistent id must exit 2; got rc=$rc"
printf '%s' "$ERR" | grep -q "no lesson with id doesnotexist1234" || fail "invalidate notfound must name the id: $ERR"

# ==== 3) invalidate: success path sets invalid_at/invalid_reason/invalidated_by, leaves superseded_by
#         empty when --superseded-by is omitted. ====
L record --signature-file <(printf '%s\n' "FAIL: hygiene widget-inv") --verified --title "hygiene lesson widget-inv" >/dev/null || fail "record widget-inv failed"
WID="$(id_for "$DIR" "hygiene lesson widget-inv")"
[ -n "$WID" ] || fail "could not extract widget-inv id"
OUT3="$(L invalidate --id "$WID" --reason "root cause was misattributed" --by "paul" 2>&1)"
rc=$?
[ "$rc" = "0" ] || fail "invalidate success path must exit 0; got rc=$rc: $OUT3"
printf '%s' "$OUT3" | grep -q "invalidated $WID — root cause was misattributed" || fail "invalidate confirmation must name id+reason: $OUT3"
grep -q '"invalid_reason": "root cause was misattributed"' "$DIR/$WID.json" || fail "invalid_reason not persisted: $(cat "$DIR/$WID.json")"
grep -q '"invalidated_by": "paul"' "$DIR/$WID.json" || fail "invalidated_by not persisted: $(cat "$DIR/$WID.json")"
grep -q '"superseded_by": ""' "$DIR/$WID.json" || fail "superseded_by must stay empty when omitted: $(cat "$DIR/$WID.json")"
grep -qE '"invalid_at": "[^"]+"' "$DIR/$WID.json" || fail "invalid_at must be set to a non-empty timestamp: $(cat "$DIR/$WID.json")"
grep -q '"invalid_at": ""' "$DIR/$WID.json" && fail "invalid_at must not be empty after invalidate: $(cat "$DIR/$WID.json")"

# ==== 4) invalidate: --by defaults to "human" when omitted, --reason defaults to "" ====
L record --signature-file <(printf '%s\n' "FAIL: hygiene gadget-inv2") --verified --title "hygiene lesson gadget-inv2" >/dev/null || fail "record gadget-inv2 failed"
GID="$(id_for "$DIR" "hygiene lesson gadget-inv2")"
[ -n "$GID" ] || fail "could not extract gadget-inv2 id"
OUT4="$(L invalidate --id "$GID" 2>&1)"
[ $? = 0 ] || fail "invalidate with no --reason/--by must still succeed: $OUT4"
printf '%s' "$OUT4" | grep -q "invalidated $GID$" || fail "invalidate confirmation with no reason must not append ' — ': $OUT4"
grep -q '"invalidated_by": "human"' "$DIR/$GID.json" || fail "invalidated_by must default to human: $(cat "$DIR/$GID.json")"
grep -q '"invalid_reason": ""' "$DIR/$GID.json" || fail "invalid_reason must default to empty: $(cat "$DIR/$GID.json")"

# ==== 5) invalidate --superseded-by: a dangling (nonexistent) target is refused, fail closed — the
#         lesson being invalidated must NOT be mutated. ====
L record --signature-file <(printf '%s\n' "FAIL: hygiene super-target-missing") --verified --title "hygiene lesson super-target-missing" >/dev/null || fail "record super-target-missing failed"
SID="$(id_for "$DIR" "hygiene lesson super-target-missing")"
[ -n "$SID" ] || fail "could not extract super-target-missing id"
rc=0; ERR5="$(L invalidate --id "$SID" --superseded-by "nonexistentxxxxxx" 2>&1 >/dev/null)" || rc=$?
[ "$rc" = "2" ] || fail "invalidate --superseded-by dangling target must exit 2; got rc=$rc"
printf '%s' "$ERR5" | grep -q "superseded-by target nonexistentxxxxxx does not exist" || fail "must name the missing superseded-by target: $ERR5"
# a fresh (never-invalidated) lesson file has no invalid_at key at all — coerce() only ADDS it as ''
# on read, it isn't persisted until a write happens. A refused invalidate must not trigger that write.
grep -q '"invalid_at"' "$DIR/$SID.json" && fail "a refused invalidate must NOT mutate the lesson (invalid_at key must not appear): $(cat "$DIR/$SID.json")"

# ==== 6) invalidate --superseded-by: an existing target succeeds and is recorded. ====
L record --signature-file <(printf '%s\n' "FAIL: hygiene super-source") --verified --title "hygiene lesson super-source" >/dev/null || fail "record super-source failed"
SUP="$(id_for "$DIR" "hygiene lesson super-source")"
[ -n "$SUP" ] || fail "could not extract super-source id"
L record --signature-file <(printf '%s\n' "FAIL: hygiene super-old") --verified --title "hygiene lesson super-old" >/dev/null || fail "record super-old failed"
OLD="$(id_for "$DIR" "hygiene lesson super-old")"
[ -n "$OLD" ] || fail "could not extract super-old id"
OUT6="$(L invalidate --id "$OLD" --superseded-by "$SUP" --reason "replaced by a newer lesson" 2>&1)"
[ $? = 0 ] || fail "invalidate --superseded-by existing target must succeed: $OUT6"
printf '%s' "$OUT6" | grep -q "superseded by $SUP" || fail "confirmation must name the superseder: $OUT6"
grep -q "\"superseded_by\": \"$SUP\"" "$DIR/$OLD.json" || fail "superseded_by not persisted: $(cat "$DIR/$OLD.json")"

# ==== 7) recall(): an invalidated lesson is NEVER recalled, even though it is verified — checked ahead
#         of the verified check. stdout stays empty/exit 0 (unchanged miss contract); stderr names it
#         INVALIDATED with the reason and the superseded-by pointer. ====
L record --signature-file <(printf '%s\n' "FAIL: hygiene recall superseder") --verified --title "hygiene lesson recall superseder" >/dev/null || fail "record recall superseder failed"
RSUP="$(id_for "$DIR" "hygiene lesson recall superseder")"
[ -n "$RSUP" ] || fail "could not extract recall superseder id"
L record --signature-file <(printf '%s\n' "FAIL: hygiene recall probe") --verified --title "hygiene lesson recall probe" >/dev/null || fail "record recall probe failed"
L invalidate --id "$(id_for "$DIR" "hygiene lesson recall probe")" --reason "stale" --superseded-by "$RSUP" >/dev/null || fail "invalidate recall probe failed"
OUT7="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"; ERR7="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp failed"
L recall --signature "FAIL: hygiene recall probe" >"$OUT7" 2>"$ERR7"
rc=$?
[ "$rc" = "0" ] || fail "recall of an invalidated lesson must still exit 0; got rc=$rc"
[ -s "$OUT7" ] && fail "recall of an invalidated lesson must NOT write to stdout: $(cat "$OUT7")"
grep -q "INVALIDATED" "$ERR7" || fail "recall miss on an invalidated lesson must say INVALIDATED: $(cat "$ERR7")"
grep -q "stale" "$ERR7" || fail "recall INVALIDATED stderr must carry the reason: $(cat "$ERR7")"
grep -q "superseded by $RSUP" "$ERR7" || fail "recall INVALIDATED stderr must name the superseder: $(cat "$ERR7")"
rm -f "$OUT7" "$ERR7"

# ==== 8) mark-clean: usage error when --gate is missing ====
rc=0; L mark-clean >/dev/null 2>&1 || rc=$?
[ "$rc" = "2" ] || fail "mark-clean with no --gate must exit 2; got rc=$rc"

echo "PASS §1-8 (invalidate/recall/coerce hygiene)"

# ================================================================================================
# ==== 9) promote()/stats(): invalidated lessons are excluded from candidates + --codify, counted
#         separately from retired in the excluded-note, and never inflate stats' open_candidates
#         beyond what promote would list — even a PREVIOUSLY-ACCEPTED lesson disappears once
#         invalidated (the safety-critical case: a challenge --verdict accept does NOT protect a
#         lesson later discovered to be wrong). ====
for i in 1 2 3; do L2 record --signature-file <(printf '%s\n' "FAIL: hygiene pool lesson A") --verified --title "hygiene pool lesson A" --gate "pnpm verify" >/dev/null || fail "record pool A #$i failed"; done
LA="$(id_for "$DIR2" "hygiene pool lesson A")"
[ -n "$LA" ] || fail "could not extract pool lesson A id"

for i in 1 2 3; do L2 record --signature-file <(printf '%s\n' "FAIL: hygiene pool lesson B (accept then invalidate)") --verified --title "hygiene pool lesson B (accept then invalidate)" >/dev/null || fail "record pool B #$i failed"; done
LB="$(id_for "$DIR2" "hygiene pool lesson B (accept then invalidate)")"
[ -n "$LB" ] || fail "could not extract pool lesson B id"
L2 challenge --id "$LB" --verdict accept --reason "looked solid at the time" >/dev/null || fail "challenge accept B failed"
L2 invalidate --id "$LB" --reason "later found to be a red herring" >/dev/null || fail "invalidate accepted lesson B failed"

for i in 1 2 3; do L2 record --signature-file <(printf '%s\n' "FAIL: hygiene pool lesson C (retired)") --verified --title "hygiene pool lesson C (retired)" >/dev/null || fail "record pool C #$i failed"; done
LC="$(id_for "$DIR2" "hygiene pool lesson C (retired)")"
[ -n "$LC" ] || fail "could not extract pool lesson C id"
L2 challenge --id "$LC" --verdict accept --reason "real fix" >/dev/null || fail "challenge accept C failed"
L2 retire --id "$LC" --ref "CLAUDE.md#hygiene-test" >/dev/null || fail "retire C failed"

POUT9="$(L2 promote 2>&1)"
printf '%s' "$POUT9" | grep -q "1 already retired, 1 invalidated — excluded" || fail "promote excluded-note must count retired and invalidated separately: $POUT9"
printf '%s' "$POUT9" | grep -q "hygiene pool lesson A" || fail "non-excluded lesson A must still be listed: $POUT9"
printf '%s' "$POUT9" | grep -q "hygiene pool lesson B" && fail "invalidated lesson B must NOT appear in the candidates listing: $POUT9"
printf '%s' "$POUT9" | grep -q "hygiene pool lesson C" && fail "retired lesson C must NOT appear in the candidates listing: $POUT9"

# --codify: B was ACCEPTED before being invalidated — this is the safety-critical assertion. It must
# still be excluded (invalidate overrides a prior accept for codification purposes).
COUT9="$(L2 promote --codify 2>&1)"
printf '%s' "$COUT9" | grep -q "hygiene pool lesson B" && fail "an invalidated (even if previously accepted) lesson must NEVER reach --codify: $COUT9"
printf '%s' "$COUT9" | grep -q "hygiene pool lesson A" && fail "lesson A (never challenged) must not be codified either: $COUT9"

# stats: invalidated=1 (B), retired=1 (C), and open_candidates must NOT count the invalidated B —
# only A is truly open (C is retired, terminal).
SOUT9="$(L2 stats 2>&1)"
printf '%s' "$SOUT9" | grep -q "retired=1 invalidated=1" || fail "stats summary must show retired=1 invalidated=1: $SOUT9"
printf '%s' "$SOUT9" | grep -q "open_candidates=1" || fail "stats open_candidates must exclude the invalidated lesson (only A is open): $SOUT9"

echo "PASS §9 (promote/stats invalidated exclusion, incl. previously-accepted lesson)"

# ================================================================================================
# ==== 10) mark-clean: bumps clean_pass_count only for lessons attributed (gate_history) to --gate,
#          and only if they are NOT invalidated and NOT retired. record()'s fail-recurrence path
#          resets the counter to 0. ====
L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-match-1") --verified --title "hygiene mc lesson-match-1" --gate "pnpm verify" >/dev/null || fail "record mc match-1 failed"
MC1="$(id_for "$DIR3" "hygiene mc lesson-match-1")"
L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-match-2") --verified --title "hygiene mc lesson-match-2" --gate "pnpm verify" >/dev/null || fail "record mc match-2 failed"
MC2="$(id_for "$DIR3" "hygiene mc lesson-match-2")"
L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-other-gate") --verified --title "hygiene mc lesson-other-gate" --gate "pnpm typecheck" >/dev/null || fail "record mc other-gate failed"
MC3="$(id_for "$DIR3" "hygiene mc lesson-other-gate")"
L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-invalidated") --verified --title "hygiene mc lesson-invalidated" --gate "pnpm verify" >/dev/null || fail "record mc invalidated failed"
MC4="$(id_for "$DIR3" "hygiene mc lesson-invalidated")"
L3 invalidate --id "$MC4" --reason "not real" >/dev/null || fail "invalidate mc4 failed"
for i in 1 2 3; do L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-retired") --verified --title "hygiene mc lesson-retired" --gate "pnpm verify" >/dev/null || fail "record mc retired #$i failed"; done
MC5="$(id_for "$DIR3" "hygiene mc lesson-retired")"
L3 challenge --id "$MC5" --verdict accept --reason "real fix" >/dev/null || fail "challenge mc5 failed"
L3 retire --id "$MC5" --ref "CLAUDE.md#hygiene-mc" >/dev/null || fail "retire mc5 failed"

OUT10="$(L3 mark-clean --gate "pnpm verify" 2>&1)"
[ $? = 0 ] || fail "mark-clean must exit 0: $OUT10"
printf '%s' "$OUT10" | grep -q "marked 2 lesson(s) clean for gate pnpm verify" || fail "mark-clean must mark exactly match-1 and match-2 (not other-gate/invalidated/retired): $OUT10"
grep -q '"clean_pass_count": 1' "$DIR3/$MC1.json" || fail "match-1 clean_pass_count must be 1: $(cat "$DIR3/$MC1.json")"
grep -q '"clean_pass_count": 1' "$DIR3/$MC2.json" || fail "match-2 clean_pass_count must be 1: $(cat "$DIR3/$MC2.json")"
# MC3/MC4/MC5 must NOT be marked (still 0, or the key is simply absent — it's only persisted once a
# lesson is written; a never-marked file may still lack the key entirely from `record` alone). Assert
# the negative (no "1") rather than the positive default, since presence of the key isn't guaranteed.
grep -q '"clean_pass_count": 1' "$DIR3/$MC3.json" && fail "other-gate lesson must NOT be marked: $(cat "$DIR3/$MC3.json")"
grep -q '"clean_pass_count": 0' "$DIR3/$MC4.json" || fail "invalidated lesson must NOT be marked even though it matches the gate: $(cat "$DIR3/$MC4.json")"
grep -q '"clean_pass_count": 0' "$DIR3/$MC5.json" || fail "retired lesson must NOT be marked even though it matches the gate: $(cat "$DIR3/$MC5.json")"

# a SECOND clean gate pass accumulates (2), proving this is a genuine counter, not a flag.
L3 mark-clean --gate "pnpm verify" >/dev/null || fail "second mark-clean failed"
grep -q '"clean_pass_count": 2' "$DIR3/$MC1.json" || fail "match-1 clean_pass_count must accumulate to 2: $(cat "$DIR3/$MC1.json")"

# fail-recurrence: match-1 recurs (record called again on the same signature) -> clean_pass_count
# resets to 0, even though the gate history / count keeps growing (a recurrence is NOT stability).
L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-match-1") --verified --title "hygiene mc lesson-match-1" --gate "pnpm verify" >/dev/null || fail "re-record match-1 (recurrence) failed"
grep -q '"clean_pass_count": 0' "$DIR3/$MC1.json" || fail "a recurrence must reset clean_pass_count to 0: $(cat "$DIR3/$MC1.json")"
grep -q '"count": 2' "$DIR3/$MC1.json" || fail "the recurrence must still increment count: $(cat "$DIR3/$MC1.json")"

echo "PASS §10 (mark-clean selective marking + fail-recurrence reset)"

# ================================================================================================
# ==== 11) promote(): the informational RETIREMENT CANDIDATE annotation fires only at
#          clean_pass_count >= CLEAN_RETIRE_THRESHOLD (5), and is purely informational — it does not
#          remove the lesson from the listing or touch invalid_at/retired. ====
for i in 1 2 3; do L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-clean5") --verified --title "hygiene mc lesson-clean5" --gate "pnpm build" >/dev/null || fail "record clean5 #$i failed"; done
for i in 1 2 3 4; do L3 record --signature-file <(printf '%s\n' "FAIL: hygiene mc lesson-clean4") --verified --title "hygiene mc lesson-clean4" --gate "pnpm lint" >/dev/null || fail "record clean4 #$i failed"; done
for i in 1 2 3 4 5; do L3 mark-clean --gate "pnpm build" >/dev/null || fail "mark-clean build #$i failed"; done
for i in 1 2 3 4; do L3 mark-clean --gate "pnpm lint" >/dev/null || fail "mark-clean lint #$i failed"; done

POUT11="$(L3 promote 2>&1)"
printf '%s' "$POUT11" | grep -q "clean_pass_count=5" || fail "clean5 (>=threshold) must be annotated RETIREMENT CANDIDATE: $POUT11"
printf '%s' "$POUT11" | grep -q "clean_pass_count=4" && fail "clean4 (below threshold) must NOT be annotated: $POUT11"
printf '%s' "$POUT11" | grep -q "hygiene mc lesson-clean4" || fail "clean4 must still be listed as an ordinary open candidate: $POUT11"
grep -q '"invalid_at": ""' "$DIR3/$(id_for "$DIR3" "hygiene mc lesson-clean5").json" || fail "the retirement-candidate annotation must be informational only — it must NOT invalidate the lesson"

echo "PASS: lessons hygiene (issue #6) — invalidate/mark-clean commands, coerce-time defaults, recall/promote/codify fail-closed exclusion (incl. previously-accepted lessons), stats open_candidates consistency, retirement-candidate annotation"
exit 0
