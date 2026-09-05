---
name: hotfix
description: Land an already-implemented, already-verified small fix through this repo's real gates (worktree isolation → verify → PR→integration → PR→release → deploy), stopping for human confirmation at the merge and deploy checkpoints. Use when the user wants to ship/merge/release a change that's already coded and verified (not a new feature to build — that's ship-feature), or asks to land/deploy a fix that just needs to reach production safely.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# hotfix — land an already-finished fix safely

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

**Precondition: the code is already written and verified.** Planning, TDD, and runtime verification
aren't this skill's job (that's `ship-feature`). This skill's only job: move the change through this
repo's real gates — worktree isolation → verify → merge → release → deploy — without skipping any
of them, and stop for real at the points a human needs to see.

## Config

Reads `.claude/ship-flow.config.json` at the consuming repo's root (written by the ship-flow setup
skill). Reuse the caller's branch/base instructions and verified repository configuration first.
Ask only for a branch decision still missing before a dependent merge; missing config does not require
a new setup interview.

```json
{
  "branchModel": "git-flow",
  "integrationBranch": "develop",
  "releaseBranch": "main",
  "ciSkipOnIntegrationPR": true,
  "deployHook": "tools/deploy/verify-and-redeploy.sh"
}
```

- `branchModel`: `"git-flow"` or `"trunk-based"`.
- `integrationBranch`: git-flow only. The shared branch feature work lands on before release.
- `releaseBranch`: the branch that ships (git-flow's `main`, or trunk-based's single branch).
- `ciSkipOnIntegrationPR`: git-flow only, optional. True if this repo's CI doesn't trigger on the
  feature→integration PR (a common git-flow cost-control pattern) — informs what "stop, confirm the
  merge" evidence is actually available at that stage.
- `deployHook`: optional. A script path this skill runs to deploy. Absent means deploy is manual —
  this skill's job ends at the merged release (see step 5).

**git-flow**: two-stage PR (feature→`integrationBranch`→`releaseBranch`), two merge stop-points plus
a deploy stop-point. **trunk-based**: single-stage PR (feature→`releaseBranch`), one merge
stop-point plus a deploy stop-point.

## Human stop points (skipping any of these defeats this skill's purpose)

1. **Every distinct PR merge**, including both feature→integration and integration→release in
   git-flow, requires explicit approval for its reviewed PR/head/base. Green CI or a broad "ship it"
   does not supply that approval. An existing exact approval remains valid if those inputs and gates
   remain unchanged; do not demand the same approval again solely because a command returned no effect.
2. **A branch-protection bypass** requires separate approval of its exact reason, target, temporary
   changes and restoration plan. Merge approval is not bypass approval.
3. **An actual production deploy** requires approval of the deployment target and artifact, separately
   from merge approval. With no deploy hook/action, report the manual handoff without a pointless deploy
   confirmation. Use the available user-input mechanism; a missing named tool is not permission.

These artifact/head bindings govern the reviewed merge, publication, bypass and deployment actions.
Necessary implementation/recovery edits within the approved scope remain authorized; update their
verification evidence and obtain the affected merge/action approval when due, not before each edit.

## Sequence

### 0. Worktree isolation and scope

Reuse the isolated worktree explicitly assigned by the caller. Otherwise prepare an isolated branch
from the verified base. Inspect the initial branch, worktree and staged/unstaged changes first; do not
assume the main checkout's HEAD or move unrelated user work. If the requested fix needs transferring,
use a path-limited patch or named stash only for its authorized files, record its exact identity and
verify the transfer. Never use whichever entry happens to be `stash@{0}` or drop unrelated stashes.
Preserve the recovery copy until the transfer is verified. Existing unrelated changes are not permission
for reset, cleanup, staging or commits. Read/draft requests end with review material, not this sequence.

### 1. Verify
Check prerequisites and reuse installed dependencies; install only when necessary and within scope. Then the project's verify
command is the **ceiling** — don't move on until it's green (self-judgement never substitutes for
it). Run it wrapped, always, never raw: `{{pluginBinPrefix}}verdict-run.sh -- <verifyCommand>`
(BAC-745; substitute `pluginBinPrefix` from `.claude/ship-flow.config.json` onto the script name with no
separator — default `""`, since a plugin's `bin/` is on PATH in a live session — and never type a `{{…}}`
token into a shell. `verdict-run.sh` is the one script here that *needs* the `--`). The wrapper emits
one canonical contract consistent with the process result, including for nested verifier contracts.
Read its `VERDICT:`/`EXIT:` lines and command status together. Missing or conflicting fields are
unresolved evidence, never PASS. Distinguish a tested failure from invocation/environment failure;
repair the cause within scope and rerun without weakening the gate.

### 2. Commit → PR→`integrationBranch` (or `releaseBranch` if trunk-based)
Classify the planned action before execution under the shared contract: AUTO is not authorization;
REQUIRE needs matching approval; a command-channel DENY blocks that command. Commit only scoped
files if authorized, then push/open the PR only within explicit publication scope. Use
`ship-flow:publisher`'s failure/dependency contract; a push failure prevents PR creation and a PR
creation failure prevents dependent comments. A partial result is not completion.

### 3. **Stop — confirm the merge**
Prepare the PR/head/base and gate evidence for approval if not already approved exactly. After merge,
verify remote state. Keep the worktree and evidence until downstream recovery is no longer needed.
Do not delete a caller-owned worktree or branch without cleanup scope; remove an owned temporary
worktree before deleting its local branch, since Git will reject the reverse order.

### 4. (git-flow only) PR `integrationBranch`→`releaseBranch` — the release
Open the release PR only within publication scope and check its CI status. **Before the normal
release merge, obtain or reuse explicit approval for this release PR's reviewed head/base.** Approval
of the feature→integration merge does not authorize the second merge.

If CI cannot run, classify the failure from actual job output. Billing/quota failure is unavailable
verification, not green CI; recent similar PRs are supporting context only. Diagnose recoverable
invocation/environment problems first. A proposed bypass must identify remaining evidence and risks.

If the user explicitly approves a protection bypass, prepare an exact read-only backup of the current
settings and a concrete temporary-change/restoration plan before touching them. Preserve every field,
including review settings and `enforce_admins`. Use the repo's reviewed bypass procedure; do not run a
DELETE→merge→PUT chain that could leave protection disabled after an intermediate failure. Arrange
restoration for both success and failure, verify it remotely, and treat restoration failure as an
unresolved blocker. This skill does not grant bypass rights or infer them from previous releases.
The setup `branch-protect.sh` helper now defaults to plan-only and requires an approved saved plan/hash
for applying supported changes; it is not an implicit bypass tool. Never edit a plan to bypass its drift
check. Inspect an uncertain merge result before retrying or creating any replacement PR.

### 5. **Stop — confirm the production deploy**
When deployment is requested and the exact artifact/target is approved:
- **`deployHook` configured**: run it. It's expected to re-verify (build/test/whatever the consuming
  repo needs) before touching real infrastructure — this skill doesn't re-verify separately.
- **No `deployHook`**: this skill's job ends at the merged release. Tell the user the change is
  merged to `releaseBranch` and hand off — deploying is manual, outside this skill's scope.

### 6. Health check + cleanup
If deployment ran and produced a health endpoint, verify liveness. Report merge, deployment and
health evidence separately; a merged PR or successful command is not proof of a live deployment.
Clean up only owned temporary resources covered by the caller's scope and no longer needed for
recovery. Do not automatically sync or alter the shared main checkout. On macOS, if an owned temporary
worktree removal fails due to a demonstrated deny-delete ACL, `chmod -R -N <worktree-path>` may repair
that specific directory before retrying; never apply it broadly or use it to discard user work.

## On failure
- A tested RED gate, malformed/incomplete verdict, environment failure or failed external action
  blocks its dependent step. Diagnose and fix within scope. Never reclassify unavailable evidence as
  PASS; the separately approved step-4 bypass does not rewrite the test result.
- `gh pr merge` reporting out-of-date/CONFLICTING: in the worktree, `git fetch origin <base>` alone
  → `git rebase origin/<base>` alone → re-verify → `git push --force-with-lease` (don't chain these —
  run each as its own independent call; a chained merge/pull-adjacent command sequence is easy to
  mis-detect as something else). If this branch was itself the base of another still-open PR (stacked),
  retarget or rebase that PR onto the release branch before it merges too — squash-merging this one
  doesn't auto-retarget it, and its commits can land in a dead branch instead. Rewriting the PR head
  invalidates the old merge approval. Retargeting or force-pushing a shared/other author's branch needs
  matching authorization; prepare a proposal if that scope is absent. A confirmed no-effect retry with
  unchanged reviewed inputs can reuse approval; an unknown outcome must be inspected first.
