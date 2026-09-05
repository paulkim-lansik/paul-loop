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

1. **For ordinary command output, `VERDICT` is decided by the exit code.** `exit 0` → `PASS`, anything else →
   `FAIL`. The exit code is the strongest ground-truth signal (environment-based verification beats
   any LLM judgement). Counts in `SUMMARY` are best-effort and advisory only.
   With `verdict-run.sh --guard-mutation`, a detected
   workspace mutation forces `VERDICT: FAIL` / `EXIT: 1` even when the command itself exited 0 —
   see that script's header. Consumers reading `EXIT:` as the raw command exit code must account
   for this when the flag is on. A nested contract must also agree with the process outcome:
   incomplete/duplicate fields, PASS with failure reasons, or inconsistent exits force FAIL/EXIT 1.
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

6. **Wrapper process exits are stable:** 0 PASS, 1 completed FAIL, 2 wrapper setup/usage failure.
   `EXIT:` retains the verifier's actual nonzero code, including 2. A nested wrapper may itself
   exit 1 while retaining `EXIT: 7`; both are valid. A command that prints PASS and exits 7 is not.
   Engine 0.15.0 normalizes the formerly inconsistent nested passthrough behavior.
   Compatible rich SUMMARY/FAIL/NOTE fields are retained; stdout and the saved state agree.

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
`{verdict, exit, sha, dirty, started_at, finished_at, cmd, log, target_before, target_after,
target_changed, receipt_id}` — *what* was verified and *when*. `sha` is captured **before**
execution. A changed or unreadable target marks freshness dirty even when raw verification
mutation is allowed. Previous PASS is removed before execution; final state is replaced atomically.
Git/read failures cannot become an empty successful mutation digest. Consumer: the Stop-hook gate this plugin ships
(`hooks/gate-stop-verdict.mjs`, wired via `hooks/hooks.json`) — it refuses to let a loop-armed
(`.loop/looping`) turn end unless the state
is a **fresh PASS** (PASS ∧ recorded sha == current HEAD ∧ recorded clean ∧
tree clean now) — a stale or dirty PASS (including cache replays) is treated the same as FAIL.
The state file is covered by the built-in operational-state protection, so the in-session guard
denies direct file-tool forgery; that guard is a guardrail, not a boundary (ADR-0036). Do **not** pass
`.loop/verdict-state.json` to `loop-fix --protect` — the verifier legitimately rewrites it every
iteration, which would trip the snapshot guard (spurious exit 3).

Each run also writes a content-bound local verification receipt under `.loop/evidence/`, including
the exact command hash, emitted verdict hash, before/after target identities and run/attempt IDs.
Its identity policy records the actual runtime directory and log exclusion. Checks reuse that
policy, compare physical paths and exclude untracked runtime outputs consistently; other source
edits still invalidate the result. Git presentation helpers (`textconv` and external diff) are
disabled when computing the digest, so a display-only transformation cannot conceal a change.
The lifecycle state references those IDs; lessons require a matching stable FAIL-to-PASS pair.
These files are local operational guardrails, not signatures against unrestricted same-user writes.
No receipt authorizes publishing or proves that an inadequate verifier checks the right behavior.
See [evidence graphs](evidence-graphs.md). Node 22 is the tested runtime.
