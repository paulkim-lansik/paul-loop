---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea until you reach shared understanding. Use when the user wants to stress-test their thinking, uses any "grill" trigger phrase, or when another skill needs the interview loop.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# Grilling

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Choose the mode from the request and caller brief:

- **Interview mode:** the user explicitly asked to be grilled. Map the agreed topic as a **design
  tree**, asking about unresolved decisions within that topic.
- **Caller mode:** another workflow needs a decision resolved. Use its scope, settled answers,
  authorization, and return condition. Resolve only the named open decisions; reversible choices
  with a defensible recommendation are recorded without another approval. Return to the caller
  when those decisions are resolved or a specific human decision is missing. Do not interview every
  adjacent branch or turn an implementation task into an open-ended design session.

## Ask one question at a time

The **frontier** is every decision whose prerequisites are already settled — the questions you can ask
*now* without guessing at answers you haven't heard yet. Use the frontier to decide **which** question
comes next, never to decide **how many** to ask.

**For a question that genuinely needs the user: ask one, wait for its answer, then recompute the
frontier.** Reuse answers already in context. In caller mode, return the question to the caller if
the delegated runtime cannot communicate with the user; continue independent authorized work.

A batch of numbered questions looks efficient and isn't: the user answers the first two carefully and
the rest thinly, and any question whose framing depended on an earlier answer was framed wrong. One
answer usually reshapes the tree — settled decisions push the frontier outward and unblock questions
that were not askable a moment ago. You cannot see that reshaping if you have already asked.

Give your **recommended answer** with every question. A question with no recommendation makes the user
do the work twice; if you genuinely have no recommendation, say why — that itself is the finding.

A question whose answer depends on another still-open question belongs *later*, not now.

## Finding facts is your job, never the user's

When a question needs a fact from the environment — the filesystem, the codebase, a tool, a live
service — go and get it. Don't ask the user anything you could look it up yourself, and don't present a
guess for confirmation when a check would settle it.

Use a sub-agent when available and permitted for bounded exploration; otherwise investigate directly.
A running exploration is an unsettled prerequisite, so only its dependent decisions wait.

Reserved product and irreversible decisions are the user's. Routine choices already delegated to
the agent stay delegated. Finding facts is the agent's job.

## When you're done

Interview mode ends when the scoped decisions are resolved or explicitly deferred. Summarize them;
ask for overall confirmation only if it has not already been given and is needed for the requested
next action. Finishing an interview does not itself authorize implementation or publication.

Caller mode ends at its return condition, not at every branch of a larger design tree. Return the
decision, alternatives, rationale, remaining unknowns, and evidence so the caller can continue.

Document confirmed decisions as they land only when documentation is authorized (for example, via
grill-with-docs). Mark unresolved proposals as drafts. A bare interview does not write files. Use
`ship-flow:domain-modeling` for authorized glossary/ADR work; it does not add a new approval round.
