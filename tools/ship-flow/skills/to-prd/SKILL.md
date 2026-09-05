---
name: to-prd
description: Turn the current conversation context into a reviewable PRD; publish to the specified tracker destination only when requested. Use when user wants to create a PRD from the current context.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# to-prd — draft a PRD from conversation context

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD (e.g. a root `CONTEXT.md`, if this repo keeps one), and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can.

Reuse accepted seams and tests from the caller's plan. Choose routine reversible details; mark
unresolved product decisions as proposed. Ask only for a decision needed to complete the requested PRD.

3. **Draft the complete PRD first**, using the template below. A request to create/write a PRD normally
   ends with a local artifact or conversation draft according to scope. It does not imply creating a
   tracker project, publishing a document, attaching private conversation material or implementing it.

4. **Resolve publication scope, when requested.** Honor the user's destination and existing project
   first, then the tracker integration doc. Propose a new project only when this body of work needs a
   distinct grouping; creating it requires that action to be authorized. A draft can be completed while
   the destination is unknown. Reuse an exact existing publication approval rather than re-interviewing.

5. Publish only the authorized PRD content to the authorized project, as a document or the tracker's
   supported equivalent. Attach only explicitly included existing supporting artifacts/links. Publishing
   the PRD does not authorize uploading all research, decision records or conversation notes. Issue
   workflow labels belong on later slice issues, not automatically on this document.

6. Confirm each requested external operation. Return the actual project identifier and document
   reference for `ship-flow:to-issues` if published; otherwise label the PRD draft. If project creation
   succeeds but the document fails, report partial completion and recover only the missing operation.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A numbered list of user stories covering the agreed scope. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

Cover the agreed feature and necessary edge cases without inventing adjacent scope.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
