#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const enabled = value => typeof value === 'boolean' ? value : value?.enabled === true
const identities = value => Object.fromEntries(['users', 'teams', 'apps'].map(kind => [kind, (value?.[kind] || []).map(v => typeof v === 'string' ? v : kind === 'users' ? v.login : v.slug)]))
const boolKeys = ['enforce_admins', 'required_linear_history', 'allow_force_pushes', 'allow_deletions', 'block_creations', 'required_conversation_resolution', 'lock_branch', 'allow_fork_syncing']
function matches(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every(e => actual.some(a => matches(e, a)))
  if (expected && typeof expected === 'object') return actual && Object.keys(expected).every(k => matches(expected[k], actual[k]))
  return expected === actual
}
function bodyFrom(raw) {
  const body = { required_status_checks: null, enforce_admins: false, required_pull_request_reviews: null, restrictions: null,
    allow_force_pushes: false, allow_deletions: false }
  if (!raw) return body
  const known = new Set([...boolKeys, 'url', 'required_status_checks', 'required_pull_request_reviews', 'restrictions', 'required_signatures'])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`unmapped protection field ${key}; refusing a lossy update`)
  for (const key of boolKeys) if (key in raw) body[key] = enabled(raw[key])
  if (raw.required_status_checks) {
    const checks = (raw.required_status_checks.checks || []).map(c => ({ context: c.context, ...(Number.isInteger(c.app_id) ? { app_id: c.app_id } : {}) }))
    for (const context of raw.required_status_checks.contexts || []) if (!checks.some(c => c.context === context)) checks.push({ context })
    body.required_status_checks = { strict: raw.required_status_checks.strict === true, contexts: [], checks }
  }
  if (raw.required_pull_request_reviews) {
    const r = raw.required_pull_request_reviews, p = {}
    const fields = ['dismiss_stale_reviews', 'require_code_owner_reviews', 'required_approving_review_count', 'require_last_push_approval']
    for (const key of Object.keys(r)) if (![...fields, 'url', 'dismissal_restrictions', 'bypass_pull_request_allowances'].includes(key)) throw new Error(`unmapped review field ${key}`)
    for (const key of fields) if (key in r) p[key] = r[key]
    for (const key of ['dismissal_restrictions', 'bypass_pull_request_allowances']) if (r[key]) p[key] = identities(r[key])
    body.required_pull_request_reviews = p
  }
  if (raw.restrictions) body.restrictions = identities(raw.restrictions)
  return body
}
function api(endpoint, method = 'GET', body) {
  const r = spawnSync('gh', ['api', '-X', method, endpoint, '-H', 'Accept: application/vnd.github+json', ...(body ? ['--input', '-'] : [])],
    { encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, maxBuffer: 4 * 1024 * 1024, timeout: 30000 })
  let value; try { value = JSON.parse(r.stdout) } catch { /* handled below */ }
  if (r.status !== 0) {
    if (method === 'GET' && value?.message === 'Branch not protected' && /404/.test(r.stderr || '')) return null
    throw new Error(`${method} failed; ${method === 'PUT' ? 'outcome may be uncertain; inspect remotely before retrying. ' : ''}${r.stderr || r.error?.message || 'unreadable response'}`)
  }
  if (!value || typeof value !== 'object') throw new Error('unreadable GitHub response')
  return value
}
function endpointFor(repo, branch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !branch || /[\x00-\x1f*]/.test(branch)) throw new Error('invalid repository or branch')
  return `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`
}
try {
  const args = process.argv.slice(2)
  if (args[0] === '--apply-plan') {
    if (args.length !== 4 || args[2] !== '--approve-plan') throw new Error('use --apply-plan <file> --approve-plan <reviewed plan_hash>')
    const plan = JSON.parse(readFileSync(args[1], 'utf8')), { plan_hash, ...content } = plan
    if (plan.schema_version !== 1 || hash(content) !== plan_hash || args[3] !== plan_hash) throw new Error('reviewed plan hash mismatch')
    const endpoint = endpointFor(plan.repo, plan.branch), current = api(endpoint)
    if (hash(current) !== plan.before_hash) throw new Error('remote protection changed after review; generate a new plan')
    api(endpoint, 'PUT', plan.after)
    const observed = api(endpoint)
    if (!matches(plan.after, bodyFrom(observed))) throw new Error('update returned but protection differs; inspect before retrying')
    process.stdout.write(JSON.stringify({ status: 'applied', repo: plan.repo, branch: plan.branch, plan_hash }) + '\n')
  } else {
    const [repo, branch] = args.splice(0, 2), endpoint = endpointFor(repo, branch)
    const requested = [], checks = []; let output = ''
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (['--require-pr', '--include-admins', '--no-force-push', '--no-delete', '--dry-run'].includes(a)) requested.push(a)
      else if (['--required-check', '--output'].includes(a)) {
        const v = args[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`)
        if (a === '--output') output = v; else checks.push(v)
      } else throw new Error(`unknown flag ${a}`)
    }
    const before = api(endpoint), after = bodyFrom(before)
    if (requested.includes('--require-pr') && !after.required_pull_request_reviews) after.required_pull_request_reviews = { required_approving_review_count: 0 }
    if (requested.includes('--include-admins')) after.enforce_admins = true
    if (requested.includes('--no-force-push')) after.allow_force_pushes = false
    if (requested.includes('--no-delete')) after.allow_deletions = false
    if (checks.length) {
      after.required_status_checks ||= { strict: true, contexts: [], checks: [] }
      for (const context of checks) if (!after.required_status_checks.checks.some(c => c.context === context)) after.required_status_checks.checks.push({ context })
    }
    const content = { schema_version: 1, status: 'proposed', repo, branch, before_hash: hash(before), before: before ? bodyFrom(before) : null, after,
      preserved_separate_controls: { required_signatures: before?.required_signatures || null },
      changed_fields: Object.keys(after).filter(k => !before || JSON.stringify(after[k]) !== JSON.stringify(bodyFrom(before)[k])) }
    const plan = { ...content, plan_hash: hash(content) }, text = JSON.stringify(plan, null, 2) + '\n'
    if (output) writeFileSync(output, text, { flag: 'wx', mode: 0o600 })
    process.stdout.write(text)
  }
} catch (e) { process.stderr.write(`branch-protect: ${e.message}\n`); process.exit(1) }
