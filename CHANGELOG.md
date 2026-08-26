# Changelog

Each plugin in this marketplace versions independently, following [semver](https://semver.org).
Explicit-version channel — see [README § Development status](README.md#development-status) for why
not a SHA channel. Entries below `## loop-engine 0.2.0` and earlier predate the multi-plugin split
and refer to `loop-engine` only (see the un-prefixed version numbers).

## ship-flow 0.6.0

Adopts upstream's **decomposition** — three skills that were inlined are now standalone and called by
name — while keeping this plugin's content where the two disagree.

- **New: `grilling`.** The interview loop, extracted so it has one home. Upstream's version asks *"the
  whole frontier in one round: number each question"*; this one asks **one question at a time**, which
  is the opposite and is deliberate. The frontier still decides *which* question comes next — it just
  never decides *how many*. Stated in the skill, because the batched form looks more efficient and
  isn't: the user answers the first two carefully and the rest thinly, and any question whose framing
  depended on an earlier answer was framed wrong.

  Taken from upstream unchanged: **finding facts is the agent's job, never the user's** — dispatch a
  sub-agent for anything past a glance, and don't block on it, since a running exploration is just an
  unsettled prerequisite. The previous inline wording ("if a question can be answered by exploring the
  codebase, explore the codebase instead") was a weaker version of the same idea.

- **New: `domain-modeling`**, extracted from `grill-with-docs` along with `CONTEXT-FORMAT.md` and
  `ADR-FORMAT.md`. Includes this plugin's own **"Reopening a settled ADR"** section, which upstream has
  no equivalent of — the grounded-reopen bar (cite the ADR by id, bring evidence that didn't exist when
  it was written) that `retrospect` already applies to lessons.

- **New: `codebase-design`**, extracted from `improve-codebase-architecture` along with `LANGUAGE.md`,
  `DEEPENING.md`, and `INTERFACE-DESIGN.md`. The deep-module vocabulary now has one home instead of
  living inside the one skill that happened to need it first.

- **`grill-with-docs` is now the composition** of `grilling` + `domain-modeling` (upstream's shape),
  with one addition: the two run *together*, not in sequence. A term sharpened mid-question goes into
  `CONTEXT.md` right there. Batching documentation to the end of a session is what loses it — by then
  the reasoning that justified the wording is gone.

- **`improve-codebase-architecture` keeps its process** and calls out to the three (upstream's shape
  too). It retains `HTML-REPORT.md`.

### Also new: four skills upstream has and this plugin didn't

- **`wizard`** — generates an interactive bash script that walks a human through steps only they can
  take (provisioning, credentials, CI secrets, an unfamiliar dashboard, a one-off cutover). Ships
  upstream's `template.sh` unchanged — the library above the `STAGES` marker is identical in every
  wizard and is never hand-edited. Adds one section upstream doesn't have: **where a value is written
  is a list, not a destination.** The recurring failure is partial propagation — the env schema and the
  secret store get updated, the infrastructure that injects the secret into the container does not, and
  nothing errors until a deploy that often auto-rolls-back, so there isn't even downtime to notice.
- **`to-questionnaire`** — for when what blocks you is in someone else's head. Ported near-verbatim;
  the header adds that the questionnaire is written in the *recipient's* language, which is usually but
  not always `outputLanguage`.
- **`wait-what`** — re-pitch a message that didn't land. Adds one line: re-pitching is not repeating
  more slowly; find the step that was skipped.
- **`ask-matt`** — a router over the skills. **Rewritten, not ported.** Upstream's version routes over
  upstream's set (`/implement`, `/to-spec`, `/to-tickets`, `/handoff`, `/prototype`, `/research`, …);
  porting it verbatim would have produced roughly fifteen references to skills this plugin doesn't
  ship, which the new `check-skill-refs` gate would correctly have rejected. This one routes over what
  is actually here, and says so: `ship-feature` is the single entrypoint, and most of the map is what
  *it* calls rather than what you call. It states its own scope — a consuming repo's own skills are
  that repo's to document.

  This is the clearest evidence the gate earns its keep: `ask-matt` alone took handoff references from
  24 to 47, and every one is verified to resolve.

### `tdd` follows the same decomposition

Upstream shrank `tdd` from 138 lines to 38 by delegating instead of duplicating. This plugin takes the
two structural moves and keeps what upstream dropped that we still use.

- **Seams get their own section**, promoted out of a planning checkbox. A seam is the public boundary
  you observe behavior at, and "no test is written at an unconfirmed seam" is the rule that decides
  where testing effort lands. When the *shape* of that boundary is the open question, it now calls
  `codebase-design` rather than restating the vocabulary.
- **Refactoring leaves the red → green loop.** Upstream's rule — refactoring belongs to the review
  stage, not the implementation cycle — is adopted, pointing at what this plugin actually has:
  `ship-feature` step 4 (`ship-flow:code-reviewer`, `ship-flow:test-hunter`) for the finished diff, and
  `improve-codebase-architecture` for structural work. Restructuring while the next test is still owed
  is how a cycle turns into a rewrite.
- **`deep-modules.md` deleted** — pure duplication of `codebase-design/LANGUAGE.md` once that skill
  exists. **`refactoring.md` deleted** — `improve-codebase-architecture`'s Explore step already covers
  shallow modules, locality, seam leakage and untestable interfaces, in a richer form, and the list was
  *not* moved into `code-reviewer`: that agent is a fail-any-criterion **blocker** bar, and refactor
  candidates are advisory. Turning suggestions into blockers would have been the wrong home.
- **`interface-design.md` kept.** It is about shaping an interface so it can be tested at all (inject
  dependencies, return results instead of mutating, small surface) — distinct from
  `codebase-design/INTERFACE-DESIGN.md`, which is a *process* for generating and comparing candidate
  designs. Upstream dropped both; only one of them was redundant here.

**Why decompose at all.** 1:1 file correspondence with upstream is what makes drift *machine*-checkable
rather than a per-round manual read. While ours was inlined and upstream's was split, "what changed
upstream" could only be answered by a human reading both — and that is exactly the comparison that
silently stops happening.

**What this costs, and what pays for it.** Decomposition multiplies skill-to-skill handoffs, and a
handoff to a target that doesn't exist is silent. `loop-engine 0.11.0`'s `check-skill-refs` gate lands
in the same change for that reason: references went 17 → 24 here, and all 24 are verified to resolve.

Two existing gates caught real breakage from the file moves, which is what they are for:
`lesson-codification-bac756.test.sh` pinned `grill-with-docs/ADR-FORMAT.md` by path, and the
output-language anchor gate rejected the rewritten `grill-with-docs/SKILL.md` for dropping its header.

## loop-engine 0.11.0

A new gate for the failure mode this plugin's own design choice creates.

- **`check-skill-refs.mjs` — a skill or agent handoff whose target doesn't exist is now RED.**
  This plugin deliberately keeps skill-to-skill handoffs; upstream `mattpocock/skills` dropped them
  repo-wide (commit `1dab982`, "Stop skills from calling other user-invoked skills") because a
  generic library can't know which siblings a consumer installed, while a curated plugin ships its
  own (see `ship-flow 0.5.0` below). That buys real composition and costs exactly one silent failure
  mode: a handoff to something that isn't there reads as a normal instruction and simply does
  nothing at runtime.

  Not hypothetical, and measured inside this PR: porting upstream's `ask-matt` verbatim would have
  referenced roughly fifteen skills this plugin does not ship (`/implement`, `/to-spec`,
  `/to-tickets`, `/prototype`, `/research`, …). The gate rejected it, so it was rewritten over this
  plugin's actual skill set instead of ported — the jump from 24 to 47 resolved references *is* that
  rewrite. That is this gate's range: **a plugin's own documents calling a sibling it doesn't ship.**

  What this gate deliberately does **not** cover: *which provider* a name resolves to. A handoff that
  resolves to some other installed plugin's same-named skill passes here and can still be wrong — on
  the machine this was developed on, a `/grilling` handoff resolved to upstream's version, whose
  specified behaviour ("ask the whole frontier in one round") is the opposite of this plugin's
  ("one question at a time"), with no error anywhere. That is a real defect and a separate one; it is
  named here so the gate's green is not read as covering it.

  `dangling-doc-refs.test.sh` does not cover this — it checks *file paths* that claim to be
  plugin-shipped, not skill/agent handoffs.

- **Checked forms, and the one it can miss — stated rather than implied.** `Call the Skill tool
  with "X"` and a backticked `` `namespace:name` `` are unambiguous and always checked. A bare
  `` `/name` `` is also a URL path (`/login`, `/healthz`), so it counts only on a line that says
  "skill". That heuristic is the gate's known limit; both directions are locked by tests (a URL path
  on a skill-free line is not flagged; the same form on a line that says "skill" is).

- **Plugin dirs and namespaces are discovered from `.claude-plugin/plugin.json`, never hardcoded** —
  `genericity-repo-agnostic.test.sh` requires that, and it means the gate also works against a
  consuming repo's `.claude/skills` + `.claude/agents`.

- **Agents resolve too.** Scanning skills alone would flag every `ship-flow:publisher` /
  `ship-flow:planner` handoff in `ship-feature` as dangling — 13 false positives on this repo as it
  stands.

- **`check-skill-refs.test.sh`** (suite 56 → 57), 11 cases. Three are fail-closed (`exit 2`, distinct
  from a violation's `exit 1`): zero providers, zero documents, and zero references extracted from a
  non-empty document set — a broken extractor finds nothing, and "nothing" must not read as "clean".
  The last case is a RED-first proof on the real tree: a dead handoff appended to
  `ship-feature/SKILL.md` turns this repo RED, and green again once removed.

## loop-engine 0.10.3

A "run as main" guard that silently stopped guarding.

- **Two `bin/` gates did nothing at all when the checkout path contained a space.**
  `check-module-size.mjs` and `check-pr-hygiene.mjs` detected direct execution with
  ``import.meta.url === `file://${process.argv[1]}` ``. `import.meta.url` is percent-encoded
  (spaces and non-ASCII become `%XX`); `process.argv[1]` is a raw OS path. On any checkout whose path
  contains either, the two never match, the CLI block below never runs, and the script **exits 0
  having printed nothing** — which `verdict` / `require-tests.sh` / CI read as the gate passing.
  Measured: the same `check-module-size.mjs` file prints `PASS: module-size ratchet — 위반 없음` from
  a normal path and produces **zero output, exit 0** from `a dir with spaces`. The module-size ratchet
  simply ceases to exist there.

  `plugin-path.mjs` had already fixed this (its comment says "BAC-699 review, ported") and
  `lib/sanitize.mjs` carried the guard too — the port just never reached these two. All four now use
  the single idiom.
- **The idiom now also guards `process.argv[1]` being absent.** `pathToFileURL(undefined)` throws, so
  under `node -e`, a worker, or an ESM loader hook, merely *importing* one of these modules killed the
  caller. A resolver and a gate must be loadable from any context; `lib/sanitize.mjs` already did this,
  the other three did not.
- **`main-detection-guard.test.sh`** (suite 55 → 56) locks it from both sides. Text: every
  `import.meta.url ===` site in the plugin must use `pathToFileURL` *and* the `process.argv[1] &&`
  guard, and finding zero sites is a failure rather than a pass — otherwise the check goes vacuous the
  moment files move. Behaviour: copy a bin into a directory whose name contains spaces, run it, and
  require non-empty output, with a no-spaces control so "both silent" cannot masquerade as success;
  plus an import-under-`node -e` probe for all four modules.

## loop-engine 0.10.2

Release tagging is no longer a manual step.

- **New `.github/workflows/tag-on-publish.yml` publishes `<plugin>--v<semver>` on every push to
  `main`** for any plugin whose current version has no tag yet. Tagging had been manual, and manual
  steps stop happening silently: by the time anyone looked, all three plugins were several releases
  past their newest tag — `loop-engine 0.10.1` vs `loop-engine--v0.8.0`, `ship-flow 0.5.0` vs
  `ship-flow--v0.2.9`, `loop-memory 0.4.1` vs `loop-memory--v0.2.6`. Nothing looked broken:
  `plugin.json` carried the new number, the marketplace served it, CI was green. The tag was simply
  the one artifact no gate examined.

  The cost landed on consumers. This marketplace's documented channel is explicit semver, not SHAs
  (ADR-0078 addendum #2), but a repo that pins by tag cannot name a version that was never tagged —
  so glucofit-partners' CI ended up pinning a raw commit for all three plugins, which is precisely
  the SHA channel that addendum rules out. Tagging on publish restores the option.

  This does not make consumers auto-follow anything; it only makes an already-published version
  addressable. `workflow_dispatch` is wired so the backlog can be filled by re-running against
  `main`, and an existing tag is skipped rather than moved — a released version can never be
  silently repointed.
- **`tag-on-publish-derives-plugins.test.sh`** (suite 54 → 55) runs the workflow's actual shell body
  against a sandbox repo of four fake plugins, none named like the real ones. The property under test
  is not "the workflow mentions three names" but "the workflow finds whatever the manifest lists" — a
  hardcoded list inside the workflow would be the same failure one level down, where adding a fourth
  plugin leaves it untagged with everything still green. Also covers: a published tag is skipped and
  not rewritten, a second run on the same commit is a clean no-op rather than a push error (`main`
  gets many pushes between releases, and a workflow that errors on "nothing to do" gets switched
  off), and a manifest entry pointing at a missing directory fails loudly instead of being skipped.

  The version bump is for the test file alone — no runtime behaviour changed. It exists because
  `tools/loop-engine/` ships as the plugin's source, so its content must not change under a version
  number that has already been handed out.

## loop-engine 0.10.1

The reward-hack guard was structurally never armed in the workflow its consuming repo mandates.

- **`hooks/protect-during-loop.mjs` judged arming and glob matching at `CLAUDE_PROJECT_DIR` (BAC-785).**
  In a worktree-isolated session that is the *main* worktree, parked on an unprotected branch — so
  `guardState(root)` returned `unprotected-branch` and the hook `exit(0)`'d **before stdin was even
  parsed**, reaching a verdict before it knew what file was being touched. A second, independent break
  sat behind it: even when armed, `relative(root, filePath)` produced `../<sibling-worktree>/…`, which
  the hook explicitly let through. Measured in a consuming repo: five protected paths
  (`.claude/settings.json`, `**/*.test.sh`, `package.json`, …) were edited across one task with no
  `.loop/guard-off` window and no denial.
- **The effective root is now derived from what is being touched**: the target's own worktree, else the
  session cwd's worktree, else `root`. Re-rooting only happens for a worktree of the *same* repository
  (`--git-common-dir`, resolved and realpath'd — a main worktree prints it relative, a linked one
  absolute, and on macOS `/var` is a symlink to `/private/var`), so an unrelated repo stays out of
  scope. This is the pattern `hooks/gate-before-merge.mjs` already used for direction inference.
- **Re-rooting can never disarm.** It exists to find protection `root` missed, not to escape protection
  `root` had: a session on an armed worktree running a Bash command with cwd back in the main worktree
  would otherwise have been handed a way out.
- **A worktree nested inside the root** (an untracked `.worktrees/…`, a layout consuming repos allow)
  counts as a separate worktree. Detected filesystem-only, so an ordinary in-root edit still spawns no
  extra git.
- **The plugin's own install path is protected again in these sessions.** That absolute-prefix
  self-protection sits behind the arming check, so it was off for the same reason — the session-cwd
  fallback is what restores it.
- New `lib/protect-globs.mjs` exports `isInsideRoot` / `resolveWorktreeRoot`; new
  `test/protect-worktree-root.test.sh` pins 19 cases (5 of them red against 0.9.0), including
  ancestor-walk resolution for a file under a not-yet-created directory — a protected `**/*.test.sh`
  written into a fresh directory was the one reward-hack path left open.

## ship-flow 0.5.0

Adds a new skill: **`diagnosing-bugs`**, ported from `mattpocock/skills` (upstream renamed it from
`diagnose` → `diagnosing-bugs`; see its own `CHANGELOG.md`). A discipline for hard bugs and
performance regressions — build a tight red-capable feedback loop first, then reproduce, minimise,
hypothesise, instrument, fix with a regression test, and clean up. Ported with the same light-touch
adaptation as `tdd`/`grill-with-docs`: the shared "Output language" header, and — since upstream
dropped its own skill-to-skill handoff line (mattpocock/skills commit `1dab982`, "Stop skills from
calling other user-invoked skills", a generic-library concern that doesn't apply to a single
curated plugin) — re-adding a Phase 6 handoff into `ship-flow:improve-codebase-architecture`, which
does exist as a sibling skill here. Ships with the two files upstream bundles:
`agents/openai.yaml` and `scripts/hitl-loop.template.sh` (the human-in-the-loop repro helper for
Phase 1's last-resort loop type).

## ship-flow 0.4.1 · loop-memory 0.4.1

- Dependency range only: both declared `loop-engine ^0.9.0`, which `0.10.0` (below) falls outside of.
  Bumped to `^0.10.0`, following the convention of every prior loop-engine minor (`^0.7.0`→`^0.8.0`
  with 0.8.0, `^0.8.0`→`^0.9.0` with 0.9.0). Neither plugin's behaviour changed and neither needs a
  0.10.0 feature — the patch bump exists because this is an explicit-version channel, so changed
  manifest content must not ship under an already-published version number.

## loop-engine 0.10.0

Genericity repair, a false-alarm fix in the heartbeat, and coverage for four previously untested
`bin/` entries.

- **The lessons recall miss hint no longer names one specific consuming repo.** `bin/lessons.mjs`
  routed a signature-recall miss to semantic recall by printing a literal
  `pnpm --filter @glucofit-partners/loop-memory recall …` — a command that exists in exactly one repo,
  so every other consuming repo was told to run something that fails in their shell. The command is
  now read from the consuming repo's `.claude/ship-flow.config.json` →
  **`semanticRecallCommand`** (new, optional), matching the convention loop-engine's own hooks already
  use for repo-specific values (`verifyCommandPattern`, `releaseBranch`/`integrationBranch`). With no
  config the hint stays generic and names that key instead of inventing an invocation. The stderr-only
  / silent-stdout / exit-0 recall contract is unchanged.
- **`lib/boundary-surfaces.mjs` send vocabulary is now repo-declarable — and this one was a real hole,
  not a cosmetic one.** That module exists so the H1 "human interventions per run" metric cannot
  optimise away the human-approval boundary itself: merge/deploy/**send** must be excluded from the
  count. Its `send` regex (`alimtalk|biz-?message|revisit-calls`) was one repo's outbound path
  vocabulary, so in any other repo *no* send command ever matched and the exact failure the module was
  written to prevent stayed open, silently. A consuming repo can now declare its own vocabulary via
  `.claude/ship-flow.config.json` → **`sendSurfacePattern`** (new, optional regex string). It
  **extends**, never replaces, the built-in rules — over-exclusion remains the safe direction for a
  metrics filter — and a missing/unreadable config or an invalid regex degrades to the built-ins
  rather than throwing (this module is imported by a hook).
- **`hooks/loop-doctor-heartbeat.mjs` stopped crying wolf about the embedding key.** It read
  `OPENAI_API_KEY`/`GEMINI_API_KEY` straight off the session env, but the loop-memory hooks it is
  reporting *on* first load a dotenv file (that is what `loop-memory 0.3.1`'s `load-dotenv.mjs` exists
  for — a key in a gitignored, un-exported `.env` is the normal way to hold that secret). So the two
  asked different questions, and a repo with working recall was told `semantic recall is fully off —
  no embedding key` on **every session**. A diagnostic that is wrong every time trains its reader to
  ignore it, which costs more than the nudge is worth. The heartbeat now loads the same file before
  the check, and bridges `CLAUDE_PLUGIN_OPTION_LOOP_DOTENV_PATH` — without that second half it would
  still miss any repo whose dotenv is not at the default `.loop/.env`, which is the only case that
  matters here. Verified in both directions: a repo whose key lives only in a non-default dotenv path
  no longer nudges, and a repo with no key anywhere still does.

  This is the fourth instance of one failure class — a component checking for the key without the
  loader — and the first pointing the *other* way (false alarm rather than silence). Because plugins
  install into separate cache directories, loop-memory cannot import from loop-engine's tree at
  runtime, so `lib/load-dotenv.mjs` had to be vendored rather than shared. `dotenv-loader-no-drift.test.sh`
  makes that duplication a checked one: it fails on any byte difference between the two copies, on the
  heartbeat dropping the import or the call, and on either direction of the behaviour above.
- **Coverage for tools that would fail *quietly*.** Four new hermetic test files (no network, no real
  `gh`, sandbox `HOME`/`CLAUDE_PROJECT_DIR`), taking the suite from 48 to 52:
  - `deps-audit-unknown-not-clean.test.sh` — locks `bin/deps-audit.mjs`'s own stated invariant that
    "unknown" never collapses into "0 / clean / 최신". An unreadable `~/.claude.json` must suppress
    every 🗑️ removal recommendation (collapsing it to `{}` would mark *everything* unused and
    recommend deleting it); `gh` being unavailable must leave staleness `null`, never `false`/"최신";
    a repo-specific `gh` failure must surface as `gone` rather than blending into "no gh"; a failed
    `git` lookup must print 미상, not `0커밋`. A readable-telemetry control run proves the suppression
    is suppression and not an accident of the fixture.
  - `mattpocock-skills-sync-check.test.sh` — locks the four-state verdict and its exit codes
    (`FIRST_RUN`/`UNCHANGED`/`CHANGED` = 0, `UNKNOWN` = 2), that the state file lands under
    `CLAUDE_PROJECT_DIR` (writing it elsewhere makes every run report `FIRST_RUN` forever — no error,
    drift never detected), that `--stamp` rejects a missing sha instead of poisoning the baseline,
    that a failed compare still reports `CHANGED` with an unknown count, and that a corrupt state file
    degrades to `FIRST_RUN` rather than a fabricated `UNCHANGED`.
  - `bin-wrapper-contract.test.sh` — the thin `bin/*.sh` wrappers (discovered, not hardcoded: 5 today)
    must pass argv through verbatim (whitespace / empty / glob arguments), resolve their `.mjs` from
    their own location under both absolute and relative invocation, and propagate the exit code. Most
    wrapper breakage is loud; unquoted `$@` is not, which is what this pins.
  - `genericity-repo-agnostic.test.sh` — behavioural lock on both fixes above (default path, configured
    path, malformed-config fallback, extends-not-replaces).

⚠️ **Dependency ranges**: `ship-flow` and `loop-memory` both declare `loop-engine ^0.9.0`, which
`0.10.0` falls outside of. They need `^0.10.0` in a companion bump, following the convention of every
prior loop-engine minor.
## loop-memory 0.4.0

Hook liveness is now recorded always-on, so "the hooks fired" stops being an anecdote (issue #35).

- **The problem.** Both hooks are fail-open by contract, which means *never fired*, *fired and
  self-gated* (no key / recall off / prompt too short), *fired and legitimately found nothing above
  the distance cutoff*, and *fired and broke* all present identically from outside: exit 0, empty
  stdout, nothing on disk. `LOOP_RECALL_DEBUG` / `LOOP_GRADUATE_DEBUG` do distinguish them but are
  opt-in and default-off, so the normal state left no trace at all. That is how these hooks stayed a
  silent no-op for days when a plugin migration dropped their `.env`-loading step (fixed in 0.3.0):
  nothing anywhere recorded that they had stopped working, and it was found only because a human
  noticed recall felt absent.
- **What's new.** Every firing of either hook now appends exactly one small JSONL line to
  loop-engine's existing session run ledger — `<repo>/.loop/runs/<run-id>.jsonl`, in its schema v1
  shape (`{id, type, ts, aggregate_id, payload, version}`) under the new types `memory.recall` and
  `memory.graduate`. Reusing that ledger instead of inventing a parallel one means a recall event
  lands in the same file, under the same run-id, as the `run.started` that opened the session;
  loop-engine's `bin/run-metrics.mjs` ignores types it doesn't know, so co-locating costs it nothing,
  and a repo without loop-engine simply gets a `.loop/runs/` of its own.
- **The four states, in the record.** `payload.outcome` is `injected` | `no_match` | `skipped` |
  `error`, with a fixed `reason` slug saying which gate or failure (`no_embedding_key`, `recall_off`,
  `prompt_too_short`, `stdin_parse_fail`, `no_hits`, `above_cutoff`, `cli_failed`, `exception`), plus
  `key`/`dotenv` booleans, candidate counts, the nearest distance actually seen, and the cutoffs in
  effect. So an honest miss ("one hit at 0.9 against a 0.65 cutoff") can no longer be confused with a
  dead hook — and *never fired* is the absence of all of them, which is now a checkable fact rather
  than an absence of evidence.
- **Cost and safety.** It runs on every user prompt, so: one `appendFileSync` of a sub-`PIPE_BUF` line
  (atomic under `O_APPEND`, so a concurrent writer can't interleave); the append is skipped once the
  run file passes `LOOP_LIVENESS_MAX_BYTES` (default 8 MiB); `LOOP_LIVENESS_OFF=1` disables it
  entirely. Nothing is recorded but counts, booleans, distances and fixed slugs — never the prompt,
  note content, an env value, a resolved dotenv path, or an error *message* (a pg/undici message can
  embed a connection URL, so only a short opaque `code` is kept). The fail-open contract is unchanged
  and now regression-tested directly: with the ledger path made unwritable, both hooks still exit 0
  with byte-identical behaviour — `UserPromptSubmit` exiting non-zero discards the user's prompt, so
  instrumentation must never be able to reach the exit code.
- **New `loop-memory liveness [--json] [--runs N] [--root DIR] [--assert]`.** Folds those events into
  per-outcome counts, reasons, "recall fired in N of the last M runs", and last-injected time. Pure
  filesystem — no database, no embedding key — so a `loop-doctor`-style consumer can call it
  unconditionally, and one whose health check currently runs a *synthetic* recall probe can assert on
  the real hook's real firings instead (a probe proves the CLI works, not that the hook ran).
  `--assert` exits 1 only on *never fired*: self-gating and honest misses are evidence of life, and a
  check that alarms on them is a check nobody keeps.
- **Session attribution, without adding a way to hang.** Events are attributed to the run-id the rest
  of the session's ledger is under, so `recall fired in N of the last M runs` is answerable — but no
  gate that previously ran *before* a stdin read now runs after one. A read-to-EOF wedges forever
  whenever fd 0 is a pipe nobody closes (measured: a hand-run inside `$(...)`; a FIFO held open
  `O_RDWR` reproduces it deterministically, and both hooks now carry a regression test built on
  exactly that). Concretely: `recall-lessons.mjs` keeps reading stdin where it always did — *after*
  its recall-off and no-key gates, which is what keeps an unconfigured install immune on every single
  prompt — and `graduate-lessons.mjs`, which never read stdin at all, still doesn't: it takes its
  lifecycle label from a new `--event SessionStart` / `--event SessionEnd` flag in `hooks/hooks.json`.
  Firings past those gates (i.e. every firing of a working install) carry the real session id;
  firings gated before them fall back to `CLAUDE_CODE_SESSION_ID` and then to the honest `unknown`
  run bucket — which still proves the firing, and "no key" needs no session correlation to act on.
  A shared, TTY-guarded `hooks/lib/hook-stdin.mjs` holds the read. **Upgrade note:** installs get the
  `--event` label automatically (the flag ships in this plugin's `hooks.json`); a hand-wired copy of
  the old command keeps working and simply records `event: null`.
- ⚠️ Same trust boundary as the rest of that ledger: `.loop/runs/*` is gitignored, unprotected local
  telemetry and is **forgeable** by anyone with shell access. This is observability, not a security
  signal, and must not become a gate input. It also does not by itself close #35's original ask —
  it makes a live firing *verifiable when it happens*, rather than being that observation.

## ship-flow 0.4.0

`to-prd` and `to-issues` now produce a project per body of work, instead of accumulating every PRD and
every issue under whatever long-lived project a repo already had.

- **`to-prd` creates a new project for each PRD (was: only "if no project exists yet").** The old
  wording was conditional, and the condition was almost never false — any repo that has been running a
  while has *some* project — so in practice the skill never created one. Measured in the consuming
  repo: a project named `… 보일러플레이트 설계` held two PRD documents for entirely unrelated bodies of
  work (product analytics instrumentation, and hospital-admin account provisioning) plus issues for
  message scheduling, call timelines, and test-DB reset. The project's name had stopped describing its
  contents, and neither PRD had a grouping of its own. The skill now creates the project as step 3 and
  names the two narrow exceptions (the PRD amends an existing PRD's scope; the repo's tracker doc pins
  PRDs somewhere) rather than leaving reuse to judgement.
- **`to-prd` attaches supporting material to the project** — tracker documents for prose, links for
  artifacts that live outside it (ADRs, PRs, published artifacts, dashboards). The project becomes the
  single place to land for a body of work, rather than a bare issue list. Only material that already
  exists gets attached; the skill does not block on artifacts not yet produced.
- **`to-prd` reports the project identifier**, because `to-issues` cannot recover it otherwise.
- **`to-issues` resolves a target project explicitly, as a new step 5, and stops if it cannot.**
  Previously project routing was one clause inside "check this repo's tracker-integration doc" — so
  when that doc pinned a fixed project (as the consuming repo's did), every issue went there, and when
  it said nothing, issues were filed with no project at all. Measured: 51 of the first 250 issues
  carrying the repo's own label had no project. Resolution order is now PRD's project → user-named →
  the repo's standing non-PRD project → **ask**. Both silent failures are called out by name, because
  each looks like success at the moment of filing.

Alongside it, finished issues now end up owned by someone.

- **`ship-feature` step 0 says who to assign the claim to.** It already said to "claim the issue to
  yourself", but an agent has no account on the tracker, so "yourself" resolved to nothing and the
  assignee was routinely left empty. It now names the target explicitly — the human whose account the
  session is authenticated as — and spells out why an empty assignee is invisible until much later:
  the tracker's merge automation closes the issue without setting one, so it lands in Done owned by
  nobody. Measured in the consuming repo: the completed issues carrying its own label include roughly
  200 with no assignee at all.
- **`retrospect` gains a tracker close-out backstop.** Claiming at step 0 only helps runs that went
  through `ship-feature`; issues closed by hand or by merge automation still arrive unowned. Before
  reporting, retrospect now assigns the session's user to any issue *this session finished* that is
  done with an empty assignee — scoped deliberately to this session's own work, because a blanket
  sweep would attribute other people's issues to whoever happened to run it. A backlog it declines to
  touch gets surfaced in the report instead.

Nothing here is repo-specific: "which project" is still resolved from the consuming repo's own
tracker-integration doc, and Linear remains the worked example rather than a requirement.

## ship-flow 0.3.2

Skill-layer hygiene closing the 2026-08-20 harness maturity audit's remaining findings. No behaviour
was removed — the reductions below are progressive disclosure, and every property asserted by
`ship-flow-executable-contract.test.sh`, `verdict-wrap-required.test.sh`,
`skill-guard-prose-wiring.test.sh`, `lesson-codification-bac756.test.sh` and
`runtime-verify-evidence-bac749.test.sh` stayed inline in `SKILL.md` by construction.

- **Workflow invocation name settled (audit finding 11).** The audit flagged
  `harness-maturity-audit/SKILL.md`'s `Workflow({ name: 'ship-flow:harness-audit' })` as disagreeing
  with `workflows/harness-audit.js`'s own `meta.name: 'harness-audit'`, and could not test which was
  right. It is the **workflow file's header comment** that was wrong, not the call site: Claude Code
  namespaces plugin-provided workflows as `<plugin-name>:<meta.name>` (docs:
  `code.claude.com/docs/en/workflows.md` — "Plugin workflows are namespaced by the plugin name"), and
  the first-party `claude-security` plugin does exactly this — `workflows/scan.js` declares
  `meta.name: "scan"` while its skill invokes `Workflow({ name: "claude-security:scan" })`. The
  comment now states the rule and warns against "fixing" the mismatch by prefixing `meta.name`.
- **`ship-feature/SKILL.md`: 4771 → 4067 words** (hard cap 5000; headroom 229 → 933). Background,
  rationale and worked examples moved into three bundled reference files linked from the point of
  use, following the pattern `tdd/` and `improve-codebase-architecture/` already use:
  `RISK-GATE.md` (what the rule set covers, why agent input may only raise a classification, the two
  channels of `DENY_AND_LOG`), `AC-CONTRACTS.md` (full AC syntax, field semantics, examples, why the
  one-contract floor exists), and `PUBLISH-HANDOFF.md` (why the Builder session doesn't publish its
  own work, and why a heredoc is unsafe for untrusted-derived text). The 2000-word soft target is not
  reachable without deleting codified behaviour: ~2100 words are the act-moment step sequence and
  ~440 are the non-negotiable invariants.
- **`publisher` is now referenced as `ship-flow:publisher`** in `ship-feature/SKILL.md`, matching the
  three review agents and `ship-flow:planner` (namespaced in 0.3.0). No known collision exists today;
  the point is that `code-reviewer`'s collision with `pr-review-toolkit:code-reviewer` arrived
  unannounced, and a generic noun like `publisher` is the same shape of risk. The namespaced form
  resolves identically either way, so there is no downside to aligning it.
- **`improve-codebase-architecture/DEEPENING.md` wired into `SKILL.md`.** The audit called it
  orphaned; it was in fact reachable, but only via `INTERFACE-DESIGN.md` (which *is* linked from
  `SKILL.md`) off a niche "want to explore alternative interfaces?" branch. Its content — the four
  dependency categories, seam discipline, replace-don't-layer testing — is core to step 3's grilling
  loop, which decides "what sits behind the seam, what tests survive", so it is now linked there
  directly. Kept rather than deleted for that reason.

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
