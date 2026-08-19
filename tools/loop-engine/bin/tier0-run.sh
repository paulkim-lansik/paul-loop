#!/usr/bin/env bash
# tier0-run.sh — 티어0 스모크 어댑터(#7): eval-gate.mjs의 기존 --target 계약(STDIN=케이스
# `input`, STDOUT/exit code=채점 대상)에 맞춰, 하네스 자기 자신(loop-fix.sh / lessons.mjs)이
# 스펙대로 동작하는지 결정론적으로 검증한다. LLM을 부르지 않는다 — 진짜 "에이전트 런" 시나리오는
# 비싸고 이 이슈의 취지("티어0" = 가장 싼 결정론적 스모크)에도 안 맞는다. 대신 하네스 스크립트들을
# 실제로 실행해 관찰 가능한 계약(exit code · 로그 문구 · 기록된 파일)을 검증한다.
#
# 계약: STDIN으로 시나리오 id 하나를 받아 격리된 임시 워크스페이스에서 실행하고, 결과(하위 명령의
# 실제 exit code + 관련 로그/파일 내용)를 STDOUT에 grep 가능한 형태로 찍는다. 이 스크립트 자신의
# exit code는 "시나리오를 실행할 수 있었는가"만 뜻한다 — 개별 시나리오의 PASS/FAIL 판정은 골든
# 케이스의 assert(contains/not_contains/...)가 위 STDOUT 텍스트를 보고 내린다("EXIT_CODE=N" 같은
# 태그로). 이렇게 하면 "exit 1로 끝나야 한다"(loop-fix)와 "usage error로 exit 2여야 한다"(lessons)
# 를 같은 채점 방식으로 다룰 수 있다. 알려지지 않은 시나리오 id는 실패(exit 1)로 취급한다 — 오타로
# 케이스가 조용히 미실행되는 것을 방지.
#
# Usage: echo "<scenario-id>" | tier0-run.sh
#   (eval-gate.mjs가 case.input을 STDIN으로 넘긴다 — 직접 실행할 땐 위처럼 파이프한다)
#
# bash 3.2 compatible (다른 bin/*.sh와 동일).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOOPFIX="$HERE/loop-fix.sh"
LESSONS_BIN="$HERE/lessons.sh"

SCENARIO="$(cat)"

WORK="$(mktemp -d)" || { echo "tier0-run: mktemp -d failed" >&2; exit 1; }
cleanup() { rm -rf "$WORK" 2>/dev/null; }
trap cleanup EXIT
cd "$WORK" || exit 1

case "$SCENARIO" in

  loop-fix-max-iter)
    # 계약: verify가 항상 FAIL이면 --max-iter를 소진하고 exit 1 + history.log에 "MAX-ITER"로
    # 종료해야 한다(loop-fix.sh의 가장 기본적인 하드 정지 기준 보증).
    "$LOOPFIX" --verify 'exit 1' --fix ':' --max-iter 2 >/dev/null 2>&1
    code=$?
    echo "EXIT_CODE=$code"
    echo "--- history.log ---"
    cat .loop/history.log 2>/dev/null
    echo "--- end history.log ---"
    ;;

  loop-fix-pass-first-try)
    # 계약: verify가 첫 회부터 PASS면 fixer 없이 exit 0 + "SUCCESS in 1 iteration(s)"로 끝나야 한다.
    "$LOOPFIX" --verify 'exit 0' --max-iter 5 >/dev/null 2>&1
    code=$?
    echo "EXIT_CODE=$code"
    echo "--- history.log ---"
    cat .loop/history.log 2>/dev/null
    echo "--- end history.log ---"
    ;;

  loop-fix-verified-lesson-on-success)
    # 계약: verify가 FAIL -> PASS로 수렴하면(loop-fix.sh:372-376, Phase 3), --lessons 디렉터리에
    # verified:true인 lesson 파일이 기록되어야 한다. fixer는 ':'(no-op) — 여기선 verify 자체가
    # 호출 횟수로 상태 전이하는 fixture라 fixer 개입이 불필요하다(다른 loop-fix 테스트와 동일 패턴).
    cat > fake-verify.sh <<'FIXTURE'
#!/bin/sh
n=$(cat n 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n
if [ "$n" -eq 1 ]; then
  echo "FAILED tier0-fixture > first attempt fails on purpose"
  exit 1
fi
echo ok
exit 0
FIXTURE
    "$LOOPFIX" --verify 'sh fake-verify.sh' --fix ':' --lessons lessons --max-iter 3 >/dev/null 2>&1
    code=$?
    echo "EXIT_CODE=$code"
    echo "--- lessons files ---"
    if ls lessons/*.json >/dev/null 2>&1; then
      cat lessons/*.json
    else
      echo "NONE"
    fi
    echo "--- end lessons files ---"
    ;;

  lessons-record-signature-only)
    # 계약(#9 병합 전 현재 동작): lessons record는 --signature만으로(--signature-file 없이,
    # --verified 없이) 성공해야 한다 — record는 서명(signature-file 또는 signature) 존재만 요구
    # 하고 provenance(verified)는 요구하지 않는다(lessons.mjs의 signatureOf()/record 분기).
    # ⚠️ #9("증거 무결성 계약 — lessons record fail-closed")가 병합되면 이 계약이 바뀌어 이 케이스가
    # 깨질 수 있다 — 그때는 #9의 새 계약에 맞춰 이 시나리오와 대응 골든 케이스를 함께 갱신할 것.
    "$LESSONS_BIN" record --signature "tier0 fixture: sample failure text" --lessons lessons > out.txt 2>&1
    code=$?
    echo "EXIT_CODE=$code"
    echo "--- stdout/stderr ---"
    cat out.txt
    echo "--- end stdout/stderr ---"
    ;;

  lessons-record-missing-signature)
    # 계약: --signature-file도 --signature도 없는 record는 usage error로 fail-closed, exit 2여야
    # 한다(lessons.mjs usage()) — 서명 없는 lesson이 조용히 기록되는 일은 없어야 한다.
    "$LESSONS_BIN" record --lessons lessons > out.txt 2>&1
    code=$?
    echo "EXIT_CODE=$code"
    echo "--- stdout/stderr ---"
    cat out.txt
    echo "--- end stdout/stderr ---"
    ;;

  *)
    echo "tier0-run: unknown scenario id: $SCENARIO" >&2
    exit 1
    ;;
esac

exit 0
