#!/usr/bin/env node
// SessionStart hook — graduates verified file lessons (.loop/lessons, loop-engine's convention) into
// loop-memory's pgvector semantic layer, so the UserPromptSubmit recall hook sees a fresh corpus.
// Idempotent (already-graduated lessons are skipped via the lesson id's `lesson:<id>` keyword).
//
// ⚠️ FAIL-OPEN: always exit 0, no context injection (silent sync only). No key / pgvector down → no-op.
// Self-gating: without an embedding key, this does not sync at all (avoids poisoning the store with
// stub vectors).
//
// Debug: LOOP_GRADUATE_DEBUG=1 logs the child process's exit code/stderr to
// `${CLAUDE_PLUGIN_DATA}/graduate-debug.log` (fail-open hides child failures otherwise) — opt-in,
// default-off.
//
// Liveness (paul-loop issue #35): *always on*, one JSONL line per firing into loop-engine's session
// run ledger (`.loop/runs/<run-id>.jsonl`, type `memory.graduate`) — see hooks/lib/liveness.mjs.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotenv } from './lib/load-dotenv.mjs';
import { errorCode, recordLiveness } from './lib/liveness.mjs';

const env = process.env;
const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
const pluginRoot = env.CLAUDE_PLUGIN_ROOT || join(import.meta.dirname, '..');
const dataDir = env.CLAUDE_PLUGIN_DATA || pluginRoot;
const startedAt = Date.now();

function dbg(msg) {
  if (env.LOOP_GRADUATE_DEBUG !== '1') return;
  try {
    appendFileSync(join(dataDir, 'graduate-debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging failure is ignored */
  }
}

// This hook is wired to *both* SessionStart and SessionEnd, so the ledger records which one fired —
// otherwise a session that graduated only on exit looks the same as one that graduated on entry.
//
// The lifecycle name comes from `--event <name>` in hooks/hooks.json, deliberately **not** from the
// hook's stdin JSON: this script has never read stdin, and a read-to-EOF here can hang forever when
// fd 0 is an inherited pipe nobody closes (measured: a hand-run inside `$(...)` wedged permanently).
// A SessionStart hook that hangs stalls session startup, which is a far worse bug than a missing
// label. The recall hook is different — it must read stdin for the prompt anyway.
//
// Session attribution therefore falls back to CLAUDE_CODE_SESSION_ID (see liveness.mjs); where the
// runtime doesn't supply it the event lands in the honest `unknown` run bucket. It still proves the
// firing, it just doesn't correlate to one session — recall, the hook issue #35 is actually about,
// gets a real session id off the stdin it already reads.
const eventFlag = process.argv.indexOf('--event');
const live = {
  outcome: 'error',
  reason: 'unreachable',
  event: eventFlag !== -1 ? (process.argv[eventFlag + 1] ?? null) : null,
  key: false,
  dotenv: false,
};

/** Single exit point — every path out of this hook leaves exactly one ledger line. */
function done(outcome, reason) {
  live.outcome = outcome;
  live.reason = reason;
  live.ms = Date.now() - startedAt;
  // Belt and braces: recordLiveness already swallows everything, but the exit-0 contract must not
  // depend on that staying true — a throw escaping here would reach the catch, call done() again, and
  // eventually surface as a non-zero exit.
  try {
    recordLiveness(projectDir, { type: 'memory.graduate', payload: live }, env);
  } catch {
    /* instrumentation never affects the session */
  }
  process.exit(0);
}

// Bridges Claude Code's userConfig injection (CLAUDE_PLUGIN_OPTION_<KEY> — hooks can't use
// ${user_config.KEY} substitution, per the plugins spec) into the plain env var names the CLI
// itself reads, so the CLI stays plugin-agnostic and also works for a bare shell invocation.
const childEnv = { ...env };
for (const [pluginOpt, plain] of [
  ['CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  ['CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY', 'GEMINI_API_KEY'],
  ['CLAUDE_PLUGIN_OPTION_LOOP_DATABASE_URL', 'LOOP_DATABASE_URL'],
  ['CLAUDE_PLUGIN_OPTION_LOOP_MEMORY_SIGNING_KEY', 'LOOP_MEMORY_SIGNING_KEY'],
  ['CLAUDE_PLUGIN_OPTION_LOOP_DOTENV_PATH', 'LOOP_DOTENV_PATH'],
]) {
  if (!childEnv[plain] && env[pluginOpt]) childEnv[plain] = env[pluginOpt];
}
// Then the repo's gitignored dotenv file, for keys neither the session env nor userConfig supplied
// (Claude Code passes hooks the session process env only — it does not read .env files, so a key that
// lives solely in .env would hit the no-key gate below and no-op silently). Runs *after* the bridge
// above so the file never overrides an explicit export or userConfig value.
const dotenv = loadDotenv(projectDir, childEnv.LOOP_DOTENV_PATH, childEnv);
dbg(dotenv ? `dotenv: loaded ${dotenv}` : 'dotenv: none found');
// Boolean only — the resolved path can be absolute, outside the repo, and is by definition where the
// secrets are.
live.dotenv = !!dotenv;
// Source tag (paul-loop issue #35) — self-reported, good-faith metadata for observability/debugging,
// NOT a security or forgery-proof signal. Anyone with shell access can run `node dist/cli.js graduate`
// directly and set this same env var by hand, at the same trust level as querying the database
// directly — there is nothing here that only a real, live-firing hook could produce. This tags rows as
// "explicitly marked as coming from the hook code path" vs. "not marked", nothing stronger. Always
// overwrite (this script's own invocation IS that code path — no legitimate reason for an inherited
// value to survive here).
childEnv.LOOP_MEMORY_SOURCE = 'hook';

live.key = !!(childEnv.OPENAI_API_KEY || childEnv.GEMINI_API_KEY);

try {
  if (env.LOOP_RECALL_OFF === '1') done('skipped', 'recall_off');
  if (!live.key) done('skipped', 'no_embedding_key');

  const cli = join(pluginRoot, 'dist', 'cli.js');
  const args = [cli, 'graduate', '--lessons', join(projectDir, '.loop', 'lessons')];
  // Knowledge-corpus sources (ADR dir / glossary file / research dir / design dir) are opt-in via
  // plugin userConfig — omitted entirely (not defaulted to any path) unless the consuming repo
  // configures them, since these paths and their markdown conventions (`# ADR-NNNN: Title` headers,
  // `**Term**:` glossary paragraphs) are this plugin's assumed format, not a universal one. See
  // README "Knowledge corpus" section.
  for (const [pluginOpt, flag] of [
    ['CLAUDE_PLUGIN_OPTION_LOOP_ADR_DIR', '--knowledge'],
    ['CLAUDE_PLUGIN_OPTION_LOOP_CONTEXT_FILE', '--context'],
    ['CLAUDE_PLUGIN_OPTION_LOOP_RESEARCH_DIR', '--research'],
    ['CLAUDE_PLUGIN_OPTION_LOOP_DESIGN_DIR', '--design'],
  ]) {
    if (env[pluginOpt]) args.push(flag, join(projectDir, env[pluginOpt]));
  }
  const res = spawnSync('node', args, { cwd: projectDir, timeout: 12000, encoding: 'utf8', env: childEnv });
  // null on timeout/signal — kept distinct from a real exit code rather than flattened.
  live.cli_status = typeof res.status === 'number' ? res.status : null;
  if (res.status !== 0) {
    // stderr goes to the opt-in debug log only. It is the CLI's own prose, but it can quote a
    // connection URL, so it must not reach the ledger.
    dbg(`cli status=${res.status} stderr=${String(res.stderr ?? '').slice(0, 500)}`);
    done('error', 'cli_failed');
  }
  dbg('cli status=0 ok');
  // Intentionally silent on success — refreshes the store without cluttering session context.
  done('synced', 'ok');
} catch (e) {
  dbg(`catch: ${e?.message ?? String(e)}`);
  live.error_code = errorCode(e); // code only, never the message (it can embed credentials)
  done('error', 'exception'); /* fail-open */
}
