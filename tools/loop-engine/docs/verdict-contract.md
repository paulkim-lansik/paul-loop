# The Verdict Contract (Phase 0)

A closed agentic loop can only converge if it has a **machine-readable, ground-truth
pass/fail signal**. Research finding: *"the success of the autonomous loop depended on a
near-perfect verifier"* — the verifier is the ceiling of the whole loop
([Anthropic, Building a C compiler](https://www.anthropic.com/engineering/building-c-compiler)).

Finding ⑥ from the same source: test/feedback output must be **deliberately engineered for an
LLM reader** — compact, with error markers greppable on a single line, and pre-computed summary
stats — so the agent steers itself instead of drowning in bytes.

The **Verdict Contract** is that interface. Any verify step (tests, build, lint, type-check,
e2e) is wrapped so it emits exactly this block on stdout:

```
=== VERDICT ===
VERDICT: PASS|FAIL
EXIT: <integer exit code of the underlying command>
SUMMARY: passed=<n> failed=<n> skipped=<n> duration_ms=<n>
FAIL: <one-line reason, greppable>      # zero or more; present only when FAIL
FAIL: <one-line reason, greppable>
LOG: <absolute path to the full, untruncated log>
=== END VERDICT ===
```

## Rules

1. **`VERDICT` is decided by the exit code, not by parsing.** `exit 0` → `PASS`, anything else →
   `FAIL`. The exit code is the strongest ground-truth signal (environment-based verification beats
   any LLM judgement). Counts in `SUMMARY` are best-effort and advisory only.
   *Single opt-in exception (BAC-626 ④):* with `verdict-run.sh --guard-mutation`, a detected
   workspace mutation forces `VERDICT: FAIL` / `EXIT: 1` even when the command itself exited 0 —
   see that script's header. Consumers reading `EXIT:` as the raw command exit code must account
   for this when the flag is on.
2. **`FAIL:` lines are the agent's steering signal.** Each is a single line: `FAIL: <reason>`.
   A reader can `grep '^FAIL:'` to get every failure with low noise. The producer matches
   *curated, framework-native* per-failure markers (TAP `not ok`, jest/vitest `✕`, `--- FAIL`,
   `FAILED`, `AssertionError`, `panic:`), de-duplicates, and caps the count (default 20) so the
   context never floods; the full output lives in `LOG`. Generic stack-frame noise (e.g. bare
   `Error:`) is intentionally excluded.
3. **Full noise goes to `LOG`, never to stdout.** The block is a few lines; the megabytes of test
   output are written to a file the agent reads *only if it needs to*.
4. **`SUMMARY` is pre-computed** so the agent never re-counts. Unparseable fields are emitted as
   empty (`failed=`) rather than guessed.
5. **The block is delimited** (`=== VERDICT ===` … `=== END VERDICT ===`) so it can be extracted
   from a larger transcript unambiguously.

## Why a contract and not just "run the tests"

The loop driver (`loop-fix.sh`, Phase 1) and the in-session skill both consume *this* shape,
regardless of whether the underlying tool is Jest, pytest, `cargo test`, `go test`, or a bash
script. New verifiers plug in without touching the loop. This is the harness-design principle of
keeping load-bearing scaffolding small and swappable
([Anthropic, Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

## Producing a verdict

`bin/verdict-run.sh -- <your verify command>` runs the command and prints the block. See that
script's header for usage. You can also emit the block yourself from any tool that knows its own
results — the contract is the integration point, the script is just one convenient producer.

## Freshness state (BAC-564)

Alongside the stdout block, `verdict-run.sh` writes `.loop/verdict-state.json` on every run:
`{verdict, exit, sha, dirty, finished_at, cmd, log}` — *what* was verified (HEAD sha at verify
time, whether the worktree was dirty) and *when*. Consumer: the Stop-hook gate
(`.claude/hooks/gate-stop-verdict.mjs`) refuses to let a loop-armed (`.loop/looping`) turn end
unless the state is a **fresh PASS** (PASS ∧ recorded sha == current HEAD ∧ recorded clean ∧
tree clean now) — a stale or dirty PASS (including cache replays) is treated the same as FAIL.
The state file is listed in `.loop/protect.globs`, so the in-session guard denies an agent
forging it; that guard is a guardrail, not a boundary (ADR-0036). Do **not** pass
`.loop/verdict-state.json` to `loop-fix --protect` — the verifier legitimately rewrites it every
iteration, which would trip the snapshot guard (spurious exit 3).
