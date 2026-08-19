#!/usr/bin/env bash
# Regression test (issue #10): FAIL 채널 lesson 기록 — verdict FAIL로 수렴 못 하고 끝나는 경로
# (STALLED/MAX-ITER/BUDGET/TIMEOUT-*/verify-only FAIL)도 --source=loop-fix-fail의 UNVERIFIED
# lesson을 기록해야 한다(성공-only 기록의 학습 신호 유실 방지). 핵심 fail-closed 경계: INFRA와
# PROTECTED-VIOLATION은 코드 실패 시그니처가 아니므로 절대 기록되면 안 된다 — 전부 기록하면
# 인프라 노이즈로 lessons 코퍼스가 오염된다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

lessons_file_count() { ls "$1"/*.json 2>/dev/null | wc -l | tr -d ' '; }

# ── case 1: MAX-ITER로 끝나는 실행 → unverified fail-channel lesson 기록 ────────────────────
C="$WORK/c1"; mkdir -p "$C"; cd "$C" || fail "cd c1"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "FAILED src/example.test.ts > max-iter fail-channel test"
exit 1
EOF
# --stall을 --max-iter보다 크게 둬서 STALLED가 아니라 MAX-ITER로 끝나게 한다(고정 fingerprint여도).
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --max-iter 2 --stall 5 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case1: expected exit 1 via max-iter, got $code"
grep -q "MAX-ITER" .loop/history.log || fail "case1: expected the loop to reach MAX-ITER"
[ "$(lessons_file_count lessons)" -eq 1 ] || fail "case1: expected exactly 1 lesson file recorded"
f="$(ls lessons/*.json)"
grep -q '"source": "loop-fix-fail"' "$f" || fail "case1: expected source=loop-fix-fail"
grep -q '"verified": false' "$f" || fail "case1: expected verified=false (never converged)"

# ── case 2: STALLED로 끝나는 실행 → unverified fail-channel lesson 기록 ─────────────────────
C="$WORK/c2"; mkdir -p "$C"; cd "$C" || fail "cd c2"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Tests  3 failed | 7 passed (10)"
echo "FAILED src/example.test.ts > stalled fail-channel test"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --stall 3 --max-iter 6 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case2: expected exit 1 via STALLED, got $code"
grep -q "STALLED" .loop/history.log || fail "case2: expected the loop to STALL"
[ "$(lessons_file_count lessons)" -eq 1 ] || fail "case2: expected exactly 1 lesson file recorded"
f="$(ls lessons/*.json)"
grep -q '"source": "loop-fix-fail"' "$f" || fail "case2: expected source=loop-fix-fail"
grep -q '"verified": false' "$f" || fail "case2: expected verified=false (never converged)"

# ── case 3: INFRA로 끝나는 실행 → 기록되면 안 된다(fail-closed 핵심 경계) ───────────────────
C="$WORK/c3"; mkdir -p "$C"; cd "$C" || fail "cd c3"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Error response from daemon: driver failed programming external connectivity: port is already allocated"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch fixer-ran' --infra-retries 2 --max-iter 10 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case3: expected exit 1 via INFRA cap, got $code"
grep -q "done: INFRA" .loop/history.log || fail "case3: expected INFRA abort marker"
[ "$(lessons_file_count lessons)" -eq 0 ] || fail "case3: INFRA must NOT record a lesson (infra noise pollution)"

# ── case 4: PROTECTED-VIOLATION으로 끝나는 실행 → 기록되면 안 된다 ─────────────────────────
C="$WORK/c4"; mkdir -p "$C"; cd "$C" || fail "cd c4"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "FAILED src/app.test.ts > protected violation fail-channel test"
exit 1
EOF
echo "original" > guarded.txt
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'echo tampered >> guarded.txt' --protect 'guarded.txt' --max-iter 5 --stall 10 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 3 ] || fail "case4: expected exit 3 via PROTECTED-VIOLATION, got $code"
grep -q "PROTECTED-VIOLATION" .loop/history.log || fail "case4: expected PROTECTED-VIOLATION abort marker"
[ "$(lessons_file_count lessons)" -eq 0 ] || fail "case4: PROTECTED-VIOLATION must NOT record a lesson (fixer misbehavior, not a failure signature)"

# ── case 5: 같은 실패가 나중에 PASS로 수렴하면 기존 fail-channel 레코드가 갱신된다 ──────────
# (count 증가 + verified=false -> true 전환) — record()의 기존 병합 로직이 자연히 처리.
C="$WORK/c5"; mkdir -p "$C"; cd "$C" || fail "cd c5"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
if [ -f fixed ]; then
  echo ok
  exit 0
fi
echo "FAILED src/example.test.ts > count-and-verify fail-channel test"
exit 1
EOF
# 1회차: 절대 수렴 못 함(no-op fix) — MAX-ITER로 끝나며 unverified lesson count=1 기록.
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --max-iter 2 --stall 5 --lessons lessons >/dev/null 2>&1
[ "$(lessons_file_count lessons)" -eq 1 ] || fail "case5: expected exactly 1 lesson after first (unconverged) run"
f1="$(ls lessons/*.json)"
grep -q '"count": 1' "$f1" || fail "case5: expected count=1 after first run"
grep -q '"verified": false' "$f1" || fail "case5: expected verified=false after first run"

# 2회차: 이번엔 fixer가 실제로 "fixed" 마커를 만들어 다음 verify가 PASS한다 — 같은 정규화
# 시그니처(동일 FAIL 문구)라 같은 lesson id로 병합돼야 한다.
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch fixed' --max-iter 3 --stall 5 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "case5: expected PASS on second run, got exit $code"
[ "$(lessons_file_count lessons)" -eq 1 ] || fail "case5: expected still exactly 1 lesson file (same signature, merged)"
f2="$(ls lessons/*.json)"
[ "$f1" = "$f2" ] || fail "case5: expected the SAME lesson id to be reused (same normalized signature)"
grep -q '"count": 2' "$f2" || fail "case5: expected count to increase to 2 after later PASS convergence"
grep -q '"verified": true' "$f2" || fail "case5: expected verified to flip true after later PASS convergence"

# ── case 6: BUDGET로 끝나는 실행 → unverified fail-channel lesson 기록 ─────────────────────
C="$WORK/c6"; mkdir -p "$C"; cd "$C" || fail "cd c6"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
sleep 1
echo "FAILED src/example.test.ts > budget fail-channel test"
exit 1
EOF
# sleep 1 이 iter1에서 이미 --budget-sec 1을 넘겨 STALLED보다 먼저 BUDGET으로 끊긴다
# (infra-exempt.test.sh case 7과 같은 패턴).
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --budget-sec 1 --max-iter 10 --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case6: expected exit 1 via BUDGET, got $code"
grep -q "done: BUDGET" .loop/history.log || fail "case6: expected the loop to hit BUDGET"
[ "$(lessons_file_count lessons)" -eq 1 ] || fail "case6: expected exactly 1 lesson file recorded"
f="$(ls lessons/*.json)"
grep -q '"source": "loop-fix-fail"' "$f" || fail "case6: expected source=loop-fix-fail"
grep -q '"verified": false' "$f" || fail "case6: expected verified=false (never converged)"

# ── case 7: --fix 없는 verify-only 모드 — 첫 FAIL에서 즉시 중단 → unverified lesson 기록 ────
C="$WORK/c7"; mkdir -p "$C"; cd "$C" || fail "cd c7"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "FAILED src/example.test.ts > verify-only fail-channel test"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --lessons lessons >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case7: expected exit 1 via verify-only FAIL, got $code"
grep -q "done: FAIL (verify-only)" .loop/history.log || fail "case7: expected verify-only FAIL marker"
[ "$(lessons_file_count lessons)" -eq 1 ] || fail "case7: expected exactly 1 lesson file recorded"
f="$(ls lessons/*.json)"
grep -q '"source": "loop-fix-fail"' "$f" || fail "case7: expected source=loop-fix-fail"
grep -q '"verified": false' "$f" || fail "case7: expected verified=false (never converged)"

echo "PASS: FAIL-channel lessons recorded on STALLED/MAX-ITER/BUDGET/verify-only-FAIL, withheld on INFRA/PROTECTED-VIOLATION, merged on later convergence"
exit 0
