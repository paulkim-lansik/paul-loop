#!/usr/bin/env bash
# Regression test for lessons.mjs `retire` — the TERMINAL retire gate (Phase 4).
#
# lessons.mjs has three gates: the verified+recurring FLOOR gates ENTRY to the promotion pool, a recorded
# `challenge --verdict accept` gates EXIT to codification, and `retire` gates RETIREMENT out of the pool
# once a lesson has been folded into a skill/CLAUDE.md. Without this last gate the pool grew monotonically:
# an accepted-and-codified lesson re-surfaced forever (promote listing, --codify re-emit, loop-doctor
# "승격 후보" false-nag). This test locks the retire semantics hermetically (pure bash+node, temp dir):
# fail-closed before accept, retirement from listing/--codify/stats, and content-change re-opening.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
L() { node "$HERE/helpers/lessons-fixture.mjs" "$LESSONS" "$@" --lessons "$DIR"; }

# record the same verified lesson 3× → recurring (count=3), clears the promote floor (min-count 3)
for i in 1 2 3; do
  L record --signature-file <(printf '%s\n' "FAIL: widget exploded at boot") --verified --fix "reboot the widget" --title "widget boot fix" >/dev/null \
    || fail "record #$i failed"
done
ID="$(L promote 2>/dev/null | grep -oE '[0-9a-f]{16}' | head -1)"
[ -n "$ID" ] || fail "could not extract lesson id from promote output"

# 1) retire BEFORE a recorded accept must be REFUSED (fail closed, exit 2) — you cannot retire what was
#    never cleared to codify.
rc=0; L retire --id "$ID" >/dev/null 2>&1 || rc=$?
[ "$rc" = "2" ] || fail "retire before accept must exit 2 (fail closed); got rc=$rc"

# 2) accept, THEN retire succeeds.
L challenge --id "$ID" --verdict accept --reason "verified real" >/dev/null || fail "challenge accept failed"
L retire --id "$ID" --ref "CLAUDE.md#S8" >/dev/null || fail "retire after accept must succeed"

# 3) a retired lesson is RETIRED: the open-candidate listing is empty and reports it as retired.
OUT="$(L promote 2>&1)"
printf '%s' "$OUT" | grep -q "no open recurring" || fail "retired lesson must NOT appear as an open candidate: $OUT"
printf '%s' "$OUT" | grep -q "1 already retired" || fail "promote must report 1 retired: $OUT"

# 4) --codify must NOT re-emit the retired (already-codified) lesson — the double-codification guard.
COUT="$(L promote --codify 2>&1)"
printf '%s' "$COUT" | grep -q "0 candidate(s) cleared" || fail "codify must emit 0 for a retired lesson (no double-codify): $COUT"

# 5) stats exposes retired=1 and open_candidates=0 (what loop-doctor reads for "승격 후보").
SOUT="$(L stats 2>&1)"
printf '%s' "$SOUT" | grep -q "retired=1" || fail "stats must show retired=1: $SOUT"
printf '%s' "$SOUT" | grep -q "open_candidates=0" || fail "stats must show open_candidates=0: $SOUT"

# 6) a CONTENT change (new fix/title on a verified re-record) clears retirement → the lesson re-enters the
#    pool for fresh review (the codified guideline is now stale). Fail closed.
L record --signature-file <(printf '%s\n' "FAIL: widget exploded at boot") --verified --fix "DIFFERENT fix now" --title "widget boot fix v2" >/dev/null \
  || fail "re-record with new content failed"
SOUT2="$(L stats 2>&1)"
printf '%s' "$SOUT2" | grep -q "retired=0" || fail "content change must clear retirement (retired=0): $SOUT2"
printf '%s' "$SOUT2" | grep -q "open_candidates=0" || fail "changed content must earn new independent confirmations: $SOUT2"
for i in 1 2; do L record --signature-file <(printf '%s\n' "FAIL: widget exploded at boot") --verified --fix "DIFFERENT fix now" --title "widget boot fix v2" >/dev/null || fail "fresh v2 confirmation failed"; done
L stats | grep -q "open_candidates=1" || fail "three confirmations of v2 must re-enter promotion"

# 7) a REJECTED recurring lesson is NOT counted as an open candidate — the skeptic decided no, so it is
#    terminal (not actionable), same as retired. loop-doctor's "승격 후보" must not nag about it.
for i in 1 2 3; do
  L record --signature-file <(printf '%s\n' "FAIL: gadget fizzled at shutdown") --verified --title "gadget fix" >/dev/null || fail "record gadget #$i failed"
done
GID="$(L promote 2>/dev/null | grep -oE '^  [0-9a-f]{16}' | tr -d ' ' | grep -v "^$ID$" | head -1)"
[ -n "$GID" ] || fail "could not extract second (gadget) lesson id"
L challenge --id "$GID" --verdict reject --reason "one-off, not reproducible" >/dev/null || fail "challenge reject failed"
SOUT3="$(L stats 2>&1)"
# widget (re-opened in step 6) still counts; gadget (rejected) must NOT → open_candidates stays 1.
printf '%s' "$SOUT3" | grep -q "open_candidates=1" || fail "rejected lesson must not count as open candidate (open_candidates=1): $SOUT3"

# 8) BAC-580 — retired/reject 교훈은 pgvector 회상 계층으로 애초에 졸업(ADD)되지 않고, 이미 졸업된
#    노트는 회수(퇴역→스텁 대체, 기각→soft-delete)된다. loop-memory는 docker pgvector가 필요하지만
#    (verify:loop는 docker 0 원칙) 이 판정은 tools/loop-memory/src/lessons.ts의 순수 함수
#    (readVerifiedLessons/decideLessonReap)라 DB 없이도 실행·검증 가능 — tsx로 직접 불러 확인한다.
TSX="$ROOT/tools/loop-memory/node_modules/.bin/tsx"
LESSONS_TS="$ROOT/tools/loop-memory/src/lessons.ts"
if [ -x "$TSX" ] && [ -f "$LESSONS_TS" ]; then
  BAC580_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
  BAC580_LESSONS_DIR="$BAC580_DIR/lessons"
  mkdir -p "$BAC580_LESSONS_DIR"
  BAC580_PROBE="$BAC580_DIR/probe.mjs"
  cat > "$BAC580_PROBE" <<EOF
import { readVerifiedLessons, decideLessonReap, lessonStub } from '$LESSONS_TS';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backedLesson } from '$ROOT/tools/loop-engine/test/helpers/backed-lesson.mjs';

const dir = '$BAC580_LESSONS_DIR';
writeFileSync(join(dir, 'active.json'), JSON.stringify({ id: 'active', verified: true, title: 'active lesson' }));
writeFileSync(join(dir, 'retired.json'), JSON.stringify({
  id: 'retired', verified: true, title: 'retired lesson',
  retired: { at: '2026-01-01T00:00:00Z', ref: 'CLAUDE.md §8', by: 'test' },
}));
writeFileSync(join(dir, 'rejected.json'), JSON.stringify({
  id: 'rejected', verified: true, title: 'rejected lesson', challenge: { verdict: 'reject' },
}));

// Authoritative fixture files back every positive summary; actual verifier issuance is separate.
for (const id of ['active', 'retired', 'rejected']) {
  const p = join(dir, id + '.json');
  const l = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify(backedLesson(l, dir)));
}

// (a) ADD 대상 필터 — retired/rejected는 애초에 졸업되지 않는다.
const ids = readVerifiedLessons(dir, { root: dir }).map((l) => l.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(['active'])) {
  console.error('FAIL: readVerifiedLessons must exclude retired/rejected, got ' + JSON.stringify(ids));
  process.exit(1);
}

// (b) 회수 결정 — 이미 졸업된 노트는 퇴역→stub, 기각→purge로 회수된다(soft-delete 동기화 패스).
const retiredRec = { id: 'retired', title: 'retired lesson', fix: '', source: 'manual', signature: [],
  verified: true, rejected: false, retired: true, retiredRef: 'CLAUDE.md §8' };
const rejectedRec = { id: 'rejected', title: 'rejected lesson', fix: '', source: 'manual', signature: [],
  verified: true, rejected: true, retired: false, retiredRef: '' };

const stubDecision = decideLessonReap('stale original content', retiredRec);
if (stubDecision.op !== 'stub' || stubDecision.content !== lessonStub(retiredRec, 'CLAUDE.md §8')) {
  console.error('FAIL: retired note must be reaped as stub, got ' + JSON.stringify(stubDecision));
  process.exit(1);
}
const purgeDecision = decideLessonReap('stale original content', rejectedRec);
if (purgeDecision.op !== 'purge') {
  console.error('FAIL: rejected note must be reaped as purge, got ' + JSON.stringify(purgeDecision));
  process.exit(1);
}

// (c) 이미 스텁 상태면 재-UPDATE하지 않는다(멱등) — keep.
const keepDecision = decideLessonReap(stubDecision.content, retiredRec);
if (keepDecision.op !== 'keep') {
  console.error('FAIL: already-stubbed note must be kept (idempotent), got ' + JSON.stringify(keepDecision));
  process.exit(1);
}

console.log('OK');
EOF
  PROBE_OUT="$("$TSX" "$BAC580_PROBE" 2>&1)"
  PROBE_RC=$?
  rm -rf "$BAC580_DIR" "$BAC580_PROBE"
  [ "$PROBE_RC" = "0" ] && printf '%s' "$PROBE_OUT" | grep -q "^OK$" \
    || fail "BAC-580 loop-memory graduation gate: $PROBE_OUT"
  echo "PASS: BAC-580 loop-memory graduation gate (tools/loop-memory)"
else
  # loop-engine-selftest CI job은 순수 bash+node로 pnpm install 없이 돈다(ci.yml 주석) — tsx가
  # 없는 건 회귀가 아니라 그 설계의 정상 결과이므로 hard fail이 아니라 soft-skip으로 처리한다.
  echo "SKIP: BAC-580 probe needs tsx+lessons.ts (tools/loop-memory) — run 'pnpm install' first" >&2
fi

echo "PASS: lessons retire — receipt-bound file lifecycle assertions passed; BAC-580 status reported separately above"
exit 0
