#!/usr/bin/env node
// Record/read content-bound local evidence. Approval records are descriptive and never authorize
// a merge, deployment or send. Use an actual external approval reference for those decisions.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evidenceDir, writeEvidence, readEvidence, artifactIdentity, checkEvidence } from '../lib/evidence-graph.mjs'

try {
  const [op, value, ...rest] = process.argv.slice(2), root = process.cwd(), dir = evidenceDir(root)
  let result
  if (op === 'artifact' && value && rest.length === 0) result = writeEvidence(dir, { kind: 'artifact', artifact: artifactIdentity(root, value), created_at: new Date().toISOString() })
  else if (op === 'record' && value && rest.length === 0) {
    const data = JSON.parse(readFileSync(resolve(value), 'utf8'))
    if (data.kind === 'verification') throw new Error('verification receipts are produced by verdict-run.sh, not imported')
    if (data.purpose === 'lesson-verification') throw new Error('lesson verification seals are produced by lessons.mjs, not imported')
    result = writeEvidence(dir, data)
  } else if (op === 'read' && value && rest.length === 0) result = readEvidence(dir, value)
  else if (op === 'check' && value && rest.length === 0) result = checkEvidence(dir, value, { root })
  else throw new Error('Usage: evidence.mjs artifact <file> | record <record.json> | read <id> | check <id>')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.status === 'invalid') process.exitCode = 1
} catch (e) { process.stderr.write(`evidence: ${e.message}\n`); process.exitCode = 1 }
