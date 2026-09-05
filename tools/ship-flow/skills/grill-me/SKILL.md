---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when the user wants to stress-test a plan, get grilled on their design, or says "grill me".
disable-model-invocation: true
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# Grill me

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Call the Skill tool with "grilling".

This is the bare interview, with nothing recorded at the end — the trigger phrase, kept separate from the
engine so `grilling` stays callable by other skills without owning a user-facing name. When decisions
worth keeping come out of it, `grill-with-docs` is the one that writes them down.
