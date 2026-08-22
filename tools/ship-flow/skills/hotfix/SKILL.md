---
name: hotfix
description: Land an already-implemented, already-verified small fix through this repo's real gates (worktree isolation → verify → PR→integration → PR→release → deploy), stopping for human confirmation at the merge and deploy checkpoints. Use when the user wants to ship/merge/release a change that's already coded and verified (not a new feature to build — that's ship-feature), or asks to land/deploy a fix that just needs to reach production safely.
---

# hotfix — land an already-finished fix safely

**Precondition: the code is already written and verified.** Planning, TDD, and runtime verification
aren't this skill's job (that's `ship-feature`). This skill's only job: move the change through this
repo's real gates — worktree isolation → verify → merge → release → deploy — without skipping any
of them, and stop for real at the points a human needs to see.

## Config

Reads `.claude/ship-flow.config.json` at the consuming repo's root (written by the ship-flow setup
skill). If it doesn't exist yet, ask the user for `branchModel` before proceeding — don't guess.

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

1. **Before merging into `integrationBranch`** (git-flow) or **`releaseBranch`** (trunk-based) —
   `AskUserQuestion`. Confirm every time, even if the user already said "ship it" broadly.
2. **Only if CI is blocked and branch protection needs a bypass** — `AskUserQuestion`. A past
   approval isn't approval for this one — re-confirm every time, precedent or not.
3. **Right before an actual production deploy** — `AskUserQuestion`, separate from the merge
   confirmation. This is a materially larger blast radius (live infra, possibly a DB migration) than
   a merge.

## Sequence

### 0. Worktree isolation
The main worktree's HEAD is always `integrationBranch` (git-flow) or `releaseBranch`
(trunk-based) — never touch it directly. Rescue any uncommitted changes there first if present (a
common mistake):
```bash
git stash push -u -m "<description>" -- <changed files...>
git worktree add -b <type>/<slug> <sibling-path-outside-repo> origin/<integrationBranch-or-releaseBranch>
cd <worktree> && git stash apply stash@{0}
# once confirmed applied: (from the main worktree) git stash drop stash@{0}
```
No pending changes: just `git fetch origin && git worktree add -b <branch> <path> origin/<base>`.

### 1. Verify
A fresh worktree has no installed dependencies — install them first. Then the project's verify
command is the **ceiling** — don't move on until it's green (self-judgement never substitutes for
it). Run it wrapped, always, never raw: `<however this repo invokes its installed loop-engine plugin's
bin scripts> verdict-run.sh -- <verifyCommand>` (BAC-745) — safe even if `verifyCommand` already emits
its own verdict-contract block, since `verdict-run.sh` passes an existing `=== VERDICT ===` block
through unchanged instead of double-wrapping it. Read the gate off the printed `VERDICT:`/`EXIT:` lines
— that's what feeds this repo's verdict state file and ledger, a bare exit code doesn't.

### 2. Commit → PR→`integrationBranch` (or `releaseBranch` if trunk-based)
Commit in the repo's convention (e.g. `fix(scope): description`) → push → open the PR.

### 3. **Stop — confirm the merge**
Once confirmed: merge + delete the branch → remove the worktree (remove the worktree *before*
deleting the branch — the reverse order errors with "used by worktree").

### 4. (git-flow only) PR `integrationBranch`→`releaseBranch` — the release
Open the release PR, check its CI status.

**If CI is blocked by a billing/quota failure** (the job fails within a few seconds without really
starting — not a real code failure): cross-check recent release PRs on the same branch for the same
pattern, as supporting evidence. Even so, **stop — confirm the bypass**. Once confirmed:
```bash
# 1) back up the current protection config first (needed for an accurate restore)
gh api repos/<owner>/<repo>/branches/<releaseBranch>/protection > /tmp/protection-backup.json
# 2) drop the required check → merge → restore (PUT, not PATCH — PATCH 404s after a DELETE)
gh api -X DELETE repos/<owner>/<repo>/branches/<releaseBranch>/protection/required_status_checks
gh pr merge <n> --merge
gh api -X PUT repos/<owner>/<repo>/branches/<releaseBranch>/protection --input <restore body built from the backed-up JSON>
```
Restore every field from the backup exactly — `enforce_admins`, review settings, everything. Missing
even one leaves protection weakened.

### 5. **Stop — confirm the production deploy**
Once confirmed:
- **`deployHook` configured**: run it. It's expected to re-verify (build/test/whatever the consuming
  repo needs) before touching real infrastructure — this skill doesn't re-verify separately.
- **No `deployHook`**: this skill's job ends at the merged release. Tell the user the change is
  merged to `releaseBranch` and hand off — deploying is manual, outside this skill's scope.

### 6. Health check + cleanup
If the deploy hook produced a way to confirm liveness (e.g. a health endpoint), check it. Clean up:
remove the deploy worktree if one was created, delete temp logs, sync the main worktree's local
branch with `origin/<integrationBranch-or-releaseBranch>` (a remote PR merge may have left it
behind).

## On failure
- Any RED gate: report to the user and investigate the root cause — don't force the next step (the
  CI-billing bypass in step 4 is the one and only sanctioned workaround; anything else is a real
  failure).
- `gh pr merge` reporting out-of-date/CONFLICTING: in the worktree, `git fetch origin <base>` alone
  → `git rebase origin/<base>` alone → re-verify → `git push --force-with-lease` (don't chain these —
  run each as its own independent call; a chained merge/pull-adjacent command sequence is easy to
  mis-detect as something else).
