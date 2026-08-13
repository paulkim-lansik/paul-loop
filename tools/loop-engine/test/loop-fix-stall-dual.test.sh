#!/usr/bin/env bash
# Regression test (BAC-626 ①): 진행-민감 이중신호 stall — 동일 실패 fingerprint(EXIT+FAIL 줄)
# "그리고" pass/fail 카운트 무전진이 둘 다일 때만 STALLED로 중단해야 한다. FAIL 문구가 같아도
# 카운트가 움직이면(10 failed → 3 failed) 진행이므로 stall 카운터는 리셋된다 — 단일신호의
# 조기 포기 오탐 방지(ouroboros O3). 카운트 추출 불가 시 fingerprint 단독 폴백 = 기존 동작 등가.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── case 1: FAIL 문구 동결 + 카운트 전진 → stall하면 안 된다(조기 포기 오탐) ────────────────
# 실전 turbo 병렬 모양 모사: 콜론 없는 vitest3 요약줄("Tests  N failed | M passed")이 tail-60
# 밖에 있어 verdict-run SUMMARY는 빈 값으로 동결되고, FAIL 마커 줄은 회차 불변 — 카운트만 전진.
C="$WORK/c1"; mkdir -p "$C"; cd "$C" || fail "cd c1"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
echo "Tests  $((10 - n)) failed | $n passed (10)"
i=0; while [ $i -lt 70 ]; do echo "noise line $i"; i=$((i + 1)); done
echo "FAILED src/example.test.ts > constant assertion message"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 6 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case1: expected exit 1 via max-iter, got $code"
grep -q "STALLED" .loop/history.log && fail "case1: stalled while pass/fail counts were progressing (single-signal false positive)"
grep -q "MAX-ITER" .loop/history.log || fail "case1: expected the loop to run through to MAX-ITER"

# ── case 2: fingerprint·카운트 모두 동결 → 진짜 stall ──────────────────────────────────────
C="$WORK/c2"; mkdir -p "$C"; cd "$C" || fail "cd c2"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Tests  3 failed | 7 passed (10)"
echo "FAILED src/example.test.ts > frozen assertion"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 6 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case2: expected exit 1, got $code"
grep -q "STALLED" .loop/history.log || fail "case2: frozen fingerprint AND frozen counts must stall"
grep -q "MAX-ITER" .loop/history.log && fail "case2: should have stalled before max-iter"

# ── case 3: 러너 요약줄 없음(카운트 추출 불가) + fingerprint 동결 → 폴백 stall(기존 등가) ───
C="$WORK/c3"; mkdir -p "$C"; cd "$C" || fail "cd c3"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "FAILED src/example.test.ts > no runner summary in this output"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 6 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case3: expected exit 1, got $code"
grep -q "STALLED" .loop/history.log || fail "case3: counts unavailable must fall back to fingerprint-only stall"

# ── case 4: fingerprint가 매 회차 변화 → stall 미발동 ──────────────────────────────────────
C="$WORK/c4"; mkdir -p "$C"; cd "$C" || fail "cd c4"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
echo "FAILED src/example.test.ts > different message $n"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 4 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case4: expected exit 1 via max-iter, got $code"
grep -q "STALLED" .loop/history.log && fail "case4: changing fingerprint must not stall"
grep -q "MAX-ITER" .loop/history.log || fail "case4: expected the loop to reach MAX-ITER"

# ── case 5: TAP 러너(# pass N 전진 + not ok 동결) → SUMMARY 2차 소스로 전진 인지, stall 금지 ─
# 'Tests' 요약줄이 없는 러너군 — 교체 전 sig는 SUMMARY 줄 포함으로 전진을 잡았으므로 이 케이스가
# 없으면 조기-STALL 회귀를 놓친다(3축 리뷰 ①).
C="$WORK/c5"; mkdir -p "$C"; cd "$C" || fail "cd c5"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
echo "not ok 1 - constant failing case"
echo "# pass $n"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 6 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case5: expected exit 1 via max-iter, got $code"
grep -q "STALLED" .loop/history.log && fail "case5: TAP count progress must reset the stall counter (SUMMARY fallback regression)"
grep -q "MAX-ITER" .loop/history.log || fail "case5: expected the loop to reach MAX-ITER"

# ── case 6: passthrough(자체 VERDICT 블록) + SUMMARY 카운트만 전진 → stall 금지 ─────────────
# 실전 `loop-fix --verify 'pnpm verdict'` 모양 — LOG에 내부 VERDICT 블록만 남는 경로.
C="$WORK/c6"; mkdir -p "$C"; cd "$C" || fail "cd c6"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
echo "=== VERDICT ==="
echo "VERDICT: FAIL"
echo "EXIT: 1"
echo "SUMMARY: passed=$n failed=$((10 - n)) skipped= duration_ms=5"
echo "FAIL: constant failing case"
echo "LOG: /dev/null"
echo "=== END VERDICT ==="
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 6 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case6: expected exit 1 via max-iter, got $code"
grep -q "STALLED" .loop/history.log && fail "case6: passthrough SUMMARY count progress must reset the stall counter"
grep -q "MAX-ITER" .loop/history.log || fail "case6: expected the loop to reach MAX-ITER"

echo "PASS: dual-signal stall — count progress resets the stall counter, frozen/fallback cases still stall"
exit 0
