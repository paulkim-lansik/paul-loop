#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/.." <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
const engine = process.argv[2], root = mkdtempSync(join(tmpdir(), 'evidence-graph-'))
const { writeEvidence, readEvidence, artifactIdentity, checkEvidence } = await import(pathToFileURL(join(engine, 'lib/evidence-graph.mjs')))
const dir = join(root, '.loop/evidence'), edge = id => ({ id, relation: 'depends_on' })
try {
  execFileSync('git', ['init', '-q', root]); writeFileSync(join(root, '.gitignore'), '.loop/\n')
  writeFileSync(join(root, 'plan.md'), 'AC: required behavior'); execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  const artifact = writeEvidence(dir, { kind: 'artifact', artifact: artifactIdentity(root, 'plan.md') })
  const reserved = join(root, '.loop/reserved.json')
  writeFileSync(reserved, JSON.stringify({ kind: 'knowledge', purpose: 'lesson-verification' }))
  const reservedImport = spawnSync(process.execPath, [join(engine, 'bin/evidence.mjs'), 'record', reserved], { cwd: root, encoding: 'utf8', env: { ...process.env, LOOP_DIR: '.loop' } })
  assert.equal(reservedImport.status, 1); assert.match(reservedImport.stderr, /not imported/)
  const ac = writeEvidence(dir, { kind: 'ac', edges: [edge(artifact.id)], requirement: 'required behavior' })
  const approval = writeEvidence(dir, { kind: 'approval', actor: 'human', action: 'implement', external_reference: 'session:explicit-user-approval', edges: [edge(ac.id)] })
  assert.equal(checkEvidence(dir, approval.id, { root }).status, 'valid')
  assert.equal(checkEvidence(dir, approval.id, { root }).authority_granted, false)
  writeFileSync(join(root, 'plan.md'), 'different scope')
  assert.equal(checkEvidence(dir, approval.id, { root }).status, 'invalid', 'changed artifact invalidates dependent approval')
  writeFileSync(join(root, 'plan.md'), 'AC: required behavior')
  execFileSync(join(engine, 'bin/verdict-run.sh'), ['--', 'true'], { cwd: root, env: { ...process.env, LOOP_DIR: '.loop' }, stdio: 'pipe' })
  const receiptId = JSON.parse(readFileSync(join(root, '.loop/verdict-state.json'))).receipt_id
  const receipt = readEvidence(dir, receiptId)
  assert.equal(receipt.kind, 'verification'); assert.equal(receipt.target_before.digest, receipt.target_after.digest)
  assert.equal(checkEvidence(dir, receiptId, { root }).status, 'valid')
  execFileSync(join(engine, 'bin/verdict-run.sh'), ['--log', 'verify.log', '--', 'true'], { cwd: root, env: { ...process.env, LOOP_DIR: '.loop' }, stdio: 'pipe' })
  const customId = JSON.parse(readFileSync(join(root, '.loop/verdict-state.json'))).receipt_id
  assert.equal(checkEvidence(dir, customId, { root }).status, 'valid', 'nonignored custom log uses the same identity policy on producer and checker')
  writeFileSync(join(root, 'plan.md'), 'actual source edit')
  assert.equal(checkEvidence(dir, customId, { root }).status, 'invalid')
  writeFileSync(join(root, 'plan.md'), 'AC: required behavior')
  rmSync(join(root, 'verify.log')); rmSync(join(root, '.gitignore'))
  execFileSync('git', ['-C', root, 'config', 'status.showUntrackedFiles', 'all'])
  execFileSync(join(engine, 'bin/verdict-run.sh'), ['--', 'true'], { cwd: root, env: { ...process.env, LOOP_DIR: '.loop' }, stdio: 'pipe' })
  const noIgnoreId = JSON.parse(readFileSync(join(root, '.loop/verdict-state.json'))).receipt_id
  assert.equal(checkEvidence(dir, noIgnoreId, { root }).status, 'valid', 'receipt/state outputs cannot stale their own unignored runtime directory')
  writeFileSync(join(root, '.gitignore'), '.loop/\n')
  const twin = mkdtempSync(join(tmpdir(), 'evidence-twin-'))
  try {
    cpSync(root, twin, { recursive: true })
    const copied = checkEvidence(join(twin, '.loop/evidence'), receiptId, { root: twin })
    assert.equal(copied.status, 'invalid', 'same Git content in another workspace does not inherit verification')
    assert.ok(copied.reasons.some(r => r.includes('another workspace')))
  } finally { rmSync(twin, { recursive: true, force: true }) }
  writeEvidence(dir, { kind: 'knowledge', text: 'new decision', edges: [{ relation: 'supersedes', id: ac.id }] })
  assert.equal(checkEvidence(dir, approval.id, { root }).status, 'invalid', 'superseded evidence invalidates dependents')
  const invalidReview = writeEvidence(dir, { kind: 'review', status: 'timeout' })
  assert.equal(checkEvidence(dir, invalidReview.id, { root }).status, 'invalid')
  const corrupt = { ...artifact, artifact: { path: 'plan.md', sha256: 'forged' } }
  writeFileSync(join(dir, artifact.id + '.json'), JSON.stringify(corrupt))
  assert.throws(() => readEvidence(dir, artifact.id), /hash/)
  console.log('PASS: artifact-bound evidence, stale approval invalidation, verification receipts, supersession and integrity')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
