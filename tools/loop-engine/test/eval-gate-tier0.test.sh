#!/usr/bin/env bash
# Regression test (#7): eval-gate.mjs가 tier0-run.sh 어댑터와 결합해 하네스 자기 자신(loop-fix.sh /
# lessons.mjs)의 관찰 가능한 계약을 결정론적으로 채점하는지 잠근다. 이 조합이 이슈의 선행조건
# ("골든셋 1회 실행 검증")을 재현 가능하게 만드는 형태다 — LLM 호출 없음(티어0 = 가장 싼 결정론적
# 스모크), pure bash + node, docker 0.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EVAL="$HERE/../bin/eval-gate.mjs"
TIER0RUN="$HERE/../bin/tier0-run.sh"
DATASET="$HERE/../eval/tier0"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$EVAL" ] || fail "eval-gate.mjs not found at $EVAL"
[ -x "$TIER0RUN" ] || fail "tier0-run.sh not executable at $TIER0RUN"
[ -d "$DATASET" ] || fail "tier0 golden dataset dir not found at $DATASET"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

# ── case 1: 전체 골든셋이 PASS로 채점되어야 한다(결정론적 — k=1 기본값으로 충분, LLM 없음) ─────
LOG="$WORK/eval.log"
OUT="$(node "$EVAL" --dataset "$DATASET" --target "bash $TIER0RUN" --log "$LOG" 2>&1)"
code=$?
[ "$code" -eq 0 ] || fail "expected the tier0 golden dataset to PASS, got exit $code:
$OUT"
printf '%s\n' "$OUT" | grep -q '^VERDICT: PASS$' || fail "expected VERDICT: PASS, got:
$OUT"
n_cases="$(find "$DATASET" -name '*.json' | wc -l | tr -d ' ')"
printf '%s\n' "$OUT" | grep -q "cases=$n_cases k=" || fail "expected cases=$n_cases in SUMMARY, got:
$OUT"

# ── case 2: 어댑터 자신 — 알려지지 않은 시나리오 id는 실패해야 한다(오타로 인한 무음 통과 방지) ─
echo "no-such-scenario" | bash "$TIER0RUN" >/dev/null 2>/dev/null
code=$?
[ "$code" -ne 0 ] || fail "expected tier0-run.sh to fail on an unknown scenario id"

echo "PASS: eval-gate + tier0-run.sh compose deterministically over the tier0 golden dataset"
exit 0
