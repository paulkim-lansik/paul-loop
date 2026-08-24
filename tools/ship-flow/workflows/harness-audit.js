// harness-audit — six-lane parallel forensic audit of this repo's self-improvement harness.
// Kept as a named workflow (rather than an inline script pasted into a skill) so a run that
// finishes the investigate phase but gets interrupted before synthesis can be resumed instead
// of re-run from scratch. The wrapping skill (harness-maturity-audit) is a thin caller: it
// invokes Workflow({ name: 'ship-flow:harness-audit' }) and owns saving the report and any
// follow-up hand-off (e.g. to an issue-creation skill) once this workflow returns.
//
// On the name: `meta.name` below is the BARE name; the INVOCATION name is plugin-namespaced.
// Claude Code namespaces plugin-provided workflows as `<plugin-name>:<meta.name>` (docs:
// code.claude.com/docs/en/workflows.md — "Plugin workflows are namespaced by the plugin name"),
// which is also what first-party plugins do: the official claude-security plugin declares
// `meta.name: "scan"` in workflows/scan.js and its skill invokes `Workflow({ name:
// "claude-security:scan" })`. So the two are SUPPOSED to differ — do not "fix" this by
// prefixing `meta.name`. (An alternative invocation form exists, `Workflow({ scriptPath:
// "${CLAUDE_PLUGIN_ROOT}/workflows/<file>.js" })`, used by the official code-modernization
// plugin; it bypasses name resolution entirely and is not what this plugin uses.)

export const meta = {
  name: 'harness-audit',
  description:
    "Six-lane parallel forensic audit of this repo's self-improvement loop harness — evidence-only, produces an L0-L5 scorecard",
  phases: [
    { title: 'Investigate', detail: 'Six dimensions, each measured by a parallel agent' },
    { title: 'Synthesize', detail: 'Scorecard + priority improvement list + delta vs. the prior report' },
  ],
}

const METHOD = `You are a forensic investigator for this repo's self-improvement harness.
Absolute rules:
(1) Any claim that something "works" must be backed by actually running a command (Bash) or
    actually reading a file (Read/grep) and observing the result — never assert it from
    inference or guesswork without having run or read it.
(2) Record the command you ran and what you observed (exit code, an excerpt of the output,
    file path/line number) as evidence.
(3) Score using this rubric — L0 absent (never built) / L1 designed (documented only, no
    working code) / L2 built (code exists, verifiable in isolation) / L3 wired (integrated
    into a real loop, at least one path works end-to-end) / L4 proven (has actually closed the
    loop on a real change) / L5 self-improving (lessons across runs have been promoted and have
    actually changed future behavior).
(4) Don't just hunt for gaps — report strengths too.
(5) This investigation is read-only — do not modify or commit any file.`

const DIMENSIONS = [
  {
    key: 'decision-archive',
    title: 'Decision archive',
    prompt: `${METHOD}

Dimension: decision archive. First check whether this repo actually has a decision-record
archive — commonly a docs/adr/ directory, but check for whatever equivalent convention this
repo documents (its CLAUDE.md or an analogous convention doc should mention it if one exists).
If no such archive exists, say so plainly, score this dimension L0, and explain in one line
that there is nothing to audit here — do not invent a convention that isn't there. If an
archive does exist, cross-check each decision record against git log and the current code to
see whether it was actually implemented. Find records left in a proposed/superseded/on-hold
state, and any drift between what a record says and what the code actually does.`,
  },
  {
    key: 'loop-engine',
    title: 'loop-engine code',
    prompt: `${METHOD}

Dimension: loop-engine code. Actually run the loop-engine@paul-loop plugin's bin/* scripts
(verdict-run, loop-fix, gate, eval-gate, lessons, etc.) — invoke them however this repo actually
resolves and calls the installed plugin's bin scripts (look for a local resolver/wrapper script
first; if there isn't one, invoke the plugin cache path directly), plus any wrapper script this
repo maintains itself outside the plugin (e.g. a loop-doctor-style helper, if this repo has one)
— synthetic fixtures are fine — and observe exit codes and output. Look for violations of the
"verifier = ceiling" principle (e.g. a gate reporting PASS with zero tests actually run — fake
green).`,
  },
  {
    key: 'loop-ops-data',
    title: '.loop operational data',
    prompt: `${METHOD}

Dimension: .loop operational data. Read the actual files — .loop/lessons/*.json (count,
verified ratio, whether any have recurred or been promoted), .loop/deps-audit.last,
.loop/looping, and similar — to confirm the harness has actually been run repeatedly in real
use, not just demonstrated once ad hoc.`,
  },
  {
    key: 'skills',
    title: 'Skill maturity',
    prompt: `${METHOD}

Dimension: skill maturity. List .claude/skills/* and read each SKILL.md looking for dangling
links and references to commands or files that don't actually exist. Cross-check against
skillUsage in ~/.claude.json (if it's readable) for how often each is actually used.`,
  },
  {
    key: 'pgvector',
    title: 'pgvector (loop-memory) usage',
    prompt: `${METHOD}

Dimension: pgvector (loop-memory) usage. Grep for the actual callers (hooks, bin scripts) of
the loop-memory package's code — it typically lives at packages/loop-memory in a repo that has
installed it. Check DB connectivity using whichever check is cheaper to run — a loop:doctor-style
helper, or whatever DB-connectivity check script this repo defines for it, if any (look for a
script name containing "memory" or "pgvector"; don't assume it's named verify:memory) — and trace
the actual call path of graduateLessons / recallLessons.`,
  },
  {
    key: 'domain-tooling',
    title: 'Domain knowledge / tool usage',
    prompt: `${METHOD}

Dimension: domain knowledge / tool usage. Check whether this repo's own domain-knowledge docs —
if any exist (a glossary, architecture notes, tracker-integration notes, whatever this repo
actually has) — show up as being actually used in recent work (check the last 20-30 commits via
git log). Also check whether an external issue tracker this repo's own CLAUDE.md documents (if
any) is the one actually being used in practice (e.g. commit messages referencing tracker IDs),
versus a fallback like bare GitHub issues with no real tracker integration. Discover what this
repo's conventions actually are rather than assuming any particular file name or tracker.`,
  },
]

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    dimension: { type: 'string' },
    level: { type: 'string', enum: ['L0', 'L1', 'L1.5', 'L2', 'L2.5', 'L3', 'L3.5', 'L4', 'L5'] },
    oneLine: { type: 'string', description: 'One-line assessment' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          observation: { type: 'string' },
        },
        required: ['observation'],
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          description: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
  },
  required: ['dimension', 'level', 'oneLine', 'evidence', 'strengths', 'gaps'],
}

phase('Investigate')
const findings = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `audit:${d.key}`, phase: 'Investigate', schema: RESULT_SCHEMA })
)

phase('Synthesize')
const priorPath = await agent(
  `Look for a report from a previous run of this same audit. Check this repo's documentation
   directories (docs/, docs/research/, docs/audits/, or wherever this repo's own conventions
   put this kind of report — check its CLAUDE.md or an equivalent convention doc if one exists)
   for a file whose name contains "harness", "maturity", "audit", or "reassessment", typically
   prefixed with a YYYY-MM-DD date. If more than one matches, return the most recent by date. If
   none exists, return an empty string.`,
  { phase: 'Synthesize', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
)

const synthesis = await agent(
  `Below is the evidence-based investigation output for all six dimensions of this repo's
self-improvement harness (JSON):

${JSON.stringify(findings.filter(Boolean))}

Most recent prior audit report path: ${priorPath?.path || '(none)'}

If a prior report exists, read it and honestly state what changed versus this run — no
exaggerating, no downplaying. Write a synthesized markdown report body (body only, no title)
covering:
1. A one-line TL;DR
2. A six-dimension scorecard table (dimension | level | one-line assessment)
3. Delta versus the prior report (omit this section if no prior report was found)
4. A priority improvement list, gaps ordered by severity (blocker/major/minor) — give each item
   a "why"
5. Strengths worth keeping
6. Appendix: a summary of each dimension's raw evidence

Write the report in English. Don't include unsupported claims — nothing that isn't backed by
evidence.`,
  { phase: 'Synthesize', label: 'synthesize-report' }
)

return { findings: findings.filter(Boolean), priorReportPath: priorPath?.path || null, reportBody: synthesis }
