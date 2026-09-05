#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/../bin/eval-gate.mjs" <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'eval-integrity-')), file = join(root, 'cases.jsonl'), baseline = join(root, 'baseline.json')
const data = assertion => writeFileSync(file, JSON.stringify({ id: 'one', input: 'hello', assert: assertion }) + '\n')
const run = (...args) => spawnSync(process.execPath, [process.argv[2], '--dataset', file, '--target', 'cat', '--log', join(root, 'eval.log'), ...args], { cwd: root, encoding: 'utf8' })
try {
  for (const assertion of [{ exit_zero: false }, { contains: [] }, { regex: '' }, { semantic: 'good' }]) {
    data(assertion); assert.equal(run('--allow-skip-semantic').status, 2)
  }
  data({ equals: 'hello' })
  assert.equal(run('--baseline', baseline, '--target-id', 'model-config-v1').status, 1, 'missing baseline cannot pass')
  for (const invalid of [null, false, 0, [], '']) {
    writeFileSync(baseline, JSON.stringify(invalid))
    assert.equal(run('--baseline', baseline, '--target-id', 'model-config-v1').status, 1, 'a parsed falsy or scalar baseline cannot bypass identity comparison')
  }
  let r = run('--baseline', baseline, '--target-id', 'model-config-v1', '--update-baseline')
  assert.equal(r.status, 1); assert.match(r.stdout, /RECORD is not verification/); assert.equal(JSON.parse(readFileSync(baseline)).operation_status, 'recorded')
  assert.equal(run('--baseline', baseline, '--target-id', 'model-config-v1').status, 0)
  assert.equal(run('--baseline', baseline, '--target-id', 'model-config-v2').status, 1)
  assert.equal(run('--baseline', baseline, '--target-id', 'model-config-v1', '--k', '2').status, 1)
  data({ equals: 'wrong' })
  r = run('--baseline', baseline, '--target-id', 'model-config-v1', '--update-baseline')
  assert.equal(r.status, 1); assert.equal(JSON.parse(readFileSync(baseline)).quality_status, 'FAIL')
  data({ equals: 'hello' }); assert.equal(run('--baseline', baseline, '--target-id', 'model-config-v1').status, 1, 'same case count with different content is a mismatch')
  r = run('--target', 'sleep 0.2; printf hello', '--budget-ms', '50', '--min-pass-at-k', '0', '--min-pass-caret-k', '0')
  assert.equal(r.status, 1); assert.match(r.stdout, /evaluation incomplete/, 'last-trial timeout fails independently of quality thresholds')
  data({ regex: '(a+)+$' })
  r = run('--target', "node -e \"process.stdout.write('a'.repeat(10000)+'!')\"", '--budget-ms', '200', '--min-pass-at-k', '0', '--min-pass-caret-k', '0')
  assert.equal(r.status, 1); assert.match(r.stdout, /evaluation incomplete/, 'regex grading shares the total deadline')
  data({ equals: '한' })
  const splitTarget = join(root, 'split-utf8.cjs')
  writeFileSync(splitTarget, "const b=Buffer.from('한');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)")
  r = run('--target', 'node ' + splitTarget)
  assert.equal(r.status, 0, 'multibyte output may span stream chunks')
  console.log('PASS: effective assertions, record/quality separation, missing and incompatible baseline rejection')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
