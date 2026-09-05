// Content-bound local evidence, separate from the forgeable observation ledger. These files
// are guardrail-protected receipts, not attestations against a writer with unrestricted Bash.
// An approval record describes an external decision; creating one NEVER grants authority.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs'
import { join, resolve, relative, dirname, isAbsolute } from 'node:path'
import { sha256, observedIdentity } from './workspace-identity.mjs'

const KINDS = new Set(['requirement', 'ac', 'artifact', 'verification', 'review', 'approval', 'knowledge'])
const RELATIONS = new Set(['depends_on', 'supports', 'contradicts', 'supersedes'])
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)
export const evidenceDir = (root = process.cwd(), loopDir = process.env.LOOP_DIR || '.loop') => resolve(root, loopDir, 'evidence')

export function writeEvidence(dir, data) {
  if (!KINDS.has(data.kind)) throw new Error('unknown evidence kind')
  const record = { ...data, schema_version: 1, id: randomUUID() }
  delete record.content_hash
  for (const edge of record.edges || []) {
    if (!safeId(edge.id) || !RELATIONS.has(edge.relation)) throw new Error('invalid evidence edge')
    readEvidence(dir, edge.id)
  }
  record.content_hash = sha256(JSON.stringify(record))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return record
}

export function readEvidence(dir, id) {
  if (!safeId(id)) throw new Error('invalid evidence id')
  const record = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
  const { content_hash, ...body } = record
  if (record.id !== id || record.schema_version !== 1 || !KINDS.has(record.kind) || sha256(JSON.stringify(body)) !== content_hash) throw new Error('evidence hash or schema mismatch')
  return record
}

export function artifactIdentity(root, path) {
  const base = realpathSync(root), abs = realpathSync(resolve(base, path)), rel = relative(base, abs)
  if (rel.startsWith('../') || rel === '..' || rel.startsWith('/')) throw new Error('artifact outside repository')
  return { path: rel, sha256: sha256(readFileSync(abs)) }
}

// A required dependency is valid only for the exact saved artifact. Explicit contrary or
// superseding evidence invalidates it. Knowledge links remain descriptive, never approval.
export function checkEvidence(dir, id, { root = process.cwd(), invalidated = [] } = {}) {
  const visiting = new Set(), visited = new Set(), reasons = []
  const revoked = new Set(invalidated)
  try {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const r = readEvidence(dir, file.slice(0, -5))
      for (const e of r.edges || []) if (['contradicts', 'supersedes'].includes(e.relation)) revoked.add(e.id)
    }
  } catch (e) { reasons.push(`evidence index unreadable: ${e.message}`) }
  const visit = key => {
    if (visiting.has(key)) { reasons.push(`${key}: dependency cycle`); return }
    if (visited.has(key)) return
    visiting.add(key)
    try {
      const r = readEvidence(dir, key)
      if (revoked.has(key)) reasons.push(`${key}: invalidated`)
      if (r.kind === 'artifact' && artifactIdentity(root, r.artifact.path).sha256 !== r.artifact.sha256) reasons.push(`${key}: artifact changed`)
      if (r.kind === 'verification' && (r.mode !== 'gate' || r.verdict !== 'PASS' || r.exit !== 0 || !r.target_before?.digest || r.target_before.digest !== r.target_after?.digest)) reasons.push(`${key}: verification failed or target changed`)
      if (r.kind === 'verification' && r.root_hash !== sha256(realpathSync(root))) reasons.push(`${key}: verification belongs to another workspace`)
      if (r.kind === 'verification') {
        const policy = r.identity_policy
        if (policy?.version !== 1 || typeof policy.loop_dir !== 'string' || realpathSync(policy.loop_dir) !== realpathSync(dirname(dir)) || typeof policy.log !== 'string' || !isAbsolute(policy.log)) reasons.push(`${key}: unsupported verification identity policy`)
        else if (observedIdentity({ cwd: root, loopDir: policy.loop_dir, log: policy.log }).digest !== r.target_after?.digest) reasons.push(`${key}: verification target is stale`)
      }
      if (r.kind === 'review' && r.status !== 'complete') reasons.push(`${key}: review incomplete`)
      if (r.kind === 'approval' && (!r.actor || !r.action || !r.external_reference || !r.edges?.some(e => e.relation === 'depends_on'))) reasons.push(`${key}: approval lacks actor/action/reference/artifact`)
      for (const edge of r.edges || []) if (edge.relation === 'depends_on') visit(edge.id)
    } catch (e) { reasons.push(`${key}: ${e.message}`) }
    visiting.delete(key); visited.add(key)
  }
  visit(id)
  return { status: reasons.length ? 'invalid' : 'valid', id, reasons, authority_granted: false }
}
