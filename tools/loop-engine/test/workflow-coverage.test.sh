#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/../../ship-flow/workflows" <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
const load = name => new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', readFileSync(join(process.argv[2], name + '.js'), 'utf8').replace(/^export const meta/m, 'const meta'))
const parallel = thunks => Promise.all(thunks.map(t => t()))
const pipeline = (items, ...stages) => Promise.all(items.map(async item => { let r = item; for (const stage of stages) r = await stage(r, item); return r }))
const review = load('adversarial-review'), audit = load('harness-audit')
const args = { target: 'fixture', domains: [{ key: 'one', prompt: 'read fixture' }] }
const finding = { title: 'bug', detail: 'observed fixture mismatch', severity: 'major' }
const vote = status => ({ status, reason: 'checked fixture', evidence: 'node fixture.test: result observed' })
const run = agent => review(args, agent, parallel, pipeline, () => {}, () => {})
for (const invalid of ['', '  ', {}, []]) {
  const result = await run(async (_, o) => o.phase === 'Find' ? { findings: [] } : invalid)
  assert.equal(result.status, 'incomplete', 'critic must return a substantive report')
}
let r = await run(async (_, o) => o.phase === 'Find' ? null : 'critic')
assert.equal(r.status, 'incomplete'); assert.equal(r.coverage[0].status, 'incomplete')
let n = 0
r = await run(async (_, o) => o.phase === 'Find' ? { findings: [finding] } : o.phase === 'Verify' ? [vote('confirmed'), vote('refuted'), null][n++] : 'critic')
assert.equal(r.confirmed.length, 0); assert.equal(r.refuted.length, 0); assert.equal(r.unverified.length, 1)
r = await run(async (_, o) => o.phase === 'Find' ? { findings: [finding] } : o.phase === 'Verify' ? { status: 'confirmed', reason: 'guess', evidence: '' } : 'critic')
assert.equal(r.status, 'incomplete'); assert.equal(r.unverified.length, 1)
r = await run(async (_, o) => { if (o.phase === 'Find') throw new Error('unavailable'); return 'critic' })
assert.equal(r.coverage[0].status, 'incomplete')
let active = 0, max = 0, calls = 0
r = await review({ ...args, domains: ['a', 'b', 'c'].map(key => ({ key, prompt: 'p' })), maxAgentCalls: 7, maxConcurrency: 2 }, async (_, o) => {
  calls++; active++; max = Math.max(max, active)
  await new Promise(resolve => setTimeout(resolve, 2)); active--
  return o.phase === 'Find' ? { findings: [finding, finding] } : o.phase === 'Verify' ? vote('confirmed') : 'critic'
}, parallel, pipeline, () => {}, () => {})
assert.ok(calls <= 7); assert.ok(max <= 2); assert.equal(r.status, 'incomplete'); assert.ok(r.incompleteCalls.some(c => c.status === 'not_run'))
r = await review({ ...args, budgetMs: 1 }, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { findings: [] } }, parallel, pipeline, () => {}, () => {})
assert.equal(r.status, 'incomplete'); assert.equal(r.budget.exceeded, true)
const phases = [], prompts = []
r = await audit({ outputLanguage: 'ko' }, async (prompt, o) => {
  phases.push(o.phase); prompts.push(prompt)
  if (o.phase === 'Context') return { path: 'docs/audit.md', context: 'ADR: source operations N/A', repositoryRole: 'provider', outputLanguage: 'en' }
  if (o.label === 'audit:skills') return null
  if (o.phase === 'Investigate') return { dimension: 'untrusted wrong key', level: 'N/A', oneLine: 'provider', evidence: [{ observation: 'read ADR' }], strengths: [], gaps: [] }
  return '보고서'
}, parallel, pipeline, () => {}, () => {})
assert.equal(phases[0], 'Context'); assert.equal(r.status, 'incomplete'); assert.equal(r.findings.length, 6)
assert.equal(r.findings.find(f => f.dimension === 'skills').status, 'incomplete'); assert.equal(r.outputLanguage, 'ko')
assert.ok(prompts.filter(p => p.includes('Prior context')).every(p => p.includes('ADR: source operations N/A')))
assert.ok(prompts.at(-1).includes('in ko'))
const context = { path: '', context: 'provider role observed; no prior report found', repositoryRole: 'provider', outputLanguage: 'ko' }
const lane = { dimension: 'fixture', level: 'N/A', oneLine: 'provider', evidence: [{ observation: 'read ADR' }], strengths: [], gaps: [] }
for (const invalid of ['', '  ', {}, []]) {
  r = await audit({}, async (_, o) => o.phase === 'Context' ? context : o.phase === 'Investigate' ? lane : invalid, parallel, pipeline, () => {}, () => {})
  assert.equal(r.status, 'incomplete'); assert.equal(r.stageCoverage.synthesis, 'incomplete')
  r = await audit({}, async (_, o) => o.phase === 'Context' ? invalid : o.phase === 'Investigate' ? lane : 'report', parallel, pipeline, () => {}, () => {})
  assert.equal(r.status, 'incomplete'); assert.equal(r.stageCoverage.context, 'incomplete')
}
console.log('PASS: required lane coverage, evidence-backed quorum, global dispatch limits, prior context and language')
JS
