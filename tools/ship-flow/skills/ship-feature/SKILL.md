---
name: ship-feature
description: This plugin's autonomous-by-default feature delivery sequence and single entrypoint — isolate a worktree, plan, TDD, runtime-verify, self-review, open the PR and STOP for the human to merge, then prepare a harness-improvement PR only when that follow-up is authorized. Risk gating is decided by a deterministic classifier, not the agent's own scoring. Use when the user delegates a task, feature, bug, or tracked issue to take from plan to an open PR (plan → tdd → runtime-verify → review → PR → improve), or asks to "ship"/"deliver"/"land" a feature.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# ship-feature — this plugin's single entrypoint (autonomous, human only where the gate calls for it)

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Takes one unit of work (a feature, a bug, a tracked issue) from **plan to an open PR, and from a
merged PR to a harness-improvement PR** only within the caller's requested scope, running autonomously
between genuine approval boundaries. Each
step's *content* belongs to the skill/agent it delegates to — this skill fixes only the **order, the
gates, and where a human steps in**.

Bundled references (read at the point each is needed): [RISK-GATE.md](RISK-GATE.md) ·
[AC-CONTRACTS.md](AC-CONTRACTS.md) · [PUBLISH-HANDOFF.md](PUBLISH-HANDOFF.md).

> **Git procedure (branch model, worktrees, merge, rebase) lives in this repo's own CLAUDE.md (or
> equivalent constitution doc), not here.** If this repo was set up via this plugin's `setup` skill,
> that doc came from `templates/CLAUDE.md.template` and already covers it. Duplicating it here would
> drift the moment the branch model changes.

## Config

Reads `.claude/ship-flow.config.json` at the consuming repo's root (`hotfix` has the field list).
If missing or incomplete, resolve branch names/model and `verifyCommand` from the request and repo
evidence first. Ask only for a value that blocks the next action; do not bootstrap unrelated config.
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
| `""` (absent → default) | `classify-risk.sh --from-git …` | Only after required commands are verified on this runtime's PATH |
| `node tools/plugin-path.mjs exec bin/` | …prefixed with that, same flags | If this repo ships its own resolver wrapper |
| `node "$LOOP_ENGINE_PATH/bin/plugin-path.mjs" exec bin/` | …same shape, loop-engine's bundled resolver | CI / headless, nothing on PATH (BAC-753) |

**Argument form is not re-derivable — use exactly what's written.** Only `verdict-run.sh` takes a `--`
separator (it needs one, to fence off the command it wraps). `classify-risk.sh`, `ac-verify.sh`, and
`lessons.sh` take **no `--`**; passing one is an unknown-arg usage error, not a harmless no-op.
`classify-risk.sh --path` is repeated once per path, not given a space-separated list.

If a substituted command fails to resolve, stop the dependent step and diagnose the invocation
within scope. Report any remaining blocker. Never substitute raw verification: a resolution/usage
error is not a code failure or a valid gate verdict.

## Execution mode — autonomous by default

Record the requested endpoint and allowed actions first. Read/draft requests end with their artifact,
not implementation or publication. For delivery authorized through PR creation, run step 0 → PR
without unnecessary stops, using these human boundaries:

Implementation approval continues across necessary source, plan and test edits within that scope.
Refresh affected evidence as the working head changes; do not re-ask implementation approval per edit.
Artifact/head binding governs the reviewed merge/publish/deploy/send action when that boundary is
reached, or another action explicitly approved against an artifact.

1. **The merge/deploy boundary** — it opens a `feature/* → integrationBranch` (or the trunk-based
   equivalent) PR and **stops**. Landing on a shared branch is `reversibility=none`, so a human reviews
   and decides the merge — the agent never approves its own code onto a shared branch. A later exact
   merge instruction uses `ship-flow:hotfix` or the repo's release procedure. **Release
   (`integrationBranch → releaseBranch`) is out of this skill's scope** (see step 5).
2. **Any step where the risk gate returns REQUIRE** — see [Risk gate](#risk-gate--the-rules-classify-not-the-agent).
   Before the action, check inherited approval for that exact action. If absent, prepare its
   reviewable result and wait for approval. Do not request existing matching approval again.
3. **Genuinely stuck, ambiguous, or unable to self-recover** — only when the agent can't resolve a gate
   on its own or a real judgment call is needed.

Ordinary check failures loop back within scope. Invocation/environment failures remain unresolved
until the real verifier runs. Missing or contradictory evidence is never PASS.

**Qualify every question before asking it.** Those three are the *only* sanctioned stops, and this skill
drifts into asking far past them — design questions the agent could already answer, put to a human who
answers "go with your recommendation". Before interrupting, apply this test:

> **Is this authorized, can I state a clear recommendation, and is the decision reversible?** If all
> are yes, **take the
> decision, don't ask** — and record it, one line per decision (what was chosen, the alternative, why),
> in a **`Decisions taken`** section of the PR body, where the human reviews it at the merge boundary
> that already exists.

Ask only when missing information or authorization blocks the next action: no defensible recommendation (a real product/priority call
the agent has no basis for), or an irreversible consequence — already covered by points 1 and 2.
"This feels like it deserves a check-in" is not a qualifying reason; a `Decisions taken` line is.

## Invariants (skipping these breaks the contract — non-negotiable)

- **Worktree isolation first.** Reuse an isolated worktree explicitly assigned by the user. Otherwise,
  inspect the actual checkout and base; never assume or change the main checkout's HEAD. Before
  the first edit when a new isolated worktree is needed:
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
- **A human approves each merge.** This delivery run ends at its verified publish outcome and the
  human merge boundary. CI/AFK cannot supply approval. No local `git merge`/`git pull` toward
  a shared branch, no direct push — a merge guardrail hook and/or branch protection will block it anyway.
- **The agent doesn't self-score risk.** Classification comes from a deterministic rule set first; agent
  input can only push it **up**, never down. Self-grading turns the gate into decoration.
- **Harness improvements land as PRs only.** Authorized CLAUDE.md / `.claude/**` edits happen in an
  isolated worktree with guards and verification, never as direct commits to a shared branch.
  Step 6 prepares accepted lessons as a **separate PR** only when that follow-up is authorized.
- **Issues live in this repo's tracker.** Use whatever `trackerName` says; don't fall back to ad-hoc
  GitHub issues if a real tracker is configured.
- **Verification results are quoted, not paraphrased.** Preserve the single canonical verdict and
  redact secrets before sharing without altering its outcome. Paste actual output (or the LOG file) verbatim
  for test runs, gate verdicts and review findings, the same way step 5 pastes the risk-verdict block
  into the PR body. A hand-summarized paraphrase can silently launder a partial/failing result into an
  apparent pass; the raw output is the evidence, not a description of it.

## Risk gate — the rules classify, not the agent

Before each action, classify its planned paths, command, and stage; refresh after changes. A planning
`--no-gate` track lookup is not authorization. Classification uses the change itself, and agent input is folded in
as `final = max(rule, agent)` — **only allowed to raise** it, never lower it.

```bash
{{pluginBinPrefix}}classify-risk.sh --from-git --stage <plan|implement|pr|improve> \
  --action "<what is about to happen>" \
  [--agent-blast-radius low|medium|high --agent-reversibility full|partial|none --agent-cost low|medium|high]
# exit 0  = AUTO         → proceed within existing authorization
# exit 10 = REQUIRE      → verify matching human approval before the action; ask only if missing
# exit 11 = DENY_AND_LOG → verdict channel: log evidence; continue only authorized reversible work
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
| `docs-only` | No runtime surface touched | Implementation/TDD and app-driving can be skipped; required repository/document gates still run |

Skipping a step always leaves a one-line reason in the PR body, so it's auditable after the fact.

See [RISK-GATE.md](RISK-GATE.md) for what the rule set covers, why the agent may only raise a
classification, the two channels of `DENY_AND_LOG`, and layering this repo's own `risk-rules.json`.

## Sequence (0 → PR is autonomous, merge is human, post-merge is `improve`)

### 0. Worktree isolation — `git worktree`
Check the authorization record before any writes or external action. For a delivery request that
includes tracker updates, claim the issue first — before
creating the worktree — by assigning it and moving it into an in-progress state. Where concurrent
sessions are common, claiming first is what stops two sessions picking up the same issue (worktree
isolation alone prevents git conflicts, not duplicate starts).

**Assign it to the verified human driving this session.** An authenticated shared/service account is
not proof of that identity. Preserve existing ownership unless reassignment is authorized. If the
owner is unresolved, report it and continue independent local work; do not invent an assignee. An empty
assignee here is the common failure and stays invisible for a long time: merge automation closes the
issue without ever setting one, so it lands in Done owned by nobody.

Unless the user assigned an existing isolated worktree:
`git fetch origin && git worktree add -b <type>/<slug> <sibling-path-outside-repo> origin/<base>`. Check
`git worktree list` first if concurrent work is common here. A fresh worktree has no installed
dependencies — inspect prerequisites and install what is needed within scope. Every following step
happens inside this worktree. (macOS: if a later
`git worktree remove` fails with a permission-denied ACL error, `chmod -R -N <path>` first — see
hotfix's cleanup step for the full note.)

### 1. Implementation plan — `Plan` agent / `grill-with-docs` if there's a design decision
Plan what to build and how to slice it. Resolve routine reversible choices from requirements and
code. For a material open decision, call `ship-flow:grill-with-docs` in **caller mode** with that
bounded question and allowed documentation. Return to this flow when it resolves; no implementation
before the finished plan is checked. Use an available planning agent or plan here.

**Scope guard.** Grilling routinely surfaces adjacent work that *should* happen. That is not licence to
grow this run: record adjacent work as a follow-up proposal; file a separate tracked issue only when
that publication is authorized (blocked-by links where applicable). **This run continues on the original issue at
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
vacuous. A BLOCK loops back here; ask a human only for a missing reserved decision. Reuse planner
proof only for the same plan digest, relevant code revision, track, and completed per-criterion
checklist. Recheck affected proof after changes. An interview or ADR is not planner proof;
`grill-with-docs` never automatically exempts this gate. Record proof reuse in the PR body.

**If the plan itself exceeds one session's budget** (too large to pin down a single verifiable "done"),
don't jump to implementation — propose decision tickets first; publish only if authorized. Use one
ticket per open question, dependencies first, sharpest one worked first.
Each resolved ticket re-enters this skill from step 0 — splitting the plan doesn't bypass the gate.

### 2. Implementation — invoke the `ship-flow:tdd` skill (red → green)
Implement the plan red→green by **invoking this plugin's `ship-flow:tdd` skill by that exact
namespaced name** — not by writing tests in this session's own style and calling it TDD. Security/
invariant paths (RLS, authorization, or whatever this repo's equivalent is) need **behavior-proof
tests**, not just coverage. This repo's verify command is this loop's convergence criterion — run it
wrapped, always, never raw: `{{pluginBinPrefix}}verdict-run.sh -- <verifyCommand>` (BAC-745 — `--` is
required here, and only here). This holds even if `verifyCommand` is itself already a verdict-contract
script (e.g. a repo's own `verdict` wrapper) — `verdict-run.sh` detects an already-emitted
`=== VERDICT ===` block according to its contract rather than creating competing verdicts. Read the
single canonical gate off the printed `VERDICT:`/`EXIT:` lines and command status. Missing, conflicting,
or inconsistent evidence stays unresolved; do not pick whichever result is green. A bare exit code
does not replace the block, state file, and ledger event.
→ **Gate:** `VERDICT: PASS` + whatever `DEEP_GATES:` step 1 identified (re-checked against the actual
diff with `--from-git`). `VERDICT: FAIL` loops back autonomously.

> If any `DEEP_GATES:` run against a shared local resource (e.g. a per-worktree docker database), don't
> run more than one deep gate in this worktree at the same time — a second one recreating the same
> container mid-run causes an unrelated-looking failure, not a clear error.

### 3. Runtime verify
Build and run the app, drive the changed surface (CLI/API/GUI — whatever applies) through it, and
confirm **what was intended actually works**. This produces runtime evidence, not a re-run of the test
suite. Check each AC command's effects against the authorized environment before execution.
When step 1's plan has any AC contracts, this is formalized via
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
the PR body** rather than transcribing it. Apply the result to this PR-open action before execution:
REQUIRE needs matching approval, DENY_AND_LOG follows its channel, and errors are unresolved. Put
any REQUIRE reason at the top of the body, but that warning does not authorize publishing. Compose
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
3. Give `ship-flow:publisher` the authorization record, exact worktree/repository, head/base,
   destination, gate evidence, command dependencies, and file paths plus the commands — `git push -u origin
   <branch>`, `gh pr create` (or this repo's tracker-appropriate equivalent) with `--title` from the
   title file and `--body-file` pointed at the body file, and the tracked-issue comment command with
   `--body-file` pointed at the comment file.

Never assemble these values with a Bash heredoc (`VAR=$(cat <<'EOF' … EOF)`) — a quoted delimiter does
**not** stop the heredoc ending early on untrusted content, and everything after that line is read back
as real shell commands. [PUBLISH-HANDOFF.md](PUBLISH-HANDOFF.md) has the full reasoning and the safe
pattern; `agents/publisher.md`'s "File-based execution" has it from the executing side. `ship-flow:publisher`
only executes what it's handed — it never reads repository files on its own initiative, fetches
content, or writes its own PR/comment text — and reports back the PR URL and each command's exit code.
Check the publisher's status for every required action; repair failures within scope without
duplicating successful posts. **Stop here** only after the requested publication is complete or a
specific remaining blocker is reported — a human decides the merge. If this PR doesn't trigger CI, the PR body is the only
verification record a human sees, so make sure step 2's gate results are in it.

**Hard termination — the run ends at the requested, verified outcome.** A PR URL alone is insufficient
if a required publish action failed or remains unknown. Once the authorized work is complete, this
session does **not**, absent a human instruction naming the new work:
create another worktree · create another branch · create or claim another tracked issue · open another
PR · start implementing anything else. Step 6 runs only if included in the existing authorization.
Report the PR URL and each required action's actual outcome in `outputLanguage`, identifiers verbatim.

**Merge approval is per-PR and never inferred.** It names this PR, reviewed head/base, destination,
and allowed operation, never a future PR or a bypass. A failed command does not automatically consume
approval: inspect remote state first. Never repeat an applied merge. A confirmed no-effect failure
may be retried with unchanged scope/head/base and valid gates; uncertain outcomes stay blocked.
Changed content or target needs approval for this affected merge; a protection bypass needs its own
authorization. Neither revokes ongoing implementation approval for necessary edits within scope.

→ **After an approved merge, if closeout was authorized:** clean up the worktree/branch (remove any dedicated deep-gate resources
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

With follow-up authorization, prepare an accepted lesson in an isolated worktree. Classify planned
paths **before editing**, apply the gate, then edit and verify. Refresh against the actual diff with
`{{pluginBinPrefix}}classify-risk.sh --from-git --stage improve`. High blast alone is not always
REQUIRE; use the actual verdict and its channel. Classify publication separately, honor its approval,
and open the authorized PR. Human merge approval remains separate.
→ **Gate:** zero codifications without an independent accept verdict · zero direct commits to a
shared branch · all required verification and action approvals intact.

## Token efficiency
- **Delegate exploration when available and authorized.** If understanding the codebase needs 3+ rounds of grep/read, hand it to an
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
  as a data file and the exact command: `git push --force-with-lease origin "$BRANCH"`, `$BRANCH`
  read from that file in the same Bash call (never pasted into shell source), never a Bash heredoc.
  Use this only on a branch covered by the caller's rewrite/publication scope. A changed head needs
  fresh merge approval; do not re-use the approval of the old diff. `<base>` is
  **that PR's base**. **Run each git operation as its own independent call** — chaining `git merge`/`git pull`
  with anything else is liable to trip a merge guardrail hook regardless of direction.
- **Stacked PR (this branch is itself another open PR's base) + squash-merge**: once this PR merges,
  the branch it was on is gone as a target — the stacked PR's base doesn't auto-retarget, so its commits
  can land in a dead branch instead of the integration branch even though GitHub shows it as merged. If
  a stacked PR exists, prepare the retarget/rebase and apply only within its authorization **before** it merges, not
  after. Don't trust a `MERGED` badge alone — confirm with `git show origin/<base>:<file> | grep
  <symbol>` that the actual content landed.
