# The Eval Gate (Phase 2)

Phase 1 makes one verifier go green. Phase 2 stops *quality regressions* from merging: a small
**golden dataset** of cases, graded with **multi-type assertions**, run **k times** for
non-determinism, and gated on **pass@k / pass^k** — emitting the same Verdict Contract so it works
as a CI merge gate *and* as a `--verify` target for `loop-fix.sh`.

Research basis:
- *Start small:* 10–20 high-priority examples covering core use cases + edge cases
  ([OpenAI, eval skills](https://developers.openai.com/blog/eval-skills); Anthropic recommends
  20–50 failure-based tasks — same order of magnitude).
- *Multi-assertion:* combine deterministic checks, semantic (LLM-graded) checks, safety checks, and
  performance/budget — not a single grader
  ([Kinde, CI/CD for evals](https://www.kinde.com/learn/ai-for-software-engineering/ai-devops/ci-cd-for-evals-running-prompt-and-agent-regression-tests-in-github-actions/)).
- *pass@k and pass^k:* agents are non-deterministic, so measure the ceiling **and** the floor.
  `pass@5=0.9` with `pass^5=0.4` is **not** production-ready ([Sierra τ-bench, arXiv 2406.12045]).
- *Regression gate:* PRs touching prompts/agent config run the eval suite against a golden dataset;
  failing the check blocks merge ([Promptfoo GitHub Action], Anthropic alignment guidance).

## Metrics

For each case, run the target `k` times:
- **pass@k** (ceiling) = fraction of cases where **≥1** of the k trials passed.
- **pass^k** (floor / reliability) = fraction of cases where **all** k trials passed.

With `k=1` they are equal. Raise `k` for non-deterministic targets (LLMs/agents); `pass^k` decays
exponentially with k, which is the point — it surfaces flakiness a single run hides.

## Golden dataset format

A directory of `*.json` files (or one `.jsonl`). Each case:

```json
{
  "id": "greet",
  "input": "hello there",
  "assert": {
    "exit_zero": true,                 // require exit 0 (default true; set false to allow non-zero)
    "contains": ["greet"],             // every substring must appear in output
    "not_contains": ["error"],         // none may appear (safety)
    "regex": "\"intent\"\\s*:\\s*\"greet\"",   // output must match
    "equals": "exact expected output", // trimmed equality
    "max_ms": 2000,                    // performance budget
    "semantic": "the reply is polite"  // LLM-graded — needs --judge (a SEPARATE evaluator)
  }
}
```

A trial **passes** iff *all* its assertions pass. Assertion types map to the research's four
families: deterministic (`contains`/`regex`/`equals`/`exit_zero`), safety (`not_contains`),
performance (`max_ms`), semantic (`semantic` via `--judge`).

## Running

```bash
bin/eval-gate.sh --dataset <dir|file.jsonl> --target "<cmd>" [--k N] \
  [--min-pass-at-k F] [--min-pass-caret-k F] \
  [--baseline <file> --target-id <model-config-version>] [--update-baseline] \
  [--judge "<cmd>" --judge-id <grader-version>]
```

- `--target` runs once per trial: case `input` on **stdin**, output on **stdout**, exit code
  observed. Per-trial env: `EVAL_TRIAL` (1..k), `EVAL_CASE_ID`.
- `--judge` (optional) grades `semantic` assertions — a **separate** evaluator (generator ≠
  evaluator): output on stdin, criterion in `EVAL_CRITERION`, exit 0 = pass. Omit it and semantic
  assertions fail unless `--allow-skip-semantic` explicitly permits skipping. A case containing
  only skipped or disabled assertions is rejected; `exit_zero:false` and empty arrays do not grade anything.
- `--budget-ms` bounds the full target/judge run (default 300000 ms), including subprocess groups.
  Late results, cancellation and unrun trials are not successful observations.
- Defaults are strict: `--k 1`, `--min-pass-at-k 1.0`, `--min-pass-caret-k 1.0`.

## Gating & regression

The gate **fails** (VERDICT FAIL, exit 1) if any of:
- `pass@k < --min-pass-at-k`
- `pass^k < --min-pass-caret-k`
- a `--baseline` is given and current `pass@k`/`pass^k` dropped below it (a **regression**).

`--update-baseline` records metrics with `operation_status: recorded` and a separate `quality_status`.
It **returns FAIL/exit 1 intentionally**: recording is not a quality gate. Inspect the baseline and
rerun without that flag for gate evidence. This changes the older RECORD-always-PASS behavior.
Baselines now require schema v2, a stable `--target-id`, and `--judge-id` when a judge is used.
Missing baselines and mismatched dataset contents, trial count, target/judge identities, grader
implementation or semantic-skip policy fail closed. Regenerate an old baseline explicitly after review.

## Composition

`eval-gate` emits the [Verdict Contract](verdict-contract.md), so:
- **CI:** the exit code blocks the job; required branch checks must be configured separately to
  block merge. The deterministic tier-0 suite is already exercised by the engine self-test workflow.
- **Loop:** `loop-fix.sh --verify "bin/eval-gate.sh --dataset ... --target ..."` drives a fix loop
  whose ground truth is the eval gate itself.

## Tier 0: the harness-self smoke gate (#7)

`eval-gate` was originally aimed at prompts (STDIN → agent output → STDOUT). `eval/tier0/` +
`bin/tier0-run.sh` aim the same pattern at the **harness itself**: does `loop-fix.sh` /
`lessons.mjs` still behave per their own documented contracts (max-iter stops, verified lessons
get recorded on convergence, `lessons record` fails closed on a missing signature, …)? No LLM is
called — every case runs the real scripts deterministically in an isolated temp workspace, which
is what makes this the cheapest ("tier 0") gate: pure bash + node, no docker, safe to run on every
`verify:loop`-adjacent change.

`bin/tier0-run.sh` is the `--target` adapter: it reads a scenario id from STDIN (the case's
`input`), runs it, and prints the underlying command's real exit code plus the relevant log/file
content to STDOUT tagged as `EXIT_CODE=N` — the golden case's `contains`/`not_contains` assertions
then grade that text. The adapter's own exit code only means "the scenario ran"; an unrecognized
scenario id is a hard failure (exit 1) so a typo in a case file can't silently no-op.

Run it:

```bash
node bin/eval-gate.mjs --dataset eval/tier0 --target "bash bin/tier0-run.sh" --log .loop/eval-revisit-call.log
```

Regression-locked by `test/eval-gate-tier0.test.sh` (part of `test/run.sh`). One case
(`lessons-record-signature-only`) documents that `lessons record` succeeds on a hand-typed
`--signature` alone, without `--signature-file` and without `--verified`. This case is unaffected
by #9 ("증거 무결성 계약"): #9 only fails closed when `--verified` is combined with a hand-typed
`--signature` and no `--signature-file` — unverified records (this case's scenario) are explicitly
out of scope for that change, so no update is needed here once #9 lands.

## Agent behavior and held-out evaluation

The tier-0 fixtures prove engine contracts. For actual model/runtime behavior, use
[the isolated agent evaluation driver](agent-evaluation.md) with an explicit runtime adapter and
an independent grader that checks artifacts and observed actions. Its 20 regression scenarios
come from the audit failures; they are evaluation inputs, not claims of native execution or efficacy.
