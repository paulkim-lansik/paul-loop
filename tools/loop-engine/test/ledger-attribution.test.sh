#!/usr/bin/env bash
# Regression test for verdict-event attribution — lib/run-ledger.mjs resolveLedgerTarget() +
# bin/ledger-append.mjs --auto-run-id + bin/verdict-run.sh (BAC-778).
#
# The hole this closes (measured in a consuming repo over 7 days): the instrumentation hook writes
# under CLAUDE_PROJECT_DIR while verdict-run.sh writes under its own cwd. A repo that isolates work
# in git worktrees splits those two apart on every single run — 3,096 events across 111 run files in
# the main ledger with ZERO verdict.* events, while one worktree's .loop/runs/unknown.jsonl held 14
# verdict.passed + 2 verdict.failed. Q1 (first-pass green) and Q2 therefore reported
# INSUFFICIENT_DATA for every run: the loop's headline metric was unmeasurable from its own ledger.
#
# Contract locked here:
#   - Attribution is by CORROBORATION, never by guessing: an event only moves to another root if
#     that root already holds `<run-id>.jsonl` (proof the hook is writing this session there).
#   - With no corroboration, the previous behaviour is byte-for-byte unchanged (cwd + the current
#     pointer + the unknown bucket) — that's what test/run-ledger.test.sh already pins.
# hermetic: mktemp + a real git worktree pair, no docker/network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LIB="$ROOT/tools/loop-engine/lib/run-ledger.mjs"
APPEND="$ROOT/tools/loop-engine/bin/ledger-append.mjs"
VRUN="$ROOT/tools/loop-engine/bin/verdict-run.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LIB" ] || fail "run-ledger.mjs not found at $LIB"
[ -f "$APPEND" ] || fail "ledger-append.mjs not found at $APPEND"
[ -x "$VRUN" ] || fail "verdict-run.sh not found/executable at $VRUN"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
DIR="$(cd -P "$DIR" && pwd)"
trap 'chmod -R u+w "$DIR" 2>/dev/null; rm -rf "$DIR"' EXIT

# ── 0) 메인 워크트리 + 링크된 워크트리 (실제 실패 형상 재현) ──────────────────────────────────
MAIN="$DIR/main"
mkdir -p "$MAIN"
git -C "$MAIN" init -q -b main
printf '.loop/\n' > "$MAIN/.gitignore"
echo x > "$MAIN/f.txt"
git -C "$MAIN" add .
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -qm init
WT="$DIR/wt"
git -C "$MAIN" worktree add -q --detach "$WT" HEAD >/dev/null 2>&1 || fail "could not create the linked worktree fixture"

SID="sess-abc-123"
# 훅이 이미 메인 워크트리에 이 세션의 원장을 쓰고 있는 상태를 만든다(= 확증의 근거).
mkdir -p "$MAIN/.loop/runs"
printf '{"id":"x","type":"run.started","ts":"2026-08-24T00:00:00.000Z","aggregate_id":"%s","payload":{},"version":1}\n' "$SID" \
  > "$MAIN/.loop/runs/$SID.jsonl"

# ── 1) 워크트리에서 돈 verdict가 메인 워크트리의 *세션* 원장에 착지한다 ────────────────────────
( cd "$WT" && CLAUDE_CODE_SESSION_ID="$SID" VERDICT_RUN_LEDGER_NESTED= "$VRUN" -- true >/dev/null 2>&1 )
rc=$?
[ "$rc" = "0" ] || fail "verdict-run -- true in the worktree must still exit 0, got $rc"
grep -q '"type":"verdict.passed"' "$MAIN/.loop/runs/$SID.jsonl" \
  || fail "a verdict run inside a linked worktree must land in the session ledger at the main worktree ($MAIN/.loop/runs/$SID.jsonl)"
[ ! -f "$WT/.loop/runs/unknown.jsonl" ] \
  || fail "the verdict must no longer be orphaned into the worktree's unknown bucket"
echo "PASS: a verdict run inside a linked worktree attributes to the session ledger (the measured hole)"

# ── 1b) 출처는 잃지 않는다 — payload.cwd가 어느 워크트리였는지 남긴다 ─────────────────────────
node -e '
  const fs = require("node:fs");
  const [file, wt] = process.argv.slice(1);
  const ev = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
    .find((e) => e.type === "verdict.passed");
  if (!ev) throw new Error("no verdict.passed event found");
  if (ev.aggregate_id !== process.argv[3]) throw new Error("aggregate_id must be the session id, got " + ev.aggregate_id);
  if (ev.payload.cwd !== wt) throw new Error("payload.cwd must record the worktree the verify ran in, got " + ev.payload.cwd);
' "$MAIN/.loop/runs/$SID.jsonl" "$WT" "$SID" || fail "redirected verdict event must stay diagnosable (aggregate_id + payload.cwd)"
echo "PASS: the redirected event keeps its provenance (aggregate_id=session, payload.cwd=worktree)"

# ── 2) 확증이 없으면 아무것도 바뀌지 않는다 — cwd + unknown 버킷 (기존 계약 불변) ───────────────
NOCORR="$DIR/nocorr"
mkdir -p "$NOCORR"
( cd "$NOCORR" && printf '{}' \
  | CLAUDE_CODE_SESSION_ID="totally-unrelated-session" node "$APPEND" --type verdict.failed --auto-run-id ) \
  || fail "uncorroborated append must still succeed"
[ -f "$NOCORR/.loop/runs/unknown.jsonl" ] \
  || fail "with no corroborating session ledger anywhere, the event must stay in cwd's unknown bucket"
[ ! -f "$NOCORR/.loop/runs/totally-unrelated-session.jsonl" ] \
  || fail "a session id must NEVER create a new ledger file on its own — corroboration only"
echo "PASS: without corroboration the previous behaviour (cwd + unknown bucket) is unchanged"

# ── 3) current 포인터는 세션 id가 확증되지 않을 때의 폴백으로 남는다 ──────────────────────────
PTR="$DIR/ptr"
mkdir -p "$PTR/.loop/runs"
printf 'runptr\n' > "$PTR/.loop/runs/current"
( cd "$PTR" && printf '{}' | CLAUDE_CODE_SESSION_ID="no-such-session" node "$APPEND" --type verdict.passed --auto-run-id ) \
  || fail "current-pointer fallback append failed"
[ -f "$PTR/.loop/runs/runptr.jsonl" ] \
  || fail "an unconfirmable session id must fall back to the current pointer, not shadow it"
echo "PASS: the current pointer stays the fallback when the session id can't be corroborated"

# ── 4) 세션 id 확증이 current 포인터보다 우선한다(동시 세션 last-writer-wins 오귀속 차단) ───────
# 같은 원장에 다른 세션이 마지막으로 쓴 포인터가 있어도, 내 세션 파일이 있으면 내 것으로 간다.
BOTH="$DIR/both"
mkdir -p "$BOTH/.loop/runs"
printf 'other-session\n' > "$BOTH/.loop/runs/current"
: > "$BOTH/.loop/runs/mine.jsonl"
( cd "$BOTH" && printf '{}' | CLAUDE_CODE_SESSION_ID="mine" node "$APPEND" --type verdict.passed --auto-run-id ) \
  || fail "session-id-priority append failed"
grep -q '"aggregate_id":"mine"' "$BOTH/.loop/runs/mine.jsonl" \
  || fail "a corroborated session id must win over a concurrent session's current pointer"
[ ! -s "$BOTH/.loop/runs/other-session.jsonl" ] 2>/dev/null \
  || fail "the event must not be misattributed to the pointer's session"
echo "PASS: a corroborated session id beats the current pointer (concurrent-session misattribution closed)"

# ── 5) --run-id 명시 경로는 루트 해소를 타지 않는다(호출자가 이미 정한 곳에 쓴다) ───────────────
EXPL="$DIR/expl"
mkdir -p "$EXPL"
( cd "$EXPL" && printf '{}' | CLAUDE_CODE_SESSION_ID="$SID" node "$APPEND" --type verdict.passed --run-id fixed ) \
  || fail "--run-id append failed"
[ -f "$EXPL/.loop/runs/fixed.jsonl" ] || fail "--run-id must write to cwd with the given id"
echo "PASS: an explicit --run-id is untouched by attribution resolution"

# ── 6) run-metrics가 실제로 Q1/Q2를 산출한다 — 이 수정의 존재 이유 ────────────────────────────
JSON="$(node "$ROOT/tools/loop-engine/bin/run-metrics.mjs" --runs-dir "$MAIN/.loop/runs" --json)" \
  || fail "run-metrics on the repaired ledger must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  const run = m.runs.find((r) => r.run_id === process.argv[2]);
  if (!run) throw new Error("the session run must appear");
  if (run.q2 === "INSUFFICIENT_DATA") throw new Error("Q2 must be computable now, got INSUFFICIENT_DATA");
  if (run.first_pass !== true) throw new Error("first_pass must be true (the only verdict passed), got " + run.first_pass);
  if (m.overall.q1 === "INSUFFICIENT_DATA") throw new Error("overall Q1 must be computable now");
' "$JSON" "$SID" || fail "the repaired ledger must make Q1/first_pass computable (the whole point)"
echo "PASS: Q1/first_pass are computable from the session ledger (was INSUFFICIENT_DATA for every run)"

exit 0
