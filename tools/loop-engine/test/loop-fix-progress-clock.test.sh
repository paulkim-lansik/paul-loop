#!/usr/bin/env bash
# Regression test (BAC-626 ③): material-progress 이원 시계 — BAC-570 런 이벤트 원장을 소스로
# "활동(아무 이벤트)"과 "실질 진전(새 verdict.* 이벤트)"을 분리한 idle/no-progress 이중 타임아웃.
# 기본 0=off(완전 opt-in). 방향은 보수적이어야 한다: 원장 이상(부재·정체·파손 포인터)은 타임아웃
# 발화(중단) 쪽으로 떨어진다 — 원장이 루프를 살리는 경로는 없다(run-ledger.mjs 신뢰 경계 참조).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

# ── case 1: 원장 이상(파손 current 포인터 → unknown 강등 + 원장 부재) + hung verify →
#            idle 타임아웃이 verify "프로세스 트리 전체"를 죽이고 중단한다(보수 방향: 원장 이상
#            = 발화). 직계(래퍼)만 죽이면 hung verify 본체가 고아로 살아남아 CPU·로그 fd를 계속
#            쥔다 — 손자 프로세스 사망까지 단언한다(3축 리뷰 ③). ─────────────────────────────
C="$WORK/c1"; mkdir -p "$C"; cd "$C" || fail "cd c1"
mkdir -p .loop/runs
printf '../evil\n' > .loop/runs/current
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo $$ > vpid
exec sleep 30
EOF
t0="$(date +%s)"
"$LOOPFIX" --verify 'sh fake-verify.sh' --idle-timeout-sec 2 --max-iter 1 >/dev/null 2>&1
code=$?
t1="$(date +%s)"
[ "$code" -eq 1 ] || fail "case1: expected exit 1 on idle timeout, got $code"
[ $((t1 - t0)) -lt 20 ] || fail "case1: watchdog did not kill the hung verify in time ($((t1 - t0))s)"
grep -q "TIMEOUT-IDLE" .loop/history.log || fail "case1: expected TIMEOUT-IDLE in history"
grep -q "runs/unknown.jsonl" .loop/history.log || fail "case1: corrupt current pointer must demote to the unknown bucket"
vp="$(cat vpid 2>/dev/null)"
sleep 1
if [ -n "$vp" ] && kill -0 "$vp" 2>/dev/null; then
  kill -KILL "$vp" 2>/dev/null   # 테스트 잔존물 정리 후 실패 보고
  fail "case1: the hung verify process (pid $vp) survived the watchdog as an orphan"
fi

# ── case 2: 활동은 있으나(비진전 이벤트 append) 진전 이벤트 0 → no-progress 발화, idle은 침묵 ─
C="$WORK/c2"; mkdir -p "$C"; cd "$C" || fail "cd c2"
L="$C/ledger.jsonl"; : > "$L"
( i=0; while [ $i -lt 40 ]; do echo '{"type":"subagent.started"}' >> "$L"; sleep 0.5; i=$((i + 1)); done ) &
APP=$!
LOOP_RUN_LEDGER="$L" "$LOOPFIX" --verify 'sleep 30' --idle-timeout-sec 15 --progress-timeout-sec 2 --max-iter 1 >/dev/null 2>&1
code=$?
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null || true
[ "$code" -eq 1 ] || fail "case2: expected exit 1 on no-progress timeout, got $code"
grep -q "TIMEOUT-NO-PROGRESS" .loop/history.log || fail "case2: activity without progress must fire the progress clock"
grep -q "TIMEOUT-IDLE" .loop/history.log && fail "case2: idle clock must not fire while the ledger has activity"

# ── case 3: 진전 이벤트(새 verdict — FAIL도 실질 진전)가 주기적으로 붙으면 생존, 정상 PASS ───
C="$WORK/c3"; mkdir -p "$C"; cd "$C" || fail "cd c3"
L="$C/ledger.jsonl"; : > "$L"
( i=0; while [ $i -lt 20 ]; do echo '{"type":"verdict.failed"}' >> "$L"; sleep 1; i=$((i + 1)); done ) &
APP=$!
# timeout 6s vs append 간격 1s — 부하 걸린 머신에서 append가 수 초 지연돼도 건강 시나리오가
# 오발화하지 않게 마진을 둔다(3축 리뷰: 3배 마진은 flaky).
LOOP_RUN_LEDGER="$L" "$LOOPFIX" --verify 'sleep 6; echo ok' --progress-timeout-sec 6 --max-iter 1 >/dev/null 2>&1
code=$?
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null || true
[ "$code" -eq 0 ] || fail "case3: progress events must keep the loop alive to a real PASS, got exit $code"
grep -q "TIMEOUT" .loop/history.log && fail "case3: watchdog fired despite material progress"

# ── case 4: 기본 off — 플래그 없으면 워치독 미기동(파일·로그 흔적 0) ─────────────────────────
C="$WORK/c4"; mkdir -p "$C"; cd "$C" || fail "cd c4"
"$LOOPFIX" --verify 'echo ok' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "case4: expected PASS, got $code"
[ -e .loop/watchdog-fired ] && fail "case4: watchdog must be off by default (fired flag present)"
grep -q "watchdog:" .loop/history.log && fail "case4: watchdog must be off by default (history mentions it)"

# ── case 5: 실제 생산 체인 통합(합성 seam 없음) — verdict-run write_state가 append하는
#            verdict.failed 이벤트가 progress 시계를 살린다. 이벤트 type명(verdict.passed/failed)
#            이 워치독 PROGRESS_RE와 별개 파일에 사는 암묵 계약이라, 이 케이스가 type명 드리프트
#            가짜 그린을 막는다(3축 리뷰 ③). ────────────────────────────────────────────────
C="$WORK/c5"; mkdir -p "$C"; cd "$C" || fail "cd c5"
mkdir -p .loop/runs
printf 'itest\n' > .loop/runs/current
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
echo "FAILED case $n"
exit 1
EOF
env -u VERDICT_RUN_LEDGER_NESTED "$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' \
  --progress-timeout-sec 10 --stall 99 --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case5: expected exit 1 via max-iter, got $code"
grep -q "MAX-ITER" .loop/history.log || fail "case5: a healthy loop on the real ledger chain must survive to MAX-ITER"
grep -q "TIMEOUT" .loop/history.log && fail "case5: watchdog fired despite real verdict events"
n_ev="$(grep -c '"type":"verdict.failed"' .loop/runs/itest.jsonl 2>/dev/null || true)"
[ "$n_ev" -ge 3 ] || fail "case5: expected >=3 verdict.failed events in the real ledger, got ${n_ev:-0}"

# ── case 6: 중첩 래퍼 아래(원장 append 억제) → 워치독 기동 시 경고 1줄(원인 가시화) ──────────
C="$WORK/c6"; mkdir -p "$C"; cd "$C" || fail "cd c6"
VERDICT_RUN_LEDGER_NESTED=1 "$LOOPFIX" --verify 'echo ok' --idle-timeout-sec 60 --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "case6: expected PASS, got $code"
grep -q "watchdog: warning" .loop/history.log || fail "case6: nested wrapper must leave a warning about suppressed ledger appends"

echo "PASS: material-progress dual clock — idle/no-progress fire conservatively, progress keeps it alive, default off"
exit 0
