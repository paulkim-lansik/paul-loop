#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/../../ship-flow/templates/branch-protect.sh" <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'branch-policy-')), remote = join(root, 'remote.json'), calls = join(root, 'calls.jsonl')
try {
  writeFileSync(join(root, 'gh'), '#!/usr/bin/env node\n' + `const fs=require('fs');const a=process.argv.slice(2),method=a[a.indexOf('-X')+1];fs.appendFileSync(process.env.POLICY_CALLS,JSON.stringify({method})+'\\n');if(method==='PUT'){let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.env.POLICY_REMOTE,s);console.log(s)});}else console.log(fs.readFileSync(process.env.POLICY_REMOTE,'utf8'));`, { mode: 0o755 })
  const before = { enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_linear_history: { enabled: true }, required_status_checks: { strict: true, contexts: ['old-check'], checks: [{ context: 'old-check', app_id: 42 }] }, required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true, require_code_owner_reviews: true, require_last_push_approval: true }, restrictions: { users: [{ login: 'owner' }], teams: [], apps: [] }, required_signatures: { enabled: true } }
  writeFileSync(remote, JSON.stringify(before)); writeFileSync(calls, '')
  const run = (...args) => spawnSync('bash', [process.argv[2], ...args], { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH, POLICY_REMOTE: remote, POLICY_CALLS: calls } })
  const file = join(root, 'plan.json')
  const r = run('owner/repo', 'main', '--require-pr', '--required-check', 'selftest', '--required-check', 'verifier-pinned-review', '--output', file)
  assert.equal(r.status, 0, r.stderr); const plan = JSON.parse(r.stdout)
  assert.equal(plan.after.required_pull_request_reviews.required_approving_review_count, 2)
  assert.equal(plan.after.enforce_admins, true); assert.equal(plan.after.required_linear_history, true)
  assert.equal(plan.after.allow_force_pushes, false); assert.equal(plan.after.allow_deletions, false)
  assert.deepEqual(plan.after.restrictions.users, ['owner'])
  assert.deepEqual(plan.after.required_status_checks.checks.map(c => c.context), ['old-check', 'selftest', 'verifier-pinned-review'])
  assert.equal(plan.after.required_status_checks.checks[0].app_id, 42)
  assert.equal(readFileSync(calls, 'utf8').includes('PUT'), false, 'default only proposes')
  assert.equal(run('--apply-plan', file, '--approve-plan', 'wrong').status, 1)
  writeFileSync(remote, JSON.stringify({ ...before, allow_deletions: { enabled: true } }))
  assert.equal(run('--apply-plan', file, '--approve-plan', plan.plan_hash).status, 1, 'stale reviewed state rejected')
  assert.equal(readFileSync(calls, 'utf8').includes('PUT'), false)
  writeFileSync(remote, JSON.stringify(before))
  const applied = run('--apply-plan', file, '--approve-plan', plan.plan_hash)
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').filter(l => JSON.parse(l).method === 'PUT').length, 1)
  console.log('PASS: additive branch protection preserves restrictions, supports multiple checks and requires an unchanged reviewed plan')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
