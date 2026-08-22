---
name: ship-feature
description: This plugin's autonomous-by-default feature delivery sequence and single entrypoint — the agent isolates a worktree, plans, TDDs, runtime-verifies, self-reviews, opens the PR and STOPS for the human to merge, then turns verified lessons into a harness-improvement PR. Risk gating at each step is decided by a deterministic classifier, not by the agent's own scoring. Use when the user delegates a task, feature, bug, or tracked issue to take from plan to an open PR following the standard flow (plan → tdd → runtime-verify → review → PR → improve), or asks to "ship"/"deliver"/"land" a feature.
---

# ship-feature — this plugin's single entrypoint (autonomous, human only where the gate calls for it)

The procedure for taking one unit of work (a feature, a bug, a tracked issue) from **plan to an open
PR, and from a merged PR to a harness-improvement PR** with the agent running autonomously the whole
way. Each step's *content* is owned by the skill/agent it delegates to — this skill only fixes the
**order, the gates, and where a human steps in**.

> **Git procedure (branch model, worktrees, merge, rebase) lives in this repo's own CLAUDE.md (or
> equivalent constitution doc), not here.** If this repo was set up via this plugin's `setup` skill,
> that doc was generated from `templates/CLAUDE.md.template` and already covers this. This skill
> references it rather than duplicating it — a duplicated copy drifts the moment the branch model
> changes.

## Config

Reads `.claude/ship-flow.config.json` at the consuming repo's root (written by this plugin's `setup`
skill — see `hotfix`'s SKILL.md for the field list). If it doesn't exist yet, ask the user for
`branchModel`, `integrationBranch`/`releaseBranch`, and `verifyCommand` before proceeding — don't guess.
`trackerName`, if set, names this repo's issue tracker (Linear is the worked example throughout this
file, since that's what this skill was originally built against — substitute this repo's actual tracker
and its equivalent mechanics: create/update issue, assignee, blocking-issue links, status transitions).

## Execution mode — autonomous by default

The agent runs step 0 → PR **without stopping**. There are exactly **three** places it calls a human:

1. **The merge/deploy boundary** — it opens a `feature/* → integrationBranch` (or the trunk-based
   equivalent) PR and **stops**. Landing on a shared branch is `reversibility=none`, so a human reviews
   and merges — the agent never approves its own code onto a shared branch. **Release
   (`integrationBranch → releaseBranch`) is out of this skill's scope** — a human decides that
   separately, and this plugin's `hotfix` skill handles that two-stage flow (including its own
   merge/deploy stop points) if needed.
2. **Any step where the risk gate returns REQUIRE** — see [Risk gate](#risk-gate--the-rules-classify-not-the-agent)
   below. The agent stops *before* running that step and waits for human approval.
3. **Genuinely stuck, ambiguous, or unable to self-recover** — only when the agent can't resolve a gate
   on its own or a real judgment call is needed.

Every other verification failure (red) is something the agent **loops back on itself** — it doesn't ask
a human.

> "Autonomous" means *the agent*, not *no human in the loop*: nobody is watching every step, but an
> intelligent agent is making judgment calls throughout the loop, which is what makes the runtime-verify
> step's model-produced verdict trustworthy.

## Invariants (skipping these breaks the contract — non-negotiable)

- **Worktree isolation first.** The main worktree's HEAD is always the integration branch (git-flow) or
  the release branch (trunk-based) — never check a work branch out there. Before the first edit:
  `git fetch origin` → `git worktree add -b <branch> <sibling-path-outside-repo> origin/<base>`. **Don't
  base a new worktree on a local branch** — the server is the source of truth.
- **Reward-hack guard — if this repo has one, it's always armed, structurally.** If loop-engine@paul-loop
  (or an equivalent) provides a reward-hack guard hook on working branches, it arms by branch condition
  automatically — this skill doesn't turn it on or off, and there's nothing to disarm before handing off
  to a human. If a legitimate edit to a protected file (test/config/verifier files) gets denied, open a
  reasoned window per that guard's convention, make the edit, close the window, and record the reason in
  the PR body.
- **This repo's verify command is the one automatic gate.** A `feature/* → integrationBranch` PR
  typically doesn't trigger CI in a git-flow setup that skips CI at that stage (a common cost-control
  pattern — check `ciSkipOnIntegrationPR` in the config) — if so, nothing catches a skipped local gate
  before the change lands on the integration branch. If this repo also gates its own harness/consumer
  wiring with a separate command (e.g. a `verify:loop`-style script), that needs to be green too whenever
  harness-consumer files were touched — step 6 especially.
- **Verify (runtime) means observing the running app**, not re-running the verify command — that already
  happened inside step 2. Step 3 asks "did the app actually get built/started and exercised at the
  changed surface," not "did the test suite pass again."
- **A human merges.** The agent gets to an open PR and no further. No local `git merge`/`git pull` toward
  a shared branch, no direct push — if this repo has a merge guardrail hook and/or server-side branch
  protection, they'll block it anyway.
- **The agent doesn't self-score risk.** Classification comes from a deterministic rule set first; the
  agent's own input can only push a classification **up**, never down (below). Self-grading turns the
  gate into decoration.
- **Harness improvements land as PRs only.** This session doesn't directly edit and commit to this
  repo's CLAUDE.md / `.claude/**` — step 6 submits only accepted lessons, as a **separate PR**, and
  stops there.
- **Issues live in this repo's tracker.** Use whatever this repo's `trackerName` config says (Linear is
  the worked example below); don't fall back to ad-hoc GitHub issues if a real tracker is configured.
- **Verification results are quoted, not paraphrased.** Test runs, gate verdicts, review findings —
  report these by pasting the actual output (or LOG file) verbatim, the same way step 5 pastes the
  risk-verdict markdown block into the PR body rather than transcribing it. A hand-summarized paraphrase
  can silently launder a partial/failing result into an apparent pass; the raw output is the evidence,
  not a description of it.

## Risk gate — the rules classify, not the agent

If this plugin (via loop-engine@paul-loop) provides a deterministic risk classifier, its decision rule is
three-valued: `reversibility=none` or an unclassified dimension → `REQUIRE` (wait for human approval);
reversible but `blast=high OR cost=high` → `DENY_AND_LOG` (deny by default without waiting on a human,
but log the verdict evidence into the PR — human review happens at the PR/merge boundary instead); anything
else → `AUTO`. The gap that matters is **who assigns blast/reversibility/cost** — inside this skill,
that would otherwise be the same agent doing the work, which turns self-scoring into a rubber stamp. So
classification is derived **from the change itself** (paths/commands/stage) by the classifier first, and
agent input is folded in as `final = max(rule, agent)` — **only allowed to raise** the classification,
never lower it:

```bash
<however this repo invokes its installed loop-engine plugin's bin scripts> classify-risk.sh --from-git --stage <plan|implement|pr|improve> \
  --action "<what is about to happen>" \
  [--agent-blast-radius low|medium|high --agent-reversibility full|partial|none --agent-cost low|medium|high]
# exit 0  = AUTO         → proceed autonomously
# exit 10 = REQUIRE      → stop before running that step, get human approval
# exit 11 = DENY_AND_LOG → on the verdict channel (here): log evidence (--render-md) into the PR and
#                          proceed; on a command-execution channel (a PreToolUse hook, if wired): block
#                          the command instead — the two channels intentionally mean different things
```

(`<however this repo invokes its installed loop-engine plugin's bin scripts>` — usually just the bare
script name in a live session, since a plugin's `bin/` is already on PATH once it's loaded; for CI or
resolving a *different* installed plugin's path, loop-engine bundles its own resolver at
`bin/plugin-path.mjs` (`exec <relative-bin> [args...]`, BAC-753), or this repo may provide its own
equivalent wrapper. If this repo layers its own `risk-rules.json` on top of loop-engine's defaults,
`classify-risk.sh` picks it up automatically.)

- **Surface the rules typically cover**: schema migrations (`reversibility=none`) · row-level-security or
  equivalent tenant-isolation schema · auth/guards · outbound send/call · the harness/constitution layer
  (`.claude/**`, this repo's CLAUDE.md, `docs/adr/**`, loop-engine tooling) · CI/deploy · workspace-root
  config · 11+ files touched. Below that threshold, with **≤10 files and 0 commands and no rule match**,
  a low-risk app-code baseline applies (`low/full/low` → AUTO); everything else unmatched (an unmatched
  *command*, or 11+ files with no classification) is **fail-closed REQUIRE** — silence isn't AUTO.
- **Merge, deploy, and release are never classified as anything but REQUIRE** — `--stage
  merge|deploy|release|send` and merge/deploy *commands* are always `reversibility=none` regardless of
  other input.
- **The track is a classification output**, not a separate axis. Whatever `TRACK:` line the classifier
  prints is the routing decision:

  | TRACK | Meaning | Steps |
  |---|---|---|
  | `risky` | Matched a rule | Full sequence + whatever `DEEP_GATES:` the output names |
  | `standard` | No rule match | Full sequence, deep gates only if this repo's own verify table says they're affected |
  | `docs-only` | No runtime surface touched | Steps 2-3 can be skipped |

  Skipping a step always leaves a one-line reason in the PR body (so it's auditable after the fact).

## Sequence (0 → PR is autonomous, merge is human, post-merge is `improve`)

### 0. Worktree isolation — `git worktree`
If this repo tracks issues externally (Linear, GitHub Issues, etc.), claim the issue to yourself first
— before creating the worktree — by assigning it and moving it into an in-progress state. If this repo
runs concurrent sessions regularly, claiming first is what stops two sessions from picking up the same
issue (worktree isolation alone only prevents git conflicts, not duplicate starts).

`git fetch origin && git worktree add -b <type>/<slug> <sibling-path-outside-repo> origin/<base>`. Check
`git worktree list` first if concurrent work is common in this repo. A fresh worktree has no installed
dependencies — install them. Every following step happens inside this worktree. (macOS: if a later
`git worktree remove` fails with a permission-denied ACL error, `chmod -R -N <path>` first — see
hotfix's cleanup step for the full note.)

### 1. Implementation plan — `Plan` agent / `grill-with-docs` if there's a design decision
Plan what to build and how to slice it. **If there's a new design decision involved**, use
`grill-with-docs` to sharpen it against the domain model and record it (ADR + `CONTEXT.md`) — no
implementation yet. Plain CRUD doesn't need that; a `Plan` agent pass is enough.

Once the plan is set, **derive the track from the paths it touches** — there's no diff yet, so pass the
planned paths directly: `<loop-engine classify-risk.sh> --no-gate --path <planned paths>...` → the
resulting `TRACK:`/`DEEP_GATES:` scope the remaining steps.
→ **Gate:** success criteria (what "done" verifiably means) has to be written down before moving on.

**Express acceptance criteria as one-line AC contracts** — this is what makes step 3's gate below
machine-checkable instead of self-reported (ADR-0104). Syntax (quoted verbatim — matches
`ac-verify.sh`'s parser exactly, an optional leading markdown list marker like `- ` is tolerated):

```
AC: <description> | verify: <command> | artifacts: <path1>,<path2> | expect: <substring>
```

Only `AC: <description>` is required — `verify:`, `artifacts:`, and `expect:` are each optional, may
appear in any combination or order, and are separated by ` | `. `artifacts:` paths are
**comma-separated** (not space-separated — a path may itself contain spaces). Example:

```
AC: login rejects a wrong password | verify: pnpm --filter api test -- auth.spec.ts | expect: 401
```

For a `standard` or `risky` track (anything with a runtime surface — `docs-only` is exempt, since
step 3 is already skipped for it per the TRACK table above), **the plan as a whole must express at
least one AC with a machine-checkable contract** (a `verify:` and/or `artifacts:`/`expect:` field) —
not every AC needs one, but zero across the whole plan means step 3 (Runtime verify) will fail closed.

**If the plan itself exceeds one session's budget** (the scope is too large to pin down a single
verifiable "done"), don't jump straight to implementation — split the issue into a map of decision
tickets first: one separate tracked issue per still-open question (blocked-by links pointing at
whichever decision has to resolve first), and work through the sharpest one first. That's just a
planning artifact — each resolved decision ticket re-enters this skill from step 0 properly, with the
full risk gate, worktree isolation, and verify still applying (splitting the plan doesn't bypass the
gate).

> **Token efficiency**: if exploring the codebase needs 3+ rounds of grep/read, delegate to an
> Explore-type agent instead of doing it in the main context — keep raw file dumps and grep output out
> of the main conversation.

### 2. Implementation — `tdd` (red → green)
Implement the plan red→green. Security/invariant paths (RLS, authorization, or whatever this repo's
equivalent is) need **behavior-proof tests**, not just coverage. This repo's verify command is this
loop's convergence criterion — run it wrapped, always, never raw: `<however this repo invokes its
installed loop-engine plugin's bin scripts> verdict-run.sh -- <verifyCommand>` (BAC-745). This holds
even if `verifyCommand` is itself already a verdict-contract script (e.g. a repo's own `verdict` wrapper)
— `verdict-run.sh` detects an already-emitted `=== VERDICT ===` block and passes it through unchanged
rather than double-wrapping, so wrapping unconditionally is always safe. Read the gate off the printed
`VERDICT:`/`EXIT:` lines, not a bare shell exit code — the block is the actual contract (state file +
ledger event), an exit code alone skips both.
→ **Gate:** `VERDICT: PASS` + whatever `DEEP_GATES:` step 1 identified (re-checked against the actual
diff with `--from-git`). `VERDICT: FAIL` loops back autonomously.

> If any `DEEP_GATES:` run against a shared local resource (e.g. a per-worktree docker database), don't
> run more than one deep gate in this worktree at the same time — a second one recreating the same
> container mid-run causes an unrelated-looking failure, not a clear error.

### 3. Runtime verify
Build and run the app, drive the changed surface (CLI/API/GUI — whatever applies) through it, and
confirm **what was intended actually works**. This produces runtime evidence, not a re-run of the test
suite. When step 1's plan has any AC contracts, this is now formalized via `<however this repo invokes
its installed loop-engine plugin's bin scripts> ac-verify.sh <plan-file>` (ADR-0104) — deterministic
subprocess judgment (verify exit code, artifact existence, output substring) per contracted AC,
composing with — not replacing — the observe-the-running-app check above.
→ **Gate:** PASS. FAIL → **loop back to step 2**. SKIP (no runtime surface exists) passes with a
one-line reason.

> If a GUI surface needs driving and a browser-automation MCP is unavailable or its profile is
> contended by another concurrent session, fall back to a standalone script that imports this repo's
> own test framework's browser driver directly (e.g. Playwright) and launches a fresh headless browser
> — independent of any shared MCP browser profile. Run it from inside the package that has that
> dependency installed (a script outside it won't resolve the same `node_modules`).

### 4. Review and fix
Run this plugin's review agents (`code-reviewer`, `test-hunter`, `verifier-integrity-hunter`) against
the diff. If this repo also runs a separate general-purpose PR-review tool, run both — during any
period where both are in use, treat this plugin's agents as complementary, not a replacement. Fix what
they flag autonomously.
→ **Gate:** Critical/Important findings resolved. Re-run the step-2 gate after fixing, then re-review.

> **Token efficiency**: review agents run in their own context — don't pull their raw internal
> deliberation into the main context, just the findings summary.

### 5. Open the PR → `integrationBranch` (or `releaseBranch` if trunk-based) and **stop** — hand off to a human
Right before opening the PR, get the final verdict against the real diff: `<loop-engine
classify-risk.sh> --from-git --stage pr --action "PR→<base>" --render-md` — paste the output markdown
block (verdict table + its audit marker, if the classifier emits one) **verbatim into the PR body**
rather than transcribing it by hand. If it's REQUIRE, put the reason at the very top of the PR body —
what a human needs to see is exactly why the gate called for them. This session still composes that PR
body (summary, verification evidence, gate verdict, any SKIP reasons) and the tracked-issue comment text
— composing text isn't an external state change.

**This session does not run the `git push`, PR-open, or tracked-issue comment itself** (ADR-0003, issue
#15 — this session has been reading untrusted issue/web content and holding full worktree access since
step 0-4, so it must not also be the one executing the external action that publishes the result of that
work). Instead, hand off to this plugin's `publisher` agent — but the handoff itself has to be file-based,
not a Bash heredoc: **write the PR title, PR body, and tracked-issue comment text with the Write tool**,
each to its own file inside a fresh `mktemp -d` directory (never a predictable fixed path), and give
`publisher` the file paths plus the exact commands to run — `git push -u origin <branch>`, `gh pr create`
(or this repo's tracker-appropriate equivalent) with `--title` read from the title file and `--body-file`
pointed at the body file, and the tracked-issue comment command with `--body-file` pointed at the comment
file. Never assemble these values with a Bash heredoc assigned to a shell variable (`VAR=$(cat <<'EOF' …
EOF)`) — a quoted delimiter only suppresses expansion inside the body, it does not stop the heredoc from
ending early if the underlying content (which can be derived from untrusted issue/web text) contains a
line that is exactly the delimiter word, and everything after that line is then read back as real shell
commands. See `publisher.md`'s "What you do" for the exact safe pattern (native `--*-file` flags where the
CLI has them, `"$(cat <path>)"` into a double-quoted variable where it doesn't) and its full explanation
of why that pattern has no equivalent collision. `publisher` only executes what it's handed — it doesn't
read repository files on its own initiative, fetch content, or write its own PR/comment text — and reports
back the PR URL and each command's exit code. **Stop here** — a human reviews and merges. If this PR
doesn't trigger CI, the PR body is the only verification record a human will see, so make sure step 2's
gate results are actually in it.
→ **After a human merges:** clean up the worktree/branch (remove any dedicated deep-gate resources first
if this repo uses per-worktree isolated containers for them, confirm no stash leftovers) + update the
tracked issue (status, merge SHA) → **step 6**. Release (`integrationBranch → releaseBranch`) is a
separate decision — `hotfix` or this repo's own release procedure.

### 6. `improve` — lessons → skeptical review → harness-improvement PR (post-merge, also stops at a PR)
Record what the verifier actually confirmed as fixed as a lesson (this plugin's `retrospect` skill, if
ported into this repo), and only promote **recurring** ones as codification candidates. The core
safeguard is **the proposer isn't the approver** — if the same judgment that nominated a candidate also
accepts it, that's a rubber stamp. A separate skeptical pass tries to *refute* each candidate; when
uncertain, the default is reject.

```bash
L() { <loop-engine bin resolver> lessons.sh "$@"; }; D='.loop/lessons'
L promote --min-count 3 --lessons $D                                   # candidates + id (verified+recurring floor)
L challenge --id <id> --verdict accept|reject --reason "…" --lessons $D # ← the separate skeptical pass records this
L promote --codify --lessons $D                                        # only accepted ones come out
L retire --id <id> --ref "<where it landed>" --lessons $D              # retire from the pool after codifying
```

Landing an accepted lesson in CLAUDE.md/a skill happens **as a PR, not a direct edit**: new worktree off
the integration branch → edit → `<loop-engine classify-risk.sh> --from-git --stage improve` (harness
files rule-match to `blast=high` → always REQUIRE) → open the PR and **stop**. Anything irreversible is a
merge, not an edit — autonomy covers getting to the PR; that door is the human boundary.
→ **Gate:** zero codifications without an accept verdict · zero direct commits to this repo's
CLAUDE.md/`.claude/**` from this session.

## Token efficiency
- **Delegate mechanical, judgment-free work** (lint/type-error fix loops, straightforward renames) to a
  cheaper model — there's no reason to spend a top-tier model on repetitive fixes that don't need
  judgment.
- **Check context size at step boundaries.** Crossing the step 2→3 or 3→4 gate after accumulating long
  test output or long review results is a good point to consider delegating or compacting — worktree
  isolation makes single sessions run long.

## Failures and conflicts (handled autonomously)
- Gate red → loop back on that step autonomously. Only call a human if the agent can't resolve it itself.
- Human-side merge reports out-of-date/CONFLICTING → in the worktree, **standalone** `git fetch origin
  <base>` → **standalone** `git rebase origin/<base>` → re-verify. Then hand the retry push off to
  `publisher` the same way step 5 does (ADR-0003) — this is still the Builder session, still holding the
  same untrusted-input history from steps 0-4, so it must not run the push itself. Give `publisher` the
  branch name as a literal value and the exact command to run: `git push --force-with-lease origin
  "$BRANCH"` with `$BRANCH` assigned from that literal (never bare/unquoted interpolation) — the same
  defensive quoting step 5 uses for the branch name, never a Bash heredoc. `<base>` is **that PR's base**
  (the integration branch, or the release branch for a release PR). **Run each command as its own
  independent call** — chaining `git merge`/`git pull` with anything else is liable to trip a merge
  guardrail hook regardless of direction, if this repo has one.
- **Stacked PR (this branch is itself another open PR's base) + squash-merge**: once this PR merges,
  the branch it was on is gone as a target — the stacked PR's base doesn't auto-retarget, so its commits
  can land in a dead branch instead of the integration branch even though GitHub shows it as merged. If
  a stacked PR exists, retarget (or rebase) it onto the integration branch **before** it merges, not
  after. Don't trust a `MERGED` badge alone — confirm with `git show origin/<base>:<file> | grep
  <symbol>` that the actual content landed.
