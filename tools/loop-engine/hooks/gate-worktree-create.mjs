#!/usr/bin/env node
// PreToolUse guardrail — when `git worktree add` creates a new branch (not just explicit `-b`/`-B`,
// but also when git DWIM-creates one because the commit-ish was omitted), detects and blocks it unless
// the base is an explicit origin/* ref. Machinery for "create new worktrees from origin/<integration
// branch>, not local" (see this repo's own worktree-discipline convention, if it has one). Prevents
// the recurring incident where a worktree created from a stale local branch conflicts, file-by-file,
// with another PR that already merged.
//
// This hook is a guardrail, not a boundary — it's bypassable, and a coarse-net parser can't fully
// emulate shell syntax.
//
// Why PreToolUse(Bash) instead of Claude Code's official WorktreeCreate hook event: per official docs
// (code.claude.com/docs/en/hooks), WorktreeCreate only fires for Claude Code's own worktree mechanisms
// (the EnterWorktree tool, Agent isolation:"worktree", a background session, etc.) — not for a manual
// `git worktree add` run directly via Bash, which is how most repos following this harness actually
// create worktrees. So this follows the repo's existing pattern instead (the same way
// gate-before-merge.mjs intercepts `git merge`/`git pull` via a PreToolUse+Bash matcher and a
// tokenizer).
//
// Unlike gate-before-merge.mjs, this hook doesn't need the "single simple command" constraint: the
// base ref for `git worktree add` is an explicit token inside that one segment (unlike merge/pull's
// target, which depends on cwd's implicit HEAD) — so however much chaining surrounds it, this
// segment's own judgment is unaffected. That's why a chained idiom like
// `git fetch origin && git worktree add -b <branch> <path> origin/main` still evaluates cleanly,
// segment by segment.
//
// Scope: only calls that create a new branch. Covers not just explicit `-b`/`-B` but also
// `git worktree add <path>` with the commit-ish omitted (git auto-creates a new branch from local HEAD
// as if `-b $(basename <path>)` were given — the exact failure mode this hook exists to catch).
// `--detach`/`--orphan`, or attaching an existing branch explicitly (a commit-ish is given), are out of
// scope. Any `origin/*` ref is accepted, not just the integration branch — covering both the common
// case and the documented exception (e.g. `git worktree add -b main <path> origin/main`, a
// main-tracking-only worktree) with one rule.

import { readFileSync } from 'node:fs';
import {
  firstSubcommand,
  GIT_VALUE_GLOBAL,
  splitSegments,
  stripHeredocs,
  stripPrefix,
  tokenize,
} from './command-tokenizer.mjs';
import { logRedEvent } from './red-events-log.mjs';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code injects this at hook runtime.
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function allow() {
  process.exit(0);
}
function deny(reason, code) {
  logRedEvent(root, { kind: 'worktree-create-guard', code });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// `git worktree add`'s own value flags — -b/-B are the new branch name, --reason is a --lock message.
const VALUE_WORKTREE_ADD = new Set(['-b', '-B', '--reason']);

// `git [global opts] worktree add [flags...] <path> [<ref>]` -> { newBranch, ref } | null (not a match).
function parseWorktreeAdd(rawToks) {
  const toks = stripPrefix(rawToks);
  if (toks[0] !== 'git') return null;
  const wIdx = firstSubcommand(toks, 1, GIT_VALUE_GLOBAL);
  if (toks[wIdx] !== 'worktree' || toks[wIdx + 1] !== 'add') return null;
  let i = wIdx + 2;
  let explicitNewBranch = false;
  let detachOrOrphan = false;
  const positional = [];
  while (i < toks.length) {
    const t = toks[i];
    if (t === '-b' || t === '-B') explicitNewBranch = true;
    if (t === '--detach' || t === '-d' || t === '--orphan') detachOrOrphan = true;
    if (t.startsWith('-')) {
      i += VALUE_WORKTREE_ADD.has(t) && !t.includes('=') ? 2 : 1;
      continue;
    }
    positional.push(t);
    i += 1;
  }
  // When the commit-ish is omitted (and none of -b/-B/--detach/--orphan is given), git DWIMs a new
  // branch from local HEAD as if -b $(basename <path>) were given (per `git worktree add` docs) — the
  // same risk as an explicit -b/-B, so treated identically.
  const dwimNewBranch = !explicitNewBranch && !detachOrOrphan && positional.length <= 1;
  return { newBranch: explicitNewBranch || dwimNewBranch, ref: positional[1] ?? null };
}

// -- Detection (fail-open: an uncertain parse / a non-target command passes) -------------------------
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}
if (payload?.tool_name !== 'Bash') allow();
const cmd = payload?.tool_input?.command;
if (typeof cmd !== 'string' || !cmd) allow();

let segs;
try {
  segs = splitSegments(stripHeredocs(cmd)).map(tokenize).map(parseWorktreeAdd).filter(Boolean);
} catch {
  allow();
}
if (!segs.some((s) => s.newBranch)) allow();

// -- Confirmed -> fails closed from here: a branch-creating worktree add without an origin/* base --
try {
  for (const seg of segs) {
    if (!seg.newBranch) continue;
    if (!seg.ref) {
      deny(
        "When `git worktree add` creates a new branch (-b/-B, or an omitted commit-ish), omitting the " +
          "base ref makes local HEAD the implicit base (if local is behind origin, this conflicts with " +
          "another already-merged PR). Specify an origin/* ref explicitly, e.g. " +
          "`git fetch origin && git worktree add -b <branch> <path> origin/<integration-branch>`.",
        'no-explicit-ref',
      );
    }
    if (!seg.ref.startsWith('origin/')) {
      deny(
        `'${seg.ref}' is a local ref — since merges all happen server-side (GitHub), the server ` +
          "(origin) is the source of truth. Specify an origin/* ref explicitly, e.g. " +
          "`git fetch origin && git worktree add -b <branch> <path> origin/<integration-branch>`.",
        'non-origin-ref',
      );
    }
  }
  allow();
} catch (e) {
  deny(
    `worktree-create guard internal error (fail-closed): ${String(e?.message ?? e).split('\n')[0]}`,
    'internal-error',
  );
}
