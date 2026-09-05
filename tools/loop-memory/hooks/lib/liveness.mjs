// Liveness ledger — the always-on record that a hook actually fired (paul-loop issue #35).
//
// Why this exists: both hooks are fail-open by contract, so "never fired", "fired and self-gated",
// "fired and legitimately found nothing", and "fired and broke" all present identically to an
// outside observer — exit 0, empty stdout, nothing on disk. The plugin's debug logs
// (LOOP_RECALL_DEBUG / LOOP_GRADUATE_DEBUG) do distinguish them, but they are opt-in and default-off,
// so the *normal* state leaves no trace at all. That is exactly how this plugin's hooks stayed a
// silent no-op for days after a migration dropped their .env loading step: nothing anywhere recorded
// that they had stopped working, and it was found only because a human noticed recall felt absent.
//
// This module makes the distinction verifiable after the fact with nobody having opted into anything:
// one small JSONL line per firing, in loop-engine's existing session-scoped run-ledger
// (`<root>/.loop/runs/<run-id>.jsonl`) and in its exact schema v1 shape
// (`{id, type, ts, aggregate_id, payload, version}`). Reusing that ledger rather than inventing a
// parallel one buys free correlation: a `memory.recall` event lands in the same file, under the same
// run-id, as the `run.started` that opened the session. loop-engine's own fold
// (`bin/run-metrics.mjs`) ignores event types it doesn't know, so co-locating costs it nothing.
// A consuming repo without loop-engine just gets a `.loop/runs/` directory of its own.
//
// ⚠️ Same trust boundary as the rest of that ledger (loop-engine lib/run-ledger.mjs): these files are
// gitignored, unprotected local telemetry and are **forgeable** — anyone with shell access can append
// a line by hand. This proves "a record exists that the hook ran", at the same trust level as any
// other local telemetry; it is not a security signal and must not become a gate input.
//
// Contract (all of it is load-bearing — see test/hooks-liveness.test.ts):
//   1. Never throws. Every failure path returns null. UserPromptSubmit exiting non-zero *discards the
//      user's prompt*, so an instrumentation bug must never be able to reach the process's exit code.
//   2. Never writes to stdout. UserPromptSubmit's stdout IS the context-injection channel.
//   3. Never records secrets or free text. Callers pass counts, booleans, distances, and fixed
//      reason slugs — never the prompt, never note content, never an env value, never an error
//      message (a pg error can carry a connection URL). `scrub()` below is the backstop, not the
//      contract.
//   4. Bounded. One line (<1 KiB) per firing, and the append is skipped entirely once the target run
//      file reaches LOOP_LIVENESS_MAX_BYTES (default 8 MiB). Kill switch: LOOP_LIVENESS_OFF=1.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** loop-engine run-ledger schema version. Same shape, same number — a foreign event in that ledger
 *  that claimed a different version would just look like corruption to its consumers. */
export const LEDGER_VERSION = 1;

/** Per-run-file ceiling. A single session's ledger passing this is already pathological (~8k of our
 *  lines plus whatever loop-engine wrote); past it we stop appending rather than keep growing a file
 *  someone will eventually have to read. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Strings in a payload are slugs and counts-as-text, never content — 120 chars is far more than any
 *  legitimate value here and short enough to be useless as an exfiltration channel. */
const STRING_CAP = 120;

/** Same sanitisation as loop-engine's `runIdFrom` — the run-id becomes a filename, so anything that
 *  could steer a path out of `.loop/runs/` is stripped. Empty result → 'unknown' (an honest
 *  unattributed bucket, not a dropped event). */
export function runIdFrom(sessionId) {
  return (
    String(sessionId ?? '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40) || 'unknown'
  );
}

export function runsDir(root, env = process.env) {
  return join(resolve(root, env.LOOP_DIR || '.loop'), 'runs');
}

function maxBytes(env) {
  const n = Number(env.LOOP_LIVENESS_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** Backstop for contract 3: keeps scalars, caps strings, keeps short numeric arrays (distance
 *  lists), recurses one level into plain objects, drops everything else. It cannot make an unsafe
 *  caller safe — a secret shorter than the cap would survive — which is why the callers, not this
 *  function, are where "no secrets, no free text" is actually enforced. */
function scrubValue(v, depth) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length > STRING_CAP ? v.slice(0, STRING_CAP) : v;
  if (Array.isArray(v)) return v.slice(0, 10).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (depth < 2 && typeof v === 'object') return scrub(v, depth + 1);
  return undefined;
}

function scrub(obj, depth = 0) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const s = scrubValue(v, depth);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * Appends one liveness event. Returns the event written, or null if anything at all prevented it
 * (kill switch, size cap, unwritable directory, serialisation failure) — the caller must not care
 * which, and must not change its own behaviour either way.
 *
 * @param {string} root         consuming repo root (CLAUDE_PROJECT_DIR ?? cwd)
 * @param {{type: string, sessionId?: string, payload?: object}} event
 * @param {NodeJS.ProcessEnv} env
 */
export function recordLiveness(root, { type, sessionId, payload }, env = process.env) {
  try {
    if (env.LOOP_LIVENESS_OFF === '1' || env.LOOP_LEARNING_OFF === '1' || env.LOOP_MEMORY_RECALL_ONLY === '1' || env.LOOP_MEMORY_OFF === '1') return null;
    // The session_id off the hook's own stdin is the primary source; CLAUDE_CODE_SESSION_ID is the
    // fallback for a firing whose stdin carried none. Both agree with the filename loop-engine's
    // instrumentation hook uses, so events correlate without either side coordinating.
    const runId = runIdFrom(env.LOOP_RUN_ID || sessionId || env.CLAUDE_CODE_SESSION_ID);
    const dir = runsDir(root, env);
    const file = join(dir, `${runId}.jsonl`);
    try {
      if (statSync(file).size >= maxBytes(env)) return null;
    } catch {
      /* absent file = size 0 — fall through and create it */
    }
    mkdirSync(dir, { recursive: true });
    const event = {
      id: randomUUID(),
      type,
      ts: new Date().toISOString(),
      aggregate_id: runId,
      payload: scrub(payload ?? {}),
      version: LEDGER_VERSION,
    };
    // One appendFileSync of a single sub-PIPE_BUF line: O_APPEND makes it atomic on POSIX, so a
    // concurrent writer (loop-engine's own hook, another session) can't interleave with it.
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    return event;
  } catch {
    return null; // contract 1 — instrumentation never reaches the exit code
  }
}

/** An error's `code` when it is a short, opaque identifier (ECONNREFUSED, ETIMEDOUT, ...). Error
 *  *messages* are never recorded: a pg/undici error message can embed a connection URL with
 *  credentials in it. */
export function errorCode(e) {
  const c = e?.code;
  return typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : null;
}
