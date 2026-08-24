#!/usr/bin/env bash
# Behavioral test for the session-scope half of hooks/gate-worktree-create.mjs (BAC-778).
#
# Contract: the FIRST feature worktree of a session is allowed; a SECOND one escalates to
# permissionDecision "ask" (the human-approval prompt = the gate vocabulary's REQUIRE). Non-feature
# branches (lessons/chore/fix/…) never count and never escalate. The pre-existing origin/* deny rule
# is unchanged and still wins — a denied command must not consume the session's budget.
#
# "One session" is the payload's session_id and nothing else. With no session_id there is no
# escalation at all: undeterminable must not become "everything is the same session" (that would
# REQUIRE on the second feature worktree ever created in a repo).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hooks/gate-worktree-create.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$HOOK" ] || fail "gate-worktree-create.mjs not found at $HOOK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
PROJ="$DIR/proj"
mkdir -p "$PROJ"

# run <project-dir> <session-id-or-empty> <command>
run() {
  node -e '
    const [sid, cmd] = process.argv.slice(1);
    const p = { tool_name: "Bash", tool_input: { command: cmd } };
    if (sid) p.session_id = sid;
    process.stdout.write(JSON.stringify(p));
  ' "$2" "$3" | CLAUDE_PROJECT_DIR="$1" node "$HOOK" 2>"$DIR/stderr"
}
expect_allow() {
  local out; out="$(run "$1" "$2" "$3")" || fail "hook must exit 0"
  [ -z "$out" ] || fail "expected allow for [$3], got: $out"
}
expect_decision() { # $4 = deny|ask
  local out; out="$(run "$1" "$2" "$3")" || fail "hook must exit 0"
  printf '%s' "$out" | grep -q "\"permissionDecision\":\"$4\"" \
    || fail "expected $4 for [$3], got: ${out:-<empty>}"
}

WT_ADD='git fetch origin && git worktree add -b %s /tmp/%s origin/main'

# ── 1) 세션의 첫 feature 워크트리는 통과 ──────────────────────────────────────────────────────
expect_allow "$PROJ" "sess-A" "$(printf "$WT_ADD" feature/bac-1 wt1)"
echo "PASS: the first feature/* worktree of a session is allowed"

# ── 2) 같은 세션의 두 번째 feature 워크트리 → ask(REQUIRE) ────────────────────────────────────
expect_decision "$PROJ" "sess-A" "$(printf "$WT_ADD" feature/bac-2 wt2)" "ask"
echo "PASS: a SECOND feature/* worktree in the same session escalates to ask (REQUIRE)"

# ── 2b) 같은 브랜치 재시도는 중복 계산하지 않는다(실패 후 재시도 시나리오) ─────────────────────
expect_allow "$PROJ" "sess-B" "$(printf "$WT_ADD" feature/retry wtr)"
expect_allow "$PROJ" "sess-B" "$(printf "$WT_ADD" feature/retry wtr)"
echo "PASS: retrying the same branch name does not consume a second slot"

# ── 3) 다른 세션은 독립 예산 ─────────────────────────────────────────────────────────────────
expect_allow "$PROJ" "sess-C" "$(printf "$WT_ADD" feature/bac-3 wt3)"
echo "PASS: a different session_id gets its own budget"

# ── 4) lessons/chore 계열은 면제 — 몇 개를 만들든 에스컬레이트하지 않는다 ──────────────────────
for b in lessons/harness-1 chore/bump-deps fix/typo docs/adr-99 lessons/harness-2; do
  expect_allow "$PROJ" "sess-D" "$(printf "$WT_ADD" "$b" "$(basename "$b")")"
done
# 그리고 그것들은 feature 예산을 갉아먹지도 않는다 — 이 세션의 첫 feature는 여전히 통과여야 한다.
expect_allow "$PROJ" "sess-D" "$(printf "$WT_ADD" feature/first wtd)"
expect_decision "$PROJ" "sess-D" "$(printf "$WT_ADD" feature/second wtd2)" "ask"
echo "PASS: lessons/chore/fix/docs branches are exempt and don't consume the feature budget"

# ── 5) session_id가 없으면 에스컬레이션 자체가 없다(판정 불가를 판정으로 바꾸지 않는다) ─────────
expect_allow "$PROJ" "" "$(printf "$WT_ADD" feature/anon-1 wta1)"
expect_allow "$PROJ" "" "$(printf "$WT_ADD" feature/anon-2 wta2)"
echo "PASS: with no session_id there is no escalation (undeterminable stays undeterminable)"

# ── 6) 기존 origin/* deny 규칙은 그대로이고, deny된 명령은 예산을 소비하지 않는다 ───────────────
E="$DIR/proj-e"
mkdir -p "$E"
expect_decision "$E" "sess-E" 'git worktree add -b feature/local-base /tmp/wte main' "deny"
expect_decision "$E" "sess-E" 'git worktree add -b feature/no-ref /tmp/wte2' "deny"
# 위 둘이 예산을 먹었다면 아래 첫 feature가 ask가 됐을 것이다.
expect_allow "$E" "sess-E" "$(printf "$WT_ADD" feature/real wte3)"
echo "PASS: the origin/* deny rule still wins, and a denied command doesn't consume the session budget"

# ── 7) DWIM 형태(commit-ish 생략 대신 origin/* 명시 + -b 생략)도 브랜치명을 basename에서 얻는다 ─
D="$DIR/proj-d"
mkdir -p "$D"
expect_allow "$D" "sess-F" 'git worktree add /tmp/feature/dwim-1 origin/main'
expect_allow "$D" "sess-F" 'git worktree add /tmp/feature/dwim-2 origin/main'
echo "PASS: a DWIM path whose basename isn't feature-prefixed doesn't escalate (branch = basename)"

# ── 8) featureBranchPrefix 설정이 기본값을 교체한다 ──────────────────────────────────────────
C="$DIR/proj-c"
mkdir -p "$C/.claude"
printf '{"featureBranchPrefix":"work/"}' > "$C/.claude/ship-flow.config.json"
expect_allow "$C" "sess-G" "$(printf "$WT_ADD" feature/ignored-now wtg1)"
expect_allow "$C" "sess-G" "$(printf "$WT_ADD" feature/ignored-too wtg2)"
expect_allow "$C" "sess-G" "$(printf "$WT_ADD" work/one wtg3)"
expect_decision "$C" "sess-G" "$(printf "$WT_ADD" work/two wtg4)" "ask"
echo "PASS: .claude/ship-flow.config.json featureBranchPrefix replaces the built-in default"

# ── 9) 킬스위치 ─────────────────────────────────────────────────────────────────────────────
K="$DIR/proj-k"
mkdir -p "$K"
for n in 1 2 3; do
  OUT="$(node -e '
    process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:"sess-K",tool_input:{command:process.argv[1]}}));
  ' "$(printf "$WT_ADD" "feature/k$n" "wtk$n")" | LOOP_WORKTREE_SESSION_GATE_OFF=1 CLAUDE_PROJECT_DIR="$K" node "$HOOK")" \
    || fail "kill switch must exit 0"
  [ -z "$OUT" ] || fail "LOOP_WORKTREE_SESSION_GATE_OFF=1 must disable the escalation, got: $OUT"
done
echo "PASS: LOOP_WORKTREE_SESSION_GATE_OFF=1 disables the session escalation"

exit 0
