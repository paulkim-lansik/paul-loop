#!/usr/bin/env node
// PreToolUse guard — reward-hacking defense: blocks **Edit/Write/MultiEdit (file paths) and Bash
// (shell mutation)** against files that decide the verifier's outcome (a consuming repo's
// `.loop/protect.globs`), at the harness level.
//
// Arming is structural, not prose: relying only on a `.loop/looping` sentinel (touched by the loop
// being watched, i.e. by the very agent it's meant to constrain) leaves the guard silently off
// whenever context gets compacted and the agent forgets to arm it. Armed state is decided by a shared
// judge (lib/protect-globs.mjs `guardState`):
//   armed = `.loop/looping` present (owned by loop-fix.sh — takes priority over guard-off)
//        OR (on a working branch, outside the consuming repo's protected-branch set, AND no valid
//            `.loop/guard-off`)
// Legitimate edits to protected files (writing a failing TDD test, touching package.json/turbo.json)
// escape via: `echo '<reason>' > .loop/guard-off` (empty file is invalid; TTL 30 min — prevents a
// permanent off-switch) -> edit -> `rm -f .loop/guard-off`, with the reason recorded in the PR body.
//
// Bash channel: what a shell touches is undecidable in general -> a conservative coarse net. Blocks
// only when a command (a) looks mutating (rm/mv/cp/sed -i/redirection/etc.) AND (b) contains a token
// that hits a protected glob. Pure reads (cat/grep/pnpm test/etc.) pass through. The real boundary is
// PR review, not this hook.
//
// Rooting: arming and glob matching are judged at the *target's* worktree, not the session's
// CLAUDE_PROJECT_DIR (BAC-785) — see the effective-root block below. On the Bash channel "the target"
// can only mean the session's cwd (what a shell touches is undecidable), so that channel is rooted at
// cwd's worktree — a coarser net, in keeping with it being a guardrail and not a boundary.
//
// fail-open: internal error / non-git / detached -> allow (never wedge the session).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code injects this at hook runtime (not a
// turbo task var).
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
// This hook ships inside loop-engine's own package (hooks/ is a sibling of lib/), so "where is the
// plugin I need to protect" is just "the directory one level above this file" — no cross-package
// resolution needed.
const pluginPath = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

let GUARD_OFF_TTL_MS;
let globToRegExp;
let guardState;
let isInsideRoot;
let loadPatterns;
let resolveWorktreeRoot;
try {
  ({ GUARD_OFF_TTL_MS, globToRegExp, guardState, isInsideRoot, loadPatterns, resolveWorktreeRoot } =
    await import('../lib/protect-globs.mjs'));
} catch (e) {
  console.error(`[protect-during-loop] judge module load failed (fail-open): ${String(e?.message ?? e)}`);
  process.exit(0);
}

// stdin is parsed BEFORE the arming verdict (BAC-785). It used to be the other way round:
// `guardState(root)` ran first and `if (!state.armed) process.exit(0)` reached a verdict before the
// target path was even known. In a worktree-isolated session root is the MAIN worktree, parked on an
// unprotected branch — so the guard disarmed itself for every edit the session made, in the exact
// workflow the consuming repo mandates.
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // stdin parse failure -> fail-open
}
const tool = payload?.tool_name;
const input = payload?.tool_input ?? {};

const str = (v) => (typeof v === 'string' && v ? v : '');
// `cwd` is present on PreToolUse payloads for Edit and Write — MEASURED, not assumed (issue #63,
// 2026-08-27). A capture hook on `matcher: "Edit|Write"` in a session started inside a git worktree
// recorded `cwd` on both tools, and its value was the WORKTREE path, not the main checkout's — which
// is the exact property the re-rooting below depends on. `process.cwd()` stays as a fallback (it
// measured identical in the same capture) so behaviour degrades rather than breaks if that ever
// changes. Both candidates still have to pass the same-repository check below, so neither can
// re-root anywhere wrong.
//
// Why the measurement had to be external: the hermetic tests build the payload themselves and inject
// `cwd`, so they are green whether or not Claude Code actually sends it. That is an AC-level
// false-green — the test proves this file's handling, never the premise it handles.
const sessionDir = str(payload?.cwd) || process.cwd();
const target = tool === 'Bash' ? sessionDir : str(input?.file_path);

// Effective root: the target's own worktree -> the session's worktree -> root.
let effRoot = root;
let rerooted = null;
try {
  rerooted = resolveWorktreeRoot(root, target);
  if (rerooted) {
    effRoot = rerooted.top;
  } else if (target && target !== sessionDir && !isInsideRoot(root, target)) {
    // The target belongs to no worktree of this repo — the plugin's own install path being the case
    // that matters. Without this step the absolute-prefix self-protection further down stays off in
    // exactly the sessions it exists for, because arming would still be judged at `root`.
    // (Skipped when target IS sessionDir — the Bash channel — since that call just failed above.)
    const viaSession = resolveWorktreeRoot(root, sessionDir);
    if (viaSession) effRoot = viaSession.top;
  }
} catch (e) {
  // Keep root (fail-open, unchanged behaviour) — but say so. What this hides is precisely the bug
  // BAC-785 fixes: the guard quietly falling back to root and disarming itself. Its sibling catches
  // both log; a silent one here would make a regression into this bug class indistinguishable from
  // normal operation. Only reachable when the target is outside root, so it can't spam every call.
  console.error(`[protect-during-loop] worktree re-root failed (fail-open): ${String(e?.message ?? e)}`);
}

let state;
try {
  state = guardState(effRoot);
  // Re-rooting must never DISARM. It exists to find protection `root` missed, not to escape
  // protection `root` had: with the session on an armed worktree, a Bash command whose cwd points at
  // the main worktree used to be denied, and re-rooting to that unprotected branch would hand back a
  // way out. Costs one extra branch lookup, and only on the rare unarmed-after-re-root path.
  if (!state.armed && effRoot !== root) state = guardState(root);
} catch (e) {
  console.error(`[protect-during-loop] arming verdict failed (fail-open): ${String(e?.message ?? e)}`);
  process.exit(0);
}
if (!state.armed) process.exit(0);

const globFile = join(effRoot, '.loop', 'protect.globs');
if (!existsSync(globFile)) process.exit(0);

let patterns;
try {
  patterns = loadPatterns(globFile);
} catch (e) {
  // Unreadable glob file (permissions, a truncated write) -> allow. This file declares fail-open as
  // its contract; an uncaught throw here would exit non-zero and wedge the tool call instead.
  console.error(`[protect-during-loop] protect.globs unreadable (fail-open): ${String(e?.message ?? e)}`);
  process.exit(0);
}
const matchesGlob = (tok) => patterns.some((p) => globToRegExp(p).test(tok));

const TTL_MIN = Math.round(GUARD_OFF_TTL_MS / 60000);
function escapeHint() {
  if (state.mode === 'sentinel') {
    return 'A loop-fix loop is armed (.loop/looping, owned by loop-fix.sh) — retry after the loop ends.';
  }
  const why =
    state.mode === 'guard-off-empty'
      ? ' (.loop/guard-off is empty and invalid — a reason string is required)'
      : state.mode === 'guard-off-expired'
        ? ` (.loop/guard-off window expired — TTL ${TTL_MIN}min)`
        : '';
  return (
    `On a working branch (${state.branch}) the guard is always armed${why}. ` +
    `For a legitimate change: echo '<reason>' > .loop/guard-off (${TTL_MIN}min window) -> edit -> ` +
    `rm -f .loop/guard-off, and record the reason in the PR body.`
  );
}

function deny(reason) {
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

// -- Bash channel: a fixer changing verifier-deciding files via shell (reward-hacking) --------------
if (tool === 'Bash') {
  const cmd = input?.command;
  if (typeof cmd !== 'string' || !cmd) process.exit(0);
  // (a) does it look mutating — conservative; the real gate is the token match below, so
  // over-matching here is harmless (it only lets more commands through the mutation check).
  // `ln` belongs here for the same reason `mv` does: `ln -sf /dev/null tests/x.test.ts` and
  // `ln -f decoy tests/x.test.ts` both replace a protected file's content without any of the verbs
  // that were listed. It was the one obvious mutation verb missing.
  const mutates =
    /(^|[\s;&|(])(rm|unlink|mv|cp|ln|dd|truncate|tee|install)\b/.test(cmd) ||
    /\bsed\b[^|;&]*\s-[a-z]*i/.test(cmd) ||
    /\bgit\s+(checkout|restore|reset|stash)\b/.test(cmd) ||
    />>?/.test(cmd);
  if (!mutates) process.exit(0);
  // (b) does it carry a token that hits a protected glob — or a token pointing at this plugin's own
  // install path. The latter matters because .loop/protect.globs is a repo-relative glob set and can
  // never, in principle, cover a path outside the repo (the plugin cache) — and if only the Edit/Write
  // channel below blocked that, a single `sed -i` would bypass it.
  const inPlugin = (t) => t === pluginPath || t.startsWith(`${pluginPath}/`);
  const tokens = cmd
    .split(/[\s>|<;&()'"`]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^\.\//, ''));
  const hitTok = tokens.find((t) => matchesGlob(t) || inPlugin(t));
  if (!hitTok) process.exit(0);
  deny(
    `Bash blocked while the guard is armed: '${hitTok}' matches ${inPlugin(hitTok) ? `this project's verifier itself (loop-engine, ${pluginPath})` : '.loop/protect.globs'}. ` +
      `Don't modify files that decide the verifier's outcome (tests, snapshots, config, migrations, the guard itself) via shell — verifier=ceiling (reward-hacking defense). ` +
      `Make the source code pass the verifier instead. ${escapeHint()}`,
  );
}

// -- Edit/Write/MultiEdit channel: file paths ---------------------------------------------------------
const filePath = input?.file_path;
if (typeof filePath !== 'string' || !filePath) process.exit(0);

// The verifier itself (classify-risk, gate, verdict-run, protect-globs, etc.) now lives outside the
// repo, in the installed plugin cache. .loop/protect.globs is a repo-relative glob set and can't cover
// that path in principle. Before falling through to the repo-relative match below (which would treat
// "outside the repo" as "pass"), block the plugin's own install path directly by absolute-path prefix
// — code, not a glob, because this path is outside the repo. Still part of the verifier=ceiling
// invariant.
if (filePath === pluginPath || filePath.startsWith(`${pluginPath}/`)) {
  deny(
    `loop-engine plugin file blocked while the guard is armed: '${filePath}' is this project's verifier itself (loop-engine, ${pluginPath}). ` +
      `It lives outside the repo but still decides verdicts, so it's protected for the same reason as .loop/protect.globs. ` +
      `Make the source code pass the verifier instead. ${escapeHint()}`,
  );
}

// A target-based re-root already carries git's own repo-relative path. When only the *session*
// fallback moved effRoot (the target resolved to no worktree), rel stays measured from `root`: the
// target isn't inside effRoot, and measuring it from there would over-block a nested foreign repo.
const rel = (rerooted ? rerooted.rel : relative(root, filePath)).split('\\').join('/');
// Paths outside the repo (another repo, /tmp, $HOME, etc. — the plugin path is already handled above)
// aren't protected -> allow (`../` and absolute paths are excluded from matching).
if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) process.exit(0);
const hit = patterns.find((p) => globToRegExp(p).test(rel));
if (!hit) process.exit(0);

deny(
  `Protected-file write blocked while the guard is armed: '${rel}' matches .loop/protect.globs ('${hit}'). ` +
    `Don't modify files that decide the verifier's outcome (tests, snapshots, config, migrations, the guard itself) — verifier=ceiling (reward-hacking defense). ` +
    `Make the source code pass the verifier instead. ${escapeHint()}`,
);
