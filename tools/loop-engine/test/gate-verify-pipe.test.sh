#!/usr/bin/env bash
# Behavioral test for hooks/gate-verify-pipe.mjs (BAC-778).
#
# Contract: a verify-shaped command piped into another command, in an invocation that does nothing
# to preserve the real exit status, is denied. Anything that keeps the status (pipefail / PIPESTATUS
# / a redirect instead of a pipe) passes, and so does every command that isn't verify-shaped.
# Detection fails open; once confirmed it fails closed. hermetic: no git, no docker, no network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hooks/gate-verify-pipe.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$HOOK" ] || fail "gate-verify-pipe.mjs not found at $HOOK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# run <command-string> [extra-json-fields] -> prints the hook's stdout
run() {
  node -e '
    const [cmd] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }));
  ' "$1" | CLAUDE_PROJECT_DIR="$DIR" node "$HOOK" 2>"$DIR/stderr"
}
expect_deny() {
  local out
  out="$(run "$1")" || fail "hook must always exit 0, got non-zero for: $1"
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"' \
    || fail "expected deny for: $1 (got: ${out:-<empty>})"
}
expect_allow() {
  local out
  out="$(run "$1")" || fail "hook must always exit 0, got non-zero for: $1"
  [ -z "$out" ] || fail "expected allow (no stdout) for: $1 (got: $out)"
}

# ── 1) 감사에서 실제로 나온 형태 — cd && timeout … pnpm verify 2>&1 | tail (RED) ────────────────
# `2>&1`의 `&`가 문장 분리자로 오인되면 파이프라인 첫 단계가 verify가 아니게 되어 탐지가 조용히
# 죽는다 — 이 케이스가 그 회귀를 잠근다(실측 형태 그대로).
expect_deny 'cd /tmp/wt && timeout 590 pnpm verify 2>&1 | tail -200'
echo "PASS: the audited form (cd && timeout … pnpm verify 2>&1 | tail) is denied"

# ── 2) 최소 형태 + 러너/스크립트 변형 ────────────────────────────────────────────────────────
expect_deny 'pnpm verify | tail -200'
expect_deny 'pnpm run verify | head'
expect_deny 'pnpm --filter @x/db verify:rls | tail -50'
expect_deny 'tools/loop-engine/bin/verdict-run.sh -- pnpm verify | tail -20'
echo "PASS: runner variants (run / --filter / :suffix) and a direct verdict-run.sh call are denied"

# 기본 패턴은 이 하네스의 어휘(verify/verdict)에 한정 — 아무 스크립트나 잡지 않는다.
expect_allow 'npm test | tail'
echo "PASS: the default pattern is scoped to verify/verdict (npm test | tail is not this gate's business)"

# ── 3) 상태를 보존하는 형태는 통과 ───────────────────────────────────────────────────────────
expect_allow 'set -o pipefail; pnpm verify 2>&1 | tail -200; echo "EXIT:$?"'
expect_allow 'pnpm verify 2>&1 | tail -200; echo "EXIT:${PIPESTATUS[0]}"'
expect_allow 'pnpm verify > /tmp/v.log 2>&1; echo "EXIT:$?"; tail -200 /tmp/v.log'
echo "PASS: pipefail / PIPESTATUS / redirect-plus-\$? forms are allowed"

# ── 4) verify가 아닌 파이프라인, 파이프 없는 verify는 무관 ───────────────────────────────────
expect_allow 'git log --oneline | head -20'
expect_allow 'ls -la | grep verify'
expect_allow 'pnpm verify'
expect_allow 'cat notes.txt | grep verdict'
echo "PASS: non-verify pipelines and un-piped verify are untouched"

# ── 5) 파이프 뒤쪽에 verify가 오는 건 대상이 아니다(그 경우 \$?가 곧 verify의 상태다) ──────────
expect_allow 'cat cmds.txt | xargs -I{} echo {}'
echo "PASS: only the FIRST pipeline stage being verify-shaped trips the gate"

# ── 6) Bash가 아닌 툴 / 빈 명령 / 깨진 stdin → allow (감지 단계 fail-open) ────────────────────
OUT="$(printf '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x"}}' | node "$HOOK")" \
  || fail "non-Bash tool must exit 0"
[ -z "$OUT" ] || fail "non-Bash tool must allow silently, got: $OUT"
OUT="$(printf 'not json at all {{{' | node "$HOOK")" || fail "broken stdin must exit 0"
[ -z "$OUT" ] || fail "broken stdin must allow silently, got: $OUT"
echo "PASS: non-Bash tools and unparseable stdin fail open"

# ── 7) 킬스위치 ─────────────────────────────────────────────────────────────────────────────
OUT="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:"pnpm verify | tail"}}))' \
  | LOOP_VERIFY_PIPE_GATE_OFF=1 node "$HOOK")" || fail "kill switch must exit 0"
[ -z "$OUT" ] || fail "LOOP_VERIFY_PIPE_GATE_OFF=1 must disable the gate, got: $OUT"
echo "PASS: LOOP_VERIFY_PIPE_GATE_OFF=1 disables the gate"

# ── 8) verifyCommandPattern 설정이 기본값을 교체한다(제품 고유 어휘 하드코딩 금지) ──────────────
CFG="$DIR/cfg"
mkdir -p "$CFG/.claude"
printf '{"verifyCommandPattern":"^gate$"}' > "$CFG/.claude/ship-flow.config.json"
cfg_run() {
  node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$1" \
    | CLAUDE_PROJECT_DIR="$CFG" node "$HOOK"
}
OUT="$(cfg_run 'pnpm gate | tail')"
printf '%s' "$OUT" | grep -q '"permissionDecision":"deny"' \
  || fail "configured verifyCommandPattern must be honored (pnpm gate | tail), got: ${OUT:-<empty>}"
OUT="$(cfg_run 'pnpm verify | tail')"
[ -z "$OUT" ] || fail "a configured pattern must fully REPLACE the default (pnpm verify no longer matches), got: $OUT"
echo "PASS: .claude/ship-flow.config.json verifyCommandPattern replaces the built-in default"

exit 0
