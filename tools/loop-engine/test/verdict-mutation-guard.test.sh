#!/usr/bin/env bash
# Regression test (BAC-626 ④): --guard-mutation(opt-in) — verify 실행 전후 git-가시 상태 digest
# 비교로 "검증이 자기 통과 조건을 만드는" 변조를 verdict FAIL로 뒤집는다. 기본은 off(기존 계약
# 완전 불변), gitignored 경로 쓰기는 오탐 없음(turbo 캐시·.loop 산출물 구조적 제외), 비-git
# 디렉토리는 exit 2 fail-closed(가드 조용히 OFF 금지 — --protect 0매치와 같은 철학).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VR="$HERE/../bin/verdict-run.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$VR" ] || fail "verdict-run.sh not executable at $VR"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

mkrepo() {
  mkdir -p "$1"
  (
    cd "$1" || exit 1
    git init -q .
    git config user.email t@example.com
    git config user.name t
    echo base > tracked.txt
    git add -A
    git commit -qm init
  ) || fail "cannot set up hermetic git repo at $1"
}

# ── case 1: 추적 파일 변조 → VERDICT FAIL + exit 1 + 전용 FAIL 줄 + state 정합 ──────────────
R="$WORK/r1"; mkrepo "$R"; cd "$R" || fail "cd r1"
out="$("$VR" --guard-mutation -- sh -c 'echo x >> tracked.txt' 2>/dev/null)"
code=$?
[ "$code" -eq 1 ] || fail "case1: expected exit 1 on mutation, got $code"
printf '%s\n' "$out" | grep -q "VERDICT: FAIL" || fail "case1: expected VERDICT: FAIL"
printf '%s\n' "$out" | grep -q "workspace mutated" || fail "case1: expected the mutation FAIL line"
grep -q '"verdict":"FAIL"' .loop/verdict-state.json || fail "case1: verdict state must record FAIL (Stop-gate consistency)"

# ── case 1b: 같은 repo에서 무변조 재실행 → 자체 산출물(.loop)로 오탐하지 않는다 ─────────────
out="$("$VR" --guard-mutation -- sh -c 'true' 2>/dev/null)"
code=$?
[ "$code" -eq 0 ] || fail "case1b: clean run after a dirty workspace must PASS (digest is delta-based), got $code"
printf '%s\n' "$out" | grep -q "VERDICT: PASS" || fail "case1b: expected VERDICT: PASS"

# ── case 2: opt-in 증명 — 플래그 없으면 같은 변조도 기존 계약 그대로 PASS ───────────────────
R="$WORK/r2"; mkrepo "$R"; cd "$R" || fail "cd r2"
out="$("$VR" -- sh -c 'echo x >> tracked.txt' 2>/dev/null)"
code=$?
[ "$code" -eq 0 ] || fail "case2: default (no flag) must keep the existing contract, got $code"
printf '%s\n' "$out" | grep -q "VERDICT: PASS" || fail "case2: expected VERDICT: PASS without the flag"

# ── case 3: gitignored 경로 쓰기 → 오탐 없음 ────────────────────────────────────────────────
R="$WORK/r3"; mkrepo "$R"; cd "$R" || fail "cd r3"
printf '.loop/\n' > .gitignore
git add .gitignore
git commit -qm ignore
out="$("$VR" --guard-mutation -- sh -c 'echo log >> .loop/scratch.log' 2>/dev/null)"
code=$?
[ "$code" -eq 0 ] || fail "case3: gitignored writes must not trip the guard, got $code"
printf '%s\n' "$out" | grep -q "VERDICT: PASS" || fail "case3: expected VERDICT: PASS"

# ── case 4: 비-git 디렉토리 + 플래그 → exit 2 fail-closed ───────────────────────────────────
N="$WORK/nogit"; mkdir -p "$N"; cd "$N" || fail "cd nogit"
"$VR" --guard-mutation -- true >/dev/null 2>&1
code=$?
[ "$code" -eq 2 ] || fail "case4: non-git dir must refuse to run (exit 2), got $code"

# ── case 5: 커밋 우회 — 변조 후 git commit으로 status/diff를 clean으로 되돌려도 FAIL ────────
# digest에 HEAD sha가 없으면 이 우회가 PASS로 통과한다(3축 리뷰 ④ 재현 확인 케이스).
R="$WORK/r5"; mkrepo "$R"; cd "$R" || fail "cd r5"
out="$("$VR" --guard-mutation -- sh -c 'echo hacked >> tracked.txt; git commit -qam self-approve' 2>/dev/null)"
code=$?
[ "$code" -eq 1 ] || fail "case5: commit-and-hide bypass must still FAIL, got exit $code"
printf '%s\n' "$out" | grep -q "workspace mutated" || fail "case5: expected the mutation FAIL line"

# ── case 6: 기존 untracked 파일의 내용 재작성 → FAIL (status 줄은 바이트 동일 — 내용 해시) ──
R="$WORK/r6"; mkrepo "$R"; cd "$R" || fail "cd r6"
echo seed > pre-untracked.txt
out="$("$VR" --guard-mutation -- sh -c 'echo cheat > pre-untracked.txt' 2>/dev/null)"
code=$?
[ "$code" -eq 1 ] || fail "case6: rewriting a pre-existing untracked file must FAIL, got exit $code"

# ── case 7: 기존 untracked 디렉토리 안 신규 파일 → FAIL (status는 '?? dir/'로 접힘) ─────────
R="$WORK/r7"; mkrepo "$R"; cd "$R" || fail "cd r7"
mkdir scratchdir; echo a > scratchdir/a.txt
out="$("$VR" --guard-mutation -- sh -c 'echo cheat2 > scratchdir/b.txt' 2>/dev/null)"
code=$?
[ "$code" -eq 1 ] || fail "case7: a new file inside an untracked dir must FAIL, got exit $code"

# ── case 8: passthrough(가짜 PASS 블록 방출) + 변조 → 자체 FAIL 블록 단일 방출 + exit 1 ─────
# 가드가 막으려는 게이밍 벡터의 정면 — 이 분기가 회귀하면 Stop 게이트·loop-fix가 변조된 PASS를
# 소비한다(3축 리뷰 ④).
R="$WORK/r8"; mkrepo "$R"; cd "$R" || fail "cd r8"
cat > emit-pass.sh <<'EOF'
#!/bin/sh
echo "=== VERDICT ==="
echo "VERDICT: PASS"
echo "EXIT: 0"
echo "SUMMARY: passed=1 failed= skipped= duration_ms=1"
echo "LOG: /dev/null"
echo "=== END VERDICT ==="
echo gamed >> tracked.txt
exit 0
EOF
out="$("$VR" --guard-mutation -- sh emit-pass.sh 2>/dev/null)"
code=$?
[ "$code" -eq 1 ] || fail "case8: passthrough with mutation must exit 1, got $code"
n_blk="$(printf '%s\n' "$out" | grep -c '^=== VERDICT ===$')"
[ "$n_blk" -eq 1 ] || fail "case8: exactly one VERDICT block must be emitted, got $n_blk"
printf '%s\n' "$out" | grep -q "VERDICT: FAIL" || fail "case8: expected VERDICT: FAIL"
printf '%s\n' "$out" | grep -q "VERDICT: PASS" && fail "case8: the inner forged PASS block must not be re-emitted"
printf '%s\n' "$out" | grep -q "workspace mutated" || fail "case8: expected the mutation FAIL line"
grep -q '"verdict":"FAIL"' .loop/verdict-state.json || fail "case8: verdict state must record FAIL"

# ── case 9: loop-fix 배선 — --guard-mutation passthrough가 실제로 가드를 켠다(무음 가드-off
#            회귀 방지: 플래그가 조용히 떨어지면 verify는 정상 동작하며 가드만 사라진다) ────────
R="$WORK/r9"; mkrepo "$R"; cd "$R" || fail "cd r9"
LOOPFIX="$HERE/../bin/loop-fix.sh"
"$LOOPFIX" --guard-mutation --verify 'echo x >> tracked.txt' --max-iter 1 >/dev/null 2>&1
code=$?
[ "$code" -eq 1 ] || fail "case9: loop-fix --guard-mutation must surface the mutation FAIL, got exit $code"
grep -q "workspace mutated" .loop/last-verdict.txt || fail "case9: the mutation FAIL line must reach the loop's verdict file"

# ── case 10: unborn HEAD(커밋 0) → digest 계산 불능은 exit 2 fail-closed(무음 강등 금지) ─────
U="$WORK/r10"; mkdir -p "$U"; cd "$U" || fail "cd r10"
git init -q .
"$VR" --guard-mutation -- true >/dev/null 2>&1
code=$?
[ "$code" -eq 2 ] || fail "case10: unborn HEAD must refuse to run (exit 2), got $code"

echo "PASS: --guard-mutation flips the verdict on git-visible mutation, stays opt-in, no gitignored false positives, fail-closed outside git"
exit 0
