---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# Grill With Docs

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Call `ship-flow:grilling` and `ship-flow:domain-modeling` with the same caller brief: mode, bounded
question, settled decisions, authorization, allowed documentation, and return condition. A delivery
caller uses grilling's caller mode; a user-requested interview uses interview mode.

The two run **together**, not in sequence: record confirmed decisions as they land within the allowed
documentation scope. Keep unresolved proposals marked as drafts; a read-only call returns proposed
wording instead of editing `CONTEXT.md` or an ADR. Reuse existing authorization for those edits.
Return once the caller's question is resolved. This discussion is not planner evidence: it does not
prove test seams, AC contracts, or implementation readiness without that checklist's actual review.
