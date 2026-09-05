---
name: retrospect
description: Turn loop outcomes into a verified-lessons memory — record what fixed a failure, recall it next time, and promote recurring lessons into skills/guidelines. Use when the user wants the loop to learn from past runs, capture a fix as a reusable lesson, see why runs keep failing, or decide what to codify into a skill or CLAUDE.md.
context: fork
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# retrospect — the learning layer (verified lessons)

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Make runs get smarter over time. A failure becomes a lesson (Reflexion); a *recurring, verified*
lesson becomes a skill/guideline candidate (Voyager). Full reference: loop-engine@paul-loop's
docs/lessons.md (in the plugin, not this repo).

> Commands below are written as **substitutable literals** beginning with `{{pluginBinPrefix}}`
> (BAC-753). Before running one, read `pluginBinPrefix` from `.claude/ship-flow.config.json` and
> replace the token with its value, **concatenated onto the script name with no separator** — then run
> the result verbatim. Never type a `{{…}}` token into a shell. The default (key absent) is `""`: in a
> live session a plugin's `bin/` is already on PATH, so `lessons.sh …` runs as-is. If this repo's CI or
> its own wrapper needs an explicit resolver, the value is something like
> `node "$LOOP_ENGINE_PATH/bin/plugin-path.mjs" exec bin/` — loop-engine's own bundled resolver
> (`resolve [plugin]` / `exec <relative-bin> [args...]`, env-var overrides
> `LOOP_ENGINE_PATH`/`SHIP_FLOW_PATH`/`LOOP_MEMORY_PATH`), which covers what bare-PATH doesn't: CI (no
> live plugin load) and resolving a *different* installed plugin's path. `lessons.sh`/`loop-fix.sh` take
> **no `--` separator** — passing one is a usage error, not a harmless no-op.

## The one rule

**Only verifier evidence can mark a lesson verified.** Record a lesson as `--verified` ONLY when ground
truth (tests/build/the eval gate passing) confirmed the fix — never on your own say-so. Only verified
lessons are recalled as authoritative; only recurring ones get promoted. This keeps hallucinated
"fixes" out of the memory and out of your guidelines.

## In a fix loop (automatic)

```bash
{{pluginBinPrefix}}loop-fix.sh --verify "npm test" --fix '<agent>' --protect "**/*.test.*" --guard-mutation --lessons .loop/lessons
```
`loop-fix` recalls past verified fixes for the current failure into your prompt, and records a
verified lesson when it converges. Nothing else to do — just point `--lessons` at a (committed) dir.

## By hand (in-session)

- **Recall before you fix:** `{{pluginBinPrefix}}lessons.sh recall --signature-file .loop/last-verdict.txt --lessons <dir>`.
  If a past run solved this exact failure, start from that, then re-verify (don't trust the memory —
  the verifier still decides).
- **Record after green:** once the verifier passes, `{{pluginBinPrefix}}lessons.sh record --signature-file <first-failure>
  --fix "<what worked>" --source <loop-fix|diagnose|review> --iterations <N> --verified --receipt <passing-receipt.json> --failure-receipt <failing-receipt.json> --gate "<verify cmd>" --lessons <dir>`.
  Use the actual matching failure→success receipts emitted by the verifier; never fabricate them.
  Missing receipts mean the verified record is blocked, not permission to substitute a prose claim.
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
{{pluginBinPrefix}}lessons.sh record --signature-file <...> --fix "<what worked>" \
  --source <tool-name> --category domain --lessons <dir>
```

A human-confirmed domain decision belongs in the decision archive or an unverified note. Human
approval does not replace verifier receipts for `--verified`. A legitimate goal change can supersede
an earlier ADR without being presented as an empirically verified fix.

## Retro & promotion (where self-improvement compounds)

- `{{pluginBinPrefix}}lessons.sh stats --lessons <dir>` — avg iterations-to-green, recurrence counts, top recurring blockers.
  Use it to see whether the loop is actually getting faster.
- `{{pluginBinPrefix}}lessons.sh promote --min-count 3 --lessons <dir>` — recurring verified lessons worth codifying. For
  each candidate, pick its destination with the checklist below, then hand it to `write-a-skill` (make
  the fix a reusable skill) or fold it into `CLAUDE.md` (a guideline) accordingly — then the loop stops
  re-solving it from scratch. Add `--runs .loop/runs` to fold in deterministic gate-regression
  signals: a `[REGRESSION: <gate> PASS→FAIL]` line — distinct from the `[N×]` recurrence count — marks
  candidates whose gate regressed in the runs ledger, and unattributed regressions list in their own section. The
  ledger is forgeable (trust boundary), so a regression is candidate INPUT only — the skeptical challenge gate stands.
- `{{pluginBinPrefix}}lessons.sh retire --id <id> --ref "<where>" --lessons <dir>` — **after** you've codified an accepted
  candidate into a skill/`CLAUDE.md`, retire it so it stops re-surfacing (the promote listing, `--codify`,
  or a heartbeat-style "promotion candidate" nudge if this repo has one). This is the terminal gate that
  keeps the candidate pool from growing monotonically. Fail closed: only a verified + `challenge
  --verdict accept`ed lesson can retire; a content change later re-opens it for fresh review.
- `{{pluginBinPrefix}}lessons.sh invalidate --id <id> --reason "<why>" [--superseded-by <id2>] --lessons <dir>`
  (if this repo's lessons tooling has it) — mark a lesson WRONG (the lesson itself was mistaken), distinct
  from `retire` (the lesson was right but is now codified). An invalidated lesson is excluded, fail
  closed, from recall and from the promote listing/`--codify` going forward.
- `{{pluginBinPrefix}}lessons.sh mark-clean --gate "<verify cmd>" --lessons <dir>` (if
  available) — bump a clean-pass counter on lessons attributed to that gate; a fresh recurrence resets it
  to 0. `promote`'s listing flags a lesson crossing the clean-pass threshold as a `RETIREMENT CANDIDATE`
  comment — informational only, never an auto-retire/invalidate.

### Destination checklist — SKILL.md or CLAUDE.md?

Don't leave this to ad hoc judgment call by call — a candidate lands in exactly one of two homes,
decided by what kind of knowledge it is:

- **A repeatable, ordered procedure** (steps you'd literally run, a tool-call sequence, something with
  a clear start and end) → **SKILL.md**. Skills are for *doing*.
- **A constraint or judgment call that recurs across many different situations** (not one runnable
  sequence, but a rule you keep checking against — "never do X", "always prefer Y before Z") →
  **CLAUDE.md guideline**. Guidelines are for *judging*.
- **Both at once** (a procedure plus a standing rule about when/how to invoke it)? Split it: the steps
  become the skill; the standing constraint stays a short CLAUDE.md line (or becomes the skill's own
  trigger-first `description:` — see the discoverability check below), pointing at the skill instead of
  restating its steps.
- **Still ambiguous?** Default to the **more narrowly triggered** option. A CLAUDE.md guideline is read
  on every session (constant context cost); a skill only loads when its trigger fires. When in doubt,
  prefer the one that costs nothing until it's actually needed.
- **Skill-shaped candidates:** use the bundled `ship-flow:write-a-skill` when callable, or follow its
  source procedure directly within the authorized edit scope. An unavailable runtime invocation does
  not mean the source skill is absent. Do not force a procedure into CLAUDE.md or install tooling just
  to satisfy a stale reference.

### After `write-a-skill` writes a new skill — discoverability check

Codifying a candidate into a skill file isn't the same as making it *discoverable*. A skill nobody's
router ever picks is dead weight. If this repo's `write-a-skill` skill already runs a check like this
itself (read its own SKILL.md to confirm), trust it and skip this; otherwise run it by hand before
calling the promotion done:

- **Capability and trigger in `description:`.** Match `write-a-skill`: describe what it does, then
  "Use when..." with specific situations. A bare category label does not supply a routing trigger.
- **No routing collision.** Skim sibling skills' `description:` fields for overlapping trigger language.
  Two skills that both plausibly fire on the same phrasing make routing ambiguous — narrow the wording
  (or merge the skills) until each has a distinct trigger.
- **Declared paths and scope.** Bundle skill-specific resources under its directory; shared bundled
  contracts such as `../AUTHORIZATION.md` are valid references. Consumer source/config/docs reads and
  writes must be explicit procedure inputs/actions within caller scope. Reject undeclared traversal
  or writes outside that scope, not every legitimate relative reference.
- **Valid frontmatter.** `name` and `description` are both present, `name` matches the directory name,
  and the YAML actually parses (a stray unescaped colon or unclosed quote silently breaks discovery
  without erroring loudly).
- **No name collision.** The `name` doesn't already exist elsewhere in this repo's skill directories — a
  silent shadow means one of the two copies never gets picked by the router.

Then, **if this repo maintains a skills index/catalog doc** (a page listing all installed skills by
category), add the newly promoted skill to it as the last step — a skill that passes every check above
but stays unlisted in the repo's own catalog is still easy to miss.

### Finding CLAUDE.md guidelines that should have been skills

CLAUDE.md accumulates guidelines over a project's life, and some of them — in hindsight — describe a
procedure rather than a standing rule, and would read and get followed better as a skill. This plugin
repo has no consuming repo's CLAUDE.md of its own to list candidates from, so what follows is the
*procedure* for auditing one, not a fixed list:

1. Read the consuming repo's CLAUDE.md guideline by guideline.
2. Run each one back through the destination checklist above, in reverse: "if this were a fresh
   promotion candidate today, would the first bullet route it to SKILL.md instead?" — i.e., is it
   actually an ordered sequence of steps written as prose, rather than a constraint that shapes
   judgment across situations?
3. Flag the ones where the answer is yes. Don't auto-migrate them — moving a guideline can break
   existing cross-references to it elsewhere in the repo (e.g. `CLAUDE.md §N` citations). Surface the
   candidate list and let a human decide the move via a normal PR, the same review boundary as any other
   promotion.
4. A flagged candidate still has to clear the normal bar before it counts as migrated: `write-a-skill`
   produces it, and the discoverability check above passes.

Worth re-running this audit periodically (e.g. during a retro sweep), not only once — a guideline that
started as a genuine standing rule can calcify into a checklist-shaped procedure as it grows.

### Grounded reopen (retired or rejected lessons)

Retired lessons and `challenge --verdict reject`ed candidates are settled — "let's revisit that" on its
own doesn't reopen them. A reopen request must:

- **Resolve the id.** The agent finds the exact lesson id or ADR from available context; do not
  require the user to memorize it. Ask only if multiple plausible targets remain.
- **Bring new evidence.** Something the original verdict didn't have: a new failure signature, a
  verified counterexample, or a recurrence recorded with a genuinely updated `--fix`/`--title` — not
  just a repeat of the same text. `lessons record` only clears a settled `challenge`/`retired` when the
  fix/title content actually changes; re-recording the identical text just bumps the count and leaves
  the old verdict standing, so a plain recurrence by itself is not reopening evidence. "On
  reflection..." with no new signal isn't evidence.
- **Not overwrite the record.** Don't edit the retired/rejected entry's fields in place — that erases the
  audit trail. Open a fresh lesson/challenge cycle instead, or (if this repo's lessons tooling has an
  `invalidate --superseded-by` command) link the old id forward to the new one; otherwise reference the
  superseded id in the new entry's `--fix` text. A reversal that belongs at the ADR level gets a new ADR
  that references the old one, not a rewrite of it.

These evidence rules govern empirical lesson claims. A user-authorized goal/priority change can create
a superseding ADR with the new rationale and link to the old decision; it is not automatically a
verified lesson and does not waive implementation/verifier/merge/deploy/send gates.

An empirical lesson reopen missing a resolved id or new evidence is rejected in the skeptical pass — the same
challenge gate as any promotion candidate. Verify it actually landed, too: after recording the new
evidence, run `lessons stats`/`lessons promote` and confirm the id is back among the open candidates —
don't take the act of re-recording alone as proof the lesson reopened.

## Tracker close-out — the issue must end up owned

When tracker close-out is authorized, inspect only issues this session worked. Reuse the established
human owner from the caller or integration doc and preserve an existing assignee. An authenticated
`me` account can be a service/shared account; do not infer that it identifies the user. If an issue is
Done and unassigned, set the known authorized human owner only within scope; otherwise return the
proposed assignment or missing-identity gap. A retrospect/read request alone does not authorize tracker
updates. Do not sweep unrelated done issues or publish lesson summaries as unsolicited comments.

## Reporting

State what was recorded/recalled and the loop-efficiency trend. When promoting, name the recurring
blocker and propose the concrete skill or guideline — don't auto-edit guidelines from a single run.

If the tracker close-out above changed anything — or found a backlog of unassigned done issues it
deliberately left alone — say so here.
