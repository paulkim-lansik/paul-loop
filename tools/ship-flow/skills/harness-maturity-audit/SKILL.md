---
name: harness-maturity-audit
description: Audits the maturity of a repo's self-improvement loop harness (verifier=ceiling, Inner/Outer/Meta loops, vector-backed loop memory, skill/tool usage) via six parallel forensic investigation lanes, producing an L0-L5 scorecard and a prioritized improvement list saved as a report. Use when the user asks for a "harness maturity audit", a "loop engineering checkup", a self-improvement loop audit, or wants a periodic checkup after a milestone/epic completes.
---

# harness-maturity-audit — six-lane parallel harness maturity audit

Measures whether this repo's self-improvement harness (an installed loop-engine plugin, any
vector-backed loop-memory package, `.claude/{skills,hooks}`, and wherever this repo keeps its
decision records and research) **actually works the way it claims to, not just how it reads on
paper.** The one method that makes an audit like this worth repeating — rather than a fresh
impression each time — is simple: **every claim that something "works" is checked by actually
running the command and observing its exit code/output. Never asserted from inference or
guesswork.**

## When to use this

- When a human asks for "a harness maturity audit" / "loop engineering checkup" / similar
- Right after a milestone or epic completes, as a periodic checkup
- **When NOT to use this**: for diagnosing one specific bug, use this repo's equivalent of a
  single-bug-diagnosis skill if it has one (e.g. `diagnose`); for extension/dependency
  maintenance checks use `deps-audit` if this repo has it installed; for a branch-freshness
  preflight, use this repo's equivalent check if it has one. This skill is a heavy audit across
  three axes of the harness as a whole — structure, operation, and self-improvement — not a
  narrow check.

## Methodology (non-negotiable — this is what makes repeated audits comparable)

- **Execution evidence only.** Investigation agents record as evidence only what they actually
  observed by reading a file (`Read`/grep) or running a command (`Bash`). Sentences like
  "this probably works" are not allowed.
- **L0-L5 rubric** (kept stable across runs so audits stay comparable):

  | Level | Meaning |
  |:---:|---|
  | L0 absent | never built |
  | L1 designed | documented only, no working code |
  | L2 built | code exists, verifiable in isolation |
  | L3 wired | integrated into a real loop — at least one path works end-to-end |
  | L4 proven | has closed the loop at least once on a real change (keystone) |
  | L5 self-improving | the Outer/Meta loop has actually promoted a lesson across runs and changed future behavior |

- **Report strengths too.** Don't just hunt for gaps — keep the "what's working well" section
  symmetric with the gap list, the way a fair audit report should read.
- **Honest delta.** Read the most recent prior audit report for this repo first (if one exists —
  check wherever this repo keeps durable research/audit docs, commonly named with "maturity",
  "audit", or "reassessment" in the filename) and explicitly state what changed since then.

## The six investigation dimensions

1. **Decision archive** — whether each decision record (e.g. this repo's ADRs, if it has an
   ADR-style archive) was actually implemented, whether any are left abandoned/on-hold, and any
   drift between a record and the current code.
2. **loop-engine code** — actually runs the installed loop-engine plugin's `bin/*` scripts
   (verdict-run, loop-fix, gate, eval-gate, lessons, etc.), invoked however this repo actually
   resolves and calls them, plus any wrapper scripts this repo maintains itself outside the
   plugin — and observes exit codes/output. Looks for violations of the "verifier = ceiling"
   principle (fake green, etc.).
3. **Operational data** — reads this repo's actual `.loop/lessons/*.json` (count, verified
   ratio, recurrence/promotion) and any other loop-state files it maintains, to confirm the
   harness has *actually run*, not just that it's wired up.
4. **Skill maturity** — enumerates this repo's skills, checks each SKILL.md for dangling links
   or references to commands/files that don't exist, and cross-checks against actual usage
   frequency data if this repo (or its tooling) tracks that.
5. **Vector-backed loop memory usage** — if this repo has a loop-memory-style package, greps its
   actual callers (hooks, bin scripts), checks DB connectivity, and measures real call paths for
   lesson recall/graduation. If no such package exists, says so and scores L0 rather than
   inventing one.
6. **Domain knowledge / tool usage** — whether this repo's domain docs (glossary, agent-facing
   docs) show up reflected in recent actual work (`git log`), and whether tools this repo's
   CLAUDE.md mandates (e.g. a specific issue tracker) are actually being used in practice rather
   than bypassed.

## Execution

**Calls the stored named workflow** — six parallel investigation lanes plus synthesis, with
resume support (a run that finishes investigation but drops before synthesis doesn't need to
restart from scratch):

```javascript
Workflow({ name: 'ship-flow:harness-audit' })
```

Use `resumeFromRunId` to continue an interrupted prior run (see the Workflow tool's own
description) — if investigation finished but synthesis was interrupted, resume on top of the
cached six-dimension results instead of rerunning everything.

## After the workflow returns — save the report + route follow-up

Once you have the workflow result (`reportBody`):

1. **Save it as a durable repo artifact.** If this repo has an established convention for where
   durable research/audit docs live (check its CLAUDE.md or an equivalent contributor doc), save
   it there, named for today's date and the audit subject (e.g.
   `<date>-loop-harness-maturity-audit.md`). If no such convention is apparent, ask the user
   where it should go rather than guessing — the point is that this is a repo artifact meant to
   be found again later, not scratch output. Put a title and a methodology footnote at the top
   of the file (link to the prior report if one was found, and note "actual command execution +
   N-agent parallel forensic investigation, not inference").  If a second run happens on the
   same day, the filename collides — ask the user whether to overwrite the first run's result or
   distinguish by timestamp; don't silently overwrite.
2. **Show the user the prioritized improvement list and ask what they want next**:
   - Leave it as a report for a human to review later
   - Continue straight into `to-issues` to turn blocker/major items into issues (the report
     content is already in context, so `to-issues` can pick it up without extra arguments)
3. If the user chooses `to-issues`, this skill hands off everything downstream (approval,
   publishing) to `to-issues` entirely — it doesn't publish anything itself.

## Discipline

- **Read-only.** The six investigation agents don't modify or commit files — they only produce
  judgment material.
- **Keep it comparable.** Use the same rubric (L0-L5) and the same severity vocabulary
  (blocker/major/minor) as prior reports so the delta is meaningful. Don't invent a new scale.
- **The honest delta is the point.** Finding a prior report and then ignoring it defeats this
  skill's reason for existing — repeatable comparison.
