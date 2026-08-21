#!/usr/bin/env node
// warn-partial-checkout.mjs — PostToolUseFailure(Bash) hook: when `git checkout`/`git rebase` fails
// partway through, the working tree can be left with a subset of files partially reflecting the
// target branch's content while HEAD never moved (measured reproduction: an unlink failure aborting
// mid-checkout left unrelated files rewritten to the target branch's content, while the user's own
// working files were deleted). To reduce the risk of this quiet data loss going unnoticed until
// someone happens to run `git status`, this hook warns via systemMessage right after a failure if the
// working tree is dirty, pointing at a recovery procedure.
//
// PostToolUseFailure can't block a command that already ran (official contract — this hook is a
// guardrail, not a boundary) — it's purely informational. Observed behavior (headless `claude -p`
// probes): this event fires when a Bash command exits non-zero (a success instead fires
// PostToolUse), and the `error` field carries "Exit code N\n<stderr>" — but repeated measurement
// (5 reproductions of the same failure scenario) found this event simply didn't fire at all on 1 of 5
// runs, even though the Bash call had failed (unrelated to this file's own logic — it happens in
// Claude Code's own hook-dispatch layer, outside what this hook can fix). So "always fires on a
// non-zero exit" is an observed tendency, not a guarantee — this hook already sits on the "guardrail,
// not a boundary" premise above, so this non-determinism is absorbed by the same premise (a human
// still has to confirm with `git status` in the end — that's exactly the limit this warning names).
// This hook doesn't parse the exit code at all — PostToolUseFailure firing is itself already the
// "it failed" signal, so it only reads tool_input.command (detection) and cwd (for the status check) —
// deliberately the smallest surface, so a schema change elsewhere doesn't break it.
//
// False-positive avoidance (measured): a successful checkout/rebase leaves the working tree clean
// (and this hook doesn't even fire on success, so it's doubly safe) — a single dirty check catches
// "command failed + something silently changed." A normal merge conflict also leaves the tree dirty,
// and in that case the same advice ("check with git status, and restore your own files with
// --source=HEAD") still applies, so this hook doesn't try to distinguish the two.
//
// cwd tracking: a `cd <dir> && git rebase ...` means the real target isn't payload.cwd — this is the
// same evasion family gate-before-merge.mjs already documents (cd/-C/GIT_DIR=). This hook isn't a deny
// gate, it's advisory, so it leans toward "follow along as best as possible so the warning isn't
// missed" rather than "block if untrustworthy" — it walks segments in order and updates a running cwd
// on every literal `cd`/`pushd <path>` (a variable expansion or `cd -`, which can't be resolved
// statically, doesn't update it — the previous cwd is kept; a coarse net, not a full shell parser).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  firstSubcommand,
  GIT_VALUE_GLOBAL,
  splitSegments,
  stripHeredocs,
  stripPrefix,
  tokenize,
} from './command-tokenizer.mjs';

function allow() {
  process.exit(0);
}

function warn(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
}

// `git [global opts] (checkout|rebase) ...` -> { cflag } | null (not a match). toks arrives already
// stripPrefix'd (reusing the same stripPrefix result the cd/pushd check uses). cflag: the value of
// `-C <dir>` if present (git resolves subsequent paths relative to it).
function parseCheckoutOrRebase(toks) {
  if (toks[0] !== 'git') return null;
  const idx = firstSubcommand(toks, 1, GIT_VALUE_GLOBAL);
  if (toks[idx] !== 'checkout' && toks[idx] !== 'rebase') return null;
  let cflag = null;
  for (let i = 1; i < idx; i++) {
    if (toks[i] === '-C' && !toks[i].includes('=')) cflag = toks[i + 1] ?? cflag;
  }
  return { cflag };
}

// `cd <literal-path>` | `pushd <literal-path>` -> that path string, else null (a variable expansion
// (`$...`), `cd -`, or a bare `cd` can't be resolved statically -> null, keeping the previous cwd).
function literalDirChange(toks) {
  if (toks[0] !== 'cd' && toks[0] !== 'pushd') return null;
  const dir = toks[1];
  if (!dir || dir.startsWith('-') || dir.includes('$')) return null;
  return dir;
}

// Walks the command's segments in order, deriving "the actual cwd at that point" for each
// checkout/rebase segment — an earlier `cd`/`pushd <dir>` accumulates.
function resolveTargetDirs(cmd, baseCwd) {
  const segs = splitSegments(stripHeredocs(cmd)).map(tokenize).map(stripPrefix);
  const targets = [];
  let cwd = baseCwd;
  for (const toks of segs) {
    const dir = literalDirChange(toks);
    if (dir) {
      cwd = resolve(cwd, dir);
      continue;
    }
    const m = parseCheckoutOrRebase(toks);
    if (m) targets.push(m.cflag ? resolve(cwd, m.cflag) : cwd);
  }
  return targets;
}

function isDirty(cwd) {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim().length > 0
    );
  } catch {
    return false; // not a git repo, or undecidable -> don't warn (fail-open — this hook never makes noise it isn't sure about)
  }
}

// -- Detection (fail-open: an uncertain parse / a non-target command passes) --------------------
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}
if (payload?.tool_name !== 'Bash') allow();
const cmd = payload?.tool_input?.command;
if (typeof cmd !== 'string' || !cmd) allow();

const baseCwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
let targetDirs;
try {
  targetDirs = resolveTargetDirs(cmd, baseCwd);
} catch {
  allow();
}
if (targetDirs.length === 0) allow();

const dirty = targetDirs.some((dir) => isDirty(dir));
if (!dirty) allow();

warn(
  '⚠️ A git checkout/rebase failed and the working tree has uncommitted changes — some files may have ' +
    'been silently, partially rewritten to the target branch\'s content, or your own working files may ' +
    'have been deleted (HEAD did not move). Check `git status` now: restore anything that isn\'t your ' +
    'own work with `git restore <path>`, and restore your own work specifically with ' +
    '`git restore --source=HEAD -- <path>`.',
);
