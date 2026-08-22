#!/usr/bin/env bash
# BAC-754 (ported from glucofit-partners' pr-hygiene.test.sh, originally BAC-629 — ouroboros O7
# 채택). bin/check-pr-hygiene.mjs is entirely synthetic-fixture-testable.
#
# 계약: PR 본문에 트래커 id 참조가 있으면 exit 0, 없으면 exit 1. closing 키워드는 요구하지 않는다
# (Closes #N 없이 그냥 "BAC-123" 텍스트만 있어도 통과해야 함). `--pattern` 없이 실행하면 흔한
# "영문 접두사-숫자" 트래커 관례를 두루 잡는 일반 정규식이 기본 동작한다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../bin/check-pr-hygiene.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "check-pr-hygiene.mjs not found at $CHECK"

# ── 1) 참조 없는 PR 본문 → exit 1 (RED) ──────────────────────────────────────────────────────
OUT_NOREF="$(node "$CHECK" --body "이 PR은 리팩터링입니다. 트래킹 이슈 참조 없음." --json)"; rc=$?
[ "$rc" = "1" ] || fail "no-reference PR body must exit 1, got $rc: $OUT_NOREF"
node -e '
  const r = JSON.parse(process.argv[1]);
  if (r.ok !== false) throw new Error("expected ok:false, got " + JSON.stringify(r));
  if (r.matched !== null) throw new Error("expected matched:null, got " + JSON.stringify(r));
' "$OUT_NOREF" || fail "no-reference JSON shape wrong"
echo "PASS: PR body with no tracker reference exits 1"

# ── 2) BAC-* 참조 있는 PR 본문 → exit 0 (GREEN, 기본 패턴) ─────────────────────────────────────
OUT_BAC="$(node "$CHECK" --body "이 PR은 BAC-629를 구현합니다." --json)"; rc=$?
[ "$rc" = "0" ] || fail "BAC-* reference must exit 0, got $rc: $OUT_BAC"
node -e '
  const r = JSON.parse(process.argv[1]);
  if (r.ok !== true) throw new Error("expected ok:true, got " + JSON.stringify(r));
  if (r.matched !== "BAC-629") throw new Error("expected matched:BAC-629, got " + JSON.stringify(r));
' "$OUT_BAC" || fail "BAC-* JSON shape wrong"
echo "PASS: PR body referencing BAC-629 exits 0 (default pattern)"

# ── 3) PRO-* 참조 있는 PR 본문 → exit 0 (GREEN, 다른 프리픽스도 기본 패턴이 잡는다) ─────────────
OUT_PRO="$(node "$CHECK" --body "관련: PRO-1234" --json)"; rc=$?
[ "$rc" = "0" ] || fail "PRO-* reference must exit 0, got $rc: $OUT_PRO"
echo "PASS: PR body referencing PRO-1234 exits 0 (default pattern isn't tied to one prefix)"

# ── 3b) 소문자/대소문자 혼용 참조도 통과(대소문자는 취지와 무관 — 참조 존재만 본다) ────────────────
OUT_LOWER="$(node "$CHECK" --body "fixes bac-42 eventually" --json)"; rc=$?
[ "$rc" = "0" ] || fail "lowercase bac-* reference must exit 0, got $rc: $OUT_LOWER"
echo "PASS: lowercase reference (bac-42) still exits 0 (case-insensitive by design)"

# ── 4) closing 키워드 없이 참조만 있어도 통과 (자동 close 오발 방지 설계 확인) ──────────────────
OUT_PLAIN="$(node "$CHECK" --body "no closing keyword, just BAC-1 mentioned mid-sentence" --json)"; rc=$?
[ "$rc" = "0" ] || fail "plain mention without closing keyword must exit 0, got $rc"
echo "PASS: reference without a closing keyword (Closes/Fixes) still passes"

# ── 5) 빈 본문 → exit 1 ──────────────────────────────────────────────────────────────────────
OUT_EMPTY="$(node "$CHECK" --body "" --json)"; rc=$?
[ "$rc" = "1" ] || fail "empty PR body must exit 1, got $rc"
echo "PASS: empty PR body exits 1"

# ── 6) --body-file 입력 경로도 동작 ──────────────────────────────────────────────────────────
DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
printf 'fixes BAC-42 eventually' > "$DIR/body.txt"
OUT_FILE="$(node "$CHECK" --body-file "$DIR/body.txt" --json)"; rc=$?
[ "$rc" = "0" ] || fail "--body-file with reference must exit 0, got $rc"
echo "PASS: --body-file input path works"

# ── 7) --pattern으로 소비 레포별 트래커 id 패턴을 주입할 수 있다 (BAC-754) ─────────────────────
# 기본 패턴이 잡지 않는 형태(예: 순수 숫자 이슈 #123)를 --pattern으로 인식시킬 수 있는지 확인.
OUT_CUSTOM="$(node "$CHECK" --body "closes #123" --pattern '#\d+' --json)"; rc=$?
[ "$rc" = "0" ] || fail "--pattern override matching #123 must exit 0, got $rc: $OUT_CUSTOM"
node -e '
  const r = JSON.parse(process.argv[1]);
  if (r.matched !== "#123") throw new Error("expected matched:#123, got " + JSON.stringify(r));
' "$OUT_CUSTOM" || fail "--pattern override JSON shape wrong"
echo "PASS: --pattern overrides the default regex with a consumer-repo-specific tracker id pattern"

OUT_CUSTOM_MISS="$(node "$CHECK" --body "references BAC-42 only" --pattern '#\d+' --json)"; rc=$?
[ "$rc" = "1" ] || fail "--pattern override must not fall back to the default pattern, got $rc: $OUT_CUSTOM_MISS"
echo "PASS: --pattern override fully replaces the default (BAC-42 doesn't match a #\\d+-only pattern)"

exit 0
