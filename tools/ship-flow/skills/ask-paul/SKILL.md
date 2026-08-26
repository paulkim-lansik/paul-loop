---
name: ask-paul
description: Ask which skill or flow fits your situation. A router over the skills this plugin ships.
disable-model-invocation: true
---

# Ask Paul

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

You don't remember every skill, so ask.

A **flow** is a path through the skills. Most work runs along one **main flow**; a few situations are
on-ramps onto it, and a few skills sit underneath as vocabulary rather than process.

**Scope, stated up front:** this routes over what *this plugin* ships. A consuming repo may install its
own skills alongside — those are its to document, and this map won't know about them.

## The main flow: one entrypoint

**`ship-flow:ship-feature` is the single entrypoint**, and that is a deliberate constraint, not an
omission. It takes one unit of work from plan to an open PR and — after a human merges — on to a
harness-improvement PR, stopping at exactly three places: the merge boundary, any step the risk gate
classifies as REQUIRE, and a genuine judgment call. Adding a second entrypoint is how a loop grows two
disagreeing procedures, so don't reach past it for ordinary feature work.

It drives the others internally, which is why most of this map is *what it calls*, not *what you call*:

1. **Plan.** `ship-flow:grill-with-docs` when there's a real design decision to settle (it leaves a
   paper trail in `CONTEXT.md` and ADRs); the `planner` agent validates the plan before any code exists,
   fail-closed on acceptance criteria that no machine could check.
2. **Build.** `ship-flow:tdd`, red→green, one behaviour at a time.
3. **Verify.** The repo's own verify command wrapped in the verdict contract — the verifier is the
   ceiling, never the agent's self-report.
4. **Review.** `code-reviewer`, `test-hunter`, and `verifier-integrity-hunter` agents, the last of which
   exists to catch the run grading its own homework.
5. **Publish.** The `publisher` agent runs pre-assembled commands. A human merges.
6. **Learn.** `ship-flow:retrospect` records only what the verifier confirmed.

**Bigger than one unit of work?** `ship-flow:to-prd` turns the conversation into a PRD on the tracker,
then `ship-flow:to-issues` splits it into tracer-bullet issues with blocking edges. Each issue then
re-enters `ship-flow:ship-feature` from the top, with a clear context.

## On-ramps

- **Something's broken** → `ship-flow:diagnosing-bugs`. For the hard ones: the bug that resists a first
  glance, the intermittent flake, the regression between two known-good states. It refuses to theorise
  until it has a tight feedback loop that already goes red on *this* bug.
- **A release needs to go out, or a fix has to jump the queue** → `ship-flow:hotfix`, which knows the
  two-stage branch model and where the human stop points are.

## Codebase and harness health

Not feature work — upkeep. Each of these *generates* work you then take into the main flow.

- `ship-flow:improve-codebase-architecture` surfaces **deepening opportunities**: shallow modules worth
  turning deep. It's the survey; `ship-flow:codebase-design` is the bench you design the chosen one on.
- `ship-flow:deps-audit` checks whether installed skills and plugins have drifted from upstream, gone
  unused, or quietly gone stale.
- `ship-flow:harness-maturity-audit` asks the harder question: is the loop itself getting better, or
  just busier.

## Vocabulary underneath

Reach for these directly when the **words**, not the process, are the problem — or let the skills above
pull them in.

- `ship-flow:domain-modeling` sharpens the project's *domain* language: challenge a fuzzy term, resolve
  an overloaded word, record a hard-to-reverse decision as an ADR. It's what keeps `CONTEXT.md` a
  glossary and not a scratch pad.
- `ship-flow:codebase-design` is the deep-module vocabulary — module, interface, depth, seam, adapter,
  leverage, locality — for designing a module's *shape*.
- `ship-flow:grilling` is the interview primitive: the design tree, one question at a time, facts are
  the agent's job and decisions are yours. `ship-flow:grill-with-docs` is the named way in that also
  keeps the docs current; reach for the primitive directly only when you want the interview bare.

## Standalone

- `ship-flow:resolving-merge-conflicts` works an in-progress merge or rebase hunk by hunk, resolving by
  **intent** traced to each side's primary source rather than by picking lines. Reach for it when you're
  already mid-conflict.
- `ship-flow:to-questionnaire` is for when the thing blocking you is in **someone else's** head. It
  interviews you about the *send* — who it goes to, what you need back — and aims the questions at the
  gap. What comes back is material for `ship-flow:grill-with-docs`.
- `ship-flow:wizard` is for steps only a **human** can take: provisioning, credentials, CI secrets, an
  unfamiliar third-party dashboard, a one-off cutover. It generates a bash script that opens each URL
  and captures each value, so the procedure stops being something you re-explain every time. If the
  agent could just do it, it should.
- `ship-flow:wait-what` is the corrective for a message that didn't land. Use it mid-conversation,
  inside any other skill, and the agent re-pitches with the step it skipped.

## Precondition

`ship-flow:setup` runs once in a consuming repo, before the first flow. It interviews for the tracker,
branch model, verify command, and `pluginBinPrefix`, and writes `.claude/ship-flow.config.json` — the
file every other skill reads instead of hardcoding one repo's setup. Skip it and the substitutions the
other skills perform have nothing to substitute.
