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
// `${CLAUDE_PLUGIN_DATA}/graduate-debug.log` (fail-open hides child failures otherwise).
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
const pluginRoot = env.CLAUDE_PLUGIN_ROOT || join(import.meta.dirname, '..');
const dataDir = env.CLAUDE_PLUGIN_DATA || pluginRoot;

function dbg(msg) {
  if (env.LOOP_GRADUATE_DEBUG !== '1') return;
  try {
    appendFileSync(join(dataDir, 'graduate-debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging failure is ignored */
  }
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
]) {
  if (!childEnv[plain] && env[pluginOpt]) childEnv[plain] = env[pluginOpt];
}
// Source tag (paul-loop issue #35) — self-reported, good-faith metadata for observability/debugging,
// NOT a security or forgery-proof signal. Anyone with shell access can run `node dist/cli.js graduate`
// directly and set this same env var by hand, at the same trust level as querying the database
// directly — there is nothing here that only a real, live-firing hook could produce. This tags rows as
// "explicitly marked as coming from the hook code path" vs. "not marked", nothing stronger. Always
// overwrite (this script's own invocation IS that code path — no legitimate reason for an inherited
// value to survive here).
childEnv.LOOP_MEMORY_SOURCE = 'hook';

try {
  if (env.LOOP_RECALL_OFF !== '1' && (childEnv.OPENAI_API_KEY || childEnv.GEMINI_API_KEY)) {
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
    if (res.status !== 0) {
      dbg(`cli status=${res.status} stderr=${String(res.stderr ?? '').slice(0, 500)}`);
    } else {
      dbg('cli status=0 ok');
    }
    // Intentionally silent on success — refreshes the store without cluttering session context.
  }
} catch (e) {
  dbg(`catch: ${e?.message ?? String(e)}`);
  /* fail-open */
}
process.exit(0);
