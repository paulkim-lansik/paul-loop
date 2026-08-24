---
name: ship-feature
description: This plugin's autonomous-by-default feature delivery sequence and single entrypoint — isolate a worktree, plan, TDD, runtime-verify, self-review, open the PR and STOP for the human to merge, then turn verified lessons into a harness-improvement PR. Risk gating is decided by a deterministic classifier, not the agent's own scoring. Use when the user delegates a task, feature, bug, or tracked issue to take from plan to an open PR (plan → tdd → runtime-verify → review → PR → improve), or asks to "ship"/"deliver"/"land" a feature.
---

# ship-feature — this plugin's single entrypoint (autonomous, human only where the gate calls for it)

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Takes one unit of work (a feature, a bug, a tracked issue) from **plan to an open PR, and from a
merged PR to a harness-improvement PR**, with the agent running autonomously the whole way. Each
step's *content* belongs to the skill/agent it delegates to — this skill fixes only the **order, the
gates, and where a human steps in**.

Bundled references (read at the point each is needed): [RISK-GATE.md](RISK-GATE.md) ·
[AC-CONTRACTS.md](AC-CONTRACTS.md) · [PUBLISH-HANDOFF.md](PUBLISH-HANDOFF.md).

> **Git procedure (branch model, worktrees, merge, rebase) lives in this repo's own CLAUDE.md (or
> equivalent constitution doc), not here.** If this repo was set up via this plugin's `setup` skill,
> that doc came from `templates/CLAUDE.md.template` and already covers it. Duplicating it here would
> drift the moment the branch model changes.

## Config

Reads `.claude/ship-flow.config.json` at the consuming repo's root (written by this plugin's `setup`
skill — `hotfix`'s SKILL.md has the field list). If it doesn't exist yet, ask the user for
`branchModel`, `integrationBranch`/`releaseBranch`, and `verifyCommand` before proceeding — don't guess.
`trackerName` names this repo's issue tracker; Linear is the worked example below, so substitute this
repo's actual tracker and its equivalents (create/update issue, assignee, blocking links, status).

### `pluginBinPrefix` — how the commands below become runnable

Every loop-engine bin command below is **one substitutable literal** starting with
`{{pluginBinPrefix}}`. Before running one, read `pluginBinPrefix` from the config and **replace the
token with its value, concatenated onto the script name with no separator** (a value needing a trailing
space or slash carries its own), then run the result verbatim. Never type a `{{…}}` token into a shell,
and never substitute a description of a command for the command.

| `pluginBinPrefix` | Resulting command | When |
|---|---|---|
| `""` (absent → default) | `classify-risk.sh --from-git …` | Live session: a plugin's `bin/` is on PATH |
| `node tools/plugin-path.mjs exec bin/` | …prefixed with that, same flags | If this repo ships its own resolver wrapper |
| `node "$LOOP_ENGINE_PATH/bin/plugin-path.mjs" exec bin/` | …same shape, loop-engine's bundled resolver | CI / headless, nothing on PATH (BAC-753) |

**Argument form is not re-derivable — use exactly what's written.** Only `verdict-run.sh` takes a `--`
separator (it needs one, to fence off the command it wraps). `classify-risk.sh`, `ac-verify.sh`, and
`lessons.sh` take **no `--`**; passing one is an unknown-arg usage error, not a harmless no-op.
`classify-risk.sh --path` is repeated once per path, not given a space-separated list.

If a substituted command fails to resolve, **stop and say so.** Falling back to this repo's raw verify
command silently drops the verdict contract, the risk gate, and the AC gate at once.

## Execution mode — autonomous by default

The agent runs step 0 → PR **without stopping**. There are exactly **three** places it calls a human:

1. **The merge/deploy boundary** — it opens a `feature/* → integrationBranch` (or the trunk-based
   equivalent) PR and **stops**. Landing on a shared branch is `reversibility=none`, so a human reviews
   and merges — the agent never approves its own code onto a shared branch. **Release
   (`integrationBranch → releaseBranch`) is out of this skill's scope** (see step 5).
2. **Any step where the risk gate returns REQUIRE** — see [Risk gate](#risk-gate--the-rules-classify-not-the-agent).
   The agent stops *before* running that step and waits for human approval.
3. **Genuinely stuck, ambiguous, or unable to self-recover** — only when the agent can't resolve a gate
   on its own or a real judgment call is needed.

Every other verification failure (red) is something the agent **loops back on itself** — it doesn't ask
a human.

**Qualify every question before asking it.** Those three are the *only* sanctioned stops, and this skill
drifts into asking far past them — design questions the agent could already answer, put to a human who
answers "go with your recommendation". Before interrupting, apply this test:

> **Can I state a clear recommendation, and is the decision reversible?** If both are yes, **take the
> decision, don't ask** — and record it, one line per decision (what was chosen, the alternative, why),
> in a **`Decisions taken`** section of the PR body, where the human reviews it at the merge boundary
> that already exists.

Ask only when one of those is genuinely no: no defensible recommendation (a real product/priority call
the agent has no basis for), or an irreversible consequence — already covered by points 1 and 2.
"This feels like it deserves a check-in" is not a qualifying reason; a `Decisions taken` line is.

## Invariants (skipping these breaks the contract — non-negotiable)

- **Worktree isolation first.** The main worktree's HEAD is always the integration branch (git-flow) or
  the release branch (trunk-based) — never check a work branch out there. Before the first edit:
  `git fetch origin` → `git worktree add -b <branch> <sibling-path-outside-repo> origin/<base>`. **Don't
  base a new worktree on a local branch** — the server is the source of truth.
- **Reward-hack guard — if this repo has one, it's always armed, structurally.** Where loop-engine@paul-loop
  (or an equivalent) provides a reward-hack guard hook on working branches, it arms by branch condition
  automatically — this skill never turns it on or off, and there's nothing to disarm before handing off
  to a human. If a legitimate edit to a protected file (test/config/verifier files) gets denied, open a
  reasoned window per that guard's convention, make the edit, close the window, and record why in the
  PR body.
- **This repo's verify command is the one automatic gate.** A `feature/* → integrationBranch` PR often
  doesn't trigger CI (a common cost-control pattern — check `ciSkipOnIntegrationPR` in the config); if
  so, nothing catches a skipped local gate before the change lands. If this repo also gates its
  harness/consumer wiring separately (e.g. a `verify:loop`-style script), that has to be green too
  whenever harness-consumer files were touched — step 6 especially.
- **Verify (runtime) means observing the running app**, not re-running the verify command — that already
  happened in step 2. Step 3 asks "did the app actually get built/started and exercised at the changed
  surface," not "did the test suite pass again."
- **A human merges.** The agent gets to an open PR and no further. No local `git merge`/`git pull` toward
  a shared branch, no direct push — a merge guardrail hook and/or branch protection will block it anyway.
- **The agent doesn't self-score risk.** Classification comes from a deterministic rule set first; agent
  input can only push it **up**, never down. Self-grading turns the gate into decoration.
- **Harness improvements land as PRs only.** This session never directly edits and commits this repo's
  CLAUDE.md / `.claude/**` — step 6 submits only accepted lessons, as a **separate PR**, and stops there.
- **Issues live in this repo's tracker.** Use whatever `trackerName` says; don't fall back to ad-hoc
  GitHub issues if a real tracker is configured.
- **Verification results are quoted, not paraphrased.** Paste actual output (or the LOG file) verbatim
  for test runs, gate verdicts and review findings, the same way step 5 pastes the risk-verdict block
  into the PR body. A hand-summarized paraphrase can silently launder a partial/failing result into an
  apparent pass; the raw output is the evidence, not a description of it.

## Risk gate — the rules classify, not the agent

Classification is derived from the change itself (paths/commands/stage), and agent input is folded in
as `final = max(rule, agent)` — **only allowed to raise** it, never lower it.

```bash
{{pluginBinPrefix}}classify-risk.sh --from-git --stage <plan|implement|pr|improve> \
  --action "<what is about to happen>" \
  [--agent-blast-radius low|medium|high --agent-reversibility full|partial|none --agent-cost low|medium|high]
# exit 0  = AUTO         → proceed autonomously
# exit 10 = REQUIRE      → stop before running that step, get human approval
# exit 11 = DENY_AND_LOG → here (verdict channel): log evidence (--render-md) into the PR and proceed
```

**Merge, deploy, release, and send are always REQUIRE**, regardless of any other input. Anything
unmatched — an unmatched *command*, or 11+ files with no classification — is **fail-closed REQUIRE**;
silence is not AUTO.

**The track is a classification output**, not a separate axis. Whatever `TRACK:` line the classifier
prints is the routing decision:

| TRACK | Meaning | Steps |
|---|---|---|
| `risky` | Matched a rule | Full sequence + whatever `DEEP_GATES:` the output names |
| `standard` | No rule match | Full sequence, deep gates only if this repo's own verify table says they're affected |
| `docs-only` | No runtime surface touched | Steps 2-3 can be skipped |

Skipping a step always leaves a one-line reason in the PR body, so it's auditable after the fact.

See [RISK-GATE.md](RISK-GATE.md) for what the rule set covers, why the agent may only raise a
classification, the two channels of `DENY_AND_LOG`, and layering this repo's own `risk-rules.json`.

## Sequence (0 → PR is autonomous, merge is human, post-merge is `improve`)

### 0. Worktree isolation — `git worktree`
If this repo tracks issues externally (Linear, GitHub Issues, etc.), claim the issue to yourself first
— before creating the worktree — by assigning it and moving it into an in-progress state. Where
concurrent sessions are common, claiming first is what stops two sessions picking up the same issue
(worktree isolation alone prevents git conflicts, not duplicate starts).

`git fetch origin && git worktree add -b <type>/<slug> <sibling-path-outside-repo> origin/<base>`. Check
`git worktree list` first if concurrent work is common here. A fresh worktree has no installed
dependencies — install them. Every following step happens inside this worktree. (macOS: if a later
`git worktree remove` fails with a permission-denied ACL error, `chmod -R -N <path>` first — see
hotfix's cleanup step for the full note.)

### 1. Implementation plan — `Plan` agent / `grill-with-docs` if there's a design decision
Plan what to build and how to slice it. **If there's a new design decision involved**, use
`grill-with-docs` to sharpen it against the domain model and record it (ADR + `CONTEXT.md`) — no
implementation yet. Plain CRUD doesn't need that; a `Plan` agent pass is enough.

**Scope guard.** Grilling routinely surfaces adjacent work that *should* happen. That is not licence to
grow this run: anything that widens scope beyond the issue you started on gets **filed as a separate
tracked issue** (blocked-by links where they apply), and **this run continues on the original issue at
its original scope**. A run that grills its way into a bigger problem and never implements the issue it
was given has failed, however good the new plan is.

Once the plan is set, **derive the track from the paths it touches** — there's no diff yet, so pass the
planned paths directly: `{{pluginBinPrefix}}classify-risk.sh --no-gate --path <path> [--path <path>]...`
(one `--path` per path, no `--` separator) → the resulting `TRACK:`/`DEEP_GATES:` scope the remaining
steps.
→ **Gate:** success criteria (what "done" verifiably means) has to be written down before moving on.

**Express acceptance criteria as one-line AC contracts** — this is what makes step 3's gate
machine-checkable instead of self-reported (ADR-0104):

```
AC: login rejects a wrong password | verify: pnpm --filter api test -- auth.spec.ts | expect: 401
```

Full syntax, field semantics, and more examples: [AC-CONTRACTS.md](AC-CONTRACTS.md). For a `standard`
or `risky` track (`docs-only` is exempt — step 3 is already skipped for it), **the plan as a whole must
express at least one AC with a machine-checkable contract**; zero across the whole plan means step 3
fails closed.

**Validate the finished plan before any code exists** — hand it to this plugin's `ship-flow:planner`
agent (namespaced, same reason as step 4). It fail-closed-checks what goes wrong *before* TDD rather
than during it: acceptance criteria that are vibes rather than checks, criteria with no test seam, and
**zero AC contracts on a `standard`/`risky` plan** — the one that makes step 3's `ac-verify.sh` gate
vacuous. A BLOCK loops back into this step; it does not call a human. Skip it only when
`grill-with-docs` already ran (that pass applies the same scrutiny), and say so in the PR body.

**If the plan itself exceeds one session's budget** (too large to pin down a single verifiable "done"),
don't jump to implementation — split the issue into decision tickets first: one tracked issue per
still-open question, blocked-by links pointing at whichever resolves first, sharpest one worked first.
Each resolved ticket re-enters this skill from step 0 — splitting the plan doesn't bypass the gate.

### 2. Implementation — invoke the `ship-flow:tdd` skill (red → green)
Implement the plan red→green by **invoking this plugin's `ship-flow:tdd` skill by that exact
namespaced name** — not by writing tests in this session's own style and calling it TDD. Security/
invariant paths (RLS, authorization, or whatever this repo's equivalent is) need **behavior-proof
tests**, not just coverage. This repo's verify command is this loop's convergence criterion — run it
wrapped, always, never raw: `{{pluginBinPrefix}}verdict-run.sh -- <verifyCommand>` (BAC-745 — `--` is
required here, and only here). This holds even if `verifyCommand` is itself already a verdict-contract
script (e.g. a repo's own `verdict` wrapper) — `verdict-run.sh` detects an already-emitted
`=== VERDICT ===` block and passes it through unchanged rather than double-wrapping, so wrapping
unconditionally is always safe. Read the gate off the printed `VERDICT:`/`EXIT:` lines, not a bare
shell exit code — the block is the actual contract (state file + ledger event), an exit code alone
skips both.
→ **Gate:** `VERDICT: PASS` + whatever `DEEP_GATES:` step 1 identified (re-checked against the actual
diff with `--from-git`). `VERDICT: FAIL` loops back autonomously.

> If any `DEEP_GATES:` run against a shared local resource (e.g. a per-worktree docker database), don't
> run more than one deep gate in this worktree at the same time — a second one recreating the same
> container mid-run causes an unrelated-looking failure, not a clear error.

### 3. Runtime verify
Build and run the app, drive the changed surface (CLI/API/GUI — whatever applies) through it, and
confirm **what was intended actually works**. This produces runtime evidence, not a re-run of the test
suite. When step 1's plan has any AC contracts, this is formalized via
`{{pluginBinPrefix}}ac-verify.sh <plan-file>` (ADR-0104 — positional plan file, no `--`) — deterministic
subprocess judgment per contracted AC, composing with (not replacing) the observe-the-running-app check.
→ **Gate:** PASS. FAIL → **loop back to step 2**. SKIP (no runtime surface exists) passes with a
one-line reason.

> If a GUI surface needs driving and a browser-automation MCP is unavailable (or its profile is
> contended by a concurrent session), fall back to a standalone script that imports this repo's own
> test framework's browser driver (e.g. Playwright) and launches a fresh headless browser, independent
> of any shared MCP profile. Run it from inside the package that has that dependency installed — a
> script outside it won't resolve the same `node_modules`.

> When a browser is involved, prefer an accessibility-tree snapshot (+ diff against the prior state)
> over a screenshot as the observation evidence — most repos already have a tool for this (e.g. a
> `take_snapshot`-style MCP call); reach for a screenshot only when something genuinely needs visual
> confirmation. Never attach a browser-automation MCP that drives the user's own logged-in browser
> (their cookies, their accounts) to this autonomous step — a prompt injection on the page under test
> would then reach the user's real accounts, not a sandboxed session.

### 4. Review and fix
Run this plugin's review agents — **by their namespaced names, `ship-flow:code-reviewer`,
`ship-flow:test-hunter`, `ship-flow:verifier-integrity-hunter`** — against the diff. The namespace is
load-bearing: a bare `code-reviewer` collides with `pr-review-toolkit:code-reviewer`, a different agent
with a different checklist that many repos also have installed, and the wrong one resolving looks
identical from the outside. If this repo also runs a separate general-purpose PR-review tool, run
both — these agents are complementary, not a replacement. Fix what they flag autonomously.

**A review agent that ends in a watchdog timeout, a stall, or any other non-completion is a BLOCK, not
"no findings".** A subagent that never produced a verdict has reviewed nothing; treating its silence as
a clean pass is how a run reports itself as reviewed when it wasn't. Re-summon it (one at a time if a
shared local resource caused the stall) and get a real verdict before step 5.
→ **Gate:** every summoned review agent returned a completed verdict, and Critical/Important findings
resolved. Re-run the step-2 gate after fixing, then re-review.

### 5. Open the PR → `integrationBranch` (or `releaseBranch` if trunk-based) and **stop** — hand off to a human
Right before opening the PR, get the final verdict against the real diff:
`{{pluginBinPrefix}}classify-risk.sh --from-git --stage pr --action "PR→<base>" --render-md` — paste the
output markdown block (verdict table + its audit marker, if the classifier emits one) **verbatim into
the PR body** rather than transcribing it. If it's REQUIRE, put the reason at the very top of the PR
body — what a human needs to see is exactly why the gate called for them. This session still composes
the PR body (summary, verification evidence, gate verdict, any SKIP reasons, and the `Decisions taken`
section from [Execution mode](#execution-mode--autonomous-by-default)) and the tracked-issue comment.
**Write both in `outputLanguage`** (the banner at the top of this file) — this is the measured drift
point: by now the context is dominated by this English skill body, and runs that worked in the user's
language through step 4 report the PR in English here. Pasted evidence (verdict block, gate output,
command names, branch name) stays verbatim — only your own prose is translated.

**This session does not run the `git push`, PR-open, or tracked-issue comment itself** (ADR-0003, issue
#15). Hand off to this plugin's `ship-flow:publisher` agent, and make the handoff **file-based, never a
Bash heredoc**:

1. `mktemp -d` — a fresh directory, never a predictable fixed path.
2. **Write the PR title, PR body, and tracked-issue comment text with the Write tool**, each to its own
   file in that directory.
3. Give `ship-flow:publisher` the file paths plus the exact commands to run — `git push -u origin
   <branch>`, `gh pr create` (or this repo's tracker-appropriate equivalent) with `--title` from the
   title file and `--body-file` pointed at the body file, and the tracked-issue comment command with
   `--body-file` pointed at the comment file.

Never assemble these values with a Bash heredoc (`VAR=$(cat <<'EOF' … EOF)`) — a quoted delimiter does
**not** stop the heredoc ending early on untrusted content, and everything after that line is read back
as real shell commands. [PUBLISH-HANDOFF.md](PUBLISH-HANDOFF.md) has the full reasoning and the safe
pattern; `agents/publisher.md`'s "What you do" has it from the executing side. `ship-flow:publisher`
only executes what it's handed — it never reads repository files on its own initiative, fetches
content, or writes its own PR/comment text — and reports back the PR URL and each command's exit code.
**Stop here** — a human reviews and merges. If this PR doesn't trigger CI, the PR body is the only
verification record a human sees, so make sure step 2's gate results are in it.

**Hard termination — the run ends when the PR URL exists.** "Stop here" is not "pause and find more work".
Once the PR is open, this session does **not**, absent a fresh human instruction naming the new work:
create another worktree · create another branch · create or claim another tracked issue · open another
PR · start implementing anything else. The one exception is step 6, this issue's own lessons pass.
Report the PR URL — in `outputLanguage`, URL and branch name verbatim — and stop talking.

**Merge approval is per-PR and never inferred.** "Merge it" authorizes **one** merge of **this** PR —
not standing approval, not a PR opened later in the same session, and not a retry. A failed
`gh pr merge` is a result to report, not a loop to go around again: that's one irreversible action
attempted twice on one approval.

→ **After a human merges:** clean up the worktree/branch (remove any dedicated deep-gate resources
first, confirm no stash leftovers) + update the tracked issue (status, merge SHA) → **step 6**.
Release (`integrationBranch → releaseBranch`) is a separate decision — `hotfix`, or this repo's own
release procedure.

### 6. `improve` — lessons → skeptical review → harness-improvement PR (post-merge, also stops at a PR)
Record what the verifier actually confirmed as fixed as a lesson (this plugin's `retrospect` skill, if
ported into this repo), and only promote **recurring** ones as codification candidates. The core
safeguard is **the proposer isn't the approver** — if the same judgment that nominated a candidate also
accepts it, that's a rubber stamp. A separate skeptical pass tries to *refute* each candidate; when
uncertain, the default is reject.

```bash
L() { {{pluginBinPrefix}}lessons.sh "$@"; }; D='.loop/lessons'
L promote --min-count 3 --lessons $D                                   # candidates + id (verified+recurring floor)
L challenge --id <id> --verdict accept|reject --reason "…" --lessons $D # ← the separate skeptical pass records this
L promote --codify --lessons $D                                        # only accepted ones come out
L retire --id <id> --ref "<where it landed>" --lessons $D              # retire from the pool after codifying
```

Landing an accepted lesson in CLAUDE.md/a skill happens **as a PR, not a direct edit**: new worktree off
the integration branch → edit → `{{pluginBinPrefix}}classify-risk.sh --from-git --stage improve` (harness
files rule-match to `blast=high` → always REQUIRE) → open the PR and **stop**. Anything irreversible is a
merge, not an edit — autonomy covers getting to the PR; that door is the human boundary.
→ **Gate:** zero codifications without an accept verdict · zero direct commits to this repo's
CLAUDE.md/`.claude/**` from this session.

## Token efficiency
- **Delegate exploration.** If understanding the codebase needs 3+ rounds of grep/read, hand it to an
  Explore-type agent — keep raw file dumps and grep output out of the main context. Same for review
  agents: pull in their findings summary, not their internal deliberation.
- **Delegate mechanical, judgment-free work** (lint/type-error fix loops, straightforward renames) to a
  cheaper model.
- **Check context size at step boundaries.** Crossing the step 2→3 or 3→4 gate after accumulating long
  test or review output is a good point to consider delegating or compacting — worktree isolation makes
  single sessions run long.

## Failures and conflicts (handled autonomously)
- Gate red → loop back on that step autonomously. Only call a human if the agent can't resolve it itself.
- Human-side merge reports out-of-date/CONFLICTING → in the worktree, **standalone** `git fetch origin
  <base>` → **standalone** `git rebase origin/<base>` → re-verify. Then hand the retry push to
  `ship-flow:publisher` the same way step 5 does (ADR-0003) — still the Builder session, still holding
  untrusted-input history from steps 0-4, so it must not run the push itself. Give it the branch name
  as a literal and the exact command: `git push --force-with-lease origin "$BRANCH"`, `$BRANCH`
  assigned from that literal (never bare/unquoted interpolation), never a Bash heredoc. `<base>` is
  **that PR's base**. **Run each command as its own independent call** — chaining `git merge`/`git pull`
  with anything else is liable to trip a merge guardrail hook regardless of direction.
- **Stacked PR (this branch is itself another open PR's base) + squash-merge**: once this PR merges,
  the branch it was on is gone as a target — the stacked PR's base doesn't auto-retarget, so its commits
  can land in a dead branch instead of the integration branch even though GitHub shows it as merged. If
  a stacked PR exists, retarget (or rebase) it onto the integration branch **before** it merges, not
  after. Don't trust a `MERGED` badge alone — confirm with `git show origin/<base>:<file> | grep
  <symbol>` that the actual content landed.
