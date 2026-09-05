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
// Model choice follows measured verifier capability. Inherit the caller's evaluated model;
// price alone is neither evidence of quality nor permission to lower verification standards.
// args.maxAgentCalls (default 64), maxConcurrency (4), budgetMs (300000) bound dispatch.
// In-flight cancellation is owned by the host adapter; late output is rejected here.
// A host without cancellation must disclose that limit rather than claim a hard kill.
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
    status: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
    evidence: { type: 'string', description: 'Concrete command/file observation supporting the vote' },
    reason: { type: 'string' },
  },
  required: ['status', 'reason', 'evidence'],
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

// One queue across finders, votes and the critic: nested fan-out cannot multiply concurrency.
const positive = (value, fallback, name) => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}
const maxAgentCalls = positive(parsedArgs.maxAgentCalls, 64, 'maxAgentCalls')
const maxConcurrency = positive(parsedArgs.maxConcurrency, 4, 'maxConcurrency')
const deadline = Date.now() + positive(parsedArgs.budgetMs, 300000, 'budgetMs')
let calls = 0, active = 0
const queue = [], incompleteCalls = []
async function boundedAgent(prompt, options) {
  if (active >= maxConcurrency) await new Promise(resolve => queue.push(resolve))
  else active++
  try {
    if (Date.now() >= deadline || calls >= maxAgentCalls) {
      incompleteCalls.push({ label: options.label, status: 'not_run', reason: 'budget exhausted' })
      return null
    }
    calls++
    const result = await agent(prompt, options)
    if (Date.now() >= deadline) {
      incompleteCalls.push({ label: options.label, status: 'inconclusive', reason: 'late result' })
      return null
    }
    if (result == null) incompleteCalls.push({ label: options.label, status: 'inconclusive', reason: 'missing result' })
    return result
  } catch (e) {
    incompleteCalls.push({ label: options.label, status: 'inconclusive', reason: String(e) })
    return null
  } finally {
    const next = queue.shift()
    if (next) next(); else active--
  }
}
const coverage = []
phase('Find')
const perDomain = await pipeline(
  parsedArgs.domains,
  async d => {
    const r = await boundedAgent(
      `Target: ${parsedArgs.target}\n\nDomain: ${d.key}\n${d.prompt}\n\nOnly record findings you observed by reading a file or running a command. This investigation is read-only.`,
      { label: `find:${d.key}`, phase: 'Find', schema: FINDER_SCHEMA }
    )
    const valid = Array.isArray(r?.findings) && r.findings.every(f => typeof f?.title === 'string' && typeof f.detail === 'string' && Object.hasOwn(SEVERITY_RANK, f.severity))
    coverage.push({ domain: d.key, status: valid ? 'complete' : 'incomplete' })
    return valid ? r.findings.map(f => ({ ...f, domain: d.key })) : []
  },
  (domainFindings, d) => parallel(capForVerification(domainFindings, d.key).map(f => async () => {
    const votes = await parallel(Array.from({ length: VOTES_PER_FINDING }, () => () => boundedAgent(
      `Check this finding skeptically: "${f.title}" — ${f.detail}${f.file ? ` (${f.file})` : ''}\nTarget: ${parsedArgs.target}. Read files or run commands. Return confirmed or refuted only with concrete evidence. Uncertainty or unavailable evidence is inconclusive.`,
      { label: `verify:${f.domain}:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    )))
    const valid = votes.filter(v => ['confirmed', 'refuted'].includes(v?.status) && typeof v.evidence === 'string' && v.evidence.trim() && typeof v.reason === 'string' && v.reason.trim())
    const confirms = valid.filter(v => v.status === 'confirmed').length
    const refutes = valid.filter(v => v.status === 'refuted').length
    const status = confirms >= REFUTATIONS_REQUIRED ? 'confirmed' : refutes >= REFUTATIONS_REQUIRED ? 'refuted' : 'inconclusive'
    return { ...f, status, survives: status === 'confirmed', isRefuted: status === 'refuted', refutations: votes }
  }))
)
const allFindings = perDomain.flat().filter(Boolean)
const confirmed = allFindings.filter(f => f.status === 'confirmed')
const refuted = allFindings.filter(f => f.status === 'refuted')
const unverified = allFindings.filter(f => f.status === 'inconclusive')
log(`${allFindings.length} findings — ${confirmed.length} confirmed, ${refuted.length} refuted, ${unverified.length} unverified`)
phase('Completeness')
const completeness = await boundedAgent(
  `Review target: ${parsedArgs.target}\nCoverage by required domain: ${JSON.stringify(coverage)}\nConfirmed: ${JSON.stringify(confirmed)}\nRefuted: ${JSON.stringify(refuted)}\nInconclusive: ${JSON.stringify(unverified)}\nNot verified due to cap: ${JSON.stringify(unverifiedOverCap)}\nIncomplete calls: ${JSON.stringify(incompleteCalls)}\nCritique missing evidence and angles, with concrete next checks. Never treat incomplete domains or inconclusive findings as cleared.`,
  { phase: 'Completeness', label: 'completeness-critic' }
)
const criticComplete = typeof completeness === 'string' && completeness.trim().length > 0
if (!criticComplete && !incompleteCalls.some(c => c.label === 'completeness-critic')) incompleteCalls.push({ label: 'completeness-critic', status: 'inconclusive', reason: 'invalid critic output' })
return {
  target: parsedArgs.target,
  status: coverage.every(d => d.status === 'complete') && !unverified.length && !unverifiedOverCap.length && !incompleteCalls.length && criticComplete ? 'complete' : 'incomplete',
  confirmed, refuted, unverified, unverifiedOverCap, maxVerifiedPerDomain, completeness, coverage, incompleteCalls,
  budget: { maxAgentCalls, calls, maxConcurrency, deadline, exceeded: Date.now() >= deadline || incompleteCalls.some(c => c.reason === 'budget exhausted'), cancellation: 'host-adapter' },
}
