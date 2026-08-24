#!/usr/bin/env bash
# Regression test for the subagent event shape + its fold (BAC-778):
#   hooks/record-run-event.mjs (SubagentStart/SubagentStop payload) and bin/run-metrics.mjs.
#
# What was measured, and why the fix is a shape change rather than a "populate the field" change
# (glucofit-partners ledger, 7 days, 146 run files):
#   - subagent.stopped: 2,307 events, of which 1,896 carried agent_type "" and 411 a real type.
#   - subagent.started: 472 events — stopped outnumbered started ~5x, so "stopped count" looked like
#     a subagent population it could not support.
#   - Cross-checking agent_id across the WHOLE ledger settles the cause: 405/405 distinct typed stop
#     ids have a matching started; 1,901/1,901 distinct untyped stop ids have none. The platform
#     fires SubagentStop for agent kinds whose SubagentStart never fires, and its stdin for those
#     carries no agent_type at all. A hook cannot invent it.
# So the contract locked here is honesty, not fabrication: absent -> null (never ""),
# attributable:false, whatever else the platform sent kept under `extra` so a later audit can find
# an identity field we don't know about yet, and a fold that never mixes paired with unpaired stops.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
HOOK="$ROOT/tools/loop-engine/hooks/record-run-event.mjs"
METRICS="$ROOT/tools/loop-engine/bin/run-metrics.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$HOOK" ] || fail "record-run-event.mjs not found at $HOOK"
[ -f "$METRICS" ] || fail "run-metrics.mjs not found at $METRICS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

emit() { # $1=project-dir  $2=stdin-json
  printf '%s' "$2" | CLAUDE_PROJECT_DIR="$1" node "$HOOK" >/dev/null 2>"$DIR/stderr" \
    || fail "record-run-event.mjs threw (stderr: $(cat "$DIR/stderr"))"
}

# ── 1) 타입 있는 started/stopped — 그대로 기록된다 ────────────────────────────────────────────
P="$DIR/p"
mkdir -p "$P"
emit "$P" '{"session_id":"s1","hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"code-reviewer"}'
emit "$P" '{"session_id":"s1","hook_event_name":"SubagentStop","agent_id":"a1","agent_type":"code-reviewer"}'
node -e '
  const fs = require("node:fs");
  const evs = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  const started = evs.find((e) => e.type === "subagent.started");
  const stopped = evs.find((e) => e.type === "subagent.stopped");
  if (started.payload.agent_type !== "code-reviewer") throw new Error("started agent_type wrong: " + JSON.stringify(started.payload));
  if (stopped.payload.agent_type !== "code-reviewer") throw new Error("stopped agent_type wrong: " + JSON.stringify(stopped.payload));
  if ("attributable" in stopped.payload) throw new Error("a typed stop must NOT be flagged unattributable");
' "$P/.loop/runs/s1.jsonl" || fail "typed subagent events must record their agent_type unchanged"
echo "PASS: a typed SubagentStart/Stop pair records agent_type unchanged"

# ── 2) agent_type 부재 → null(빈 문자열 아님) + attributable:false + extra 보존 ────────────────
# 빈 문자열은 "타입을 잡았는데 그게 비어 있었다"로 읽힌다 — 실제로 일어난 일과 정반대다.
Q="$DIR/q"
mkdir -p "$Q"
emit "$Q" '{"session_id":"s2","hook_event_name":"SubagentStop","agent_id":"a9","agent_type":"","some_future_id":"ff-77"}'
node -e '
  const fs = require("node:fs");
  const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8").trim());
  if (e.payload.agent_type !== null) throw new Error("absent agent_type must be null, got " + JSON.stringify(e.payload.agent_type));
  if (e.payload.attributable !== false) throw new Error("an untyped stop must carry attributable:false, got " + JSON.stringify(e.payload));
  if (!e.payload.extra || e.payload.extra.some_future_id !== "ff-77")
    throw new Error("unknown platform fields must be preserved under extra, got " + JSON.stringify(e.payload.extra));
' "$Q/.loop/runs/s2.jsonl" || fail "untyped subagent.stopped must be recorded honestly"
echo "PASS: an untyped SubagentStop records agent_type=null + attributable:false + extra (no fabricated type)"

# ── 3) permission.denied는 command 없는 툴에서도 진단 가능해야 한다 ───────────────────────────
# Bash는 command를, Edit/Write는 file_path를 싣지만 나머지 툴(실측: SendMessage·ScheduleWakeup)은
# tool_name 하나만 남아 사후에 서로 구별되지 않았다. 값이 아니라 *키 이름*만 남긴다(시크릿·용량 무관).
R="$DIR/r"
mkdir -p "$R"
emit "$R" '{"session_id":"s3","hook_event_name":"PermissionDenied","tool_name":"Bash","tool_input":{"command":"rm -rf /","timeout":5}}'
emit "$R" '{"session_id":"s3","hook_event_name":"PermissionDenied","tool_name":"SendMessage","tool_input":{"agent_id":"x","message":"hello"}}'
node -e '
  const fs = require("node:fs");
  const evs = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  const bash = evs.find((e) => e.payload.tool_name === "Bash");
  const send = evs.find((e) => e.payload.tool_name === "SendMessage");
  if (bash.payload.command !== "rm -rf /") throw new Error("a Bash denial must record its command, got " + JSON.stringify(bash.payload.command));
  const keys = send.payload.tool_input_keys;
  if (!Array.isArray(keys) || !keys.includes("agent_id") || !keys.includes("message"))
    throw new Error("a command-less denial must record tool_input key NAMES, got " + JSON.stringify(keys));
  if (JSON.stringify(send.payload).includes("hello"))
    throw new Error("tool_input VALUES must never be carried by the key fingerprint");
' "$R/.loop/runs/s3.jsonl" || fail "permission.denied must stay diagnosable for every tool shape"
echo "PASS: permission.denied keeps Bash commands and, for command-less tools, a values-free tool_input key fingerprint"

# ── 4) fold — 짝 맞은 stop과 귀속 불가 stop을 절대 섞지 않는다 ────────────────────────────────
F="$DIR/f"
mkdir -p "$F"
cat > "$F/runS.jsonl" <<'EOF'
{"id":"s1","type":"run.started","ts":"2026-08-24T00:00:00.000Z","aggregate_id":"runS","payload":{},"version":1}
{"id":"s2","type":"subagent.started","ts":"2026-08-24T00:01:00.000Z","aggregate_id":"runS","payload":{"agent_id":"a1","agent_type":"fork"},"version":1}
{"id":"s3","type":"subagent.started","ts":"2026-08-24T00:02:00.000Z","aggregate_id":"runS","payload":{"agent_id":"a2","agent_type":"Explore"},"version":1}
{"id":"s4","type":"subagent.stopped","ts":"2026-08-24T00:03:00.000Z","aggregate_id":"runS","payload":{"agent_id":"a1","agent_type":"fork"},"version":1}
{"id":"s5","type":"subagent.stopped","ts":"2026-08-24T00:04:00.000Z","aggregate_id":"runS","payload":{"agent_id":"zz","agent_type":null,"attributable":false},"version":1}
{"id":"s6","type":"subagent.stopped","ts":"2026-08-24T00:05:00.000Z","aggregate_id":"runS","payload":{"agent_id":"yy","agent_type":null,"attributable":false},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$F" --json)" || fail "run-metrics with subagent events must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  const r = m.runs.find((x) => x.run_id === "runS");
  if (r.subagents.started !== 2) throw new Error("started must be 2, got " + r.subagents.started);
  if (r.subagents.stopped_paired !== 1) throw new Error("stopped_paired must be 1 (only a1 has a started), got " + r.subagents.stopped_paired);
  if (r.subagents.stopped_unattributed !== 2) throw new Error("stopped_unattributed must be 2, got " + r.subagents.stopped_unattributed);
  if (m.overall.subagents.stopped_paired !== 1 || m.overall.subagents.stopped_unattributed !== 2)
    throw new Error("overall subagent split wrong: " + JSON.stringify(m.overall.subagents));
' "$JSON" || fail "subagent fold must split paired from unattributed stops"
OUT="$(node "$METRICS" --runs-dir "$F")"
printf '%s' "$OUT" | grep -q "stopped_unattributed=2" \
  || fail "text output must surface stopped_unattributed so nothing downstream reads the raw stop count as a population, got: $OUT"
echo "PASS: run-metrics splits subagent stops into paired vs unattributed (no unsupported count implied)"

exit 0
