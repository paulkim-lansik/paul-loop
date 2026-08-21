#!/usr/bin/env node
// gate-risky-commands.mjs — PreToolUse(Bash) guardrail: enforces "merge and deploy always require a
// human, regardless of risk classification" at the tool-call boundary, not just in skill prose.
//
// Why a hook (two structural holes in skill-level prose gates): (1) gate.mjs's exit 10 is non-blocking
// under the Claude Code hooks contract — only exit 2, or exit 0 + JSON (permissionDecision), block.
// (2) skill-level gates leak from subagents/bypassPermissions — a PreToolUse hook fires in both of
// those contexts too (official docs).
//
// Single decision point: this hook doesn't decide AUTO vs REQUIRE itself. Its own scope filter answers
// only "is this command a merge/deploy surface" (gh pr merge · a repo's deploy-script path · its
// deploy/redeploy package-manager aliases). Once a surface is confirmed, it mirrors
// bin/classify-risk.mjs --command (-> gate.mjs) and mirrors its exit code (10 = REQUIRE -> ask/deny, 0
// = AUTO -> defer). The classification table itself is never duplicated in this hook — change the
// rules in one place (classify-risk) and every consumer follows.
//
// deny vs ask: default is "ask" — REQUIRE means human approval, not prohibition. A consuming repo's
// permissions.ask rules can already route the same surface to interactive approval and, per official
// docs, already survive compound commands and env-var prefixes. What this hook adds on top:
// (1) detection beyond string rules — env/nohup/nice/command/sudo/time word prefixes, whitespace
//     variants (via the shared tokenizer), and gh/pnpm global-flag traversal (firstSubcommand)
// (2) a single source of truth for the verdict — mirrors classify-risk, with the matched rule
//     surfaced in the reason
// (3) a bypassPermissions deny backstop (below) (4) red-events telemetry.
// "ask" is a valid PreToolUse hookSpecificOutput value (official hooks doc). Headless sessions can't
// prompt, so ask resolves to a fail-closed rejection there (intended). In bypassPermissions mode this
// hook denies rather than asks: official docs say an *explicit* ask rule still forces a prompt even in
// that mode, but how a hook-returned "ask" behaves there is undocumented, so this hook doesn't rely on
// undocumented behavior and fails closed instead.
//
// fail-open/fail-closed (same principle as gate-before-merge): the detection stage (stdin parse,
// non-Bash, tokenizing, "not a target surface") fails open (defer — the permissions.ask layer still
// applies); once a surface is confirmed (including the classify-risk spawn and its verdict), it fails
// closed.
//
// This hook is a guardrail, not a boundary (see the repo-wide threat-model ADR that applies to this
// harness) — the tokenizer can't emulate eval/bash -c/quoting/node -e, and finding a bypass isn't a
// bug (parser hardening is a won't-fix). The real boundary: server-side branch protection for merges,
// human-approval practice for deploys. Don't read this as "merges are now blocked."

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  firstSubcommand,
  splitSegments,
  stripHeredocs,
  stripPrefix,
  tokenize,
} from './command-tokenizer.mjs';
import { logRedEvent } from './red-events-log.mjs';

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code injects this at hook runtime.
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
// This hook ships inside loop-engine's own package, so bin/classify-risk.mjs is a plain sibling path —
// no cross-package plugin-install resolution needed (contrast: when this hook lived in a consuming
// repo, it had to go find an installed plugin first).
const pluginRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const RULES = join(root, 'risk-rules.json');
const CLASSIFY = join(pluginRoot, 'bin', 'classify-risk.mjs');

function allow() {
  process.exit(0); // exit 0 with no JSON = defer — the normal permission flow (incl. permissions.ask) applies.
}
function block(decision, reason, code) {
  logRedEvent(root, { kind: 'gate', code }); // best-effort — a logging failure never changes the verdict
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0); // exit 0 + JSON is the block contract — exit 1/10 is non-blocking, exit 2 is unstructured blocking.
}

// -- Detection stage (fail-open) ----------------------------------------------------------------------
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}
if (payload?.tool_name !== 'Bash') allow();
const cmd = payload?.tool_input?.command;
if (typeof cmd !== 'string' || !cmd) allow();

// A scope filter — a subset of classify-risk's COMMAND_RULES (cmd-irreversible). Not a full mirror:
// classify-risk fails closed (REQUIRE) on no match, so routing every Bash call through it would make
// even `ls` REQUIRE. So this narrows to "command surfaces that are always REQUIRE" (gh pr merge · a
// deploy-script path · the repo's canonical deploy aliases) and defers the actual verdict to
// classify-risk below. (`git push ...:main` is deliberately out of scope — server-side branch
// protection is the real boundary there. Other risky commands outside this filter still route through
// classify-risk elsewhere, e.g. a ship-feature step's own classification, where an unmatched command
// fails closed to REQUIRE.)
// Detection style: gh/pnpm go through the tokenizer (segments, prefixes, flag traversal); a deploy
// path is a raw substring match on the pre-tokenized command.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
// pnpm: --filter/-F/-C/--dir take a value; -w/--workspace-root is boolean (pnpm docs) and falls
// through the ordinary flag-skip path. A value-flag outside this list can mis-parse -> fail-open defer
// (an accepted guardrail limit).
const PNPM_VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir']);
function detectsRiskySurface(command) {
  try {
    const stripped = stripHeredocs(command); // heredoc bodies are data, not commands
    if (/tools\/deploy\//.test(stripped)) return 'deploy-path'; // same substring classify-risk uses (matches read commands too — same tradeoff as the permissions.ask layer)
    for (const rawToks of splitSegments(stripped).map(tokenize)) {
      const toks = stripPrefix(rawToks); // strip env/word prefixes, incl. sudo/time
      if (toks[0] === 'gh') {
        // gh [global flags] pr [flags] merge — skip flags between subcommands with the same helper.
        const i = firstSubcommand(toks, 1, GH_VALUE_FLAGS);
        if (toks[i] === 'pr' && toks[firstSubcommand(toks, i + 1, GH_VALUE_FLAGS)] === 'merge')
          return 'command';
      }
      if (toks[0] === 'pnpm') {
        const i = firstSubcommand(toks, 1, PNPM_VALUE_FLAGS);
        const sub =
          toks[i] === 'run' ? toks[firstSubcommand(toks, i + 1, PNPM_VALUE_FLAGS)] : toks[i];
        if (sub === 'deploy' || sub === 'redeploy') return 'command';
      }
    }
    return null;
  } catch (e) {
    // A detection-stage error fails open (a bug in this hook must never block arbitrary Bash calls).
    // Never fail silently — a stderr breadcrumb keeps a parser crash distinguishable from a quiet defer.
    console.error(
      `[gate-risky-commands] detection stage error (fail-open): ${String(e?.message ?? e).split('\n')[0]}`,
    );
    return null;
  }
}
const surface = detectsRiskySurface(cmd);
if (!surface) allow();

// -- Surface confirmed — fail-closed from here on. classify-risk (-> gate.mjs) decides. --------------
if (!existsSync(CLASSIFY)) {
  block(
    'deny',
    '[gate-risky-commands] classify-risk.mjs is missing from this plugin install — the surface is ' +
      'already confirmed, so this fails closed rather than deferring. Reinstall/update the loop-engine plugin and retry.',
    'risky-cmd-classify-missing',
  );
}
try {
  // E2BIG guard: a very large command (e.g. a huge heredoc) can fail to spawn at all under the OS argv
  // limit (measured: a 1.3MB command -> E2BIG -> a classification failure that would deny). The
  // judgment input is capped to the first 100KB. A truncated match can only lose rule matches, which
  // classify-risk's own unmatched-input fail-closed (REQUIRE) absorbs — the verdict can't flip toward
  // AUTO from truncation (safe direction, monotone), and the surface itself was already confirmed
  // against the full string. Kept as "ask" rather than "deny" to preserve REQUIRE's meaning (human
  // approval, not prohibition).
  const cmdForJudge = cmd.length > 100_000 ? cmd.slice(0, 100_000) : cmd;
  const res = spawnSync(
    process.execPath,
    [
      CLASSIFY,
      '--json',
      '--command',
      cmdForJudge,
      '--rules',
      RULES,
      '--action',
      'PreToolUse(Bash) gate',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  // Mirror AUTO — this hook never gets independently stricter than classify-risk (single decision
  // point). Defensive branch — the current scope filter is a strict subset of cmd-irreversible, so
  // status 0 isn't reachable today; kept for when the filter widens.
  if (res.status === 0) allow();
  // DENY_AND_LOG — the middle tier: default-deny + evidence attached to the PR. Defensive branch — this
  // hook's filtered surfaces (merge/deploy) are all rev=none today, so gate always returns 10 here; kept
  // so a future filter widening doesn't mislabel status 11 as "verdict failed" below.
  if (res.status === 11) {
    block(
      'deny',
      '[gate-risky-commands] medium risk (DENY_AND_LOG) — denying by default. Attach the classification ' +
        "evidence to the PR body via 'classify-risk --from-git --render-md'.",
      'risky-cmd-deny-and-log',
    );
  }
  // A spawn failure (res.error), a signal/timeout (status=null), or any other unexpected exit code
  // (1, 2, ...) all mean "the verdict couldn't be determined" — fail closed (the surface is already
  // confirmed, matching this file's own contract above).
  if (res.error || res.status !== 10) {
    const cause = res.error
      ? String(res.error.message ?? res.error).split('\n')[0]
      : `status=${res.status}`;
    block(
      'deny',
      `[gate-risky-commands] classify-risk failed to produce a verdict (${cause}) — the surface is ` +
        `already confirmed, so this fails closed. Repair the loop-engine plugin install (${CLASSIFY}) and retry.`,
      'risky-cmd-classify-failed',
    );
  }
  // status === 10 (REQUIRE) — surface the matched rule as evidence for the single decision point.
  let matched;
  try {
    const arr = JSON.parse(res.stdout).matched ?? [];
    // The reason is human-facing — cap at 2000 chars so a bloated `matched` array doesn't dump wholesale.
    matched = arr.length ? arr.join('; ').slice(0, 2000) : 'no rule matched (unmatched fails closed)';
  } catch (e) {
    // A block is still valid without a parsed reason — just don't let a parse failure silently masquerade
    // as "no rule matched"; label it distinctly and leave a stderr breadcrumb.
    console.error(
      `[gate-risky-commands] reason parse failed: ${String(e?.message ?? e).split('\n')[0]}`,
    );
    matched = '(reason parse failed)';
  }
  const bypass = payload?.permission_mode === 'bypassPermissions';
  const surfaceLabel =
    surface === 'deploy-path'
      ? "commands touching this repo's deploy-script path (including reads — same tradeoff as the permissions.ask layer) are"
      : 'merge/deploy commands are';
  const base =
    `[gate-risky-commands] ${surfaceLabel} always routed through a human-approval gate (REQUIRE, ` +
    `verdict via classify-risk). ${matched}. ` +
    'This hook is a guardrail, not a boundary — the real boundary is server-side branch protection.';
  if (bypass) {
    block(
      'deny',
      `${base} An explicit ask rule still forces a prompt even under bypassPermissions (per official ` +
        `docs), but this hook's own "ask" decision has undocumented behavior in that mode, so it fails ` +
        `closed instead — run this interactively with human approval, or run it yourself.`,
      'risky-cmd-deny-bypass',
    );
  }
  block('ask', `${base} A human approval will let this proceed.`, 'risky-cmd-ask');
} catch (e) {
  block(
    'deny',
    `[gate-risky-commands] internal error (fail-closed — surface already confirmed): ${String(e?.message ?? e).split('\n')[0]}`,
    'risky-cmd-internal-error',
  );
}
