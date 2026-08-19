---
name: retrospect
description: Turn loop outcomes into a verified-lessons memory — record what fixed a failure, recall it next time, and promote recurring lessons into skills/guidelines. Use when the user wants the loop to learn from past runs, capture a fix as a reusable lesson, see why runs keep failing, or decide what to codify into a skill or CLAUDE.md.
---

# retrospect — the learning layer (verified lessons)

Make runs get smarter over time. A failure becomes a lesson (Reflexion); a *recurring, verified*
lesson becomes a skill/guideline candidate (Voyager). Full reference: loop-engine@paul-loop's
docs/lessons.md (in the plugin, not this repo).

## The one rule

**Only the verifier decides what is a lesson.** Record a lesson as `--verified` ONLY when ground
truth (tests/build/the eval gate passing) confirmed the fix — never on your own say-so. Only verified
lessons are recalled as authoritative; only recurring ones get promoted. This keeps hallucinated
"fixes" out of the memory and out of your guidelines.

## In a fix loop (automatic)

```bash
node tools/plugin-path.mjs exec bin/loop-fix.sh --verify "npm test" --fix '<agent>' --protect "**/*.test.*" --lessons .loop/lessons
```
`loop-fix` recalls past verified fixes for the current failure into your prompt, and records a
verified lesson when it converges. Nothing else to do — just point `--lessons` at a (committed) dir.

## By hand (in-session)

- **Recall before you fix:** `node tools/plugin-path.mjs exec bin/lessons.sh recall --signature-file .loop/last-verdict.txt --lessons <dir>`.
  If a past run solved this exact failure, start from that, then re-verify (don't trust the memory —
  the verifier still decides).
- **Record after green:** once the verifier passes, `node tools/plugin-path.mjs exec bin/lessons.sh record --signature-file <first-failure>
  --fix "<what worked>" --source <loop-fix|diagnose|review> --iterations <N> --verified --gate "<verify cmd>" --lessons <dir>`.
  `--gate` (e.g. this repo's verify command) attributes the recurrence to that verify gate so
  `promote --runs` can annotate the candidate when the gate regresses — without it, regressions only
  show in their own section.
- **Never** record `--verified` for a fix the verifier didn't confirm.
- **Tag the kind of lesson:** add `--category domain` when the lesson is about product/domain behavior
  (not process/tooling) — e.g. a business-rule bug, not a flaky test or a build config gotcha. Omit it
  and it defaults to `engineering` (the vast majority of lessons). `recall`/`stats` accept the same flag
  to filter/aggregate by category.

## Semantic recall (optional) — beyond exact-signature

**Routing:** the file recall above is **signature recall** — an exact match on the normalized failure
signature, no similarity, no ranking. Its only legitimate caller is a **machine** passing verifier
output verbatim (`--signature-file`, which is exactly what `loop-fix` does). A hand-typed, paraphrased,
or natural-language query is tool misuse for signature recall — that's a job for **semantic recall**
instead, if this repo has it wired up (see below). A signature-recall miss names this on stderr (the
normalized key it looked up + this same routing hint) — but stdout and the exit code are unchanged,
since `loop-fix` still pipes recall through `2>/dev/null`.

The file recall above only matches the *exact* normalized failure fingerprint — a paraphrased or
slightly-different failure misses past fixes. Some repos layer a **semantic memory** store (embeddings
+ a vector DB) on top of the file-based lessons to catch *similar* failures, wired to run automatically
via hooks rather than an explicit call. If this repo has such a layer, it typically works like this:

- A SessionStart hook graduates verified file-lessons into the vector store (idempotent).
- A UserPromptSubmit hook injects semantically-near verified lessons for your prompt.
- It activates only when an embedding API key (e.g. `OPENAI_API_KEY`/`GEMINI_API_KEY`) and the vector
  DB are both reachable; otherwise it should no-op silently (fail-open) rather than block you. A common
  convention for an explicit off-switch is an env var like `LOOP_RECALL_OFF=1`.
- If a key is set but the vector DB isn't reachable, a heartbeat-style check may nudge once — that's
  the signal this layer went dark.
- For a manual query, check this repo's semantic-memory setup for its own recall command (it should
  mirror the file recall's `--query`/`--json` shape) — it should load the same config the hooks do, and
  refuse rather than silently querying with a meaningless stub embedder if no key is visible either way.
- Either way, file lessons stay canonical; a semantic layer is at best a richer copy. The verifier is
  still the ceiling — a recalled lesson is a hint, not a pass.

## Domain lessons from an external ideas tool (optional)

Some repo owners also keep an external ideas/scratch-capture tool outside this repo (gstack is one
example) where product/domain insights surface during other work. A durable one is worth cross-posting
into `.loop/lessons` by hand, using the same recording flow as any other domain lesson:

```bash
node tools/plugin-path.mjs exec bin/lessons.sh record --signature-file <...> --fix "<what worked>" \
  --source <tool-name> --category domain --lessons <dir>
```

Mark it `--verified` immediately only if a human directly confirmed the insight; anything merely
observed, inferred, or model-suggested still has to clear the same recurring + `lessons challenge` bar
as any engineering lesson before it's trusted. This is a per-repo/per-owner convenience — there's no
plugin-standard tooling for it, and a repo without such a tool can skip this section entirely.

## Retro & promotion (where self-improvement compounds)

- `node tools/plugin-path.mjs exec bin/lessons.sh stats --lessons <dir>` — avg iterations-to-green, recurrence counts, top recurring blockers.
  Use it to see whether the loop is actually getting faster.
- `node tools/plugin-path.mjs exec bin/lessons.sh promote --min-count 3 --lessons <dir>` — recurring verified lessons worth codifying. Hand
  each to `write-a-skill` (make the fix a reusable skill) or fold it into `CLAUDE.md` (a guideline),
  then the loop stops re-solving it from scratch. Add `--runs .loop/runs` to fold in deterministic gate-regression
  signals: a `[REGRESSION: <gate> PASS→FAIL]` line — distinct from the `[N×]` recurrence count — marks
  candidates whose gate regressed in the runs ledger, and unattributed regressions list in their own section. The
  ledger is forgeable (trust boundary), so a regression is candidate INPUT only — the skeptical challenge gate stands.
- `node tools/plugin-path.mjs exec bin/lessons.sh retire --id <id> --ref "<where>" --lessons <dir>` — **after** you've codified an accepted
  candidate into a skill/`CLAUDE.md`, retire it so it stops re-surfacing (the promote listing, `--codify`,
  or a heartbeat-style "promotion candidate" nudge if this repo has one). This is the terminal gate that
  keeps the candidate pool from growing monotonically. Fail closed: only a verified + `challenge
  --verdict accept`ed lesson can retire; a content change later re-opens it for fresh review.

### Grounded reopen (retired or rejected lessons)

Retired lessons and `challenge --verdict reject`ed candidates are settled — "let's revisit that" on its
own doesn't reopen them. A reopen request must:

- **Cite the id.** Name the exact lesson id (or ADR number) under discussion — a vague appeal to "that
  decision" doesn't identify a target.
- **Bring new evidence.** Something the original verdict didn't have: a fresh recurrence, a new failure
  signature, a verified counterexample. "On reflection..." with no new signal isn't evidence.
- **Not overwrite the record.** Don't edit the retired/rejected entry's fields in place — that erases the
  audit trail. Open a fresh lesson/challenge cycle instead, or (if this repo's lessons tooling has an
  `invalidate --superseded-by` command) link the old id forward to the new one; otherwise reference the
  superseded id in the new entry's `--fix` text. A reversal that belongs at the ADR level gets a new ADR
  that references the old one, not a rewrite of it.

A reopen missing an id or missing new evidence is an automatic reject in the skeptical pass — the same
challenge gate as any promotion candidate.

## Reporting

State what was recorded/recalled and the loop-efficiency trend. When promoting, name the recurring
blocker and propose the concrete skill or guideline — don't auto-edit guidelines from a single run.
