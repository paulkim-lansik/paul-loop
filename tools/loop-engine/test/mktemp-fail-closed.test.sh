#!/usr/bin/env bash
# BAC-755 (ported near-verbatim from glucofit-partners' mktemp-fail-closed.test.sh, BAC-720 — the
# meta-lint is entirely generic and belongs wherever *.test.sh files with mktemp calls live, which is
# now also here).
#
# 배경: bare mktemp가 $TMPDIR를 무시해 샌드박스가 거부하는 기본 임시 디렉토리를 고르면 EPERM으로
# 실패하고(BAC-718), 실패를 아무도 체크하지 않으면 변수가 빈 문자열이 되어 후속 `git -C "$WORK" init`
# 같은 호출이 `-C` 무시로 실제 cwd에서 실행된다(실측 피해: 빈 커밋 4개 생성). 고정:
# tools/loop-engine/test/*.test.sh의 모든 mktemp 호출 지점에 `|| fail "..."`를 붙여 mktemp가 어떤
# 이유로든 실패하면 그 즉시 스크립트가 죽고 이후 명령이 전혀 실행되지 않게 한다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$HERE/$(basename "$0")"

fail() { echo "FAIL: $1"; exit 1; }

# ── 1) wiring sweep: every mktemp call in this directory's other *.test.sh files must be guarded
#      with a trailing `|| fail`/`|| exit`/`|| {`. ───────────────────────────────────────────────
unguarded=""
for f in "$HERE"/*.test.sh; do
  [ "$f" = "$SELF" ] && continue
  while IFS= read -r line; do
    trimmed="${line#"${line%%[! ]*}"}"
    case "$trimmed" in
      '#'*) continue ;;
    esac
    case "$line" in
      *'mktemp'*'|| fail'*|*'mktemp'*'|| exit'*|*'mktemp'*'|| {'*) ;;
      *) unguarded="$unguarded  $(basename "$f"): $line"$'\n' ;;
    esac
  done < <(grep 'mktemp' "$f")
done
[ -z "$unguarded" ] || fail "unguarded mktemp call(s) — must end with '|| fail ...' on the same line:
$unguarded"
echo "PASS: every mktemp call in tools/loop-engine/test/*.test.sh is guarded against silent failure"

# ── 2) behavioral proof: reproduce a real mktemp -d failure (chmod 000 parent) and confirm the
#      GUARDED idiom aborts before any subsequent command runs — no fake-repo side effect leaks. ───
DENIEDPARENT="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "setup: mktemp -d for the denied-parent fixture failed"
MARKER="$HERE/.mktemp-fail-closed-leak-marker.$$"
trap 'chmod u+rwx "$DENIEDPARENT" 2>/dev/null; rm -rf "$DENIEDPARENT"; rm -f "$MARKER"' EXIT
chmod 000 "$DENIEDPARENT"

rm -f "$MARKER"

(
  set -uo pipefail
  WORK="$(mktemp -d "$DENIEDPARENT/tmp.XXXXXXXX")" || { echo "FAIL: mktemp -d failed"; exit 1; }
  touch "$MARKER"
  git -C "$WORK" init -q -b main
)
RC=$?

[ "$RC" -ne 0 ] || fail "guarded idiom must exit non-zero when mktemp -d fails, got $RC"
[ ! -e "$MARKER" ] || { rm -f "$MARKER"; fail "guard did not stop execution — a side effect ran after the failed mktemp"; }
echo "PASS: mktemp -d failure aborts immediately — no fake-repo side effect leaks into the real cwd"

# ── 3) sanity: the SAME idiom minus the guard DOES leak — proves this test can actually detect the
#      regression it exists to catch, not vacuously green. ─────────────────────────────────────────
rm -f "$MARKER"
(
  set -uo pipefail
  WORK="$(mktemp -d "$DENIEDPARENT/tmp.XXXXXXXX")"
  touch "$MARKER"
)

if [ ! -e "$MARKER" ]; then
  fail "sanity check failed: expected the UNGUARDED idiom to leak (proves this test can detect the original bug) — got no marker, this test may be vacuous"
fi
rm -f "$MARKER"
echo "PASS: sanity — the unguarded (pre-BAC-720) idiom does leak, confirming this test would have caught the original bug"

exit 0
