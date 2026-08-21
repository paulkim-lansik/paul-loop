#!/usr/bin/env node
// PreToolUse guardrail — detects a direct local merge/pull into a protected branch and redirects to
// the PR flow. This hook is not a boundary. It's best-effort, local, bypassable, fail-fast guidance
// (the filename "gate" is a historical artifact — not renamed). The real boundary is server-side
// branch protection. Finding a bypass for this hook isn't a bug (parser hardening is a won't-fix).
//
// Detects `git merge`/`git pull` targeting a protected branch (see loadProtectedBranches below —
// direction inference is cwd-based: effective branch is computed from the actual exec cwd, checkout
// targets are tracked, and chaining/subshells/redirection keep the same structural-trust gate) and
// denies **unconditionally**, pointing at `gh pr merge`. This hook does not enforce marker freshness,
// --ff-only, or a specific source ref — that's the server's job now.
//
// Command parsing is two layers: the shared tokenizer (command-tokenizer.mjs — segment splitting,
// heredoc stripping, env/word-prefix traversal) handles env prefixes (FOO=bar); this file's
// parseGit/checkoutTarget handles git global options (-C/-c/...) and checkout create/value flags ->
// together they resist `FOO=bar git merge` / `git -C . merge` / `git checkout -q/-B main`-style
// evasion or mis-parsing. `git pull` targeting a protected branch is blocked too. Shell quoting isn't
// fully parseable (coarse-net), so *detection* fails open (a non-merge command passes); once a merge
// is confirmed, this fails closed.
//
// Heredoc bodies (a commit message via `-F -`, a PR body via `$(cat <<'EOF' ... EOF)`) are stripped
// *before* segment splitting — otherwise splitting on newlines would misread a body's individual lines
// as commands. Example: a doc's example code block happens to token-match `git merge --ff-only <ref>`,
// and `<ref>` isn't a real rev -> the outer catch fails closed and denies an unrelated commit outright.
//
// Note: start-marker detection has no quote context — a match inside a quoted string, a grep pattern,
// or a here-string (`<<<word`) can false-positive as a heredoc start. Such false positives almost
// always fail to find a closing marker (because it isn't really a heredoc) -> in that case the
// original text is restored rather than dropped (command-tokenizer.mjs's stripHeredocs). Dropping it
// would also erase a *real* `git merge` line that follows, silently reopening detection (measured in
// review) — a much larger blast radius than the "when in doubt, pass" philosophy this coarse-net
// otherwise follows, so this specific case is guarded against.
//
// Scope: `git branch -f main` / `reset --hard` on a protected branch / `push (.|origin) HEAD:main` are
// not merges and are out of scope — a local hook can't cover directly moving a protected branch;
// server-side branch protection is the backstop there (this hook only watches merge/pull).
//
// Syncing a local protected branch to match origin is not blocked by this hook (and shouldn't be) —
// the safe path is a ff-only merge from `origin/<branch>` (already-reviewed, already-merged server
// truth), which doesn't route through this PreToolUse hook's merge-gate concern and doesn't bypass the
// merge gate either.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
// The tokenizer is a shared lib (shared with gate-risky-commands.mjs — same implementation, one home).
import { splitSegments, stripHeredocs, stripPrefix, tokenize } from './command-tokenizer.mjs';
import { logRedEvent } from './red-events-log.mjs';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code injects this at hook runtime.
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// The protected branch set is repo-specific — read from the consuming repo's ship-flow.config.json
// (releaseBranch / integrationBranch) if present. Absent that config (or a repo not using ship-flow's
// setup skill), fall back to a conservative default that covers the two most common trunk names.
function loadProtectedBranches(projectRoot) {
  try {
    const cfg = JSON.parse(
      readFileSync(join(projectRoot, '.claude', 'ship-flow.config.json'), 'utf8'),
    );
    const branches = [cfg.releaseBranch, cfg.integrationBranch].filter(
      (b) => typeof b === 'string' && b,
    );
    if (branches.length) return new Set(branches);
  } catch {
    /* missing/unreadable config -> fall through to the default */
  }
  return new Set(['main', 'master']);
}
const PROTECTED_BRANCHES = loadProtectedBranches(root);

const EXEC = {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 16 * 1024 * 1024,
};

function allow() {
  process.exit(0);
}
function deny(reason, code) {
  // Best-effort record (reason code included so a false positive, e.g. a direction mis-detection, can
  // later be filtered out when measuring a real deny rate). Keyed to root (the worktree this hook runs
  // in) — logRedEvent itself is fail-open, so a failure here never affects the deny verdict below.
  logRedEvent(root, { kind: 'gate', code });
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
function git(args, cwd = root) {
  return execFileSync('git', args, { ...EXEC, cwd }).trim();
}

// Flags that take a following value token — skipped along with their value.
const VALUE_GLOBAL = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
]);
// checkout/switch's branch-creating flags — the token right after is the *new branch name* (the
// checkout target). Must not be skipped as a value.
const CREATE_CHECKOUT = new Set(['-b', '-B', '-c', '-C', '--orphan']);
// checkout/switch value-taking flags — skipped along with their value when searching for the target.
const VALUE_CHECKOUT = new Set(['--conflict', '--pathspec-from-file', '--start-point']);

// Parses a git segment -> { sub, args }. After stripping prefixes, skips git global options (with
// their values) and returns the first non-flag token as the subcommand.
function parseGit(rawToks) {
  const toks = stripPrefix(rawToks);
  if (toks[0] !== 'git') return null;
  let i = 1;
  while (i < toks.length) {
    const t = toks[i];
    if (t.startsWith('-')) {
      i += VALUE_GLOBAL.has(t) && !t.includes('=') ? 2 : 1;
      continue;
    }
    return { sub: t, args: toks.slice(i + 1) };
  }
  return null;
}
// checkout/switch's target branch. A create flag (-b/-B/-c/-C/--orphan) means the token right after it
// is the target. A file-restore form is not a branch switch, so returns null (no switch -> effective
// branch stays as-is, the fail-closed direction):
//   - `checkout <tree> -- <paths>` / `checkout -- <paths>`: `--` always means a file restore.
//   - `checkout .` / `checkout *`: a pathspec, not a valid branch ref name (git refname rules).
function checkoutTarget(args) {
  if (args.includes('--')) return null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (CREATE_CHECKOUT.has(t)) return args[i + 1] ?? null;
    if (t.startsWith('-')) {
      if (VALUE_CHECKOUT.has(t) && !t.includes('=')) i += 1;
      continue;
    }
    return t === '.' || t === '*' ? null : t;
  }
  return null;
}
// -- Merge detection (fails open up to here: an uncertain parse or a non-merge command passes) -------
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}
if (payload?.tool_name !== 'Bash') allow();
const cmd = payload?.tool_input?.command;
if (typeof cmd !== 'string' || !cmd) allow();

const strippedCmd = stripHeredocs(cmd);
let gitSegs;
try {
  gitSegs = splitSegments(strippedCmd).map(tokenize).map(parseGit).filter(Boolean);
} catch {
  allow(); // a detection-stage error -> pass (a bug in this hook must not block arbitrary Bash)
}

// Trusting payload.cwd for direction inference kept producing new evasions across review rounds — -C /
// cd / GIT_DIR= first, then a subshell `(cd ... && merge)`, brace groups, and backslash escapes next
// (all reproduced). Blacklisting tokens one at a time keeps breaking the moment a structural character
// glues itself onto `cd`/`git`/`-C` in a way the whitespace-only tokenizer can't see (`(git`, `\git`
// aren't recognized as `git`). Flip it to a whitelist instead: cwd-based direction inference is only
// trusted when the command is "structurally a single simple git merge/pull" — (1) exactly one segment
// (no &&/;/|/newline/bare &) (2) no structural characters `(){}\\` at all (3) no -C/--git-dir/
// --work-tree/GIT_DIR=/GIT_WORK_TREE= redirection signal. If any of the three trips,
// direction-untrusted -> if merge/pull appears anywhere in the command (a loose scan too, spreading
// structural characters into spaces so it also catches what the strict parser misses, like `(git` /
// `\git`), deny regardless of reason. This is effectively reverting to the original default (treat
// direction as always-protected-branch) — the only thing newly allowed is "a simple single command"
// (exactly the scenario this cwd-based trust was meant to fix), so there's no new attack surface. The
// strict tokenize/parseGit path itself is untouched — this check sits as a separate safety net on top
// of it.
const hasStructuralChars = (s) => /[(){}\\]/.test(s);
const stripStructuralChars = (s) => s.replace(/[(){}\\]/g, ' ');
const rawSegs = splitSegments(strippedCmd);
const DIR_REDIRECT_GLOBAL = new Set(['-C', '--git-dir', '--work-tree']);
const hasDirRedirectSignal = (rawToks) => {
  // A GIT_DIR=/GIT_WORK_TREE= env prefix has the same redirection effect as -C/--git-dir — checked on
  // the *raw* tokens before stripPrefix removes that evidence.
  if (rawToks.some((t) => /^(GIT_DIR|GIT_WORK_TREE)=/.test(t))) return true;
  const toks = stripPrefix(rawToks);
  if (['cd', 'pushd', 'popd'].includes(toks[0])) return true;
  return (
    toks[0] === 'git' &&
    toks.some(
      (t) =>
        DIR_REDIRECT_GLOBAL.has(t) || t.startsWith('--git-dir=') || t.startsWith('--work-tree='),
    )
  );
};
const isSimpleSingleGitCmd =
  rawSegs.length === 1 &&
  gitSegs.length === 1 &&
  !hasStructuralChars(rawSegs[0]) &&
  (gitSegs[0].sub === 'merge' || gitSegs[0].sub === 'pull') &&
  !hasDirRedirectSignal(tokenize(rawSegs[0]));
let looseHasMergeOrPull = false;
try {
  looseHasMergeOrPull = splitSegments(stripStructuralChars(strippedCmd))
    .map(tokenize)
    .map(parseGit)
    .filter(Boolean)
    .some((g) => g.sub === 'merge' || g.sub === 'pull');
} catch {
  looseHasMergeOrPull = false; // a scan failure is itself detection-stage -> fail-open (same philosophy)
}
// A non-merge/pull command (neither the strict nor the loose check found one) passes quickly.
if (!gitSegs.some((g) => g.sub === 'merge' || g.sub === 'pull') && !looseHasMergeOrPull) allow();

// Never let a single merge/pull targeting a protected branch through. An unexpected error in direction
// inference itself fails closed (deny in the catch below).
try {
  if (!isSimpleSingleGitCmd) {
    deny(
      'This command is not a simple single `git merge`/`git pull` call (chaining, a subshell, braces, ' +
        'backslashes, -C/cd/GIT_DIR=, etc.), so merge direction cannot be trusted. Run a single ' +
        '`git merge`/`git pull` line directly in the target directory instead of changing directory.',
      'not-simple-command',
    );
  }
  // From here on isSimpleSingleGitCmd holds — gitSegs contains exactly that one merge/pull, so the
  // loop below evaluates only that single op. Direction inference is based on the *actual Bash exec
  // cwd* (payload.cwd — a field the hook receives on every call, the session cwd right before the
  // command runs). `root` (CLAUDE_PROJECT_DIR) stays fixed at the main worktree's path, and its HEAD is
  // typically pinned to a specific branch by convention — so measuring HEAD via `root` alone would
  // misjudge a perfectly normal sync command run from a different worktree as targeting the protected
  // branch.
  //
  // Trust boundary: payload.cwd is external input and fails far more often than root does — (a) an
  // already-removed/nonexistent worktree (this genuinely happens when cleanup overlaps a merge), (b) a
  // different repo than root (the session cd'd outside the repo). This hook's philosophy is
  // "unconfirmed -> fail closed", but an early implementation let both of these cases fall through to
  // effective=null and skip the gate for that op entirely — a real protected-branch-targeting merge
  // could silently (with no log) pass. Falling back to `root` in both cases below restores the
  // originally-intended safe default.
  const execCwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : root;
  const gitCommonDir = (dir) => {
    try {
      // Normalize via realpath — a main vs. linked worktree can print --git-common-dir as relative or
      // absolute depending on git version/location, and on macOS /var is a symlink to /private/var, so
      // the same path can appear in two forms. Without normalization, a string comparison can wrongly
      // conclude two paths point at different repos when they're the same one (measured: a linked
      // worktree case fell through to the fallback and broke a regression test).
      return realpathSync(resolve(dir, git(['rev-parse', '--git-common-dir'], dir)));
    } catch {
      return null; // doesn't exist, or not a git repo
    }
  };
  const sameRepo =
    execCwd === root ||
    (() => {
      const a = gitCommonDir(execCwd);
      return a !== null && a === gitCommonDir(root);
    })();
  const headAt = (dir) => {
    try {
      return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    } catch {
      return null;
    }
  };
  let effective = sameRepo ? headAt(execCwd) : null;
  if (effective === null) effective = headAt(root); // execCwd undecidable / a different repo -> fall back to root (the fail-closed default)

  for (const seg of gitSegs) {
    if (seg.sub === 'checkout' || seg.sub === 'switch') {
      const t = checkoutTarget(seg.args);
      if (t) effective = t;
      continue;
    }
    if (seg.sub !== 'merge' && seg.sub !== 'pull') continue;
    if (!PROTECTED_BRANCHES.has(effective)) continue; // this op doesn't target a protected branch -> pass

    // A merge-state subcommand (--abort/--continue/--quit) isn't a landing attempt -> skip this op
    // (subsequent ops keep being evaluated).
    if (
      seg.sub === 'merge' &&
      seg.args.some((a) => ['--abort', '--continue', '--quit'].includes(a))
    )
      continue;

    // -- Direct landing attempt on a protected branch -> redirect to the PR flow (a guardrail, not a
    // boundary). No marker freshness / --ff-only / source-ref enforcement here — the actual
    // enforcement is the server's (branch protection + required status checks on the release branch).
    deny(
      `Can't land directly on ${effective} via local git ${seg.sub} — use the PR flow: push the branch ` +
        `and merge with \`gh pr merge\` (or the GitHub UI). If you only want your local ${effective} to ` +
        `match origin/${effective}, use \`git fetch origin && git merge --ff-only origin/${effective}\` ` +
        `(a safe ff-only sync) instead.`,
      `${effective}-direct-landing`,
    );
  }

  allow(); // no merge/pull targeted a protected branch, or every op passed the check above -> allow
} catch (e) {
  // An unexpected error after a protected-branch merge is confirmed fails closed.
  deny(
    `merge gate internal error (fail-closed): ${String(e?.message ?? e).split('\n')[0]}`,
    'internal-error',
  );
}
