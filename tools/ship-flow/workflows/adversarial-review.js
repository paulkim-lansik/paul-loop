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
// Verification fan-out is BOUNDED. Total agents = domains + VOTES_PER_FINDING x verified-findings + 1,
// and the finder's `findings` array had no cap — a finder that returns 20 findings across 6 domains
// spawns 360 verifier agents from a script whose own authoring guidance caps workflows far below
// that. The bound here is per-domain and severity-ordered (blocker first), so what gets verified is
// the part most worth spending votes on. Nothing is DISCARDED: findings past the cap are returned as
// `unverifiedOverCap` and the drop is log()'d — the authoring reference's "no silent caps" rule,
// because a truncated review that looks complete is worse than one that says what it skipped.
//
// Note on what is deliberately NOT done here: the refutation votes are not routed to a cheaper model
// or a lower effort tier. They are the verifier, and this plugin's whole premise is that the verifier
// is the ceiling — a cheaper skeptic is exactly how a plausible-but-wrong finding survives. Bound the
// QUANTITY of verification, never its quality.
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
          // severity drives WHICH findings get the verification budget when a domain overflows the
          // cap. Required so the ordering is the finder's judgement rather than array order, which
          // carries no meaning. An unrecognised/missing value sorts last (see SEVERITY_RANK).
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
        required: ['title', 'detail', 'severity'],
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
// Per-domain cap on how many findings get the (VOTES_PER_FINDING-agent) verification treatment.
// Per-domain rather than global so one noisy domain cannot starve every other domain's findings.
// Overridable via args.maxVerifiedPerDomain for a deliberately exhaustive run.
const DEFAULT_MAX_VERIFIED_PER_DOMAIN = 8
const maxVerifiedPerDomain = Number.isInteger(parsedArgs.maxVerifiedPerDomain)
  && parsedArgs.maxVerifiedPerDomain > 0
  ? parsedArgs.maxVerifiedPerDomain
  : DEFAULT_MAX_VERIFIED_PER_DOMAIN
// Unknown/missing severity sorts last — a finder that ignores the enum loses priority, it does not
// silently jump the queue ahead of a declared blocker.
const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2 }
const severityRank = (f) => SEVERITY_RANK[f?.severity] ?? 3

// Everything a domain found that the cap kept out of verification. Returned to the caller so a
// truncated review can never read as an exhaustive one.
const unverifiedOverCap = []

// Stable severity ordering + hard slice. The schema's enum is a REQUEST to the model; this slice is
// the enforcement — the same generator-vs-verifier split the rest of this plugin runs on.
function capForVerification(findings, domainKey) {
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityRank(a.f) - severityRank(b.f) || a.i - b.i)
    .map((x) => x.f)
  if (ordered.length <= maxVerifiedPerDomain) return ordered
  const kept = ordered.slice(0, maxVerifiedPerDomain)
  const dropped = ordered.slice(maxVerifiedPerDomain)
  unverifiedOverCap.push(...dropped)
  log(
    `${domainKey}: ${ordered.length} findings exceed the per-domain verification cap ` +
      `(${maxVerifiedPerDomain}) — verifying the ${kept.length} most severe, carrying ` +
      `${dropped.length} through as unverified (raise args.maxVerifiedPerDomain to verify all).`,
  )
  return kept
}

phase('Find')
const perDomain = await pipeline(
  parsedArgs.domains,
  d =>
    agent(
      `Target: ${parsedArgs.target}\n\nDomain: ${d.key}\n${d.prompt}\n\nOnly record something as a finding if you actually observed it by reading a file or running a command — don't assert from inference. This investigation is read-only.`,
      { label: `find:${d.key}`, phase: 'Find', schema: FINDER_SCHEMA }
    ).then((r) => (r?.findings ?? []).map((f) => ({ ...f, domain: d.key }))),
  (domainFindings, d) =>
    parallel(
      capForVerification(domainFindings, d.key).map((f) => () =>
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
${unverifiedOverCap.length ? `\nNOT verified — ${unverifiedOverCap.length} finding(s) exceeded the per-domain verification cap (${maxVerifiedPerDomain}) and never got a verifier. Treat these as open, not as cleared:\n${JSON.stringify(unverifiedOverCap.map(({ title, file, domain, severity }) => ({ title, file, domain, severity })))}` : ''}

Critique what's missing — domains/angles not covered, claims that went unverified, sources not read.
Propose concretely what the next round should look at — no generic advice, be specific to this target.`,
  { phase: 'Completeness', label: 'completeness-critic' }
)

return {
  target: parsedArgs.target,
  confirmed,
  refuted,
  unverified,
  // Distinct from `unverified` (verification RAN but too few votes came back): these never got a
  // verifier at all because the per-domain cap stopped at them. Different fact, different field.
  unverifiedOverCap,
  maxVerifiedPerDomain,
  completeness,
}
