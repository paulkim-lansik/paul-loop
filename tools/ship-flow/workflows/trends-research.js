// trends-research — parallel research across N domains → per-domain skeptical verification (revisit a
// sample of key claims) → synthesis.
//
// Codified from an ad-hoc script used in a research session that ran two internal re-probes plus six
// domain researchers plus six per-domain skeptical verifiers (14 agents total). That session's
// per-domain scratchpad outputs were never committed, so this file was written from a description of
// the methodology rather than lifted from the original script. "Internal re-probe" was specific to
// that session's own topic (re-checking the source repo's own state) and isn't generalized here — if
// you need something similar, add a prompt among `domains` that has one domain investigate the target
// repo itself.
//
// args (all required):
//   { topic: '<one-sentence research question>',
//     domains: [{ key: '<slug>', prompt: '<what to investigate in this domain>' }, ...] }

export const meta = {
  name: 'trends-research',
  description: 'Parallel external research across N domains → per-domain skeptical verification (revisit a sample of key claims) → synthesis report',
  phases: [
    { title: 'Research', detail: 'Parallel first-pass research per domain' },
    { title: 'Verification', detail: 'Per-domain skeptical verifier — revisits a sample of key claims' },
    { title: 'Synthesis', detail: 'Write a report synthesizing all domains' },
  ],
}

const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

if (!parsedArgs?.topic || !Array.isArray(parsedArgs?.domains) || parsedArgs.domains.length === 0) {
  throw new Error(
    'trends-research requires args = { topic: "<research question>", domains: [{key, prompt}, ...] } — domains are topic-specific, this workflow does not guess a default set.'
  )
}

const DOMAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          source: { type: 'string', description: 'URL or primary source' },
        },
        required: ['claim'],
      },
    },
  },
  required: ['summary', 'claims'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    checked: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          confirmed: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['claim', 'confirmed'],
      },
    },
  },
  required: ['checked'],
}

phase('Research')
const verified = await pipeline(
  parsedArgs.domains,
  (d) =>
    agent(
      `Research topic: ${parsedArgs.topic}\n\nDomain: ${d.key}\n${d.prompt}\n\nFind primary sources (official docs, papers, repos) and investigate. Attach a source URL to every key claim. Do not put unsourced claims into claims.`,
      { label: `research:${d.key}`, phase: 'Research', schema: DOMAIN_SCHEMA }
    ),
  (domainResult, d) =>
    agent(
      `Pick up to 6 of the key claims from the following domain research result and actually revisit the original sources to confirm them (skeptically — check for exaggeration, distortion, or claims that are out of date):

Domain: ${d.key}
${JSON.stringify(domainResult?.claims ?? [])}`,
      { label: `verify:${d.key}`, phase: 'Verification', schema: VERIFY_SCHEMA }
    ).then((v) => ({ domain: d.key, ...domainResult, verification: v?.checked ?? [] }))
)

const clean = verified.filter(Boolean)
const totalClaims = clean.reduce((n, d) => n + (d.claims?.length ?? 0), 0)
const totalChecked = clean.reduce((n, d) => n + (d.verification?.length ?? 0), 0)
log(`${clean.length} domains, ${totalClaims} claims, ${totalChecked} sampled-claim verifications`)

phase('Synthesis')
const reportBody = await agent(
  `The following is the result of research across ${clean.length} domains on "${parsedArgs.topic}", plus per-domain skeptical verification (JSON):

${JSON.stringify(clean)}

Write a markdown report body (no title, body only) that synthesizes:
1. TL;DR
2. Per-domain summary (where verification refuted or corrected something, reflect the correction — not the original claim)
3. Limits of the evidence (verification coverage — how many claims were revisited per domain, and how the remaining unverified claims were handled)

Where a claim wasn't confirmed by verification, present it with reduced confidence or drop it — don't
ignore the verification results and just copy the first-pass research.`,
  { phase: 'Synthesis', label: 'synthesize-report' }
)

return { topic: parsedArgs.topic, domains: clean, reportBody }
