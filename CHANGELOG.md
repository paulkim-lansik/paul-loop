# Changelog

Each plugin in this marketplace versions independently, following [semver](https://semver.org).
Explicit-version channel — see [README § Development status](README.md#development-status) for why
not a SHA channel. Entries below `## loop-engine 0.2.0` and earlier predate the multi-plugin split
and refer to `loop-engine` only (see the un-prefixed version numbers).

## ship-flow 0.3.1 · loop-memory 0.3.1

- Dependency range only: both declared `loop-engine ^0.8.0`, which `0.9.0` (below) falls outside of.
  Bumped to `^0.9.0`, following the convention of every prior loop-engine minor (`^0.6.0`→`^0.7.0` with
  0.7.0, `^0.7.0`→`^0.8.0` with 0.8.0). Neither plugin's behaviour changed and neither actually needs a
  0.9.0 feature — the patch bump exists because this is an explicit-version channel, so changed manifest
  content must not ship under an already-published version number.

## loop-engine 0.9.0

Ledger instrumentation repairs + two new gates, all evidence-driven from a 7-day audit of a consuming
repo's own `.loop/runs/` (3,096 events across 111 run files).

- **Verdict events now reach the session ledger (BAC-778).** Measured hole: the instrumentation hook
  writes under `CLAUDE_PROJECT_DIR` while `bin/verdict-run.sh` writes under its own **cwd**, so any
  repo that isolates work in git worktrees split the two apart on every run — the main ledger held
  **zero** `verdict.*` events across all 111 runs while one worktree's `.loop/runs/unknown.jsonl`
  held 14 `verdict.passed` + 2 `verdict.failed`. `bin/run-metrics.mjs` therefore reported `q2` and
  `first_pass` as `INSUFFICIENT_DATA` for every single run: the loop's headline metric (verify
  first-pass rate) was unmeasurable from its own ledger. New `lib/run-ledger.mjs` →
  `resolveLedgerTarget()`, used by `bin/ledger-append.mjs --auto-run-id`, resolves both the ledger
  root and the run-id by **corroboration** — an event only moves to another root if that root already
  holds `<run-id>.jsonl` (proof the hook is writing this session there). Run-id prefers
  `CLAUDE_CODE_SESSION_ID` (present in the Bash tool's env — verified empirically; `CLAUDE_PROJECT_DIR`
  is **not**, which is why the main worktree also has to be inferred via `git rev-parse
  --git-common-dir`), which is immune to the `current` pointer's concurrent-session last-writer-wins.
  With no corroboration the previous behaviour (cwd + `current` pointer + `unknown` bucket) is
  unchanged byte-for-byte. `verdict-run.sh` now also records `payload.cwd`, so a redirected event
  doesn't lose which worktree it actually ran in.
- **Subagent events stop implying a count they can't support (BAC-778).** Measured: 2,307
  `subagent.stopped` vs 472 `subagent.started`, with 1,896 stops carrying `agent_type: ""`.
  Cross-checking `agent_id` across the whole ledger settles the cause and rules out a payload bug on
  our side — **405/405** distinct *typed* stop ids have a matching `started`; **1,901/1,901** distinct
  *untyped* stop ids have none. The platform fires `SubagentStop` for agent kinds whose
  `SubagentStart` never fires, and its stdin for those carries no `agent_type`; a hook cannot invent
  it. So the shape gets honest instead: absent → `agent_type: null` (never `""`, which reads as "we
  captured a type and it was blank"), plus `attributable: false` and an `extra` bag preserving
  whatever else the platform did send — the only way a later audit discovers an identity field under
  a name we don't know yet. `bin/run-metrics.mjs` gains a `subagents` axis splitting `started` /
  `stopped_paired` / `stopped_unattributed`, so per-agent duration/success can only be derived from
  the paired population.
- **`permission.denied` is diagnosable for every tool shape (BAC-778).** Bash denials already
  recorded `command` and Edit/Write `file_path` (checked against 28 real denial events — the audit's
  "Bash denials record only the tool name" did not reproduce against this code), but every other tool
  landed with `tool_name` and nothing else (measured: `SendMessage`, `ScheduleWakeup`). Denial events
  now carry `tool_input_keys` — the key **names** only, never the values, so it can't carry a secret
  or grow the ledger.
- **New gate `hooks/gate-verify-pipe.mjs` (PreToolUse/Bash).** Denies a verify-shaped command piped
  into another command when the same invocation preserves no real exit status. Measured in four
  audited runs: `cd <wt> && timeout 590 pnpm verify 2>&1 | tail -200` followed, in a *separate* Bash
  call, by `echo "exit code of last pnpm verify: $?"` → `0`. That `0` was unrelated to verify twice
  over (a pipeline's `$?` is the last stage's, and the tool resets the shell between calls). Those
  runs happened to be green, so the evidence was merely worthless rather than wrong — and the same
  sessions used the correct `> log 2>&1; echo EXIT:$?` form elsewhere. `pipefail`/`PIPESTATUS`
  anywhere in the invocation, or a redirect instead of a pipe, pass untouched. Reuses
  `hooks/command-tokenizer.mjs` (no second parser) and follows the established
  fail-open-on-detection / fail-closed-once-certain shape. Verify vocabulary is config
  (`.claude/ship-flow.config.json` → `verifyCommandPattern`), defaulting to this harness's own
  `verify`/`verdict`; kill switch `LOOP_VERIFY_PIPE_GATE_OFF=1`.
- **`hooks/gate-worktree-create.mjs` escalates a second feature worktree in one session** to
  `permissionDecision: "ask"` (the human-approval prompt = the gate vocabulary's REQUIRE) — the
  mechanical half of a boundary violation where an audited run opened its PR and then began an
  entirely new issue. The existing `origin/*` deny rule is unchanged and still wins, and a denied
  command doesn't consume the budget. Non-feature branches (`lessons/*`, `chore/*`, …) are exempt.
  Prefix is config (`featureBranchPrefix`, default `feature/`); kill switch
  `LOOP_WORKTREE_SESSION_GATE_OFF=1`. **The limits are stated in the file header and are real**: "one
  session" is the payload's `session_id` and nothing else — no `session_id` means no escalation at
  all (undeterminable must not become "everything is one session"); a subagent has its own session id
  so it neither counts toward nor sees the parent's budget; `EnterWorktree` / `Agent
  isolation:"worktree"` never reach a Bash hook; and it counts *attempts* (deduped by branch name),
  so a `git worktree add` that later fails on its own still consumes the budget.
- **`bin/check-pr-hygiene.mjs` gains opt-in reviewer coverage** (`--reviewers a,b,c`,
  `--result-pattern`): each named reviewer must appear in the PR body with a result token on its line
  or within the next 2 lines — a bare mention in prose is not a result block. Motivated by an audited
  run that summoned 2 of 3 mandated review agents with no gate catching it. Reviewer names are
  consumer-repo config, never hardcoded here (a self-test asserts the plugin's code contains none),
  and without `--reviewers` the existing tracker-reference contract is untouched.
- 5 new self-tests (`ledger-attribution`, `subagent-event-shape`, `gate-verify-pipe`,
  `worktree-session-scope`, `pr-reviewer-coverage`); suite 42 → 47 files. `hooks/hooks.json` gains 1
  hook command (16→17, 8→9 distinct files).
- **Follow-up needed elsewhere**: `tools/ship-flow/.claude-plugin/plugin.json` declares
  `loop-engine ^0.8.0`, which excludes 0.9.0 — that range needs widening in a separate PR.
  Deliberately not edited here: concurrent work owns that file.

## ship-flow 0.3.0

Forensic audit of 12 real `ship-feature` runs (2026-08-24) found the skill's own mandated deterministic
tools executed **0 out of 12 times** — `ship-flow:tdd` 0/12, `ac-verify.sh` 0/5, `verdict-run.sh` 0/2,
AC-contract authoring 1/5. This release fixes the cause and five adjacent findings from the same sample.

- **Commands are substitutable literals, not prose (the root cause).** Every loop-engine bin invocation
  in `ship-feature`/`hotfix`/`retrospect`/`deps-audit` was written as a *description* —
  `<however this repo invokes its installed loop-engine plugin's bin scripts> verdict-run.sh -- …`.
  An agent cannot execute a description, so every run fell back to the raw verify command it already
  knew, silently dropping the verdict contract, the risk gate and the AC gate at once. These are now
  one literal each, `{{pluginBinPrefix}}<script> …`, substituted from a new `pluginBinPrefix` config key
  (concatenated onto the script name with no separator; default `""`, since a plugin's `bin/` is on PATH
  in a live session). `setup` interviews for and records it.
- **Argument form is now stated, not re-derived.** The same prose placeholder also caused mis-parsing:
  4 runs pasted a spurious `--` into `classify-risk.sh` and got a usage error before retrying.
  `ship-feature` now states that `verdict-run.sh` is the only script here that takes a `--`, that
  `classify-risk.sh`/`ac-verify.sh`/`lessons.sh` reject one, and that `--path` repeats per path.
- **Review agents are named `ship-flow:`-namespaced** in `ship-feature` step 4. A bare `code-reviewer`
  collides with `pr-review-toolkit:code-reviewer` — a different agent with a different checklist that
  many consuming repos also install. No mis-resolution was actually observed in the sample (outputs
  carried ship-flow's own checklist markers), so this closes a structural risk rather than a live bug.
- **`agents/planner.md` is wired in rather than deleted.** It shipped but no skill invoked it. It earns
  its place because its criterion 5 is the only thing that checks a plan declares an AC contract *before*
  TDD — and AC-contract authoring was the 1/5 finding above, which is exactly what makes step 3's
  `ac-verify.sh` gate vacuous when it's missing. `ship-feature` step 1 now hands the finished plan to
  `ship-flow:planner`; a BLOCK loops back into step 1 without calling a human.
- **Review subagents must not run docker-based deep gates themselves.** In one run two review subagents
  collided 3 ways on the same worktree's shared deep-gate container, both hit watchdog timeouts, and
  their failures were silently skipped — the run continued as if reviewed. `code-reviewer`/`test-hunter`/
  `verifier-integrity-hunter` now consume the calling session's already-produced result logs instead, and
  `ship-feature` step 4 states that a watchdog/stall non-completion is a **BLOCK** to be re-summoned,
  never "no findings".
- **Hard termination at the PR, and a scope guard on the grill step.** Step 5's bare "Stop here" never
  said what was forbidden: one run opened its PR then created a new worktree + issue + PR in the same
  session; another read a single "머지해줘" as blanket approval and ran `gh pr merge` three times; a third
  let scope grow until the original issue was never implemented. Step 5 now names what must not happen
  after the PR opens and that merge approval is per-PR and never inferred; step 1 requires scope growth
  found while grilling to be split into a separate issue with **this** run continuing at its original scope.
- **Question qualification.** The skill claimed "autonomous by default, humans called at exactly 3
  points", but the sample showed 17 design round-trips of which **17/17** were answered "just go with
  your recommendation". If the skill can state a clear recommendation and the decision is reversible, it
  now proceeds and records the choice in a `Decisions taken` PR-body section instead of blocking. Human
  calls stay reserved for risk-gate REQUIRE verdicts and the merge boundary.
- **Output language is config-driven (`outputLanguage`, BCP-47).** Across 78 sampled interactive sessions,
  21 had the user ask for Korean 30 times; the drift points were almost entirely `ship-feature` step 5's
  PR report and the session-closing summary — where the English skill body has come to dominate context —
  and one session reported its PR in Japanese. No language anchor existed anywhere in the consuming repo.
  Every ship-flow skill and agent now opens with an anchor reading `outputLanguage`, restated at the
  measured drift points (step 5's PR/comment composition, the final message, each review agent's Output
  section). The prose/verbatim boundary is explicit — **prose, reports, PR bodies in that language; code,
  commands, flags, identifiers, paths, branch names and quoted tool output verbatim, never translated.**
  Fail-open: key absent → the language the user is writing in, never an error. `publisher` gets a
  deliberately narrower rule (it reads no repo files and re-encodes nothing it was handed).
- New `tools/loop-engine/test/ship-flow-executable-contract.test.sh` locks all of the above — 13
  assertions, each negative-controlled (the property was broken and the test observed to fail). It lives
  in `tools/loop-engine/test/` because that directory *is* the whole-repo self-test suite despite its
  path, and it adds no loop-engine runtime behaviour, so **loop-engine is deliberately not bumped for
  it**. Like `verdict-wrap-required.test.sh` and `skill-guard-prose-wiring.test.sh`, it is a text-level
  regression guard on skill prose — it cannot prove an agent obeyed an instruction, only that the
  instruction hasn't reverted to the shape that provably wasn't obeyable. Runtime enforcement of the
  output language (measuring a target-language ratio in an agent's actual prose) was considered and
  rejected: this plugin never sees agent output — `verdict-run.sh`'s LOG captures the *verifier's*
  output, not the agent's — so there is nothing here to measure it against.


## loop-memory 0.3.0

- **Fixes a silent no-op**: both hooks read the embedding key from the process env only, but Claude
  Code hands a hook the *session process env* — it never loads `.env` files. A repo keeping its key
  in a gitignored `.env` (the normal way to hold a secret that must not be committed) and not
  `export`ing it therefore tripped each hook's own no-key gate: recall and graduation were both dead,
  with no error anywhere. The plugin now loads a dotenv-shaped file itself, before that gate
  (`hooks/lib/load-dotenv.mjs`, dependency-free), so no consuming repo needs to carry a local loader
  hook — which is how the capability got lost in the first place, when a repo dropped its local hook
  copies in favour of this plugin.
- New `loop_dotenv_path` userConfig option (env `LOOP_DOTENV_PATH`), default `.loop/.env` — the file's
  location is a per-repo layout question, so it's configurable rather than assumed. Precedence is
  session env > userConfig > file; a key already set is never overwritten. Every key in the file is
  loaded, not only the ones with a matching userConfig option (so `LOOP_EMBED_PROVIDER` and friends
  reach the CLI from the file too).
- Worktree fallback: a gitignored `.env` does not exist in a freshly-created feature worktree, which
  is exactly where an isolated agent loop runs. If the configured path is missing there, the *main*
  worktree's copy is read instead (`git rev-parse --git-common-dir`). Nothing is copied — the key
  stays untracked and in one place. Without this the plugin fails closed in every worktree, which is
  how this same failure class stayed invisible for six weeks in the plugin's origin repo.
- Loading stays best-effort: a missing/unreadable file, or a non-git directory, leaves the env
  untouched and the hooks return to their normal fail-open no-op.
- New `test/hooks-dotenv.test.ts` (11 tests) exercising the **real hook processes**, not the loader in
  isolation: key-from-file reaches the gate (both hooks), session env and userConfig each beat the
  file, custom path honoured, quoting/`export`/inline-comment parsing, missing file → clean no-op,
  directory-instead-of-file → no throw, worktree fallback resolves, a worktree's own `.env` preferred
  over the main one's, non-git directory → clean no-op.


## loop-engine 0.8.0

- New `templates/risk-rules.example.json` (BAC-757) — a shape-only starter for `classify-risk.mjs`'s
  externalized rule table (this plugin ships zero product-specific rules by design, BAC-698/BAC-563
  C5). Every path/pattern is a `<placeholder>` a consuming repo must replace, but the `harness` rule's
  self-coverage property (it matches `risk-rules.json` itself, so silently weakening a rule and the
  file that defines rules in the same PR still gets flagged) is meant to survive the copy — called out
  explicitly in both the template's own `$comment` and `setup`'s guidance (ship-flow, below).
- New `test/classify-risk-rules.test.sh` case (8) locking the template: valid JSON, its harness rule
  self-covers (`risk-rules.json` and `CLAUDE.md` both match, both raise `blast=high`), and its per-rule
  `deep` gate lists are pinned so a future edit can't silently drop one.
- New `test/skill-frontmatter-bac757.test.sh` (BAC-757) — locks which ship-flow skills declare
  `context: fork` and which don't (see ship-flow 0.2.9 below for what that split is and why).

## ship-flow 0.2.9

- Skill frontmatter modernization (BAC-757, backport of BAC-621's glucofit-partners pattern): three
  ship-flow skills — `deps-audit`, `retrospect`, `resolving-merge-conflicts` — gain `context: fork`.
  Each was read end-to-end to confirm it never blocks mid-run on a live user question (a forked
  subagent's questions never reach the user); any "get a human's OK" moment in these three is async —
  producing a report/candidate list for a *later*, separate review, not something the run itself
  blocks on. The other 9 skills (`setup`, `grill-with-docs`, `to-issues`, `hotfix`, `ship-feature`,
  `harness-maturity-audit`, `improve-codebase-architecture`, `tdd`, `to-prd`) deliberately do NOT get
  `context: fork` — each has at least one load-bearing mid-flow question the rest of that same run
  depends on (an explicit `AskUserQuestion` gate, or a "confirm/ask the user" checkpoint prose
  describes as blocking) — full audit trail of which line justified each exclusion is in
  `test/skill-frontmatter-bac757.test.sh`'s header comment (loop-engine, above).
- `setup` now offers loop-engine's new `templates/risk-rules.example.json` alongside the other optional
  scaffolding in step 4, calling out its self-coverage property so a repo's copy doesn't silently drop
  it while filling in the placeholders.
- **`allowed-tools` and `paths` frontmatter fields were deliberately NOT added in this pass** (unlike
  BAC-621's glucofit-partners precedent, which uses both) — verified against the current official
  syntax first (`allowed-tools` is a non-restrictive pre-approval hint only, cleared every turn; it
  cannot break a skill even if incomplete) rather than assumed. `paths` doesn't semantically fit any of
  these 12 skills — they're all intent-triggered ("Use when the user..."), not file-path-triggered like
  `design-sync`/`partners-web-design` are in glucofit-partners. `allowed-tools` would fit, but ship-flow
  skills are deliberately consuming-repo-agnostic (Bash commands route through "however this repo
  invokes its bin scripts"), so a literal command-pattern list is either wrong per-repo or so broad
  (`Read Write Edit Bash Task`) it adds no real precision — low value for the effort/review-risk of
  enumerating 12 skills' full tool needs, especially the complex multi-agent ones. Left for a future
  pass if a concrete need surfaces.
- `loop-engine` dependency range `^0.7.0`→`^0.8.0` (joint-constraint: loop-engine's own bump above is
  minor, so the old range would become unsatisfiable).

## loop-memory 0.2.6

- No content change — same joint-constraint dependency bump as ship-flow 0.2.9 above
  (`loop-engine` `^0.7.0` → `^0.8.0`).

## loop-engine 0.7.1

- New `test/runtime-verify-evidence-bac749.test.sh` (BAC-749) — locks the two ship-feature step 3
  guidelines below in place. No bin/lib change (patch).

## ship-flow 0.2.8

- ship-feature step 3 (runtime-verify) gains two evidence-gathering guidelines (BAC-749, Aside
  harness-benchmarking research §5.1 conditional candidate A3, downgraded from a full ARIA-diff-first
  build to a one-line guideline since equivalent tooling already exists in most consuming repos):
  when a browser is involved, prefer an accessibility-tree snapshot (+ diff) as the observation
  evidence over a screenshot — a screenshot is for when something genuinely needs visual confirmation,
  not the default; and never attach a browser-automation MCP that drives the user's own logged-in
  browser (their cookies, their accounts) to this autonomous step, since a prompt injection on the
  page under test would then reach the user's real accounts instead of a sandboxed session.

## loop-engine 0.7.0

- Compaction instrumentation (BAC-746, Aside harness-benchmarking research §5.1 #2): bundles a
  `PreCompact` (matcher `auto`/`manual`) hook registration and a new `compaction` run-ledger event
  type (payload: `cwd`, `trigger`, `custom_instructions`) via `hooks/record-run-event.mjs`. Measures
  whether context compaction correlates with subsequent verifier failure — previously only known
  indirectly via `instructions.loaded`'s `load_reason:"compact"` count, with no signal on whether
  compaction actually hurt outcomes.
- `bin/run-metrics.mjs` adds two fold outputs (both text and `--json`): per-run `compactions` (count)
  and overall `post_compaction_red` — the fraction of "first verdict after a compaction" events that
  were `verdict.failed`. Back-to-back compactions with no intervening verdict collapse to one pending
  "recently compacted" state rather than double-counting the same next verdict. Follows the existing
  `INSUFFICIENT_DATA` convention when no compaction events exist in the ledger.
- `hooks/hooks.json` gains 2 more hook commands (14→16, still 8 distinct files — `PreCompact`'s two
  matchers both point at the already-existing `record-run-event.mjs`) — regression-tested end-to-end
  (a real `PreCompact` input must append a `type:"compaction"` ledger event, not just parse without
  throwing).
- Consuming repos: bump loop-engine (and re-tag `PreCompact` reaches them automatically via the
  bundled hook — no local `.claude/settings.json` wiring needed per BAC-752's plugin-first decision).
  After ~1 week of real usage, check `run-metrics.mjs`'s `post_compaction_red` to decide whether the
  separate conditional "compaction checkpoint" issue is worth starting.

## ship-flow 0.2.7

- No content change — `dependencies` range on loop-engine bumped `^0.6.0` → `^0.7.0` to stay
  satisfiable after loop-engine's minor bump above (joint-constraint: a 0.x caret range is
  same-minor-strict, so this must land in the same PR as the loop-engine bump it depends on).

## loop-memory 0.2.5

- No content change — same joint-constraint dependency bump as ship-flow 0.2.7 above
  (`loop-engine` `^0.6.0` → `^0.7.0`).

## loop-engine 0.6.2

- `test/lesson-codification-bac756.test.sh` updated for the ship-flow 0.2.6 correction below — its
  PASS blocks now match what's actually codified, plus regression guards against re-adding the 5
  reverted lessons. No bin/lib change (patch).

## ship-flow 0.2.6

- **Self-correction of 0.2.5**: PR#50 (BAC-756) codified 9 lessons before running an independent
  challenge pass instead of after — backwards from this repo's own rule (CLAUDE.md's "회의적 평가(accept)를
  통과한 것만 코디파이", mirrored here in `docs/adr/README.md`'s lessons-lifecycle notes). Running that
  challenge pass afterward rejected 5 of the 9:
  - `3602ba166619af93` (ADR-number collision across concurrent PRs) — already covered, more strictly,
    by the consuming repo's own worktree-scan policy; not new or surprising enough on its own.
  - `630796f2f488f993` (deep-gate container race) — a near-duplicate of the already-accepted
    `0e5154a1`, tied to one repo's non-portable container-naming script rather than a portable fact.
  - `92d95548aad4ebf4` (stale docker volume after a migration-set change) — restates Postgres's own
    documented init-script behavior (init scripts only run against an empty `$PGDATA`), not a non-obvious
    finding worth a permanent doc entry.
  - `5b4f4c8ba005695f` (preserve isolation env vars when bypassing a helper script) — a single (count=1)
    incident whose generalized lesson is close to generic engineering discipline.
  - `38e9a48c3659de1d` (grep the whole repo before narrowing scope) — standard diligence most engineers
    already default to; too obvious for a permanent doc entry.

  Their prose is reverted here: `skills/ship-feature/SKILL.md` step 2's blockquote drops the
  stale-volume and isolation-identifier sentences (keeps the still-accepted "don't run more than one
  deep gate at once" sentence, which covers `0e5154a1`); `skills/setup/SKILL.md`'s namespace-migration
  section drops the "grep whole repo from the first pass" bullet (keeps the still-accepted raw-substring
  re-grep bullet, `53da49e1`); `skills/grill-with-docs/ADR-FORMAT.md`'s Numbering section drops the
  concurrent-open-PR check entirely. The other 4 codifications from 0.2.5 stand as accepted:
  `07bc4859` (stacked PR + squash-merge retarget), `15c8b2ca` (MCP browser fallback), `1a5200e3`
  (macOS ACL blocking `git worktree remove`), `fb72c699` (reviewer has no web access). The 2 lessons
  that already carried `challenge.verdict: "reject"` before this issue started
  (`8932917806328c0b`, `f3f65538bf7d33b6`) were never codified and are unaffected.

## ship-flow 0.2.5 (superseded by 0.2.6 above — see correction)

- Codifies 7 of the 9 verified lessons a reverse-backport audit found in glucofit-partners'
  `.loop/lessons/` with no matching guidance anywhere upstream (BAC-756). The other 2
  (`8932917806328c0b` "workflow tier merge step must assert `merged===true`", `f3f65538bf7d33b6`
  "`gh pr merge --admin` needs `enforce_admins` disabled first") already carry
  `challenge.verdict: "reject"` in that repo's lesson store — CLAUDE.md's own rule is that only an
  accept-passed lesson gets codified, so those two are deliberately left out here despite being listed
  in the source issue's table.
  - `skills/ship-feature/SKILL.md`: a stacked-PR + squash-merge base-retarget warning (failures
    section) with a "verify beyond the MERGED badge" pointer; a deep-gate docker-isolation advisory in
    step 2 (don't run more than one in a worktree at once, clean stale state after a rebase, preserve a
    bypassed helper's isolation identifiers); an MCP-unavailable browser-automation fallback note in
    step 3; a one-line macOS ACL cross-reference in step 0.
  - `skills/hotfix/SKILL.md`: the same stacked-PR retarget warning and the full macOS ACL
    `git worktree remove` fix in the cleanup step.
  - `agents/code-reviewer.md`: a new operating rule — this reviewer has no web access, so a BLOCK on a
    platform-spec question from a local reference doc alone should be flagged as unverified, not
    treated as settled fact.
  - `skills/grill-with-docs/ADR-FORMAT.md`: the Numbering section now says to check open PRs for
    `docs/adr/` additions before finalizing a number, not just the local filesystem.
  - `skills/setup/SKILL.md`: a new "If this repo already had local skills with the same names" section
    on namespace-migration sweep discipline (grep the whole repo from the first pass; re-grep the raw
    renamed substring, not just the escaping form your edit targeted, to catch differently-escaped
    sibling occurrences).

## loop-memory 0.2.4

- `loop-engine` dependency range bumped `^0.5.0` → `^0.6.0` to match loop-engine's minor bump below
  (same-PR joint-constraint bump — the exact bug class fixed three times before, this time caught
  proactively via `grep -rn '"loop-engine"' --include=plugin.json` before publishing). No other
  content change.

## ship-flow 0.2.4

- `templates/ci.yml.template`: new commented-out `hygiene` job showing how to wire loop-engine's three
  new repo-hygiene gates (below) via the existing `setup-loop-engine` action.
- `skills/setup/SKILL.md` step 4: proposes the `hygiene` job when offering CI wiring, and notes that a
  consuming repo whose tracker id format isn't caught by `check-pr-hygiene.mjs`'s default pattern
  should record a `--pattern` override (e.g. via a `trackerIdPattern` field in
  `.claude/ship-flow.config.json`) rather than editing the plugin.
- `loop-engine` dependency range bumped `^0.5.0` → `^0.6.0` (same-PR joint-constraint bump, see above).

## loop-engine 0.6.0

- New `bin/check-docs-hygiene.mjs`, `bin/check-pr-hygiene.mjs`, `bin/check-module-size.mjs` (BAC-754,
  ported from glucofit-partners' `tools/check-*.mjs` — upstream harness-maturity audit finding #15:
  "no machine docs-hygiene gate; the original monorepo built exactly this"). All three were already
  fully generic (root/baseline/base-ref/json flags, no repo-specific hardcoding) except
  `check-pr-hygiene.mjs`'s tracker-id regex, which was hardcoded to `BAC-*`/`PRO-*` — replaced with a
  `--pattern` CLI override, defaulting to a generic "LETTERS-digits" shape that still matches both of
  those plus common conventions like JIRA-style `PROJ-123`.
  - `check-docs-hygiene.mjs`: ADR number uniqueness/gaps, bidirectional README index completeness,
    dangling markdown-link/backtick-path references (CLAUDE.md + docs/adr/**), SKILL.md word-count
    WARN tiers (2,000 target / 5,000 max). Also fixes a malformed cross-repo markdown link in this
    repo's own `docs/adr/0006-ac-level-success-contract.md` that the new gate caught immediately when
    run against this repo's own docs.
  - `check-pr-hygiene.mjs`: PR body must reference at least one tracker id (no closing-keyword
    requirement — see the bin's own header for why).
  - `check-module-size.mjs`: module-size ratchet with a self-modification guard (a PR can't relax its
    own baseline/threshold vs. base-ref in the same commit).
  - New `test/check-docs-hygiene.test.sh` (24 cases, ported from glucofit-partners' 23 synthetic-fixture
    cases + a new case 14 asserting paul-loop's own `docs/adr/` stays clean — the plugin repo is now
    also a real user of its own gate), `test/check-pr-hygiene.test.sh` (9 cases: the 7 ported +
    2 new covering `--pattern`), `test/check-module-size.test.sh` (12 cases, ported verbatim — already
    entirely synthetic-fixture).
- `ship-flow/templates/ci.yml.template` and `skills/setup/SKILL.md` updated to offer wiring these three
  gates (see ship-flow's own changelog entry below).

## loop-engine 0.5.1

- New generic test coverage for pieces of the ADR-0078 "split principle" (a consuming repo's own
  `tools/harness-test/` should only wire-check that repo's use of the plugin; the plugin's own
  GENERIC behavior belongs here) that were still only tested via glucofit-partners' consumer suite
  (BAC-755):
  - `test/check-rules-always-on.test.sh` — 8 synthetic-fixture cases for `bin/check-rules-always-on.mjs`
    (missing-dir, scoped-vs-leaking frontmatter shapes, `--report-only`, text output, nested scan,
    mixed accounting, byte-vs-count exit semantics). Consumer keeps only its own real-repo assertion.
  - `test/verdict-state-producer.test.sh` — `.loop/verdict-state.json` producer correctness
    (`bin/verdict-run.sh`'s sha/dirty/`finished_at` fields on clean/dirty trees, FAIL runs, non-git
    dirs, control-char-injected commands, a PATH-spoofed `git status` failure — none of which were
    covered by the existing `ac-verify.test.sh`/`verdict-mutation-guard.test.sh`, which only consume
    this state as a side channel for their own features) and `bin/loop-fix.sh`'s `LOOP_STOP_GATE_OFF=1`
    propagation to the fixer subprocess.
  - `test/skill-guard-prose-wiring.test.sh` — ship-flow's `tdd`/`ship-feature` SKILL.md still name the
    reward-hack guard's `.loop/guard-off` escape hatch and never reintroduce the BAC-583 prose-arming
    failure mode (`touch .loop/looping`).
  - `test/protect-globs-matcher.test.sh` — first direct unit coverage of `lib/protect-globs.mjs`'s
    `globToRegExp`/`loadPatterns` (`*`/`**`/`**/`/`?` semantics, comment/blank-line filtering), which
    had zero coverage anywhere before this (only indirectly exercised against one consumer's real
    `protect.globs` file).
  - `test/mktemp-fail-closed.test.sh` — ported the BAC-720 meta-lint (every `mktemp` call in this
    directory's own `*.test.sh` files must be guarded with `|| fail`) to scan `test/` itself; fixed
    the comment-line false positives the port surfaced (the sweep now skips `#`-prefixed lines) and one
    real unguarded pair it caught in `lessons-hygiene.test.sh`.
  - Fixed `test/eval-gate-tier0.test.sh`'s bare `mktemp -d` (missing the `${TMPDIR:-/tmp}/tmp.XXXXXXXX`
    template — the actual BAC-718/720 root-cause pattern, present here despite already having the
    `|| fail` guard).

## loop-memory 0.2.3

- Fix: `loop-engine` dependency range was left at `^0.4.0` when loop-engine bumped to 0.5.0 in the
  same train (PR #46, BAC-753) — the exact joint-constraint bug class fixed twice before (PR #43/#44):
  with ship-flow now requiring `^0.5.0` and loop-memory still at `^0.4.0`, no version satisfied both,
  and `claude plugin update loop-engine@paul-loop` reported "conflicting version requirements" instead
  of updating. Bumped to `^0.5.0` to match. No other content change beyond the version number and this
  changelog entry — caught immediately while reinstalling for glucofit-partners' BAC-753 follow-up.

## loop-engine 0.5.0

- New `bin/plugin-path.mjs` (BAC-753) — resolves the on-disk root of loop-engine/ship-flow/loop-memory
  for a consuming repo, ported from glucofit-partners' repo-local `tools/plugin-path.mjs`
  (BAC-699/706/766). A repo with ONLY these plugins installed (no local copy of its own) now has a
  working resolver, closing the dangling reference that upstream `ship-feature`/`retrospect`/
  `deps-audit` skills used to have when they hardcoded a consuming repo's own `tools/plugin-path.mjs`
  path. Env-var overrides (`LOOP_ENGINE_PATH`/`SHIP_FLOW_PATH`/`LOOP_MEMORY_PATH`) let CI (a plain
  shell process outside the live plugin cache) point at a pinned `git clone`. New
  `test/plugin-path.test.sh`, including the hermetic plugin-unresolved idiom (`LOOP_ENGINE_PATH=`
  empty + `HOME=$WORK/no-home`).

## ship-flow 0.2.3

- Fix (BAC-753): `retrospect`, `deps-audit`, and `ship-feature`'s `classify-risk` step hardcoded a
  consuming repo's own `tools/plugin-path.mjs` as the way to invoke loop-engine bin scripts — a
  dangling reference for any repo with only the plugins installed and no such file of its own. Now
  point at loop-engine's bundled `bin/plugin-path.mjs` (0.5.0+) instead, and note that in a live
  session this is usually just the bare script name (a plugin's `bin/` is already on PATH once
  loaded) — the resolver only matters for CI or resolving a *different* plugin's path.
- New CI templates (BAC-753): `templates/setup-loop-engine.action.yml.template` (a composite action
  that pins loop-engine/ship-flow via tagged `git clone` and exports `LOOP_ENGINE_PATH`/
  `SHIP_FLOW_PATH`, ported from glucofit-partners' `.github/actions/setup-loop-engine`) and
  `templates/loop-selftest.yml.template` (a git-flow integration-branch-PR backstop for
  harness/policy changes `ci.yml` never sees, adapt-by-hand like `turbo-verify-wiring.example.md`).
  `setup` skill's step 4 now offers wiring both.
- `loop-engine` dependency bumped to `^0.5.0` (0.5.0 is the first version with `bin/plugin-path.mjs`).

## ship-flow 0.2.2

- Fix: `ship-feature` step 2 and `hotfix` step 1 ran a consuming repo's raw `verifyCommand` directly
  — `SKILL.md` never called `loop-engine`'s `verdict-run.sh`, so the `=== VERDICT ===` block,
  `.loop/verdict-state.json`, and the `verdict.passed`/`verdict.failed` ledger events (loop-engine's
  core contract, everything downstream — the Stop-hook fresh-PASS gate, `run-metrics`, lessons'
  `gate_history` — depends on) never fired from the canonical entry points. Confirmed via a real
  consuming repo's `run-metrics`: 92 runs, `with-verdict=0`. Both skills now wrap unconditionally:
  `<however this repo invokes its installed loop-engine plugin's bin scripts> verdict-run.sh --
  <verifyCommand>`, reading the gate off the printed `VERDICT:`/`EXIT:` lines instead of a bare shell
  exit code. Safe even when `verifyCommand` is already a repo's own verdict-contract wrapper (e.g.
  `pnpm verdict`) — `verdict-run.sh` detects an already-emitted `=== VERDICT ===` block and passes it
  through unchanged rather than double-wrapping it, which is also why `setup`'s interview keeps
  recording `verifyCommand` as the raw command rather than pointing it at `verdict-run.sh` itself.
  New regression test `test/verdict-wrap-required.test.sh` (loop-engine test suite, since ship-flow
  has no test harness of its own) fails if either skill's prose reverts to a raw verify-command
  instruction.

## loop-engine 0.4.1

- Fix: `plugin.json` no longer declares `"hooks": "./hooks/hooks.json"`. `hooks/hooks.json` is
  auto-discovered by convention — declaring it explicitly in the manifest made Claude Code load it
  twice (once by convention, once via the manifest field) and fail with "Duplicate hooks file
  detected", breaking every hook the plugin ships. Regression test
  `test/hooks-json-wiring.test.sh` updated to assert the field's *absence* (it previously asserted
  the opposite — the bug shipped in 0.4.0 with a passing test that locked it in).

## loop-engine 0.4.0

- Bundles 8 generic runtime-enforcement hooks via `hooks/hooks.json` (`plugin.json`'s new `hooks`
  field), so a consuming repo gets them on a plugin-version bump instead of hand-maintaining a
  local `.claude/hooks/` copy: `record-run-event` (run-ledger instrumentation across 7 events),
  `gate-stop-verdict` (Stop-hook fresh-PASS gate), `loop-doctor-heartbeat` (SessionStart
  self-diagnostic nudges), `protect-during-loop` (PreToolUse reward-hacking guard on
  `.loop/protect.globs` + the plugin's own install path), `gate-risky-commands` (PreToolUse
  merge/deploy REQUIRE mirror of `classify-risk`), `gate-before-merge` (PreToolUse direct-landing
  guard on protected branches), `gate-worktree-create` (PreToolUse origin/*-only worktree-base
  guard), and `warn-partial-checkout` (PostToolUseFailure partial-checkout data-loss warning).
  Ported from a consuming repo's local copy with three genericizations: (1) hooks now resolve
  their own sibling `lib/`/`bin/` files via `import.meta.url` instead of a cross-package plugin
  resolver, since they ship colocated in the same plugin package; (2) `gate-before-merge`'s
  protected-branch set now reads a consuming repo's `.claude/ship-flow.config.json`
  (`releaseBranch`/`integrationBranch`) instead of a hardcoded pair, falling back to `{main,
  master}` when that config is absent; (3) `loop-doctor-heartbeat`'s embedding-key/DB-URL check
  now bridges `CLAUDE_PLUGIN_OPTION_*` (loop-memory's own `userConfig` injection convention)
  instead of reading a hardcoded repo-local `.env` path. `ship-flow`'s `loop-engine` dependency
  bumped to `^0.4.0` accordingly. New regression test `test/hooks-json-wiring.test.sh` covers
  `plugin.json`/`hooks.json` structural wiring, an orphaned-file drift guard, an allow-path
  end-to-end smoke test for all 8 hooks, and a deny-path + config-driven-branch-set behavioral
  check for `gate-before-merge`.
- `docs/verdict-contract.md` updated — it previously said this plugin doesn't ship a Stop hook;
  now that it does, the doc points at `hooks/gate-stop-verdict.mjs`.

## loop-engine 0.3.0

- AC-level success contract gate — `bin/ac-verify.sh` (ADR-0006, #23): per-AC `verify:`/
  `artifacts:`/`expect:` contracts parsed from a plan file, judged by deterministic subprocess
  (reusing `verdict-run.sh` per AC), aggregated into one pass/fail. Composes with, doesn't replace,
  the observe-the-running-app check — zero contracted ACs on a runtime-surface plan is fail-closed.
- `bin/verifier-pinned-review.sh` + CODEOWNERS-based reinterpretation (#14): pins base-revision
  tests against self-weakening (bin/+test loosened together in the same PR), hardened through
  several adversarial rounds (TOCTOU close, CODEOWNERS-deletion-at-same-commit still caught,
  unresolvable BASE is a hard error rather than a silent PASS).
- `loop-fix --protect` hardened through six adversarial rounds: ground truth moved off tamperable
  on-disk files into process memory, restores a tampered/deleted protected file before aborting
  (not just detects it), now also runs the check on the PASS path (not just FAIL), a bounded
  grace-period recheck on both paths, and closes a watchdog-vs-grace-period race plus a
  VERDICT-RUN-ERROR abort gap.
- `lessons` hygiene: `invalidate`/`mark-clean` commands (#6), fail-closed `record --verified`
  without `--signature-file` (#9), FAIL-channel lesson auto-collection wired into `loop-fix` (#10),
  and a grounded-reopen convention (a retired lesson or rejected challenge needs a cited id + new
  evidence to reopen — a plain recurrence isn't reopening evidence).
- tier0 harness self-smoke gate (#7).
- ADR-0006/0007 (rationale for `ac-verify.sh` and loop-memory's manual-recall env sharing, ported
  upstream from a consuming repo — BAC-758) and a new `test/dangling-doc-refs.test.sh` regression
  guard against skill/doc examples pointing at consumer-repo-only paths (`tools/plugin-path.mjs`,
  `.claude/hooks/*`, `bin/loop-doctor.mjs`) as if this plugin ships them.

## ship-flow 0.2.1

- Fix: bump the plugin's own version so its `loop-engine` dependency bump (`^0.3.0` → `^0.4.0`,
  landed earlier without a version bump alongside it) actually reaches installs. Claude Code's
  plugin cache is keyed by `(name, version)` — with the version unchanged, every `claude plugin
  update loop-engine@paul-loop` kept resolving against the *stale cached* `^0.3.0` constraint no
  matter how new loop-engine's own marketplace version was, silently pinning consumers to
  loop-engine 0.3.0 forever. No content change beyond the version number and this changelog entry —
  found while reinstalling for glucofit-partners' BAC-766 verification (`claude plugin update
  loop-engine@paul-loop` reported "already at latest satisfying ^0.3.0" even after loop-engine had
  moved to 0.4.1).

## ship-flow 0.2.0

- `publisher` subagent for ship-feature step 5 (#15): the Builder session — which has held
  untrusted issue/web content and full worktree access since step 0 — no longer runs the
  `git push`/PR-open/tracked-issue-comment itself. It hands off file-based title/body/comment text
  to a separate `publisher` agent instead, closing a heredoc-injection risk class (adversarial
  rounds closed a heredoc-to-variable handoff gap and a conflict-retry push gap).
- Grounded-reopen convention documented in `retrospect` (#9/#11): a retired lesson or rejected
  challenge needs a cited id + genuinely new evidence to reopen.
- Consumes loop-engine 0.3.0's `ac-verify.sh` (ADR-0006) — `ship-feature` step 1 plans now express
  AC contracts, step 3 runs `ac-verify.sh` against them.
- `retrospect`/`deps-audit` SKILL.md examples now disclaim that `tools/plugin-path.mjs` is a
  consuming-repo convention, not something this plugin ships (BAC-758 B7).

## loop-memory 0.2.2

- Fix: bump the `loop-engine` dependency range `^0.3.0` → `^0.4.0` — it had gone stale (last
  touched when loop-engine was 0.2.x) and, being a caret range, silently *excluded* loop-engine
  0.4.x entirely. Combined with ship-flow's now-fixed `^0.4.0` requirement (0.2.1), this produced
  an unsatisfiable joint constraint (no version satisfies both `^0.3.0` and `^0.4.0`) the moment
  both plugins were installed together, blocking `loop-engine` from ever updating past 0.3.0.
  loop-engine 0.4.x is purely additive relative to what loop-memory actually uses (hooks bundling
  + a manifest bugfix) — no compatibility reason to stay below it. Found immediately after 0.2.1,
  while completing glucofit-partners' BAC-766 plugin reinstall.

## loop-memory 0.2.1

- Fix: same `plugin.json` "hooks" field bug as loop-engine 0.4.1 — this plugin had the identical
  latent defect but it never surfaced because `defaultEnabled: false` means its hooks were never
  live-loaded by anyone yet. New `test/plugin-manifest.test.ts` locks the manifest shape so it
  can't regress once someone enables it.
- `hooks.json` now also wires `graduate-lessons.mjs` on `SessionEnd` (previously `SessionStart`
  only) — restores parity with a consuming-repo local fork's wiring (glucofit-partners' BAC-357):
  graduating verified lessons at session end avoids a real one-session indexing lag versus waiting
  for the next SessionStart. Safe to run twice per session boundary — the script is idempotent and
  self-gating (no key/pgvector unreachable → no-op). New `test/hooks-graduate-lessons.test.ts`
  covers the hook's own debug-logging behavior (ported from that same local fork, BAC-766).

## loop-memory 0.2.0

- Sleep-time consolidation batch (#12): dedup, decay-based ranking, promotion pre-scoring.
- Hook-fired graduate/recall writes now tag their source in `memory_op.payload.source`.
- ADR-0007 documenting why the manual `recall` CLI shares the hooks' env source and fails closed
  without an embedding key, rather than silently querying with a stub embedder (ported rationale,
  BAC-758).

## loop-memory 0.1.0 — M3 scaffold

- Initial extraction of `loop-memory` (pgvector semantic recall for verified lessons + optional
  ADR/glossary/research knowledge) from the origin monorepo, generalized: the worktree-scoped
  `.env`-file loading mechanism (`load-env.ts` and its hook counterpart) doesn't apply to a shared
  plugin install, so key/config sourcing moved to plugin `userConfig` (embedding keys and the
  signing key are `sensitive: true`, stored via the OS keychain) — hooks bridge Claude Code's
  `CLAUDE_PLUGIN_OPTION_<KEY>` injection into the plain env var names the CLI itself reads, keeping
  the CLI usable standalone too.
- Ships as a dependency-free `dist/cli.js` (esbuild bundle, drizzle-orm + pg included) — the hooks
  never touch `node_modules` at runtime, matching `loop-engine`'s "ships as a script" shape.
- Ships **`defaultEnabled: false`** at both `plugin.json` and the marketplace entry — installs
  disabled, verified via a real install-and-inspect against a local-scope marketplace copy.
- Knowledge-corpus sources (ADR dir / glossary file / research dir / design dir) are opt-in via
  userConfig with no default paths — the plugin makes no assumption about a consuming repo's doc
  layout unless explicitly pointed at one.

## ship-flow 0.1.0 — M2

- Initial `ship-flow` scaffold (`tools/ship-flow/`) registered in the marketplace, depending on
  `loop-engine`, with its first skill `hotfix` — lands an already-verified fix through worktree
  isolation → verify → PR → merge, with human confirmation checkpoints at merge and deploy.
- Review agent stack ported from glucofit-partners (ADR-0079/BAC-623): 4 self-owned agents
  (`planner`, `code-reviewer`, `test-hunter`, `verifier-integrity-hunter`) + 3 named workflows
  (`adversarial-review`, `harness-audit`, `trends-research`) — self-contained review capability, no
  external `pr-review-toolkit`-style dependency.
- `templates/` (CLAUDE.md constitution template, CI workflow template, branch-protection script, a
  turbo-verify wiring reference doc) + a `setup` skill that interviews a consuming repo's user and
  installs them — a plugin's own root `CLAUDE.md` isn't loaded as project context, so this can't
  just be a file sitting in the plugin.
- Remaining category-B skills ported and generalized: `grill-with-docs`, `retrospect`, `deps-audit`,
  `to-issues`, `to-prd`, `resolving-merge-conflicts`, `harness-maturity-audit`,
  `improve-codebase-architecture`, `tdd`, and `ship-feature` — the flagship plan-to-PR autonomous
  delivery loop and this plugin's single entrypoint. All glucofit-partners-specific pointers
  (`BAC-nnn`/`ADR-00nn` citations, hardcoded script/wrapper paths) replaced with either plain-prose
  descriptions or config-driven lookups (`.claude/ship-flow.config.json`'s `trackerName`, etc.).

## loop-engine 0.2.0 — M1 (public release)

- `docs/otel.md` and the remaining Korean prose in `docs/lessons.md` translated to English.
- `classify-risk.mjs`'s path/command rule table externalized: the plugin now ships with zero
  product-specific rules, loaded instead from `--rules <path>` / `CLASSIFY_RISK_RULES` / a
  `risk-rules.json` at the consumer's repo root. Structural baselines (docs-only, small-changeset
  AUTO, many-files, human-only-stage) still apply with no rules file present.
- New `test/classify-risk-rules.test.sh` covering the three injection channels and both error paths.

## 0.1.0 — M0 (private scaffold)

- Initial extraction of `loop-engine` (bin/lib/test) from the origin monorepo, unmodified except for
  removing what only made sense inside that repo (one hook with an external import, tests asserting
  on that repo's own CI/hook wiring, a fixture carrying real PR titles/paths).
- Secrets/PII sweep, `gitleaks` CI, `claude plugin validate --strict` green, one dogfooded
  `verdict-run` via `--plugin-dir`.
