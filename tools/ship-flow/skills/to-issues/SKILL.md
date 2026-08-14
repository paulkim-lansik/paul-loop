---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

## Tracker

This skill is tracker-agnostic — it targets whatever issue tracker this repo actually uses. Before
drafting anything, work out which one:

- Check `.claude/ship-flow.config.json` for a `trackerName` field (this plugin's `setup` skill records
  one during onboarding, if the repo has an external tracker).
- Check the repo for its own tracker-integration doc, if it has one — that's the source of truth for
  the exact conventions this repo expects (required fields, labels, project/team assignment, how
  dependency links work).
- If neither exists, ask the user which tracker this repo uses and how issues should be filed there
  before continuing. Don't guess.

The worked example throughout this skill (the issue-creation call, the `blockedBy` dependency link,
the `ENG-123`-style identifier) uses Linear, because that's what this skill was originally built and
proven against — it's illustrative, not the only tracker this applies to. Adapting it to GitHub Issues,
Jira, or anything else means substituting that tracker's own mechanics for title/description/labels and
for however it expresses "this issue is blocked by that one" (a native link where the tracker has one,
a body-text reference where it doesn't).

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary (e.g. a `CONTEXT.md`, if this repo has one), and respect any documented architecture decisions in the area you're touching (e.g. `docs/adr/`, if this repo has one).

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- Each slice is sized to fit in a single fresh context window
</vertical-slice-rules>

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own issue blocked by the expand, keeping the verify command green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in an issue blocked by every migrate batch.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to this repo's issue tracker. Check this repo's own tracker-integration doc, if it has one, for the exact conventions it expects (team/project routing, required fields) — apply this repo's own required labels/conventions, if any. Use the issue body template below.

These issues are considered ready for AFK agents — if this repo's tracker has a triage-state or label vocabulary for that, apply it here (check the tracker-integration doc if unsure which value to use) unless instructed otherwise.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

**Set the blocking edge as a native dependency link where the tracker supports one, not just body text.** The example below is Linear: after creating a blocking issue, create the blocked issue with `mcp__plugin_linear_linear__save_issue`'s `blockedBy` parameter (issue identifier, e.g. `ENG-123`) — this is append-only and shows up in Linear's UI as a real dependency, not prose someone has to keep in sync by hand. If this repo's tracker has no equivalent native link, the "Blocked by" section in the body is the only record of the dependency — keep it accurate. Keep that body section either way, for readability when skimming the issue alone.

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</issue-template>

Do NOT close or modify any parent issue.
