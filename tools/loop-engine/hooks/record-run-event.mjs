#!/usr/bin/env node
// record-run-event.mjs — run-event instrumentation hook. Never judges, never blocks — every error is
// a no-op (exit 0).
//
// If this hook exits 2 on PermissionRequest, that permission gets denied (official hooks doc: "Exit
// Code 2 Behavior: Denies the permission") — instrumentation must never change permission flow, so
// this file never exits non-zero (main().finally(exit 0)). No stdout either — SessionStart's stdout is
// the additionalContext injection channel, and an instrumentation hook must not pollute context.
//
// Writes via lib/run-ledger.mjs -> <consuming-repo>/.loop/runs/<run-id>.jsonl (append-only, gitignored
// local telemetry). run-id = a sanitized stdin session_id (a run's boundary = the session's boundary).
// verdict.* events are appended by loop-engine's own bin/verdict-run.sh directly, not by this hook —
// consistent with "the agent can't write its own verdict state" (verifier=ceiling).
//
// Best-effort dependencies are dynamically imported — a static import would let a broken dependency
// silently disable the whole hook.
import { readFileSync } from 'node:fs';

const TYPE = {
  SessionStart: 'run.started',
  SessionEnd: 'run.ended',
  PermissionRequest: 'permission.requested',
  PermissionDenied: 'permission.denied',
  SubagentStart: 'subagent.started',
  SubagentStop: 'subagent.stopped',
  InstructionsLoaded: 'instructions.loaded',
  PreCompact: 'compaction',
};

// Common stdin fields (official hooks doc) — noise to drop from instructions.loaded's "everything
// else" payload.
const COMMON_FIELDS = new Set([
  'session_id',
  'prompt_id',
  'transcript_path',
  'cwd',
  'permission_mode',
  'hook_event_name',
  'agent_id',
  'agent_type',
]);

// sanitize() scans the full string *before* the 256-char storage cap — an unbounded command (e.g. a
// base64 blob with no whitespace) makes the greedy-star regex backtrack O(n^2) and can blow the hook's
// timeout (measured: a 64k-char command took ~3.4s). Storage truncates to 256 chars anyway, so
// pre-truncate before sanitize. Surface classification alone still runs on the full string (a boundary
// command sitting past the truncation point must not be missed).
const PRE_SANITIZE_CAP = 2048;
const capStr = (v) =>
  typeof v === 'string' && v.length > PRE_SANITIZE_CAP ? v.slice(0, PRE_SANITIZE_CAP) : v;

// The key names (never the values) of a tool_input object, capped — a diagnostic fingerprint for
// tools that carry neither `command` nor `file_path`.
function inputKeys(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  return Object.keys(toolInput).slice(0, 20);
}

// Everything the platform sent that isn't a documented common field — used both for
// instructions.loaded (whose event-specific fields aren't documented) and for an unattributable
// subagent.stopped (see below: keeping the raw extras is the only way a later audit can discover an
// identity field the platform supplies under a name we don't know yet).
function restFields(input) {
  const rest = {};
  for (const [k, v] of Object.entries(input)) {
    if (!COMMON_FIELDS.has(k)) rest[k] = capStr(v);
  }
  return rest;
}

function pickPayload(type, input, surfaceOf) {
  if (type === 'permission.requested' || type === 'permission.denied') {
    return {
      tool_name: input.tool_name,
      command: capStr(input.tool_input?.command),
      file_path: capStr(input.tool_input?.file_path),
      tool_use_id: input.tool_use_id,
      // bypassPermissions runs never fire this event at all, so an aggregator can't tell "no
      // intervention needed" apart from "this event never fires here" without the mode on the event.
      permission_mode: input.permission_mode,
      // Surface tagging happens at record time — a long-command preview cap upstream can make surface
      // classification impossible for very long commands. Aggregation should only count
      // surface==null interventions.
      surface: surfaceOf(input.tool_name, input.tool_input?.command),
      // Bash carries `command` and Edit/Write carry `file_path`, but every other tool (measured in a
      // real ledger: SendMessage, ScheduleWakeup) lands with tool_name and nothing else — a denial
      // that can't be told apart from any other denial of the same tool afterwards. The key *names*
      // of tool_input are enough to identify which shape it was, and unlike the values they can't
      // carry a secret or blow up the ledger. Values stay excluded on purpose.
      tool_input_keys: inputKeys(input.tool_input),
    };
  }
  if (type === 'subagent.started' || type === 'subagent.stopped') {
    // agent_type is recorded as null (absent), never '' — an empty string reads like "we captured a
    // type and it happened to be blank", which is the opposite of what actually happened.
    //
    // Measured (glucofit-partners ledger, 7 days, 146 run files): of 2,307 subagent.stopped events,
    // 1,896 carried agent_type '' and 411 carried a real type. Cross-checking agent_id against every
    // subagent.started in the whole ledger is unambiguous — 405/405 distinct *typed* stop ids have a
    // matching started; 1,901/1,901 distinct *untyped* stop ids have none. So the absence isn't
    // truncation or a payload-shape mistake on our side: the platform fires SubagentStop for agent
    // kinds whose SubagentStart never fires, and its stdin for those carries no agent_type. A hook
    // cannot invent it. What a hook CAN do is stop pretending the two counts are comparable — hence
    // attributable:false here, and a separate stopped_unattributed axis in bin/run-metrics.mjs so
    // nothing downstream derives per-agent duration/success from a population it can't pair.
    const agentType =
      typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : null;
    const payload = { agent_id: input.agent_id, agent_type: agentType };
    if (type === 'subagent.stopped' && agentType === null) {
      payload.attributable = false;
      // Carry whatever else the platform did send. If a future runtime starts supplying identity
      // under a different key, it lands in the ledger and the next audit sees it instead of guessing.
      payload.extra = restFields(input);
    }
    return payload;
  }
  if (type === 'run.started' || type === 'run.ended') {
    return { cwd: input.cwd, reason: input.reason, permission_mode: input.permission_mode };
  }
  if (type === 'compaction') {
    // trigger: 'auto' | 'manual' (official PreCompact hook doc). custom_instructions only exists for
    // manual — carry it capped, since a user could paste something long into it.
    return { cwd: input.cwd, trigger: input.trigger, custom_instructions: capStr(input.custom_instructions) };
  }
  // instructions.loaded — the event-specific fields aren't documented: carry everything except the
  // common fields, still pre-truncating unknown long strings (sanitize's blocklist/cap defends the
  // content).
  return restFields(input);
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // stdin parse failure = no-op
  }
  const type = TYPE[input?.hook_event_name];
  if (!type) return;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code injects this at hook runtime.
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  try {
    const [ledger, surfaces] = await Promise.all([
      import('../lib/run-ledger.mjs'),
      import('../lib/boundary-surfaces.mjs'),
    ]);
    ledger.appendRunEvent(root, {
      type,
      sessionId: input.session_id,
      payload: pickPayload(type, input, surfaces.boundarySurface),
      writeCurrentPointer: type === 'run.started',
      // A stale pointer left after session end would attribute a later terminal verdict to a dead
      // run — clear only on our own run (run-ledger cross-checks); after that, verdicts honestly fall
      // into the unknown bucket instead of misattributing.
      clearCurrentPointer: type === 'run.ended',
    });
  } catch {
    /* best-effort — instrumentation failure must never affect session/permission flow */
  }
}
main().finally(() => process.exit(0));
