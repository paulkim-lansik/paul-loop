---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea until you reach shared understanding. Use when the user wants to stress-test their thinking, uses any "grill" trigger phrase, or when another skill needs the interview loop.
---

# Grilling

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Interview the user relentlessly until you reach a shared understanding. Map the plan as a **design
tree**: every decision branches into the decisions that hang off it.

## Ask one question at a time

The **frontier** is every decision whose prerequisites are already settled — the questions you can ask
*now* without guessing at answers you haven't heard yet. Use the frontier to decide **which** question
comes next, never to decide **how many** to ask.

**Ask one. Wait for the answer. Then recompute the frontier and ask the next one.**

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

Dispatch a sub-agent for anything that takes more than a glance, and **don't block on it**: a running
exploration is just an unsettled prerequisite, so only the questions downstream of it wait. Ask the
next question that doesn't depend on it while the sub-agent works.

The *decisions* are the user's. The *facts* are yours.

## When you're done

The session is done when the frontier is empty: every branch of the design tree visited, nothing left
silently assumed. **Do not act on the plan until the user confirms you've reached shared understanding**
— agreement on the last question is not agreement on the whole.

If the session produced decisions worth keeping, that's the point where they get recorded, not before.
Call the Skill tool with "domain-modeling" when a term needs sharpening in `CONTEXT.md` or a decision
has earned an ADR.
