---
name: wait-what
description: "Stop. That last message did not land: re-pitch it."
disable-model-invocation: true
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# Wait, What

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Wait, I don't understand where you've got to here. Re-pitch that: give me a little bit of context, talk
in the configured output language using short sentences and defined terms (the clarity principles
of ASD-STE100, not a switch to English), and use the ubiquitous language from `CONTEXT.md` (follow
`CONTEXT-MAP.md` to the right one if the repo has more than one).

Re-pitching is not repeating more slowly. Find the step that was skipped — the term used before it was
defined, the conclusion stated before its premise, the acronym never expanded — and start from there.
