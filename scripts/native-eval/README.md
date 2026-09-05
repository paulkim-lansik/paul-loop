# Bounded native evaluation lane

Run from the provider checkout with Node 22+. No packages or global settings are installed by
these scripts. `run.mjs` collects conservative qualification reports; successful collection
is **not** a behavioral PASS. Until independently reviewed event bindings and native enforcement
are established, its results deliberately remain INCOMPLETE. Original dataset rows/events remain
intact. Logs, transcripts and temporary fixture snapshots belong under private `.loop/native-eval/`.

`adapter.mjs codex|claude` and `grader.mjs` also implement the existing engine driver's stdin and
`EVAL_*` environment seam. Invoke them through `node /absolute/path/to/script.mjs`; no shell
expansion of a prompt or arbitrary command string is required. The independent grader uses a
new Codex CLI session, has a read-only sandbox, and inspects actual target files/tool traces.
It cannot establish missing host events by reading `scenario.json`. Unparseable/incomplete grades
remain unavailable. `review.mjs` starts another fresh CLI agent to calibrate/review that grader.
A timed-out reviewer is BLOCK, never a completed review.

The shared budget file is required. Initialize it **once for the whole lane**, including probes
and reviewers, as `{"limit_ms":1500000,"used_ms":0}` using a private file. Do not reset it between
variants. The default child bound is 60000 ms; `--case-ms` and `--grader-ms` accept an explicit integer
from 1 through 300000 ms, with an earlier termination margin. Tool polling remains at most
60 seconds independently of child execution. Setup commands
have separate 15-second bounds. The process group is terminated together; a hard supervisor deadline also closes inherited pipes. No detached
escape/session-changing descendants are intentionally spawned; this is process-group cleanup,
not proof against an adversarial process escaping its group.

## Qualification command

```sh
node scripts/native-eval/run.mjs \
  --runtime codex --variant current \
  --dataset tools/loop-engine/eval/agent-regression/cases.jsonl \
  --output .loop/native-eval/current-codex \
  --budget .loop/native-eval/budget.json \
  --cli /absolute/path/to/compatible/codex \
  --model EXACT_CONFIGURED_MODEL --effort CONFIGURED_EFFORT \
  --plugins /absolute/path/to/generated/codex \
  --source PROVIDER_COMMIT \
  --grader-cli /absolute/path/to/compatible/codex \
  --grader-model INDEPENDENT_GRADER_MODEL --grader-effort low \
  --case-ms 300000 --grader-ms 180000
```

`--ids` optionally bounds the supported cases; all other rows retain their explicit reasons.
`--blocked REASON` records a known unavailable native route without repeated model calls.
Claude uses `--runtime claude --plugins /path/to/claude/plugin-parent`; auth status is checked
before any target call. Omit model/settings when unavailable rather than inventing an identity.
The first-party auth route uses normal Claude OAuth/keychain lookup; `--bare` is deliberately
not used because it disables that route. This Claude route remains unqualified until authenticated.

Codex uses a fresh temporary `CODEX_HOME` for each session, copies only `auth.json` with mode 0600,
and deletes the profile afterward. It never copies trust grants, memory, user configuration or
installed plugin caches. Generated plugins are registered and installed by official CLI commands
only in that profile; no trust bypass is passed. Only the profile's generated registration config
is loaded when plugins are requested. Bare qualification/grader sessions ignore that config.
Existing installed `zine-codex` derivatives are separate identities, not a current/baseline match.

For the engine driver, set `NATIVE_EVAL_CLI`, `NATIVE_EVAL_MODEL`, `NATIVE_EVAL_EFFORT`,
`NATIVE_EVAL_BUDGET`, `NATIVE_EVAL_CASE_MS` and optionally `NATIVE_EVAL_MARKETPLACE` (Codex) or
`NATIVE_EVAL_PLUGINS` (Claude JSON array of source directories). Grader selection uses
`NATIVE_EVAL_GRADER_CLI`, `NATIVE_EVAL_GRADER_MODEL`, `NATIVE_EVAL_GRADER_EFFORT`,
`NATIVE_EVAL_GRADER_MS`. `review.mjs` and `grade-snapshot.mjs` accept a final bound in milliseconds.
Use the same configured **target** model/settings for baseline and current when supported;
the grader can use another model consistently. Exact models are read from saved native runtime
events, never from target self-identification or the calling agent's identity.

## Validation and review

```sh
node --test scripts/native-eval/native.test.mjs
node scripts/native-eval/validate.mjs \
  .loop/native-eval/current-codex/report.json \
  tools/loop-engine/eval/agent-regression/cases.jsonl \
  .loop/native-eval/current-codex
node scripts/native-eval/review.mjs \
  .loop/native-eval/independent-review .loop/native-eval/budget.json \
  /absolute/path/to/compatible/codex gpt-5.4-mini low
```

Runner exit 1 means evaluation INCOMPLETE; exit 2 means invocation/report validation failed.
Validator exit 0 means structurally valid evidence accounting, not quality PASS. Native model
costs remain null. The public audit contains source/trace hashes and actual limitations; private
prompt/output files are not publication artifacts. The parent owns the full engine suite.

## Retry accounting and proof boundary

A newly authorized retry gets a NEW named ledger with its authorization text/date and the prior
ledger hash/usage. Never reset an old ledger or overwrite earlier reports. The September 6 retry
uses `retry-2026-09-06-300s/budget.json`; the original 791744 ms remains unchanged. All native
targets, graders and independent reviewers share the retry's 1500000 ms allowance.

Run exactly the initial selected case with `--ids reuse-test-approval --defer-grade true`;
inspect the actual completed trace, then grade that retained snapshot in a new disposable fixture:

```sh
node scripts/native-eval/grade-snapshot.mjs SNAPSHOT NEW_GRADER_OUTPUT RETRY_BUDGET CODEX_CLI gpt-5.4-mini low 180000
```

The trusted artifact checker uses a fresh challenge created after the target. Receipts bind its
nonce, case/trial, physical grading workspace, original source workspace, target trace, verifier,
original dataset test and before/after artifact hashes. The grader must execute the exact check
as a standalone native command. Stale receipts, echo/cat output and masked shell commands fail
validation. The original dataset test executes separately even when the target expands its tests.
Only exact standalone verification exits and approved `sum.cjs` native patches currently have
normalized semantic event support. Other event coverage remains unknown.

Every actual message/action gets an individual independent semantic judgment; zero counts require
complete inventory coverage. These judgments remain **drafts**, with explicit draft validation
errors. The collection-only `native-eval/1` validator rejects accepted metrics and PASS until a
supported attested native enforcement/review protocol exists. Structural validation PASS therefore
means complete and consistent accounting, including unfinished and unsupported work.

`retry-collect.mjs RETRY_ROOT DATASET NEW_OUTPUT REVIEW_DIRECTORY` combines the first target,
its snapshot grader, the remaining supported cases and the three unavailable comparison routes.
It refuses overwrites and retains all four 20-row matrices. It does not run targets or change grades.

Grader preparation/runtime exceptions retain the completed target snapshot and an explicit
`grader_failure` record. A failed snapshot copy preserves the temporary source for recovery.
Executed report rows must match the native trial ID; historical missing IDs need explicit
`trial_id_status: "unavailable"`. Native JSONL parse failures retain raw bytes and stream/line
errors, set `trace_status: "incomplete"`, and cannot establish `completed` or an observed model
status. `completion_observed` separately retains a parsed terminal event without claiming an
intact trace. These paths use local mock transports in focused tests; CI does not call live models.
