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
  [--baseline <file>] [--update-baseline] [--judge "<cmd>"]
```

- `--target` runs once per trial: case `input` on **stdin**, output on **stdout**, exit code
  observed. Per-trial env: `EVAL_TRIAL` (1..k), `EVAL_CASE_ID`.
- `--judge` (optional) grades `semantic` assertions — a **separate** evaluator (generator ≠
  evaluator): output on stdin, criterion in `EVAL_CRITERION`, exit 0 = pass. Omit it and semantic
  assertions are skipped (with a NOTE).
- Defaults are strict: `--k 1`, `--min-pass-at-k 1.0`, `--min-pass-caret-k 1.0`.

## Gating & regression

The gate **fails** (VERDICT FAIL, exit 1) if any of:
- `pass@k < --min-pass-at-k`
- `pass^k < --min-pass-caret-k`
- a `--baseline` is given and current `pass@k`/`pass^k` dropped below it (a **regression**).

`--update-baseline` records current metrics to the baseline file (commit it). Later PRs are gated
against it — the regression gate. Run the full suite on a schedule (nightly) and a sample per PR;
full LLM-judged suites every PR are uneconomical (research nuance).

## Composition

`eval-gate` emits the [Verdict Contract](verdict-contract.md), so:
- **CI:** the exit code blocks merge — run the gate command as a step under `.github/workflows/`
  (no committed workflow yet; add one when a golden dataset lands).
- **Loop:** `loop-fix.sh --verify "bin/eval-gate.sh --dataset ... --target ..."` drives a fix loop
  whose ground truth is the eval gate itself.
