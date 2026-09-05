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
//
// ── Second feature worktree in one session -> REQUIRE (human approval) ───────────────────────────
// Second job (BAC-778): opening a *second* `feature/*` worktree inside one session is the mechanical
// half of a scope boundary this harness draws in prose — a run takes one issue to an open PR and
// STOPS there for the human. An audited run opened its PR and then started an entirely new issue in
// the same session, with nothing to catch it. A second feature worktree is the earliest mechanically
// observable moment of that, so this hook escalates it to `permissionDecision: "ask"` (Claude Code's
// human-approval prompt = the gate vocabulary's REQUIRE) rather than denying: starting a second
// feature is legitimate when a human says so, and only when a human says so.
//
// Exempt: everything that isn't a feature branch — `lessons/*`, `chore/*`, `fix/*`, `docs/*`, and a
// detached or existing-branch worktree (already out of this hook's newBranch scope). The prefix is
// read from a consuming repo's `.claude/ship-flow.config.json` -> `featureBranchPrefix`; without
// config it defaults to `feature/`. Kill switch: LOOP_WORKTREE_SESSION_GATE_OFF=1.
//
// ⚠️ How "one session" is determined, and what that can't see (be honest about the limits):
//   - The counter is keyed on the PreToolUse payload's `session_id`, persisted at
//     `<CLAUDE_PROJECT_DIR>/.loop/worktree-gate.<session>.json` (same per-session-file technique as
//     gate-stop-verdict.mjs's deny counter, and for the same reason — a shared file would let two
//     concurrent sessions reset each other).
//   - No `session_id` on the payload -> no escalation at all (allow). A missing id can't be told
//     apart from "some other session", and collapsing every session into one bucket would REQUIRE on
//     the second feature worktree *ever created in this repo*. Undeterminable -> don't claim it.
//   - A subagent has its own session id, so a subagent-created worktree neither counts toward nor
//     sees the parent's budget. A `--resume`/`--continue` that starts a new session id starts a new
//     budget. Deleting `.loop/worktree-gate.*.json` resets it.
//   - Worktrees created through Claude Code's own mechanisms (`EnterWorktree`, `Agent
//     isolation:"worktree"`) never reach a Bash PreToolUse hook — same blind spot the header above
//     already describes for the origin/* rule.
//   - Requests stay pending. On subsequent Bash PreToolUse calls, Git's actual worktree list must
//     match the requested repository, branch AND physical path before it counts as confirmed.
//     No tool_response or pending prompt is approval evidence. Failed attempts consume no slot;
//     a successful second creation is confirmed later without pretending this hook observed approval.
//   - This observation-based guard cannot attribute an identical creation by another process or
//     serialize simultaneous unobserved first requests. State is local/best-effort, not authority.

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { observationCache, queueRequests, reconcile, requestedWorktree, saveSession, sessionState, unseenRequests } from '../lib/worktree-session-state.mjs';
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
const env = process.env;
const root = env.CLAUDE_PROJECT_DIR ?? process.cwd();

const DEFAULT_FEATURE_PREFIX = 'feature/';

function featureBranchPrefix(projectRoot) {
  try {
    const cfg = JSON.parse(
      readFileSync(join(projectRoot, '.claude', 'ship-flow.config.json'), 'utf8'),
    );
    if (typeof cfg.featureBranchPrefix === 'string' && cfg.featureBranchPrefix) {
      return cfg.featureBranchPrefix;
    }
  } catch {
    /* missing/unreadable config -> fall through to the default */
  }
  return DEFAULT_FEATURE_PREFIX;
}

function allow() {
  process.exit(0);
}
function decide(decision, reason, code) {
  logRedEvent(root, { kind: 'worktree-create-guard', code });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}
const deny = (reason, code) => decide('deny', reason, code);
const ask = (reason, code) => decide('ask', reason, code);

// `git worktree add`'s own value flags — -b/-B are the new branch name, --reason is a --lock message.
const VALUE_WORKTREE_ADD = new Set(['-b', '-B', '--reason']);
const literal = (word) => word.length >= 2 && ['"', "'"].includes(word[0]) && word.slice(-1) === word[0] ? word.slice(1, -1) : word;

// `git [global opts] worktree add [flags...] <path> [<ref>]` -> { newBranch, ref } | null (not a match).
function parseWorktreeAdd(rawToks, cwd) {
  const toks = stripPrefix(rawToks);
  if (toks[0] !== 'git') return null;
  const wIdx = firstSubcommand(toks, 1, GIT_VALUE_GLOBAL);
  if (toks[wIdx] !== 'worktree' || toks[wIdx + 1] !== 'add') return null;
  for (let g = 1; g < wIdx; g++) {
    if (toks[g] === '-C') { g++; if (cwd) cwd = resolve(cwd, toks[g]); }
    else if (cwd && toks[g].startsWith('-C') && toks[g].length > 2) cwd = resolve(cwd, toks[g].slice(2));
    // Unmodelled explicit plumbing must never be attributed to the wrong repository.
    else if (/^--(git-dir|work-tree)(=|$)/.test(toks[g])) cwd = null;
  }
  let i = wIdx + 2;
  let explicitNewBranch = false;
  let detachOrOrphan = false;
  let explicitBranchName = null;
  const positional = [];
  while (i < toks.length) {
    const t = toks[i];
    if (t === '-b' || t === '-B') {
      explicitNewBranch = true;
      explicitBranchName = toks[i + 1] ?? null;
    }
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
  // The DWIM branch name is the path's basename, by the same doc'd rule.
  const branch = explicitNewBranch
    ? explicitBranchName
    : dwimNewBranch && positional[0]
      ? basename(positional[0])
      : null;
  return { newBranch: explicitNewBranch || dwimNewBranch, ref: positional[1] ?? null, branch, path: positional[0], cwd };
}

// Per-session record of feature branches this session already opened a worktree for. Best-effort:
// an unreadable/unwritable state file means the escalation simply doesn't fire (it must never turn
// into a broken-state deny — the origin/* rule above is this hook's actual gate).
function sessionStatePath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return safe ? join(root, '.loop', `worktree-gate.${safe}.json`) : null;
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
const sid = typeof payload.session_id === 'string' ? payload.session_id : '';
const stateFile = env.LOOP_WORKTREE_SESSION_GATE_OFF !== '1' && sid ? sessionStatePath(sid) : null;
const observe = observationCache();
const state = stateFile ? reconcile(sessionState(stateFile), observe) : null;
if (stateFile) saveSession(stateFile, state); // even a later non-creation command can confirm execution

let segs;
try {
  let cwd = typeof payload.cwd === 'string' ? payload.cwd : root;
  segs = splitSegments(stripHeredocs(cmd)).map((segment) => tokenize(segment).map(literal)).map((tokens) => {
    const plain = stripPrefix(tokens);
    if (plain[0] === 'cd' && plain.length === 2) cwd = resolve(cwd, plain[1]);
    return parseWorktreeAdd(tokens, cwd);
  }).filter(Boolean);
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

  // -- Every origin/* check passed. Now the session-scope escalation (see header) ------------------
  // Deliberately after the deny checks: a command that never runs must not consume the budget.
    if (stateFile) {
      const prefix = featureBranchPrefix(root);
      const requests = segs
        .filter((s) => s.newBranch && typeof s.branch === 'string' && s.branch.startsWith(prefix))
        .map(requestedWorktree).filter(Boolean);
      if (requests.length) {
        const unseen = unseenRequests(state, requests);
        const requiresApproval = state.confirmed.length + unseen.length > 1;
        queueRequests(state, requests, observe, requiresApproval);
        saveSession(stateFile, state); // pending prompts remain pending, including denied/cancelled retries
        if (unseen.length) {
          if (requiresApproval) {
            ask(
              `REQUIRE (human approval): this session has ${state.confirmed.length} Git-confirmed ${prefix}* branch(es) ` +
                `(${state.confirmed.map((r) => r.branch).join(', ') || 'none'}); this command requests ` +
                `${unseen.map((r) => r.branch).join(', ')}. One run ` +
                `takes one issue to an open PR and stops there — starting a second feature in the ` +
                `same session is a scope-boundary decision a human makes, not the run. Approve if ` +
                `that's intended; otherwise finish (or hand off) the first one in a fresh session.`,
              'second-feature-worktree',
            );
          }
        }
      }
    }
  allow();
} catch (e) {
  deny(
    `worktree-create guard internal error (fail-closed): ${String(e?.message ?? e).split('\n')[0]}`,
    'internal-error',
  );
}
