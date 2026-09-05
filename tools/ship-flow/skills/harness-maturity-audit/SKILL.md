---
name: harness-maturity-audit
description: Audits the maturity of a repo's self-improvement loop harness (verifier=ceiling, Inner/Outer/Meta loops, vector-backed loop memory, skill/tool usage) via six parallel forensic investigation lanes, producing an L0-L5 scorecard and a prioritized improvement list saved as a report. Use when the user asks for a "harness maturity audit", a "loop engineering checkup", a self-improvement loop audit, or wants a periodic checkup after a milestone/epic completes.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# harness-maturity-audit — six-lane parallel harness maturity audit

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Measures whether this repo's self-improvement harness (an installed loop-engine plugin, any
vector-backed loop-memory package, `.claude/{skills,hooks}`, and wherever this repo keeps its
decision records and research) **actually works the way it claims to, not just how it reads on
paper.** The one method that makes an audit like this worth repeating — rather than a fresh
impression each time — is simple: **every claim that something "works" is checked by actually
running a command within the investigation's scope and observing its exit code/output. Never asserted
from inference or guesswork.** Source inspection establishes only what the source says. Preserve the
audited resources and external systems; needed isolated disposable fixture tests, temporary reports
and browser/test caches are allowed unless the user forbids those writes. Direct their outputs away
from audited/live state. An explicit no-write-anywhere constraint prohibits even fixture/cache writes.
Do not call paid services, activate infrastructure or execute costly root gates without the
corresponding scope; record those runtime checks as not run.

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
  | L0 absent | applicable capability confirmed absent |
  | L1 designed | documented only, no working code |
  | L2 built | code exists, verifiable in isolation |
  | L3 wired | integrated into a real loop — at least one path works end-to-end |
  | L4 proven | has closed the loop at least once on a real change (keystone) |
  | L5 self-improving | the Outer/Meta loop has actually promoted a lesson across runs and changed future behavior |

- **Applicability and coverage precede scoring.** A provider repo need not contain consumer `.loop/`
  state. An optional, deliberately excluded capability is evidence-backed **N/A**, outside the numeric
  score; unknown/unavailable evidence is **INCOMPLETE**, not L0. L0 requires confirmed applicable
  absence. Missing or failed lanes stay visible and prevent an overall complete assessment.
- **Report strengths too.** Don't just hunt for gaps — keep the "what's working well" section
  symmetric with the gap list, the way a fair audit report should read.
- **Honest delta.** Read the most recent prior audit report for this repo first (if one exists —
  check wherever this repo keeps durable research/audit docs, commonly named with "maturity",
  "audit", or "reassessment" in the filename) and explicitly state what changed since then.

## The six investigation dimensions

1. **Decision archive** — whether each decision record (e.g. this repo's ADRs, if it has an
   ADR-style archive) was actually implemented, whether any are left abandoned/on-hold, and any
   drift between a record and the current code.
2. **loop-engine code** — safely inspects and, where authorized, runs the installed loop-engine plugin's `bin/*` scripts
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
   lesson recall/graduation without changing live memory state or activating it. Isolated disposable
   fixture evidence is allowed within investigation scope but is not proof of live usage. If the capability is deliberately optional
   or excluded by accepted ADRs, report N/A with evidence. Confirmed absence of an applicable required
   capability is L0; inaccessible DB evidence is INCOMPLETE, not proof of absence.
6. **Domain knowledge / tool usage** — whether this repo's domain docs (glossary, agent-facing
   docs) show up reflected in recent actual work (`git log`), and whether tools this repo's
   CLAUDE.md mandates (e.g. a specific issue tracker) are actually being used in practice rather
   than bypassed.

## Execution

**Preflight first, then investigate.** Read the latest prior audit and relevant accepted ADRs, identify
whether this checkout is a provider, consumer or mixed repo, and settle dimension applicability before
dispatching the six lanes. Pass the same prior context, role, exclusions, output language and allowed
commands to every lane, including the same disposable-fixture allowance or explicit all-writes ban.
Do not activate optional services to manufacture operational evidence.

Where the stored workflow is callable and delegation is authorized, invoke it with the resolved prose
language (`args.outputLanguage` is optional; absent means config/user-language fallback):

```javascript
Workflow({ name: 'ship-flow:harness-audit', args: { outputLanguage: 'ko' } })
```

Use the actual resolved language rather than copying `ko` regardless of the user. Use
`resumeFromRunId` according to the available Workflow tool schema to continue an interrupted run.
Reuse successful evidence only while its source revisions and scope still match. A missing Workflow
or a caller restriction on agents does not authorize installing tools or spawning agents: perform the
same bounded lanes directly, recording which checks could not be performed. If the caller assigned
only one lane, return that lane's evidence and coverage without claiming a complete six-lane audit.

## After the workflow returns — report + route follow-up

Inspect `status`, `coverage`, `findings`, `repositoryRole`, `priorReportPath`, `outputLanguage` and
`reportBody`, not just the existence of a body. Null/error/missing lanes remain INCOMPLETE; synthesis
cannot erase them. Retain observed evidence and resume only missing authorized work when possible.

1. **Save within scope.** For a report request permitting local artifacts, use the established audit
   directory or `docs/audits/` by default. Name it `<date>-loop-harness-maturity-audit.md`; on collision,
   choose a timestamp (and unique suffix if needed), never overwrite or ask a routine location question.
   When the audited repo must remain read-only, return the report in the conversation or a permitted
   isolated temporary report; do not write `docs/audits/` unless that artifact write is authorized.
   An explicit no-write-anywhere constraint means conversation output only. Needed isolated disposable
   fixtures remain allowed in ordinary read-only investigations. Ask only if the requested destination
   or publication exceeds scope. Include prior-report links and an honest
   methodology note: actual tools/commands used, skipped checks, and coverage; do not claim parallel
   execution or runtime proof if only source inspection happened.
2. **Return prioritized findings, strengths and limitations.** A report/draft endpoint is complete
   when the requested review material is returned; it does not authorize tracker publication. If the
   caller already requested the next bounded implementation or issue-drafting step, continue with its
   inherited scope instead of asking again. Missing evidence remains visibly incomplete.
3. If issue creation was explicitly authorized, pass concrete findings, destination and authorization
   to `ship-flow:to-issues`; otherwise provide follow-up proposals without publishing them.

## Discipline

- **Read-only audited resources.** The six investigators do not modify source/live state, commit or
  publish. They may use needed isolated disposable fixtures and temporary browser/test outputs within
  scope unless those writes are forbidden. An explicit no-write-anywhere instruction overrides this
  allowance. Record fixture evidence as isolated reproduction, not consumer operational history.
- **Keep it comparable.** Use the same rubric (L0-L5) and the same severity vocabulary
  (blocker/major/minor) as prior reports so the delta is meaningful. Don't invent a new scale.
- **The honest delta is the point.** Finding a prior report and then ignoring it defeats this
  skill's reason for existing — repeatable comparison.
