---
name: retrospect
description: Turn loop outcomes into a verified-lessons memory — record what fixed a failure, recall it next time, and promote recurring lessons into skills/guidelines. Use when the user wants the loop to learn from past runs, capture a fix as a reusable lesson, see why runs keep failing, or decide what to codify into a skill or CLAUDE.md.
---

# retrospect — the learning layer (verified lessons)

Make runs get smarter over time. A failure becomes a lesson (Reflexion); a *recurring, verified*
lesson becomes a skill/guideline candidate (Voyager). Full reference: loop-engine@paul-loop's
docs/lessons.md (in the plugin, not this repo).

> Commands below invoke `bin/<name>.sh` as `<however this repo invokes its installed loop-engine
> plugin's bin scripts> <name>.sh` (BAC-753). In a live session this is usually just the bare script
> name — a plugin's `bin/` is already on PATH once it's loaded. loop-engine also bundles its own
> resolver at `bin/plugin-path.mjs` (`resolve [plugin]` / `exec <relative-bin> [args...]`, env-var
> overrides `LOOP_ENGINE_PATH`/`SHIP_FLOW_PATH`/`LOOP_MEMORY_PATH`) for the cases bare-PATH doesn't
> cover — CI (no live plugin load, nothing on PATH) or resolving a *different* installed plugin's
> path. A consuming repo may still provide its own equivalent wrapper instead; either way, invoke it
> however this repo actually resolves plugin bin scripts.

## The one rule

**Only the verifier decides what is a lesson.** Record a lesson as `--verified` ONLY when ground
truth (tests/build/the eval gate passing) confirmed the fix — never on your own say-so. Only verified
lessons are recalled as authoritative; only recurring ones get promoted. This keeps hallucinated
"fixes" out of the memory and out of your guidelines.

## In a fix loop (automatic)

```bash
<however this repo invokes its installed loop-engine plugin's bin scripts> loop-fix.sh --verify "npm test" --fix '<agent>' --protect "**/*.test.*" --guard-mutation --lessons .loop/lessons
```
`loop-fix` recalls past verified fixes for the current failure into your prompt, and records a
verified lesson when it converges. Nothing else to do — just point `--lessons` at a (committed) dir.

## By hand (in-session)

- **Recall before you fix:** `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh recall --signature-file .loop/last-verdict.txt --lessons <dir>`.
  If a past run solved this exact failure, start from that, then re-verify (don't trust the memory —
  the verifier still decides).
- **Record after green:** once the verifier passes, `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh record --signature-file <first-failure>
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
<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh record --signature-file <...> --fix "<what worked>" \
  --source <tool-name> --category domain --lessons <dir>
```

Mark it `--verified` immediately only if a human directly confirmed the insight; anything merely
observed, inferred, or model-suggested still has to clear the same recurring + `lessons challenge` bar
as any engineering lesson before it's trusted. This is a per-repo/per-owner convenience — there's no
plugin-standard tooling for it, and a repo without such a tool can skip this section entirely.

## Retro & promotion (where self-improvement compounds)

- `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh stats --lessons <dir>` — avg iterations-to-green, recurrence counts, top recurring blockers.
  Use it to see whether the loop is actually getting faster.
- `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh promote --min-count 3 --lessons <dir>` — recurring verified lessons worth codifying. For
  each candidate, pick its destination with the checklist below, then hand it to `write-a-skill` (make
  the fix a reusable skill) or fold it into `CLAUDE.md` (a guideline) accordingly — then the loop stops
  re-solving it from scratch. Add `--runs .loop/runs` to fold in deterministic gate-regression
  signals: a `[REGRESSION: <gate> PASS→FAIL]` line — distinct from the `[N×]` recurrence count — marks
  candidates whose gate regressed in the runs ledger, and unattributed regressions list in their own section. The
  ledger is forgeable (trust boundary), so a regression is candidate INPUT only — the skeptical challenge gate stands.
- `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh retire --id <id> --ref "<where>" --lessons <dir>` — **after** you've codified an accepted
  candidate into a skill/`CLAUDE.md`, retire it so it stops re-surfacing (the promote listing, `--codify`,
  or a heartbeat-style "promotion candidate" nudge if this repo has one). This is the terminal gate that
  keeps the candidate pool from growing monotonically. Fail closed: only a verified + `challenge
  --verdict accept`ed lesson can retire; a content change later re-opens it for fresh review.
- `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh invalidate --id <id> --reason "<why>" [--superseded-by <id2>] --lessons <dir>`
  (if this repo's lessons tooling has it) — mark a lesson WRONG (the lesson itself was mistaken), distinct
  from `retire` (the lesson was right but is now codified). An invalidated lesson is excluded, fail
  closed, from recall and from the promote listing/`--codify` going forward.
- `<however this repo invokes its installed loop-engine plugin's bin scripts> lessons.sh mark-clean --gate "<verify cmd>" --lessons <dir>` (if
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
- **`write-a-skill` not available in this repo** (check `ls <skills-dir>/` — e.g. this plugin's own
  `tools/ship-flow/skills/` has no `write-a-skill` skill as of this writing): a skill-shaped candidate
  either waits for `write-a-skill` to be added, or — only if it truly can't survive as prose — becomes a
  CLAUDE.md guideline as a fallback. Don't force a procedure into CLAUDE.md by writing it as a numbered
  step list; a numbered list inside a guideline is the tell that the destination was chosen wrong, and
  it should move to skill form once `write-a-skill` lands.

### After `write-a-skill` writes a new skill — discoverability check

Codifying a candidate into a skill file isn't the same as making it *discoverable*. A skill nobody's
router ever picks is dead weight. If this repo's `write-a-skill` skill already runs a check like this
itself (read its own SKILL.md to confirm), trust it and skip this; otherwise run it by hand before
calling the promotion done:

- **Trigger-first `description:`.** It opens with *when* the skill fires ("Use when...", "Trigger this
  when...") — not a bare category label ("Handles X", "X utilities"). A category label can't be matched
  against a request; a trigger clause can.
- **No routing collision.** Skim sibling skills' `description:` fields for overlapping trigger language.
  Two skills that both plausibly fire on the same phrasing make routing ambiguous — narrow the wording
  (or merge the skills) until each has a distinct trigger.
- **No path escape.** Every file the skill reads or writes stays under its own skill directory
  (`<skills-dir>/<skill-name>/...`) — no `../` reaching into a sibling skill's directory or the skills
  root.
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

- **Cite the id.** Name the exact lesson id (or ADR number) under discussion — a vague appeal to "that
  decision" doesn't identify a target.
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

A reopen missing an id or missing new evidence is an automatic reject in the skeptical pass — the same
challenge gate as any promotion candidate. Verify it actually landed, too: after recording the new
evidence, run `lessons stats`/`lessons promote` and confirm the id is back among the open candidates —
don't take the act of re-recording alone as proof the lesson reopened.

## Reporting

State what was recorded/recalled and the loop-efficiency trend. When promoting, name the recurring
blocker and propose the concrete skill or guideline — don't auto-edit guidelines from a single run.
