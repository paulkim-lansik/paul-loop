#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/.." <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
const engine = process.argv[2], root = mkdtempSync(join(tmpdir(), 'verdict-contract-'))
const run = (...args) => spawnSync(join(engine, 'bin/verdict-run.sh'), args, { cwd: root, encoding: 'utf8', env: { ...process.env, LOOP_DIR: '.loop' } })
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
const state = () => JSON.parse(readFileSync(join(root, '.loop/verdict-state.json')))
try {
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@test'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.loop/\n'); git('add', '.'); git('commit', '-qm', 'init')
  const before = git('rev-parse', 'HEAD').toString().trim()
  const block = (v, code, extra = '') => `=== VERDICT ===\nVERDICT: ${v}\nEXIT: ${code}\nSUMMARY: passed= failed= skipped= duration_ms=1\n${v === 'FAIL' ? 'FAIL: actual failure\n' : ''}${extra}LOG: /tmp/test.log\n=== END VERDICT ===\n`
  for (const [v, declared, actual] of [['PASS', 0, 7], ['FAIL', 1, 0], ['FAIL', 2, 7]]) {
    const r = run('--', process.execPath, '-e', 'process.stdout.write(process.argv[1]);process.exit(Number(process.argv[2]))', block(v, declared), String(actual))
    assert.equal(r.status, 1); assert.match(r.stdout, /^VERDICT: FAIL$/m); assert.equal(state().verdict, 'FAIL'); assert.equal(state().exit, 1)
  }
  for (const output of ['=== VERDICT ===\nVERDICT: PASS\n', block('PASS', 0, 'VERDICT: PASS\n')]) {
    assert.equal(run('--', process.execPath, '-e', 'process.stdout.write(process.argv[1])', output).status, 1)
  }
  for (const actual of [2, 1]) {
    const r = run('--', process.execPath, '-e', 'process.stdout.write(process.argv[1]);process.exit(Number(process.argv[2]))', block('FAIL', 2), String(actual))
    assert.equal(r.status, 1); assert.match(r.stdout, /^EXIT: 2$/m); assert.equal(state().exit, 2)
  }
  const mutate = run('--', 'sh', '-c', 'printf new > new.txt; git add new.txt; git commit -qm change')
  assert.equal(mutate.status, 0, 'raw mutation remains opt-in')
  assert.equal(state().sha, before); assert.equal(state().dirty, true); assert.equal(state().target_changed, true)
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  mkdirSync(join(root, 'fakebin')); writeFileSync(join(root, 'fakebin/git'), '#!/bin/sh\n[ "$1" = ls-files ] && exit 4\nexec ' + JSON.stringify(realGit) + ' "$@"\n', { mode: 0o755 })
  const failure = spawnSync(join(engine, 'bin/verdict-run.sh'), ['--guard-mutation', '--', 'touch', 'must-not-run'], { cwd: root, encoding: 'utf8', env: { ...process.env, LOOP_DIR: '.loop', PATH: join(root, 'fakebin') + ':' + process.env.PATH } })
  assert.equal(failure.status, 2); assert.throws(() => readFileSync(join(root, 'must-not-run')))
  console.log('PASS: nested contracts agree across stdout/state/exit; target is captured before verify; digest enumeration fails closed')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
