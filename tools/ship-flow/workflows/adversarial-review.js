// adversarial-review — three-stage pipeline: finder → skeptical verifier (aims to refute) → completeness critic.
//
// pipeline() returns only its last stage's result — a documented, intentional part of its contract,
// not a bug. That means a naive pipeline(domains, finder, verifier) spanning all domains would hand
// the completeness critic only the verifier's output and silently drop the finder's raw findings.
// This workflow avoids that footgun by keeping each domain's find→verify chain inside its own
// pipeline lane (no cross-domain barrier), and nesting verification per finding inside parallel() so
// each finding's original content is carried forward alongside its verdict rather than replaced by it.
//
// Votes on a finding can come back null (skipped, or an agent/API error) — those don't count as
// refutations. The tally below distinguishes three outcomes: a finding that survives verification,
// one that's genuinely refuted by valid votes, and one that's merely unverified because too few
// votes came back cleanly (an infrastructure failure isn't read as a refutation).
//
// args (all required — domains are task-specific, this workflow does not guess a default set):
//   { target: '<what is being reviewed — one sentence>',
//     domains: [{ key: '<slug>', prompt: '<what to look for in this domain>' }, ...] }

export const meta = {
  name: 'adversarial-review',
  description: 'Three-stage adversarial review — finder → skeptical verifier → completeness critic. Parallel per-domain discovery, per-finding majority-vote refutation, coverage-gap critique.',
  phases: [
    { title: 'Find', detail: 'Parallel finders, one per domain' },
    { title: 'Verify', detail: 'Per-finding skeptical verification (aims to refute, majority vote)' },
    { title: 'Completeness', detail: 'What was covered vs. what was missed' },
  ],
}

const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

if (!parsedArgs?.target || !Array.isArray(parsedArgs?.domains) || parsedArgs.domains.length === 0) {
  throw new Error(
    'adversarial-review requires args = { target: "<what is being reviewed>", domains: [{key, prompt}, ...] } — domains are task-specific, this workflow does not guess a default set.'
  )
}

const FINDER_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: 'string' },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true means this verifier judged the finding does not actually hold' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

const VOTES_PER_FINDING = 3
const REFUTATIONS_REQUIRED = 2

phase('Find')
const perDomain = await pipeline(
  parsedArgs.domains,
  d =>
    agent(
      `Target: ${parsedArgs.target}\n\nDomain: ${d.key}\n${d.prompt}\n\nOnly record something as a finding if you actually observed it by reading a file or running a command — don't assert from inference. This investigation is read-only.`,
      { label: `find:${d.key}`, phase: 'Find', schema: FINDER_SCHEMA }
    ).then((r) => (r?.findings ?? []).map((f) => ({ ...f, domain: d.key }))),
  (domainFindings) =>
    parallel(
      domainFindings.map((f) => () =>
        parallel(
          Array.from({ length: VOTES_PER_FINDING }, () => () =>
            agent(
              `Try to refute this finding (default to refuted=true if uncertain): "${f.title}" — ${f.detail}${f.file ? ` (${f.file})` : ''}\n\nTarget: ${parsedArgs.target}. Actually check it (Read/Bash) before judging.`,
              { label: `verify:${f.domain}:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA }
            )
          )
        ).then((votes) => {
          // A vote can be null (skipped, or an agent/API error) — that does not count as a refutation.
          // Three outcomes, matching the deep-research workflow's own convention:
          //   survives   — valid votes >= REFUTATIONS_REQUIRED and refuting votes below that
          //   isRefuted  — refuting votes >= REFUTATIONS_REQUIRED (genuinely refuted on the merits)
          //   otherwise  — unverified: too few valid votes (most verifier agents errored) — an
          //                infrastructure failure is not read as a refutation
          const valid = votes.filter(Boolean)
          const refutedVotes = valid.filter((v) => v.refuted).length
          const survives = valid.length >= REFUTATIONS_REQUIRED && refutedVotes < REFUTATIONS_REQUIRED
          const isRefuted = refutedVotes >= REFUTATIONS_REQUIRED
          return { ...f, survives, isRefuted, refutations: valid }
        })
      )
    )
)

const allFindings = perDomain.flat().filter(Boolean)
const confirmed = allFindings.filter((f) => f.survives)
const refuted = allFindings.filter((f) => f.isRefuted)
const unverified = allFindings.filter((f) => !f.survives && !f.isRefuted)
log(
  `${allFindings.length} findings — ${confirmed.length} confirmed, ${refuted.length} refuted, ${unverified.length} unverified (infra failure)`
)

phase('Completeness')
const completeness = await agent(
  `Below is the result of an adversarial review of "${parsedArgs.target}" (${parsedArgs.domains.length} domains, ${confirmed.length} findings that survived majority-vote verification):

${JSON.stringify(confirmed.map(({ title, detail, file, domain }) => ({ title, detail, file, domain })))}

Domains covered: ${parsedArgs.domains.map((d) => d.key).join(', ')}

Critique what's missing — domains/angles not covered, claims that went unverified, sources not read.
Propose concretely what the next round should look at — no generic advice, be specific to this target.`,
  { phase: 'Completeness', label: 'completeness-critic' }
)

return { target: parsedArgs.target, confirmed, refuted, unverified, completeness }
