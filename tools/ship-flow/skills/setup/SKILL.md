---
name: setup
description: One-time interactive setup for this plugin in a consuming repo — interviews the user, writes `.claude/ship-flow.config.json`, and installs (or offers to install) a CLAUDE.md constitution, a CI workflow, and branch protection from this plugin's templates/. Use once per repo, when a repo first adopts ship-flow, or when re-running to fill in config that was skipped the first time.
---

# setup — one-time ship-flow bootstrap

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

This plugin's skills (`hotfix`, and others as they're added) read `.claude/ship-flow.config.json` at
the consuming repo's root. This skill is how that file — and the repo-level scaffolding it depends on
(a CLAUDE.md, a CI workflow, branch protection) — gets created in the first place.

**This skill is not part of the day-to-day delivery loop.** Run it once when adopting this plugin in a
repo; re-run it later only to fill in something skipped the first time or to change a config value.

## What this plugin can and can't install

A plugin's own root-level `CLAUDE.md` is **not** loaded as project context by Claude Code (confirmed
against the official plugin spec) — so the constitution layer can't just ship inside the plugin and
work automatically. That's why this skill exists: it *copies* a template into the consuming repo's own
`CLAUDE.md`, where it will actually be loaded.

| Can install directly | Needs this skill to copy/patch into place |
|---|---|
| Skills, agents, workflows (this plugin itself) | `CLAUDE.md` (constitution) |
| | CI workflow (`.github/workflows/ci.yml` or equivalent) |
| | Branch protection (a GitHub API call, not a file) |
| | `turbo.json`/verify-script wiring (repo-specific, example only) |

## Sequence

### 1. Check for existing config
Read `.claude/ship-flow.config.json` if it exists. If it does, tell the user what's already set and
ask whether they want to reconfigure or just fill gaps — don't silently overwrite it.

### 2. Interview
Ask one question at a time (don't front-load all of them — a wrong early answer, like the wrong branch
model, changes what later questions even mean):

1. **Branch model**: `git-flow` (a shared integration branch + a release branch, e.g.
   develop→main) or `trunk-based` (a single shared branch). If git-flow: what are the two branch
   names? If trunk-based: what's the one branch name?
2. **Package manager**: what does this repo use (`pnpm`/`npm`/`yarn`/`cargo`/`uv`/other)?
3. **Verify command**: what single command does this repo run to check "is this change good" —
   typecheck+lint+test, or whatever this repo actually has? (If the repo has nothing yet, offer
   `templates/turbo-verify-wiring.example.md` as a starting point — see step 4.) Record the **raw**
   command as-is (e.g. `pnpm verify`), even if this repo already has its own verdict-contract wrapper
   (e.g. `pnpm verdict`) — either way, `ship-feature`/`hotfix` always run it as
   `verdict-run.sh -- <verifyCommand>` (BAC-745), and `verdict-run.sh` passes an already-emitted
   `=== VERDICT ===` block through unchanged instead of double-wrapping it. Don't write `verdict-run.sh`
   itself into this field.
4. **Project name**: what should the `CLAUDE.md` template call this repo?
5. **Issue tracker** (optional): does this repo use an external tracker (Linear, Jira, bare GitHub
   Issues, none)? Only asked if relevant — don't force an answer if the repo has no tracker at all.
6. **Output language**: which language should this repo's agents write prose in — reports, summaries,
   PR bodies, tracked-issue comments? **Infer a default first, then confirm it rather than asking cold**
   — the language the user has been writing to you in this very session is the strongest signal, and an
   existing `CLAUDE.md`, README, recent commit messages, or tracked-issue titles corroborate it. Present
   what you inferred ("this repo's docs and your messages are Korean — record `ko`?") and let the user
   correct it. Record it as `outputLanguage`, a **BCP-47 tag** (`ko`, `ja`, `en`, `pt-BR`), not a
   language name — a tag has one spelling, "Korean"/"korean"/"한국어" have three.

Write answers into `.claude/ship-flow.config.json` as you go (don't wait until the end — a skill that
dies partway through step 3 shouldn't lose steps 1-2's answers):

```json
{
  "branchModel": "git-flow",
  "integrationBranch": "develop",
  "releaseBranch": "main",
  "packageManager": "pnpm",
  "verifyCommand": "pnpm verify",
  "projectName": "my-project",
  "trackerName": "Linear",
  "pluginBinPrefix": "",
  "outputLanguage": "ko"
}
```

(`integrationBranch`/`ciSkipOnIntegrationPR`/`deployHook` are `hotfix`'s existing fields — leave them
as `hotfix`'s own doc describes if this is a fresh file. `trunk-based` repos omit `integrationBranch`.)

**`outputLanguage` is the one field a re-run should always check for.** Every ship-flow skill and agent
opens with an output-language banner that reads this key; with the key missing they fall back to
whatever language the current conversation is in, which holds early in a session and then drifts as
long English skill bodies come to dominate the context — the observed failure is a run that plans and
reviews in the user's language and then reports its PR in English (or, once, in a third language
nobody asked for). Writing the key is what removes the guessing. It is **prose language only**: code,
commands, flags, identifiers, paths, branch names, and quoted tool output are never translated, and
`verifyCommand`/`pluginBinPrefix`/branch names in this same config are values, not prose.

**`pluginBinPrefix` — don't skip this one.** It's what turns every loop-engine bin command in
`ship-feature`/`hotfix`/`retrospect`/`deps-audit` from a description into a string an agent can actually
run: those skills write commands as `{{pluginBinPrefix}}<script>` and substitute this value, concatenated
onto the script name **with no separator** (so a value needing a space or slash carries its own trailing
one). Don't ask the user to phrase it — derive it and confirm:

| Situation | Value |
|---|---|
| Normal case: skills run inside a live Claude Code session, where an installed plugin's `bin/` is on PATH | `""` (the default) |
| This repo already has its own resolver wrapper | `node tools/plugin-path.mjs exec bin/` (or whatever its real path is) |
| Skills also need to run headless (CI, a cron shell) where nothing is on PATH | `node "$LOOP_ENGINE_PATH/bin/plugin-path.mjs" exec bin/`, paired with the `setup-loop-engine` action from step 4 |

Write `""` if unsure — that's the case that works in a live session, and it's the value whose failure
mode is loud (`command not found`) rather than silent.

### 3. Install `CLAUDE.md`
Read `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md.template`, substitute every `{{PLACEHOLDER}}` with the
interview's answers (see the template's own placeholder list at its end for what's expected), and
write the result to the consuming repo's `CLAUDE.md`.

**If a `CLAUDE.md` already exists**: don't overwrite it silently. Show the user a diff-style summary of
what the template would add/change and ask whether to merge, skip, or replace.

### 4. Offer CI + turbo wiring (optional — ask, don't assume)
Ask whether to install a starting CI workflow from `${CLAUDE_PLUGIN_ROOT}/templates/ci.yml.template`
(substituting `{{RELEASE_BRANCH}}` and `{{VERIFY_COMMAND}}` from the config) at
`.github/workflows/ci.yml`. If the repo already has a CI workflow, don't overwrite it — point out
`templates/ci.yml.template`'s `ci-gate` pattern (the always-run aggregator, and why it exists) as
something worth adopting into their existing workflow instead, and stop there.

If the repo is (or will be) a turbo monorepo with no verify wiring yet, point at
`${CLAUDE_PLUGIN_ROOT}/templates/turbo-verify-wiring.example.md` as a starting point — this one is
reference material to adapt by hand, not something this skill copies verbatim (task names vary too
much repo to repo to template safely).

If any CI job in this repo needs to invoke a loop-engine or ship-flow bin script directly (a PR gate
running `classify-risk.sh`/`ac-verify.sh`, or a repo-local harness self-test) — ask whether to
install `${CLAUDE_PLUGIN_ROOT}/templates/setup-loop-engine.action.yml.template` at
`.github/actions/setup-loop-engine/action.yml` (BAC-753), substituting `{{LOOP_ENGINE_TAG}}`/
`{{SHIP_FLOW_TAG}}` with the plugin versions this repo currently targets (match `minPluginVersions`
if this repo has one — see verify-loop-wiring's floor check pattern). GitHub Actions is a plain shell
process outside the live-session plugin cache, so any such job needs this action's
`LOOP_ENGINE_PATH`/`SHIP_FLOW_PATH` exports before loop-engine's bundled `bin/plugin-path.mjs`
resolver (or a bin script invoked directly) can find anything.

For `git-flow` repos, also offer `${CLAUDE_PLUGIN_ROOT}/templates/loop-selftest.yml.template` as a
`{integrationBranch}`-PR backstop for harness/policy changes that `ci.yml` never sees (git-flow's
feature→integration PRs skip `ci.yml`'s trigger entirely — see `ci.yml.template`'s own comments).
Like `turbo-verify-wiring.example.md`, this one is reference material to adapt by hand — the actual
policy paths and selftest command are this repo's own, not something to copy verbatim.

Also offer the commented-out `hygiene` job in `ci.yml.template` (BAC-754) — three cheap, dependency-free
static gates from loop-engine's own `bin/`: `check-docs-hygiene.mjs` (ADR numbering/README index/
dangling-reference/SKILL.md word cap), `check-pr-hygiene.mjs` (PR body must reference a tracker id —
ask whether this repo's id format needs `--pattern` beyond the generic "LETTERS-digits" default), and
`check-module-size.mjs` (module-size ratchet — needs `tools/module-size-baseline.json` committed for
first adoption, or defaults to a bare threshold with no per-module entries). All three need the
`setup-loop-engine` action from step 4 above; skip offering this job if that action wasn't installed.

If this repo's tracker id format needs a non-default `check-pr-hygiene.mjs` pattern, note it in
`.claude/ship-flow.config.json` (e.g. a `trackerIdPattern` field) so it stays discoverable alongside
the rest of this repo's ship-flow config, and pass it through wherever `check-pr-hygiene.mjs` is
invoked (the `ci.yml` job above, and `ship-feature`/`publisher`'s own PR-body composition step, if this
repo wants the same check enforced before a PR is even opened).

Offer `${CLAUDE_PLUGIN_ROOT}/templates/risk-rules.example.json` too, if this repo doesn't already have a
`risk-rules.json` at its root — `classify-risk.mjs` ships zero product-specific rules on purpose
(BAC-698/BAC-563 C5), so without one, this plugin's risk gating only ever sees its structural baselines
(docs-only, low-file-count, etc.) and every domain-specific path (migrations, auth, outbound sends) goes
unclassified. This is reference material to adapt by hand, not something to copy verbatim — every
placeholder path needs replacing with this repo's real ones. Point out that the template's `harness`
rule is self-covering by design (it matches `risk-rules.json` itself, so silently weakening a rule and
the file that defines rules in the same PR still gets flagged) — the copy should keep that property, not
drop it while filling in the other placeholders.

### 5. Offer branch protection — human stop point, always
**Never run `templates/branch-protect.sh` without an explicit `AskUserQuestion` confirmation first,
every time** — this changes a real GitHub repo setting, and a past "yes" to a different question isn't
consent for this one. Show the user the exact command this would run (repo, branch, flags) before
asking.

If confirmed, run it once per branch that needs protecting (the release branch always; the integration
branch too, if git-flow and the user wants it protected).

### 6. Confirm
Report what was installed/changed and what was skipped (and why — e.g. "CLAUDE.md already existed, so
I left it — here's what the template would have added"). If anything from steps 3-5 was skipped, say
so explicitly rather than letting the user assume everything happened.

## If this repo already had local skills with the same names

Plugin skills are namespaced by the platform (`plugin:skill`, not a bare name); if this repo used to
invoke a same-named local skill directly (e.g. `/ship-feature`), there's no compat shim to fall back
on — every live reference has to be updated in the same pass (CLAUDE.md, `docs/agents/*`, other skill
bodies; leave `.loop/lessons/*.json` and other historical records alone). One sweep habit catches what a
narrower one misses:
- After a bulk find-and-replace, grep the **raw renamed substring** across each touched file, not just
  the specific quoting/escaping form your edit targeted — the same string can appear a second time in a
  different escaping (e.g. a plain backtick in a single-quoted string vs. an escaped backtick inside a
  template literal), and a `replace_all` on one form silently leaves the other.

## Testing this skill itself

If you're validating this skill's own correctness (not running it for a real repo): run it against a
genuinely empty scratch repository (a fresh `git init`, nothing else) and confirm that after it
finishes, a real verify-like gate actually runs and exits non-zero on a deliberately broken change —
that's the concrete, checkable version of "the interview actually produced a working setup," not just
"the files got written."
