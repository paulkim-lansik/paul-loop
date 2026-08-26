---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

# Grill With Docs

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Call the Skill tool twice, for "grilling" and "domain-modeling".

The two run **together**, not in sequence: the interview supplies the decisions, and the domain model
absorbs them **as they land** — a term sharpened mid-question goes into `CONTEXT.md` right there, and a
decision that clears the ADR bar is offered right there. Batching the documentation to the end of the
session is what loses it; by then the reasoning that justified the wording is gone.
