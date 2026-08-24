#!/usr/bin/env node
// PreToolUse guardrail — denies a verify-shaped command piped into another command when that same
// invocation does nothing to preserve the verifier's real exit status.
//
// Why (measured, glucofit-partners run audit): four runs read their verify result like this —
//
//   [15:31] cd <worktree> && timeout 590 pnpm verify 2>&1 | tail -200
//   [15:32] echo "exit code of last pnpm verify: $?"        ->  0
//
// Both halves are broken. A pipeline's `$?` is the *last* stage's status (`tail` here, which always
// succeeds), and the Bash tool does not preserve shell state between calls — every result ends with
// "Shell cwd was reset to …", so the second call's `$?` describes that brand-new shell's own `echo`.
// The reported `0` was unrelated to verify in two independent ways. Those four runs happened to be
// genuinely green, so nothing broke — but the evidence was worthless, and the *same sessions* used
// the correct `> log 2>&1; echo EXIT:$?` form elsewhere. Inconsistent behaviour with no mechanical
// backstop is exactly what a gate is for: "the verifier is the ceiling" is meaningless if the run
// can't read the verifier's actual verdict.
//
// This hook is a guardrail, not a boundary (ADR-0036) — bypassable, and a coarse-net parser can't
// fully emulate shell syntax. Detection fails open (an uncertain parse passes); once a
// status-losing verify pipeline is confirmed, it fails closed. It reuses hooks/command-tokenizer.mjs
// rather than growing a second parser, following gate-before-merge.mjs / gate-worktree-create.mjs.
//
// Not denied (the invocation keeps the real status inside itself):
//   - `set -o pipefail; pnpm verify 2>&1 | tail -200; echo "EXIT:$?"`
//   - `pnpm verify 2>&1 | tail -200; echo "EXIT:${PIPESTATUS[0]}"`
//   - `pnpm verify > /tmp/v.log 2>&1; echo "EXIT:$?"; tail -200 /tmp/v.log`  (no pipe at all)
// Detection is per-invocation, on the whole command string: `pipefail`/`PIPESTATUS` anywhere in the
// same Bash call is accepted as intent to preserve the status. That's deliberately generous — this
// gate exists to stop the *unaware* form, not to grade shell style.
//
// Configuration (this plugin ships no product-specific rules): the "what counts as verify" regex
// comes from a consuming repo's `.claude/ship-flow.config.json` -> `verifyCommandPattern`, matched
// against the runner subcommand (`pnpm <here>`) or a directly-invoked script's basename. Without
// config it defaults to this harness's own vocabulary — `verify` / `verdict` and their `:`/`-`/`_`
// suffixed variants (`verify:rls`, `verdict-run.sh`). Kill switch: LOOP_VERIFY_PIPE_GATE_OFF=1.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { firstSubcommand, stripHeredocs, stripPrefix, tokenize } from './command-tokenizer.mjs';
import { logRedEvent } from './red-events-log.mjs';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code injects this at hook runtime.
const env = process.env;
const root = env.CLAUDE_PROJECT_DIR ?? process.cwd();

const DEFAULT_VERIFY_PATTERN = /^(verify|verdict)([:._-]|$)/i;

// Package/task runners whose *subcommand* names the script being run.
const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'make', 'just', 'turbo', 'nx']);
// Runner global flags that consume the following token (`pnpm --filter <pkg> verify`).
const RUNNER_VALUE_FLAGS = new Set(['--filter', '-F', '--dir', '-C', '--workspace', '-w', '--prefix']);
// `pnpm run verify` / `npm run-script verify` / `pnpm exec …` — the real script is one token later.
const RUNNER_INDIRECTIONS = new Set(['run', 'run-script', 'exec']);
// `timeout`'s own value flags (a duration follows the flags and precedes the real command).
const TIMEOUT_VALUE_FLAGS = new Set(['-s', '--signal', '-k', '--kill-after']);

function loadVerifyPattern(projectRoot) {
  try {
    const cfg = JSON.parse(
      readFileSync(join(projectRoot, '.claude', 'ship-flow.config.json'), 'utf8'),
    );
    if (typeof cfg.verifyCommandPattern === 'string' && cfg.verifyCommandPattern) {
      return new RegExp(cfg.verifyCommandPattern, 'i');
    }
  } catch {
    /* missing/unreadable/invalid config -> fall through to the default */
  }
  return DEFAULT_VERIFY_PATTERN;
}

function allow() {
  process.exit(0);
}
function deny(reason, code) {
  logRedEvent(root, { kind: 'verify-pipe-guard', code });
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

// Redirection operators containing `&` (`2>&1`, `>&2`, `&>log`) must not be mistaken for the `&`
// statement separator — without this, `pnpm verify 2>&1 | tail` splits into `pnpm verify 2>` and
// `1 | tail`, and the pipeline's first stage is no longer the verify (detection silently dies on
// the single most common real form).
const dropAmpRedirections = (s) => s.replace(/&>>?/g, ' ').replace(/\d?>&(-|\d?)/g, ' ');

// Statements are split on everything that ends a command EXCEPT a single `|` — the pipe is the
// structure this hook is about, so it must survive splitting (splitSegments() from the shared
// tokenizer eats it, which is right for its own consumers and wrong here).
const splitStatements = (s) =>
  s
    .split(/&&|\|\||[;\n&]/)
    .map((x) => x.trim())
    .filter(Boolean);

// `timeout 590 pnpm verify` -> `pnpm verify`. Kept local rather than added to the shared
// stripPrefix(): that function is shared with gate-before-merge/gate-risky-commands, and widening
// it would silently change what those two hooks detect (the tokenizer header's S-1 warning).
function stripTimeout(toks) {
  if (!toks.length || basename(toks[0]) !== 'timeout') return toks;
  let i = 1;
  while (i < toks.length && toks[i].startsWith('-')) {
    i += TIMEOUT_VALUE_FLAGS.has(toks[i]) && !toks[i].includes('=') ? 2 : 1;
  }
  if (i < toks.length && /^[0-9]/.test(toks[i])) i += 1; // the duration argument
  return toks.slice(i);
}

// -> a human-readable label for the matched verify command, or null (not verify-shaped).
function verifyShaped(stage, pattern) {
  const toks = stripPrefix(stripTimeout(stripPrefix(tokenize(stage))));
  if (!toks.length) return null;
  const head = basename(toks[0]);
  // A directly-invoked script: ./scripts/verify.sh, tools/loop-engine/bin/verdict-run.sh
  if (pattern.test(head.replace(/\.(sh|bash|mjs|js|ts|py)$/i, ''))) return toks[0];
  if (!RUNNERS.has(head)) return null;
  let i = firstSubcommand(toks, 1, RUNNER_VALUE_FLAGS);
  if (RUNNER_INDIRECTIONS.has(toks[i])) i += 1;
  const sub = toks[i];
  return typeof sub === 'string' && pattern.test(sub) ? `${toks[0]} ${sub}` : null;
}

// -- Detection (fail-open: an uncertain parse / a non-matching command passes) -----------------------
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}
if (env.LOOP_VERIFY_PIPE_GATE_OFF === '1') allow();
if (payload?.tool_name !== 'Bash') allow();
const cmd = payload?.tool_input?.command;
if (typeof cmd !== 'string' || !cmd) allow();

const offenders = [];
try {
  const stripped = stripHeredocs(cmd);
  // Any status-preserving intent anywhere in the same invocation -> not this hook's problem.
  if (/PIPESTATUS|pipefail/.test(stripped)) allow();
  const pattern = loadVerifyPattern(root);
  for (const statement of splitStatements(dropAmpRedirections(stripped))) {
    const stages = statement.split('|').map((s) => s.trim());
    if (stages.length < 2) continue; // not a pipeline -> `$?` is already the command's own status
    const label = verifyShaped(stages[0], pattern);
    // The downstream stage is named for context, but the statement text itself is NOT echoed back —
    // it has been through dropAmpRedirections(), so quoting it would show the user a mangled version
    // of what they typed.
    if (label) offenders.push({ label, into: tokenize(stages[1])[0] ?? 'another command' });
  }
} catch {
  allow(); // a detection-stage error -> pass (a bug in this hook must not block arbitrary Bash)
}
if (!offenders.length) allow();

// -- Confirmed -> fails closed from here -------------------------------------------------------------
try {
  const { label, into } = offenders[0];
  deny(
    `This pipes a verify-shaped command (\`${label}\`) into \`${into}\`, so \`$?\` ` +
      `reports the LAST stage's status, not the verifier's. A follow-up \`echo $?\` in a separate ` +
      `Bash call is worse still — the tool resets the shell between calls, so that \`$?\` belongs to ` +
      `a brand-new shell. Preserve the real status inside this same invocation, e.g.:\n` +
      `  ${label} > /tmp/verify.log 2>&1; echo "EXIT:$?"; tail -200 /tmp/verify.log\n` +
      `  set -o pipefail; ${label} 2>&1 | tail -200; echo "EXIT:$?"\n` +
      `  ${label} 2>&1 | tail -200; echo "EXIT:\${PIPESTATUS[0]}"`,
    'verify-piped-status-lost',
  );
} catch (e) {
  deny(
    `verify-pipe guard internal error (fail-closed): ${String(e?.message ?? e).split('\n')[0]}`,
    'internal-error',
  );
}
