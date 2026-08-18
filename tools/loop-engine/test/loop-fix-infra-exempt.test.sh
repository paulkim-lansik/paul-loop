#!/usr/bin/env bash
# Regression test (BAC-626 ②): transient 인프라 실패(docker daemon/port 서명)의 예산 면제 —
# 인프라 서명이 감지된 iteration은 --max-iter를 소모하지 않고 verify를 재시도한다(별도 상한
# --infra-retries, 기본 2). 면제 회차엔 fixer 미스폰·FIRST_VERDICT 미보존(lessons 서명 미오염).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$LOOPFIX" ] || fail "loop-fix.sh not executable at $LOOPFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

# ── case 1: 인프라 실패 2회 → 3회차 PASS. --max-iter 1이어도 면제 재시도로 성공해야 한다 ────
C="$WORK/c1"; mkdir -p "$C"; cd "$C" || fail "cd c1"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
if [ "$n" -le 2 ]; then
  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
  exit 1
fi
echo ok
exit 0
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "case1: expected PASS after exempt infra retries, got exit $code"
n_ex="$(grep -c "iter(exempt)" .loop/history.log || true)"
[ "$n_ex" -eq 2 ] || fail "case1: expected 2 exempt retries in history, got $n_ex"

# ── case 2: 인프라 실패 지속 → --infra-retries 상한이 max-iter보다 먼저 끊는다 + fixer 미스폰 ─
C="$WORK/c2"; mkdir -p "$C"; cd "$C" || fail "cd c2"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Error response from daemon: driver failed programming external connectivity: port is already allocated"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch fixer-ran' --infra-retries 2 --max-iter 10 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case2: expected exit 1 at the infra retry cap, got $code"
grep -q "done: INFRA" .loop/history.log || fail "case2: expected INFRA abort marker in history"
grep -q "MAX-ITER" .loop/history.log && fail "case2: infra cap must abort before max-iter"
[ -e fixer-ran ] && fail "case2: fixer must not be spawned on infra-exempt iterations"

# ── case 3: 인프라→실코드 실패→PASS — lessons 서명(FIRST_VERDICT)이 인프라 문구로 오염 금지 ──
C="$WORK/c3"; mkdir -p "$C"; cd "$C" || fail "cd c3"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
if [ "$n" -eq 1 ]; then
  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
  exit 1
fi
if [ "$n" -eq 2 ]; then
  echo "FAILED src/app.test.ts > real assertion broke"
  exit 1
fi
echo ok
exit 0
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --lessons lessons --max-iter 3 >/dev/null 2>&1
code=$?
[ "$code" -eq 0 ] || fail "case3: expected PASS, got exit $code"
ls lessons/*.json >/dev/null 2>&1 || fail "case3: expected a verified lesson to be recorded"
grep -ril "docker" lessons | grep -q . && fail "case3: lesson signature polluted with infra failure text"

# ── case 4: 인프라 서명 + 러너 실패 마커 공존 → 인프라 아님(코드 실패 — fixer 디스패치) ─────
# 정리용 docker 노이즈가 로그에 섞여도 테스트가 실제로 돌아 실패했으면 면제 금지(3축 리뷰 ②).
C="$WORK/c4"; mkdir -p "$C"; cd "$C" || fail "cd c4"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Error response from daemon: No such container: cleanup-noise"
echo "FAILED src/app.test.ts > real assertion broke"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch fixer-ran' --max-iter 2 >/dev/null 2>&1
grep -q "iter(exempt)" .loop/history.log && fail "case4: runner failure markers present — must NOT be classified as infra"
grep -q "done: INFRA" .loop/history.log && fail "case4: must not abort as INFRA when tests actually ran and failed"
[ -e fixer-ran ] || fail "case4: fixer must be dispatched on a real code failure"

# ── case 5: EADDRINUSE 표준 문구 단독 → 인프라 서명 아님(목록 제외 — 제품 버그 출력과 겹침) ──
C="$WORK/c5"; mkdir -p "$C"; cd "$C" || fail "cd c5"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Error: listen EADDRINUSE: address already in use :::3000"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch fixer-ran' --max-iter 2 >/dev/null 2>&1
grep -q "iter(exempt)" .loop/history.log && fail "case5: EADDRINUSE alone must not be classified as infra"
[ -e fixer-ran ] || fail "case5: fixer must be dispatched"

# ── case 6: --infra-retries off → 분류기 완전 비활성(구 동작 복원 — daemon 서명도 fixer로) ───
C="$WORK/c6"; mkdir -p "$C"; cd "$C" || fail "cd c6"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --fix 'touch fixer-ran' --infra-retries off --max-iter 2 >/dev/null 2>&1
grep -q "iter(exempt)" .loop/history.log && fail "case6: --infra-retries off must disable the classifier"
grep -q "done: INFRA" .loop/history.log && fail "case6: --infra-retries off must never abort as INFRA"
[ -e fixer-ran ] || fail "case6: fixer must be dispatched with the classifier off"

# ── case 7: 면제 경로도 --budget-sec(하드 정지 기준)을 우회하지 못한다 ──────────────────────
C="$WORK/c7"; mkdir -p "$C"; cd "$C" || fail "cd c7"
cat > fake-verify.sh <<'EOF'
#!/bin/sh
sleep 1
echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
exit 1
EOF
"$LOOPFIX" --verify 'sh fake-verify.sh' --infra-retries 99 --budget-sec 1 --max-iter 5 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case7: expected exit 1 on budget, got $code"
grep -q "done: BUDGET" .loop/history.log || fail "case7: infra-exempt retries must still honour --budget-sec"

echo "PASS: infra failures are budget-exempt with their own retry cap, no fixer spawn, no lessons pollution"
exit 0
