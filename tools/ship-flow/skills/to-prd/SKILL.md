---
name: to-prd
description: Turn the current conversation context into a PRD, create a dedicated project for it on this repo's issue tracker, and publish the PRD as a document under that project. Use when user wants to create a PRD from the current context.
---

# to-prd — publish a PRD from conversation context

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD (e.g. a root `CONTEXT.md`, if this repo keeps one), and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can.

Check with the user that these seams match their expectations.

3. **Create a new project for this PRD.** A PRD defines a distinct body of work, and that body of work
   gets its own grouping on the tracker — Linear's Project is the worked example; other trackers may
   call it an epic, a milestone, or something else.

   **Create it new. Do not file the PRD under an existing project because one happens to be there.**
   That is the failure this step exists to prevent: reusing whatever long-lived project the repo
   already has turns it into a catch-all whose name stops describing its contents, and the PRDs inside
   it lose any grouping of their own. If you find yourself reaching for an existing project, the
   question to ask is not "does a project exist?" but "is this PRD an amendment to *that specific*
   PRD's scope?" — and only a yes justifies reuse.

   Two legitimate exceptions, both narrow: the PRD genuinely amends an existing PRD's scope (then
   reuse that PRD's project), or this repo's tracker-integration doc explicitly pins PRDs somewhere.
   Anything else — create the project.

   Give the project a name that describes *this* body of work, a summary, and a description saying
   what is in and out of scope.

4. Write the PRD using the template below and publish it as a **document under the project created in
   step 3** (not as an issue) — Linear's Document feature is the worked example. If the tracker has no
   separate document concept, the closest equivalent (e.g. a pinned top-level issue) is fine.

   The PRD document doesn't need this repo's issue-workflow labels, if it uses them — those apply to
   issues, not documents. Any actionable label marking work ready to pick up belongs on the slice
   issues produced later by `to-issues`, which reference this PRD document as their source.

5. **Attach the supporting material to the project**, so the project is the one place someone lands to
   find everything about this body of work:
   - **Documents** for prose that lives in the tracker — research notes, design write-ups, decision
     records drafted during this conversation.
   - **Links** for artifacts that live outside it — ADRs and design docs in the repo, pull requests,
     published artifacts, dashboards, external specs. Where the tracker's link list is append-only
     (Linear's is), adding a link never removes an existing one.

   Only attach what already exists. Don't invent artifacts to fill the list, and don't block on
   material that hasn't been produced yet — `to-issues` and the implementation runs will add more
   links as they go.

6. **Report the project identifier** in your final message, alongside the PRD document reference.
   `to-issues` needs it: the slice issues it creates must land in this same project, and it has no way
   to recover the identifier if you don't hand it over.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

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
