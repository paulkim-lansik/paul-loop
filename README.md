# paul-loop

A Claude Code plugin marketplace for a self-improving dev loop harness.

## Why

Agentic coding loops fail in a specific, recurring way: the agent decides for itself whether its
own work passed. Self-graded loops drift toward whatever is easiest to claim as done, not what's
actually correct — tests get weakened instead of code getting fixed, "looks right" quietly
substitutes for "is right".

**paul-loop's one invariant: the verifier is the ceiling.** Whatever ground-truth check applies —
a test suite, a type checker, a lint rule, an RLS isolation proof — its exit code is the only thing
that ever produces a verdict. The agent's self-report is not consulted, weighted, or trusted as a
tiebreaker. Everything else this repo ships (verified-fix memory, deterministic risk gating, a
closed verify → fix loop with hard stopping criteria) is built as a consequence of that one rule,
not as a separate feature list.

This is also why the repo ships as **several small plugins instead of one monolith**: you can adopt
the ceiling invariant (`loop-engine`) without also adopting an opinionated delivery workflow
(`ship-flow`) or a semantic-memory database (`loop-memory`). Install only what you're going to use —
`claude plugin details <name>` shows the projected per-plugin token cost before you decide.

> **Status: M0 (private scaffold).** This repo is sanitized and validated but not yet publicly
> announced or version-pinned for external consumers. Expect breaking changes without notice. See
> [Milestones](#milestones).

## What's in `loop-engine`

The only plugin shipped so far. It has no opinions about *how* you deliver work — no issue tracker
integration, no delivery skill, no memory database — only the verify/fix/remember mechanics
underneath one. All commands below live in `tools/loop-engine/bin/` and are automatically added to
`PATH` once the plugin is loaded (the official plugin spec registers `bin/` for you — no manual
`PATH` wiring).

### `verdict-run.sh` — wrap any verify command in a machine-readable contract

Everything downstream (`loop-fix`, lesson recording, CI) reads this contract, not raw stdout, so one
format has to hold for pytest, vitest, `go test`, a shell script, anything with an exit code.

```bash
verdict-run.sh -- pnpm test
verdict-run.sh --log /tmp/run.log --max-fails 10 -- pnpm typecheck
verdict-run.sh --guard-mutation -- pnpm verify   # fail the verdict if verify mutates tracked files
```

```
=== VERDICT ===
VERDICT: PASS
EXIT: 0
SUMMARY: passed= failed= skipped= duration_ms=8
LOG: /path/to/.loop/last-run.log
=== END VERDICT ===
```

- `VERDICT`/`EXIT` come straight from the wrapped command's exit code — never inferred from output.
- `SUMMARY` is best-effort count extraction (jest/vitest/pytest/`node --test` formats); it never
  changes the verdict, only helps a reader triage faster.
- On `FAIL`, greppable `FAIL: ...` lines are pulled from the log (curated markers: `✕`, `not ok`,
  `AssertionError`, `panic:`, etc.) so an LLM reading the block steers instead of drowning in a raw
  stack trace.
- `--guard-mutation` snapshots git-visible workspace state before/after and forces `FAIL` if verify
  itself changed tracked files — closes the "the fix mutated the test instead of the code" hole.
- The full doc, including the wire format other tools can rely on, is in
  [`docs/verdict-contract.md`](tools/loop-engine/docs/verdict-contract.md).

### `loop-fix.sh` — a closed verify → fix → re-verify loop with hard stopping criteria

```bash
loop-fix.sh --verify "pnpm test" --fix "claude -p 'fix the failing test'" --max-iter 8
loop-fix.sh --verify "pnpm typecheck" --stall 3 --infra-retries 2 --budget-sec 900
```

- **Generator ≠ evaluator**: the `--fix` command never decides success; only `--verify`'s exit code
  (via `verdict-run.sh`) does.
- **Hard stops, not vibes**: `--max-iter` (always on), `--budget-sec` (wall clock), `--stall`
  (aborts once the failure signature repeats N times *and* pass/fail counts stop moving — a moving
  count is treated as progress even with an identical error message).
- **Infra failures don't burn the iteration budget**: a docker-daemon/port-down signature with no
  actual test-runner failure marker is exempt (`--infra-retries`, default 2) instead of counting
  against `--max-iter` or polluting the lessons store.
- **No reward hacking**: pair with `--guard-mutation` on the underlying verify command so a "fix"
  that edits the test instead of the code gets caught, not rewarded.
- Every iteration writes a structured handoff to `.loop/` (`$LOOP_PROMPT_FILE`, `$LOOP_VERDICT_FILE`,
  `$LOOP_LOG_FILE`) that the `--fix` command can read — wrap `claude -p` for a real agentic fixer, or
  a deterministic script for tests.

### `lessons.mjs` — record only what a verifier actually confirmed, recall it next time

```bash
lessons.mjs record --signature "FAIL: ..." --verified --fix "..." --title "..." --lessons .loop/lessons
lessons.mjs recall  --signature "FAIL: ..." --lessons .loop/lessons
lessons.mjs promote --min-count 3 --lessons .loop/lessons          # recurring candidates
lessons.mjs challenge --id <key> --verdict accept|reject --reason "..."   # separate skeptical pass
lessons.mjs promote --codify --lessons .loop/lessons               # ONLY accepted candidates, fail-closed
lessons.mjs retire --id <key> --ref "docs/where-this-got-codified.md"
```

- A lesson is written only when a **verifier**, not the fixer's own claim, confirmed the fix worked.
  Unverified self-reports are never treated as authoritative on recall.
- `recall` matches on failure signature first, with room for semantic recall on top (see
  [`docs/lessons.md`](tools/loop-engine/docs/lessons.md)).
- Promotion is a two-step, two-party protocol: `promote` surfaces *candidates* (recurring ≥ N
  times); a separate `challenge` pass — deliberately not the same judgement that proposed the
  candidate — has to `accept` before `--codify` will ever emit it. No accept, no codification;
  the codify path fails closed.
- `retire` is terminal: only an accepted+codified lesson can retire, so it stops resurfacing once
  it's already living in a guideline/skill.

### `classify-risk.mjs` / `gate.mjs` — deterministic risk gating, not agent self-scoring

The problem this closes: an agent that scores its own blast radius turns a safety gate into
decoration. So the dimensions are derived from the **change itself** — file paths touched,
commands run, the pipeline stage — and an agent may only ever *escalate* a dimension, never
soften one below what the rules already derived:

```
final(dimension) = max(rule(dimension), agent(dimension))
```

```bash
classify-risk.mjs --from-git --stage pr --action "PR against main"
classify-risk.mjs --from-git --stage implement \
  --agent-blast-radius high --agent-reversibility partial   # can only raise, never lower
gate.mjs --blast-radius high --reversibility partial --cost low
```

- Exit codes are the contract: `0` = AUTO, `10` = REQUIRE (a human has to approve before this runs —
  fires whenever reversibility is `none` *or* any dimension is left unset: unknown fails closed,
  never silently AUTO), `11` = DENY_AND_LOG (reversible but broad/expensive — denied by default,
  with the verdict evidence attached for a human to review later, not blocked on waiting for one),
  `2` = usage error.
- `--render-md` emits one PR-body-ready markdown block with a greppable
  `<!-- gate-verdict: ... -->` marker, so the routing decision has a durable, auditable trail
  instead of living only in a terminal that scrolled away.
- `classify-risk.mjs` computes dimensions and then execs `gate.mjs` — there is exactly one place
  that turns dimensions into a routing decision, not two copies that can drift.

### `require-tests.sh` — a verifier that runs zero tests must go RED, not vacuously green

```bash
require-tests.sh "*.integration.test.ts" "RLS isolation proof"
```

Put this before a test runner on any step whose entire purpose is to *prove* something. If the
tests that prove it were deleted, or never written, `vitest --passWithNoTests`-style flags would
happily exit `0` over nothing — this guard turns that into an explicit `FAILED:` line instead.

## Install

```bash
claude plugin marketplace add paulkim-lansik/paul-loop
claude plugin install loop-engine@paul-loop
```

## Try it without installing anything

`--plugin-dir` loads a plugin for one session only — no marketplace registration needed. Useful for
trying it against a clone, or for developing this repo itself:

```bash
git clone https://github.com/paulkim-lansik/paul-loop
claude --plugin-dir paul-loop/tools/loop-engine
# inside the session, bin/ is already on PATH:
#   verdict-run.sh -- echo hi
```

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest — lists every plugin this repo ships
tools/loop-engine/
  .claude-plugin/plugin.json      # this plugin's manifest
  bin/                            # commands, auto-registered on PATH when the plugin loads
  lib/                            # shared helpers bin/ scripts import
  test/                           # self-test suite (bash + node, no docker) — test/run.sh runs all of it
  docs/                           # verdict contract, lessons model, eval-gate, otel notes
```

`tools/loop-engine` (not `plugins/loop-engine`) is not a style choice — this plugin was extracted
from a monorepo where its own test suite hardcodes that relative path three levels up from
`test/`. Renaming the directory would have meant "unmodified migration" was no longer true, so the
path stayed.

## Development status

- **Sanitized, not yet public.** M0 removed everything that only made sense inside the origin
  monorepo: one hook with an external import, tests that assert on that repo's own CI/hook wiring,
  and a fixture file that carried real (if scrubbed-of-secrets) PR titles and file paths from a
  production codebase. What's left runs standalone — `tools/loop-engine/test/run.sh` is 15/15 green
  with nothing outside this repo.
- CI (`.github/workflows/`) runs `gitleaks` and the self-test suite + `claude plugin validate
  --strict` on every push to `main`.
- Version pins are **not** load-bearing yet — this repo is pre-`M1`, expect force-pushes and
  breaking changes without a deprecation window.

## Milestones

- **M0 (current)** — private scaffold: secrets/PII sweep, gitleaks CI, `loop-engine` bin + tests
  migrated unmodified, `claude plugin validate --strict` green, one dogfooded `verdict-run` via
  `--plugin-dir`.
- **M1** — public release of `loop-engine`: English docs for the remaining Korean-language prose in
  `docs/`, `classify-risk`'s rule table externalized so a consumer can supply their own, marketplace
  goes public on a SHA-pinned channel.
- **M2** — `ship-flow` (the delivery-loop skill stack) + `templates/` (constitution-layer templates
  a setup skill wires into a consuming repo — a plugin's root `CLAUDE.md` is not loaded as project
  context by Claude Code, so this can't just be a file sitting in the plugin).
- **M3 (optional)** — `loop-memory` (pgvector semantic lesson recall, opt-in / `defaultEnabled:
  false`) and a submission to `anthropics/claude-plugins-community`.

## License

MIT — see [LICENSE](LICENSE).
