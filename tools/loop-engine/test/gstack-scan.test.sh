#!/usr/bin/env bash
# Regression test for gstack-scan.mjs (BAC-503, ADR-0065) — scans a gstack learnings.jsonl fixture
# and records domain lesson candidates into the file lesson store, unmodified by lessons.mjs itself.
#
# Locks: (1) verified:true requires BOTH source:"user-stated" AND trusted:true — trusted:true alone
#     (e.g. source:"cross-model") must NOT verify, and fix stays '' (no prose auto-extraction),
# (2) category=domain, source=gstack, signature=[insight] (raw, unnormalized), title=key,
# (3) malformed lines (bad JSON, missing required fields) are skipped, not fatal,
# (4) a repeated skill:key WITHIN the same file (gstack re-emitting a refined insight under the same
#     key, observed in real data) dedupes to the LAST occurrence, not the first,
# (5) dedup ACROSS runs is EXACT on sha256(skill:key) — a re-scan does not touch an existing lesson
#     file (no count bump, no overwrite) even if the fixture line reappears,
# (6) a missing learnings.jsonl is a clean no-op (exit 0), not an error.
# (7) the default gstack-file path is resolved from the repo's basename in a way that is INVARIANT to
#     which linked worktree invoked it (CLAUDE.md §8 requires all work happen in a worktree, whose own
#     basename is NOT the repo name) — `--git-common-dir`, not `--show-toplevel`.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
SCAN="$ROOT/tools/loop-engine/bin/gstack-scan.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$SCAN" ] || fail "gstack-scan.mjs not found at $SCAN"

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
LESSONS="$DIR/lessons"
FIXTURE="$DIR/learnings.jsonl"

idOf() { node -e "console.log(require('crypto').createHash('sha256').update('$1:$2').digest('hex').slice(0,16))"; }

# 1) missing learnings.jsonl is a clean no-op.
OUT_MISSING="$(node "$SCAN" --lessons "$LESSONS" --gstack-file "$DIR/does-not-exist.jsonl" 2>&1)"
rc=$?
[ "$rc" = "0" ] || fail "missing gstack file must exit 0, got rc=$rc"
printf '%s' "$OUT_MISSING" | grep -q "nothing to scan" || fail "missing gstack file must report nothing-to-scan: $OUT_MISSING"
[ ! -d "$LESSONS" ] || fail "missing gstack file must not create the lessons dir"

# 2) fixture: user-stated+trusted, observed+untrusted, cross-model+TRUSTED (must still be unverified —
#    trusted alone is not enough), a within-file duplicate skill:key (refined insight, last must win),
#    a malformed JSON line, and a line missing the required `insight` field.
cat > "$FIXTURE" <<'EOF'
{"skill":"plan-ceo-review","type":"pattern","key":"analysis-layer-as-skill","insight":"Build only instrumentation; make dashboards a periodic skill.","confidence":8,"source":"user-stated","ts":"2026-07-06T19:52:41.170Z","trusted":true}
{"skill":"plan-eng-review","type":"pitfall","key":"slug-mismatch","insight":"remote-slug vs gstack-slug diverge for this repo.","confidence":9,"source":"observed","ts":"2026-07-02T02:46:05.035Z","trusted":false}
{"skill":"design-review","type":"pattern","key":"trusted-but-not-user-stated","insight":"cross-model trusted alone must not verify.","confidence":9,"source":"cross-model","ts":"2026-07-10T00:00:00.000Z","trusted":true}
{"skill":"office-hours","type":"pitfall","key":"dup-in-file","insight":"first version of this insight.","confidence":8,"source":"observed","ts":"2026-07-13T14:00:00.000Z","trusted":false}
{"skill":"office-hours","type":"pitfall","key":"dup-in-file","insight":"refined SECOND version of this insight.","confidence":8,"source":"observed","ts":"2026-07-13T15:00:00.000Z","trusted":false}
not valid json at all
{"skill":"office-hours","type":"pattern","key":"missing-insight-field","confidence":7,"source":"observed","ts":"2026-07-09T08:17:40.621Z","trusted":false}
EOF

OUT1="$(node "$SCAN" --lessons "$LESSONS" --gstack-file "$FIXTURE" 2>&1)"
rc=$?
[ "$rc" = "0" ] || fail "first scan must exit 0, got rc=$rc: $OUT1"
printf '%s' "$OUT1" | grep -q "scanned=7 recorded=4 (verified=1 unverified=3) skipped(existing)=0 dup-in-file=1 malformed=2" \
  || fail "first scan summary mismatch: $OUT1"

ID_TRUSTED="$(idOf plan-ceo-review analysis-layer-as-skill)"
ID_OBSERVED="$(idOf plan-eng-review slug-mismatch)"
ID_CROSSMODEL="$(idOf design-review trusted-but-not-user-stated)"
ID_DUP="$(idOf office-hours dup-in-file)"
[ -f "$LESSONS/$ID_TRUSTED.json" ] || fail "trusted lesson file not written: $LESSONS/$ID_TRUSTED.json"
[ -f "$LESSONS/$ID_OBSERVED.json" ] || fail "observed lesson file not written: $LESSONS/$ID_OBSERVED.json"
[ -f "$LESSONS/$ID_CROSSMODEL.json" ] || fail "cross-model lesson file not written: $LESSONS/$ID_CROSSMODEL.json"
[ -f "$LESSONS/$ID_DUP.json" ] || fail "dup-in-file lesson file not written: $LESSONS/$ID_DUP.json"

grep -q '"verified": true' "$LESSONS/$ID_TRUSTED.json" || fail "user-stated+trusted entry must be verified:true: $(cat "$LESSONS/$ID_TRUSTED.json")"
grep -q '"category": "domain"' "$LESSONS/$ID_TRUSTED.json" || fail "must be category:domain: $(cat "$LESSONS/$ID_TRUSTED.json")"
grep -q '"source": "gstack"' "$LESSONS/$ID_TRUSTED.json" || fail "must be source:gstack: $(cat "$LESSONS/$ID_TRUSTED.json")"
grep -q '"title": "analysis-layer-as-skill"' "$LESSONS/$ID_TRUSTED.json" || fail "title must be the raw key: $(cat "$LESSONS/$ID_TRUSTED.json")"
grep -q '"Build only instrumentation; make dashboards a periodic skill."' "$LESSONS/$ID_TRUSTED.json" || fail "signature must carry the raw insight text unnormalized: $(cat "$LESSONS/$ID_TRUSTED.json")"
grep -q '"count": 1' "$LESSONS/$ID_TRUSTED.json" || fail "new lesson must start count:1: $(cat "$LESSONS/$ID_TRUSTED.json")"
grep -q '"fix": ""' "$LESSONS/$ID_TRUSTED.json" || fail "fix must stay empty (no prose auto-extraction): $(cat "$LESSONS/$ID_TRUSTED.json")"

grep -q '"verified": false' "$LESSONS/$ID_OBSERVED.json" || fail "observed+untrusted entry must be verified:false: $(cat "$LESSONS/$ID_OBSERVED.json")"

# trusted:true ALONE (source != user-stated) must NOT verify — the conjunction, not just one half.
grep -q '"verified": false' "$LESSONS/$ID_CROSSMODEL.json" || fail "trusted:true with source!=user-stated must stay verified:false: $(cat "$LESSONS/$ID_CROSSMODEL.json")"

# within-file duplicate: the LAST occurrence's insight wins, not the first.
grep -q "refined SECOND version" "$LESSONS/$ID_DUP.json" || fail "within-file duplicate must keep the LAST occurrence: $(cat "$LESSONS/$ID_DUP.json")"
grep -q "first version" "$LESSONS/$ID_DUP.json" && fail "within-file duplicate must NOT keep the first (superseded) occurrence: $(cat "$LESSONS/$ID_DUP.json")"

# 3) re-scan the SAME fixture: exact-match dedup means 0 new, all 4 unique ids skipped — no count bump.
OUT2="$(node "$SCAN" --lessons "$LESSONS" --gstack-file "$FIXTURE" 2>&1)"
printf '%s' "$OUT2" | grep -q "scanned=7 recorded=0 (verified=0 unverified=0) skipped(existing)=4 dup-in-file=1 malformed=2" \
  || fail "re-scan summary mismatch (dedup must skip all 4, not re-record): $OUT2"
grep -q '"count": 1' "$LESSONS/$ID_TRUSTED.json" || fail "re-scan must not bump count on an existing lesson: $(cat "$LESSONS/$ID_TRUSTED.json")"

# 4) an existing lesson file under the same id is left byte-for-byte untouched (not just count) —
#    simulate a hand-edited existing lesson (e.g. already challenged/retired) and confirm the scanner
#    never overwrites it, even though the fixture line would compute the same id.
cat > "$LESSONS/$ID_OBSERVED.json" <<EOF
{ "id": "$ID_OBSERVED", "signature": ["hand-edited content, already reviewed"], "title": "custom",
  "fix": "", "source": "gstack", "category": "domain", "verified": false, "count": 7,
  "iterations": [], "first_seen": "2020-01-01T00:00:00.000Z", "last_seen": "2020-01-01T00:00:00.000Z" }
EOF
node "$SCAN" --lessons "$LESSONS" --gstack-file "$FIXTURE" >/dev/null 2>&1
grep -q '"count": 7' "$LESSONS/$ID_OBSERVED.json" || fail "existing lesson file must never be overwritten by a re-scan: $(cat "$LESSONS/$ID_OBSERVED.json")"

# 5) default gstack-file resolution (no --gstack-file) must be INVARIANT to which linked worktree
#    invoked it: a fake repo's basename is "fake-main", a linked worktree of it is named differently
#    ("fake-linked") — the scanner run from inside the linked worktree must still resolve to
#    ~/.gstack/projects/fake-main/learnings.jsonl, not .../fake-linked/... (the bug this test locks:
#    `--show-toplevel` returns the WORKTREE's own path; `--git-common-dir` does not).
FAKE_HOME="$DIR/fake-home"
mkdir -p "$FAKE_HOME"
FAKE_MAIN="$DIR/fake-main"
mkdir -p "$FAKE_MAIN"
git -C "$FAKE_MAIN" init -q
git -C "$FAKE_MAIN" -c user.email=t@t.com -c user.name=t commit -q --allow-empty -m init
git -C "$FAKE_MAIN" worktree add -q "$DIR/fake-linked" -b fake-linked-branch >/dev/null 2>&1 \
  || fail "could not create fake linked worktree for the invariance test"

OUT_WT="$(cd "$DIR/fake-linked" && HOME="$FAKE_HOME" node "$SCAN" --lessons "$DIR/wt-lessons" 2>&1)"
printf '%s' "$OUT_WT" | grep -q "fake-main/learnings.jsonl" \
  || fail "default resolution from a linked worktree must key off the MAIN repo basename (fake-main), got: $OUT_WT"
printf '%s' "$OUT_WT" | grep -q "fake-linked" \
  && fail "default resolution must NOT key off the linked worktree's own basename (fake-linked): $OUT_WT"

echo "PASS: gstack-scan — trust mapping (conjunction, not either half), field mapping, malformed-line skip, within-file dup (last wins), exact-match cross-run dedup (no overwrite), missing-file no-op, worktree-invariant default path"
exit 0
