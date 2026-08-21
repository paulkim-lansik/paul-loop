#!/usr/bin/env node
// SessionStart hook — a self-improvement dashboard heartbeat. Cost ceiling: 0 embedding API calls, 0
// docker exec, 0 pnpm/CLI spawns, at most 2 git calls (check (1)'s `git status` +, if a project-local
// `.env` isn't found, a `git rev-parse --git-common-dir` fallback probe for a main-worktree `.env` —
// this fallback fires on essentially every call from a feature worktree), 1 localhost TCP probe (check
// (3) below):
//   (1) an uncommitted verified lesson (.loop/lessons/*.json) -> a reproducibility-gap nudge (won't be
//       seen by another clone until committed)
//   (2) `pnpm loop:doctor` (or this repo's equivalent) hasn't run in 7+ days (.loop/doctor.last) -> a
//       full self-check nudge
//   (3) semantic-recall layer liveness: unless `LOOP_RECALL_OFF=1`, always judged. If an embedding key
//       is present but loop-memory's pgvector isn't reachable -> a "pgvector is down" nudge. If no key
//       is present at all -> **also** a nudge (a worktree-isolated setup can silently be off, and
//       "no key = intentionally off" is not a safe assumption to make silently). `LOOP_RECALL_OFF=1` is
//       the only silent opt-out.
// The full diagnostic (a real pgvector query, a recall smoke test) is too expensive for a SessionStart
// hook — that's `pnpm loop:doctor`'s job. Same shape as a deps-audit heartbeat (SessionStart is the
// right mechanism for a local-cadence reminder).
//
// ⚠️ FAIL-OPEN: always exit 0. Disable with LOOP_DOCTOR_HEARTBEAT_OFF=1.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const DAY = 86_400_000;
const EVERY_DAYS = 7;

// Bridges Claude Code's userConfig injection (CLAUDE_PLUGIN_OPTION_<KEY>) — as declared by the
// loop-memory plugin's own userConfig schema — into the plain env var names this check reads, the
// same way loop-memory's own hooks do. A plain shell-exported value always wins if already set.
for (const [pluginOpt, plain] of [
  ['CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  ['CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY', 'GEMINI_API_KEY'],
  ['CLAUDE_PLUGIN_OPTION_LOOP_DATABASE_URL', 'LOOP_DATABASE_URL'],
]) {
  if (!env[plain] && env[pluginOpt]) env[plain] = env[pluginOpt];
}

try {
  if (env.LOOP_DOCTOR_HEARTBEAT_OFF === '1') process.exit(0);
  const root = env.CLAUDE_PROJECT_DIR || process.cwd();
  const nudges = [];

  // (1) Uncommitted lessons — the cheapest git signal. Silently skipped on non-git / a git failure
  // (fail-open).
  try {
    const st = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', '.loop/lessons'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = st
      .split('\n')
      .filter((l) => l.startsWith('??') && l.trim().endsWith('.json')).length;
    if (untracked > 0) nudges.push(`${untracked} uncommitted verified lesson(s) — commit so other clones see them`);
  } catch {
    /* fail-open */
  }

  // (2) Self-diagnostic is stale or has never run.
  try {
    const stamp = join(root, '.loop', 'doctor.last');
    const last = existsSync(stamp) ? parseInt(readFileSync(stamp, 'utf8').trim(), 10) || 0 : 0;
    const days = last ? Math.floor((Date.now() - last) / DAY) : null;
    if (days === null || days >= EVERY_DAYS)
      nudges.push('loop self-diagnostic is stale — run `pnpm loop:doctor` (or this repo\'s equivalent)');
  } catch {
    /* fail-open */
  }

  // (3) Semantic-recall layer liveness. If `LOOP_RECALL_OFF=1` is set, that's an intentional opt-out —
  // pass silently (don't re-flag an intentional off-switch as noise). Otherwise it splits on key
  // presence:
  //   - key present but the DB isn't reachable -> a "pgvector is down" nudge.
  //   - no key at all -> **still nudge** (a worktree-isolated setup can be silently dead, and "no key =
  //     intentional off" is not something this heartbeat can safely assume without evidence).
  try {
    if (env.LOOP_RECALL_OFF !== '1') {
      const hasKey = !!(env.OPENAI_API_KEY || env.GEMINI_API_KEY);
      if (!hasKey) {
        nudges.push(
          'semantic recall is fully off — no embedding key (can be silently dead due to worktree isolation) — ' +
            'run `pnpm loop:doctor` to check, or set `LOOP_RECALL_OFF=1` if this is intentional',
        );
      } else {
        const { tcpReachable } = await import('../lib/tcp-reachable.mjs');
        const dbUrl = env.LOOP_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5434/loop_memory';
        const db = await tcpReachable(dbUrl, 2000);
        if (!db.ok) {
          nudges.push(
            `semantic recall is off — an embedding key is set but pgvector isn't reachable (${db.label}) — ` +
              'start loop-memory\'s database (see its docker-compose.yml / README)',
          );
        }
      }
    }
  } catch (e) {
    // fail-open — this hook missing one nudge matters less than wedging the session. Still, total
    // silence regardless of cause would make "plugin not resolved" indistinguishable from "a transient
    // git/DB error", so a breadcrumb only.
    console.error(
      `[loop-doctor-heartbeat] semantic-recall check failed (fail-open): ${String(e?.message ?? e)}`,
    );
  }

  if (nudges.length) console.log(`🩺 loop-doctor: ${nudges.join(' · ')}`);
} catch {
  /* fail-open */
}
process.exit(0);
