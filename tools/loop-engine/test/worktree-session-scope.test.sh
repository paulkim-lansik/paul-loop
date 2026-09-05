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
init_repo() {
  mkdir -p "$1"
  git -C "$1" init -q -b main || fail "git init fixture"
  git -C "$1" -c user.name=Fixture -c user.email=fixture@local commit --allow-empty -qm initial || fail "git commit fixture"
  git -C "$1" update-ref refs/remotes/origin/main HEAD || fail "local origin ref fixture"
}
create() { git -C "$1" worktree add -qb "$2" "$DIR/$3" origin/main || fail "create fixture worktree $2"; }
init_repo "$PROJ"

# run <project-dir> <session-id-or-empty> <command>
run() {
  node -e '
    const [sid, cmd, cwd] = process.argv.slice(1);
    const p = { tool_name: "Bash", cwd, tool_input: { command: cmd } };
    if (sid) p.session_id = sid;
    process.stdout.write(JSON.stringify(p));
  ' "$2" "$3" "$1" | CLAUDE_PROJECT_DIR="$1" node "$HOOK" 2>"$DIR/stderr"
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

WT_ADD="git fetch origin && git worktree add -b %s \"$DIR/%s\" origin/main"

# ── 1) 세션의 첫 feature 워크트리는 통과 ──────────────────────────────────────────────────────
expect_allow "$PROJ" "sess-A" "$(printf "$WT_ADD" feature/bac-1 wt1)"
node -e 'const s=require(process.argv[1]); if(s.confirmed.length || s.pending.length!==1 || s.branches.length)process.exit(1)' "$PROJ/.loop/worktree-gate.sess-A.json" || fail "first request must be pending, not confirmed"
create "$PROJ" feature/bac-1 wt1
echo "PASS: the first feature/* worktree of a session is allowed"

# ── 2) 같은 세션의 두 번째 feature 워크트리 → ask(REQUIRE) ────────────────────────────────────
expect_decision "$PROJ" "sess-A" "$(printf "$WT_ADD" feature/bac-2 wt2)" "ask"
expect_decision "$PROJ" "sess-A" "$(printf "$WT_ADD" feature/bac-2 wt2)" "ask"
node -e 'const s=require(process.argv[1]); if(s.confirmed.length!==1 || s.pending.length!==1 || s.pending[0].requires_approval!==true)process.exit(1)' "$PROJ/.loop/worktree-gate.sess-A.json" || fail "denied second retries must stay pending"
# A human-approved creation is simulated by executing the exact previously requested local add.
create "$PROJ" feature/bac-2 wt2
expect_allow "$PROJ" "sess-A" 'git status --short'
node -e 'const s=require(process.argv[1]); if(s.confirmed.length!==2 || s.pending.length)process.exit(1)' "$PROJ/.loop/worktree-gate.sess-A.json" || fail "actual second execution must be confirmed on the next PreToolUse"
expect_allow "$PROJ" "sess-A" "$(printf "$WT_ADD" feature/bac-2 wt2)"
echo "PASS: a SECOND feature/* worktree in the same session escalates to ask (REQUIRE)"

# ── 2b) 같은 브랜치 재시도는 중복 계산하지 않는다(실패 후 재시도 시나리오) ─────────────────────
mkdir -p "$DIR/wtr"; printf occupied > "$DIR/wtr/file"
expect_allow "$PROJ" "sess-B" "$(printf "$WT_ADD" feature/retry wtr)"
git -C "$PROJ" worktree add -qb feature/retry "$DIR/wtr" origin/main >"$DIR/failed-add.log" 2>&1
[ "$?" -ne 0 ] || fail "fixture first creation must actually fail"
expect_allow "$PROJ" "sess-B" "$(printf "$WT_ADD" feature/retry wtr)"
expect_allow "$PROJ" "sess-B" "$(printf "$WT_ADD" feature/after-failed wtr2)"
node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:"sess-B",tool_input:{command:"git status"},tool_response:{success:true,stdout:"worktree created"}}))' \
  | CLAUDE_PROJECT_DIR="$PROJ" node "$HOOK" >/dev/null
node -e 'const s=require(process.argv[1]); if(s.confirmed.length || s.branches.length)process.exit(1)' "$PROJ/.loop/worktree-gate.sess-B.json" || fail "failed creation/fabricated success must not confirm any branch"
echo "PASS: retrying the same branch name does not consume a second slot"

# ── 3) 다른 세션은 독립 예산 ─────────────────────────────────────────────────────────────────
expect_allow "$PROJ" "sess-C" "$(printf "$WT_ADD" feature/bac-3 wt3)"
echo "PASS: a different session_id gets its own budget"

# ── 4) lessons/chore 계열은 면제 — 몇 개를 만들든 에스컬레이트하지 않는다 ──────────────────────
for b in lessons/harness-1 chore/bump-deps fix/typo docs/adr-99 lessons/harness-2; do
  expect_allow "$PROJ" "sess-D" "$(printf "$WT_ADD" "$b" "$(basename "$b")")"
  create "$PROJ" "$b" "$(basename "$b")"
done
# 그리고 그것들은 feature 예산을 갉아먹지도 않는다 — 이 세션의 첫 feature는 여전히 통과여야 한다.
expect_allow "$PROJ" "sess-D" "$(printf "$WT_ADD" feature/first wtd)"
create "$PROJ" feature/first wtd
expect_decision "$PROJ" "sess-D" "$(printf "$WT_ADD" feature/second wtd2)" "ask"
echo "PASS: lessons/chore/fix/docs branches are exempt and don't consume the feature budget"

# ── 5) session_id가 없으면 에스컬레이션 자체가 없다(판정 불가를 판정으로 바꾸지 않는다) ─────────
expect_allow "$PROJ" "" "$(printf "$WT_ADD" feature/anon-1 wta1)"
create "$PROJ" feature/anon-1 wta1
expect_allow "$PROJ" "" "$(printf "$WT_ADD" feature/anon-2 wta2)"
echo "PASS: with no session_id there is no escalation (undeterminable stays undeterminable)"

# ── 6) 기존 origin/* deny 규칙은 그대로이고, deny된 명령은 예산을 소비하지 않는다 ───────────────
E="$DIR/proj-e"
mkdir -p "$E"
init_repo "$E"
expect_decision "$E" "sess-E" 'git worktree add -b feature/local-base /tmp/wte main' "deny"
expect_decision "$E" "sess-E" 'git worktree add -b feature/no-ref /tmp/wte2' "deny"
# 위 둘이 예산을 먹었다면 아래 첫 feature가 ask가 됐을 것이다.
expect_allow "$E" "sess-E" "$(printf "$WT_ADD" feature/real wte3)"
echo "PASS: the origin/* deny rule still wins, and a denied command doesn't consume the session budget"

# ── 7) DWIM 형태(commit-ish 생략 대신 origin/* 명시 + -b 생략)도 브랜치명을 basename에서 얻는다 ─
D="$DIR/proj-d"
mkdir -p "$D"
init_repo "$D"
expect_allow "$D" "sess-F" 'git worktree add /tmp/feature/dwim-1 origin/main'
expect_allow "$D" "sess-F" 'git worktree add /tmp/feature/dwim-2 origin/main'
echo "PASS: a DWIM path whose basename isn't feature-prefixed doesn't escalate (branch = basename)"

# ── 8) featureBranchPrefix 설정이 기본값을 교체한다 ──────────────────────────────────────────
C="$DIR/proj-c"
mkdir -p "$C/.claude"
init_repo "$C"
printf '{"featureBranchPrefix":"work/"}' > "$C/.claude/ship-flow.config.json"
expect_allow "$C" "sess-G" "$(printf "$WT_ADD" feature/ignored-now wtg1)"
expect_allow "$C" "sess-G" "$(printf "$WT_ADD" feature/ignored-too wtg2)"
expect_allow "$C" "sess-G" "$(printf "$WT_ADD" work/one wtg3)"
create "$C" work/one wtg3
expect_decision "$C" "sess-G" "$(printf "$WT_ADD" work/two wtg4)" "ask"
echo "PASS: .claude/ship-flow.config.json featureBranchPrefix replaces the built-in default"

# ── 9) 킬스위치 ─────────────────────────────────────────────────────────────────────────────
K="$DIR/proj-k"
mkdir -p "$K"
init_repo "$K"
for n in 1 2 3; do
  OUT="$(node -e '
    process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:"sess-K",tool_input:{command:process.argv[1]}}));
  ' "$(printf "$WT_ADD" "feature/k$n" "wtk$n")" | LOOP_WORKTREE_SESSION_GATE_OFF=1 CLAUDE_PROJECT_DIR="$K" node "$HOOK")" \
    || fail "kill switch must exit 0"
  [ -z "$OUT" ] || fail "LOOP_WORKTREE_SESSION_GATE_OFF=1 must disable the escalation, got: $OUT"
  create "$K" "feature/k$n" "wtk$n"
done
echo "PASS: LOOP_WORKTREE_SESSION_GATE_OFF=1 disables the session escalation"

# ── 10) 브랜치 이름만 같거나 요청 전부터 존재한 worktree는 새 실행 성공 증거가 아니다 ─────────
expect_allow "$PROJ" "sess-path" "$(printf "$WT_ADD" feature/wrong-path expected-path)"
create "$PROJ" feature/wrong-path different-path
expect_allow "$PROJ" "sess-path" "$(printf "$WT_ADD" feature/path-next path-next)"
node -e 'const s=require(process.argv[1]); if(s.confirmed.length)process.exit(1)' "$PROJ/.loop/worktree-gate.sess-path.json" || fail "branch match at the wrong path must not confirm"
create "$PROJ" feature/preexisting preexisting
expect_allow "$PROJ" "sess-existing" "$(printf "$WT_ADD" feature/preexisting preexisting)"
expect_allow "$PROJ" "sess-existing" "$(printf "$WT_ADD" feature/really-new really-new)"
node -e 'const s=require(process.argv[1]); if(s.confirmed.length)process.exit(1)' "$PROJ/.loop/worktree-gate.sess-existing.json" || fail "pre-existing worktree must not be attributed as successful execution"
echo "PASS: confirmation requires a newly observed exact branch AND path"

# ── 11) 하나의 명령이 feature 둘을 요청하면 confirmed=0이어도 ask; 승인으로 표시하지 않는다 ─
MULTI="$(printf "$WT_ADD" feature/multi-a multi-a) && $(printf "$WT_ADD" feature/multi-b multi-b)"
expect_decision "$PROJ" "sess-multi" "$MULTI" ask
expect_decision "$PROJ" "sess-multi" "$MULTI" ask
node -e 'const s=require(process.argv[1]); if(s.confirmed.length || s.pending.length!==2 || s.pending.some(x=>x.requires_approval!==true))process.exit(1)' "$PROJ/.loop/worktree-gate.sess-multi.json" || fail "compound pending requests must not become confirmations"
echo "PASS: two requested features require approval even before either is confirmed"

# ── 12) git -C 및 단순 cd의 실제 실행 repo/path로 관측; repo별 세션 파일도 독립 ────────────────
expect_allow "$PROJ" "sess-cwd" "git -C '$E' worktree add -b feature/cwd-one '../cwd-one' origin/main"
create "$E" feature/cwd-one cwd-one
expect_allow "$PROJ" "sess-cwd" 'git status'
expect_decision "$PROJ" "sess-cwd" "cd '$E' && git worktree add -b feature/cwd-two '../cwd-two' origin/main" ask
expect_allow "$E" "sess-cwd" "$(printf "$WT_ADD" feature/other-project other-project)"
echo "PASS: git -C / cd attribution and per-project state isolation are preserved"

# ── 13) legacy attempts-only branches는 확인된 실행으로 자동 승격하지 않는다 ─────────────────
printf '{"branches":["feature/legacy-attempt"]}\n' > "$PROJ/.loop/worktree-gate.sess-legacy.json"
expect_allow "$PROJ" "sess-legacy" "$(printf "$WT_ADD" feature/first-after-migration migrated)"
node -e 'const s=require(process.argv[1]); if(s.schema_version!==2 || s.confirmed.length || s.legacy_unconfirmed[0]!=="feature/legacy-attempt")process.exit(1)' "$PROJ/.loop/worktree-gate.sess-legacy.json" || fail "legacy attempts lack branch/path execution evidence"
echo "PASS: legacy attempt records remain explicitly unconfirmed"

exit 0
