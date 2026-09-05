---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
context: fork
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

1. **See the current state** of the merge/rebase, current branch, source/target refs, conflicts, and
   existing staged/unstaged work. Reuse the caller's authorization and preserve unrelated changes.
   A review/proposal request returns proposed resolutions without applying or completing anything.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each authorized hunk.** Preserve both intents where possible. Where incompatible, use
   the stated goal and record the trade-off; do not invent behavior. If a reserved decision remains,
   return that blocker to the caller. A cancellation or incorrectly started operation is grounds to
   stop and plan safe recovery, not to force completion. Abort only when authorized and after checking
   that it will preserve pre-existing work; do not run destructive recovery blindly.

4. Discover the project's **automated checks** and run them — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Complete only the authorized working-branch operation.** Include only the resolved files in its
   staging/commit, preserving unrelated staged and unstaged work. If that separation is not safe,
   return the blocker rather than committing unrelated content. Continue an authorized rebase until
   its commits finish. Never complete a local merge onto a shared branch in place of human PR approval.
   Do not push or publish unless separately authorized. Return actual checks, resolved files, remaining
   conflicts, and operation status to the caller; finishing this helper does not end the caller's task.
