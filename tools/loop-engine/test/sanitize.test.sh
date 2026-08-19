#!/usr/bin/env bash
# Regression test for sanitize.mjs — 루프 기록 경로의 저장 시점 redaction (BAC-628, ouroboros O5).
#
# 루프 기록(.loop 로그·lessons)에 시크릿/장문 payload가 그대로 착지하지 않음을 행위로 증명한다:
# 레코드 blocklist 키 낙하(T1)·장문 트렁케이션(T2)·비파괴 통과(T3)·텍스트 마스킹(T4)·in-place 원자
# 재작성(T5)·privacy 스위치 fail-closed(T6), 그리고 배선 왕복 — verdict-run LOG 원천 살균이 stdout
# FAIL 줄까지 상속됨(T7)·OFF 스위치 관통(T8)·lessons 서명/fix 대칭 살균+키 불변(T9).
# 커밋 시점 gitleaks(ADR-0078 M0)와의 역할 분리는 sanitize.mjs 헤더 주석 참조.
# 주의: 이 파일의 시크릿 모양 문자열은 전부 명백한 더미(hunter2 등) — 실제 포맷(AWS 키 모양) 금지.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
S="$ROOT/tools/loop-engine/lib/sanitize.mjs"
VR="$ROOT/tools/loop-engine/bin/verdict-run.sh"
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$S" ] || fail "sanitize.mjs not found at $S"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# T1: blocklist 키 낙하 — 값은 마커로 치환, 비민감 키는 보존. 케이스/구분자 변형(api_key/API-KEY)도 매치.
OUT="$(printf '{"apiKey":"AKSECRET1","Authorization":"Bearer xyzTOKEN2","payload":{"prompt":"PROMPT3","stdout":"STDOUT4"},"api_key":"AKSECRET5","API-KEY":"AKSECRET6","ok":"keep"}' | node "$S" --record)" || fail "T1: --record exited non-zero"
for leak in AKSECRET1 xyzTOKEN2 PROMPT3 STDOUT4 AKSECRET5 AKSECRET6; do
  printf '%s' "$OUT" | grep -q "$leak" && fail "T1: blocklist key value leaked: $leak in $OUT"
done
printf '%s' "$OUT" | grep -q '\[REDACTED' || fail "T1: redaction marker missing: $OUT"
printf '%s' "$OUT" | grep -q '"ok":"keep"' || fail "T1: non-sensitive key must pass through: $OUT"

# T2: 장문 트렁케이션 — preview 256자 + <truncated len=N sha256=…> 마커, 해시는 실제 sha256 앞 16자.
LONG="$(head -c 300 /dev/zero | tr '\0' 'a')"
OUT="$(printf '{"note":"%s"}' "$LONG" | node "$S" --record)" || fail "T2: --record exited non-zero"
printf '%s' "$OUT" | grep -q '<truncated len=300 sha256=' || fail "T2: truncation marker missing: $OUT"
WANT="$(printf '%s' "$LONG" | shasum -a 256 | cut -c1-16)"
printf '%s' "$OUT" | grep -q "sha256=$WANT" || fail "T2: sha256 prefix mismatch (want $WANT): $OUT"
PREVIEW="$(head -c 256 /dev/zero | tr '\0' 'a')"
printf '%s' "$OUT" | grep -q "\"$PREVIEW<truncated" || fail "T2: preview must be the first 256 chars: $OUT"

# T3: 비파괴 통과 — 시크릿/장문 없는 레코드는 그대로, 재적용해도 불변(멱등).
IN='{"a":"x","n":5,"arr":[1,"two"],"z":null,"b":true}'
OUT1="$(printf '%s' "$IN" | node "$S" --record)" || fail "T3: --record exited non-zero"
[ "$OUT1" = "$IN" ] || fail "T3: clean record must pass through unchanged: $OUT1"
OUT2="$(printf '%s' "$OUT1" | node "$S" --record)"
[ "$OUT2" = "$OUT1" ] || fail "T3: sanitize must be idempotent: $OUT2"

# T4: 텍스트 마스킹 — 시크릿류 key=value·Bearer 값만 마스킹, 비시크릿 진단 줄은 무변형.
TIN="$(printf 'password=hunter2\nAuthorization: Bearer abc.def.ghi\nTests: 3 passed, 3 total')"
TOUT="$(printf '%s' "$TIN" | node "$S" --text)" || fail "T4: --text exited non-zero"
printf '%s' "$TOUT" | grep -q hunter2 && fail "T4: password value leaked: $TOUT"
printf '%s' "$TOUT" | grep -q 'abc\.def\.ghi' && fail "T4: bearer token leaked: $TOUT"
printf '%s' "$TOUT" | grep -q '\[REDACTED\]' || fail "T4: [REDACTED] marker missing: $TOUT"
printf '%s' "$TOUT" | grep -q 'Tests: 3 passed, 3 total' || fail "T4: non-secret diagnostic line must be untouched: $TOUT"

# T5: --in-place 원자 재작성 — 파일이 살균되고 tmp 잔존물이 없다.
printf 'token=tok777\nok line\n' > "$DIR/f.log"
node "$S" --in-place "$DIR/f.log" || fail "T5: --in-place exited non-zero"
grep -q tok777 "$DIR/f.log" && fail "T5: secret survived the in-place rewrite"
grep -q 'ok line' "$DIR/f.log" || fail "T5: non-secret line lost in the rewrite"
ls "$DIR"/f.log.*.tmp >/dev/null 2>&1 && fail "T5: tmp leftover remained"

# T6: privacy 스위치 fail-closed — 미지 값은 여전히 ON(redact), 정확히 '1'만 OFF.
OUT="$(printf 'password=hunter2' | LOOP_SANITIZE_OFF=yes node "$S" --text)"
printf '%s' "$OUT" | grep -q hunter2 && fail "T6: unknown switch value must stay ON (fail-closed): $OUT"
OUT="$(printf 'password=hunter2' | LOOP_SANITIZE_OFF=1 node "$S" --text)"
[ "$OUT" = "password=hunter2" ] || fail "T6: LOOP_SANITIZE_OFF=1 must pass raw text through: $OUT"

# T7: verdict-run 배선 왕복 — LOG가 소비 전 원천 살균되어 stdout FAIL 줄까지 시크릿이 상속되지 않는다.
WK="$DIR/wk"; mkdir -p "$WK"
VOUT="$( (cd "$WK" && "$VR" --log "$DIR/t.log" -- sh -c 'echo password=hunter2; echo "FAILED: token=tok123 boom"; exit 1') )"
rc=$?
[ "$rc" = "1" ] || fail "T7: verdict-run must mirror the FAIL exit (1), got rc=$rc"
grep -q hunter2 "$DIR/t.log" && fail "T7: secret survived in the log"
grep -q tok123 "$DIR/t.log" && fail "T7: token survived in the log"
grep -q '\[REDACTED\]' "$DIR/t.log" || fail "T7: log must carry redaction markers"
printf '%s' "$VOUT" | grep -q tok123 && fail "T7: secret leaked into the VERDICT block: $VOUT"
printf '%s' "$VOUT" | grep -q 'FAIL: .*\[REDACTED\]' || fail "T7: FAIL line must inherit the sanitized log: $VOUT"

# T8: 배선 OFF 스위치 관통 — LOOP_SANITIZE_OFF=1이면 verdict-run이 로그를 건드리지 않는다.
( cd "$WK" && LOOP_SANITIZE_OFF=1 "$VR" --log "$DIR/t8.log" -- sh -c 'echo password=hunter2; exit 1' ) >/dev/null 2>&1
grep -q hunter2 "$DIR/t8.log" || fail "T8: LOOP_SANITIZE_OFF=1 must leave the log raw"

# T9: lessons 대칭 배선 — 저장 JSON에 시크릿 부재 AND 같은 원문 서명 재-record가 같은 키에 적중(count=2).
LDIR="$DIR/ls"
node "$LESSONS" record --signature-file <(printf '%s\n' "FAIL: boom token=abc123xyz") --fix "export PASSWORD=hunterX99 후 재시도" --verified --lessons "$LDIR" >/dev/null || fail "T9: record #1 failed"
grep -rq abc123xyz "$LDIR" && fail "T9: signature secret persisted in the lessons store"
grep -rq hunterX99 "$LDIR" && fail "T9: fix secret persisted in the lessons store"
ROUT="$(node "$LESSONS" record --signature-file <(printf '%s\n' "FAIL: boom token=abc123xyz") --verified --lessons "$LDIR")" || fail "T9: record #2 failed"
printf '%s' "$ROUT" | grep -q 'count=2' || fail "T9: same raw signature must hit the same key (record/recall symmetry): $ROUT"

# T10: 리뷰 회귀 — assertion operand·진단 어휘 보존 (lessons 서명 불변식·loop-fix stall 오탐 방지).
AIN="$(printf "expected 'gf_session' cookie: undefined to be defined\nx rejects when id_token: expired (12 ms)\nError: Authorization: header missing\nSESSION_SECRET: Required")"
AOUT="$(printf '%s' "$AIN" | node "$S" --text)"
[ "$AOUT" = "$AIN" ] || fail "T10: assertion operands / diagnostic vocabulary must survive sanitisation: $AOUT"

# T11: 리뷰 회귀 — JSON 인용 키·URL 내장 자격증명 마스킹 (로그의 최빈 시크릿 착지 모양).
JIN='{"password": "hunter2", "access_token": "eyJabc123"} postgres://app:LEAKPW9@localhost:5433/db'
JOUT="$(printf '%s' "$JIN" | node "$S" --text)"
printf '%s' "$JOUT" | grep -q hunter2 && fail "T11: quoted JSON password leaked: $JOUT"
printf '%s' "$JOUT" | grep -q eyJabc123 && fail "T11: quoted JSON access_token leaked: $JOUT"
printf '%s' "$JOUT" | grep -q LEAKPW9 && fail "T11: URL-embedded credential leaked: $JOUT"
printf '%s' "$JOUT" | grep -q 'postgres://app:\[REDACTED\]@localhost' || fail "T11: URL password must be masked in place: $JOUT"

# T12: 리뷰 회귀 — 미닫힘 따옴표가 줄 경계를 넘어 진단 줄을 삼키지 않는다 + verdict 소비 계약
# (첫 줄 불변 = passthrough 판별, 프레임워크 요약 줄 불변 = 카운트 추출, VERDICT 블록 위조 없음).
MIN="$(printf 'first diagnostic line\nTests: 1 failed, 4 passed, 5 total\ntoken="abc\nFAILED: real assertion here\nlast " line')"
MOUT="$(printf '%s' "$MIN" | node "$S" --text)"
[ "$(printf '%s' "$MOUT" | head -n1)" = "first diagnostic line" ] || fail "T12: first line must be unchanged (passthrough contract): $MOUT"
printf '%s' "$MOUT" | grep -q 'Tests: 1 failed, 4 passed, 5 total' || fail "T12: framework summary line must be unchanged (count extraction): $MOUT"
printf '%s' "$MOUT" | grep -q 'FAILED: real assertion here' || fail "T12: unclosed quote must not swallow following lines: $MOUT"
printf '%s' "$MOUT" | head -n1 | grep -q 'VERDICT' && fail "T12: sanitiser must never fabricate a VERDICT block"

# T13: 리뷰 회귀 — 레코드 계측치 보존: 숫자/불리언/null은 blocklist 키여도 통과, 경계 밖 키
# (input_tokens·token_source·stdout_bytes·promptVersion)는 낙하하지 않는다 (BAC-570 원장 AC 정합).
MIN2='{"token_source":"runtime_usage","input_tokens":1200,"output_tokens":340,"stdout_bytes":88,"promptVersion":3,"token":123,"gate":"verify"}'
MOUT2="$(printf '%s' "$MIN2" | node "$S" --record)"
[ "$MOUT2" = "$MIN2" ] || fail "T13: metric fields must pass through untouched: $MOUT2"
OUT13="$(printf '{"access_token":"eyJleak","client_secret":"cs_leak1","Set-Cookie":"sid=abc"}' | node "$S" --record)"
for leak in eyJleak cs_leak1 sid=abc; do
  printf '%s' "$OUT13" | grep -q "$leak" && fail "T13: boundary matching must still drop real secret keys: $leak in $OUT13"
done

# T14: 배선 fail-closed — 미지 스위치 값(0)도 verdict-run 레벨에서 여전히 살균 (셸 가드 약화 방지).
( cd "$WK" && LOOP_SANITIZE_OFF=0 "$VR" --log "$DIR/t14.log" -- sh -c 'echo password=hunter2; exit 1' ) >/dev/null 2>&1
grep -q hunter2 "$DIR/t14.log" && fail "T14: LOOP_SANITIZE_OFF=0 (unknown value) must still redact at the wiring level"
grep -q '\[REDACTED\]' "$DIR/t14.log" || fail "T14: redaction marker missing under unknown switch value"

# T15: 배선 fail-open — 살균기 실행 불능(node 없는 PATH) 시 경고 발화·원문 유지·exit 불변.
# node가 시스템 경로에 있는 환경에선 시뮬레이션 불가라 건너뛴다(핵심 계약은 T7/T14가 커버).
if ! PATH="/usr/bin:/bin" command -v node >/dev/null 2>&1; then
  ( cd "$WK" && PATH="/usr/bin:/bin" "$VR" --log "$DIR/t15.log" -- sh -c 'echo password=hunter2; exit 1' ) >/dev/null 2>"$DIR/t15.err"
  rc=$?
  [ "$rc" = "1" ] || fail "T15: exit code must mirror the command on redaction failure, got rc=$rc"
  grep -q hunter2 "$DIR/t15.log" || fail "T15: raw log must be kept on redaction failure (fail-open)"
  grep -q 'redaction failed' "$DIR/t15.err" || fail "T15: failure warning must fire on stderr"
fi

# T16: lessons --signature-file 분기(loop-fix 정본 경로)도 살균 대칭 — 저장 JSON에 시크릿 부재.
printf 'FAIL: boom token=sigfileleak77\n' > "$DIR/sig.txt"
node "$LESSONS" record --signature-file "$DIR/sig.txt" --verified --lessons "$DIR/ls2" >/dev/null || fail "T16: record via signature-file failed"
grep -rq sigfileleak77 "$DIR/ls2" && fail "T16: signature-file secret persisted in the lessons store"

echo "PASS: sanitize.mjs — blocklist drop, truncation, pass-through, text masking, in-place atomic rewrite, fail-closed switch, verdict-run + lessons wiring, operand preservation, JSON/URL shapes, metric pass-through, fail-open path"
