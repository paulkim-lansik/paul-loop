#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/.." <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'workspace-identity-')), repo = join(root, 'repo'), child = join(root, 'child')
const { workspaceIdentity } = await import(pathToFileURL(join(process.argv[2], 'lib/workspace-identity.mjs')))
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })
const init = dir => { mkdirSync(dir); git(dir, 'init', '-q'); writeFileSync(join(dir, 'file'), 'first'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init') }
try {
  init(repo); init(child)
  mkdirSync(join(repo, 'subdir'))
  assert.equal(workspaceIdentity({ cwd: repo }).digest, workspaceIdentity({ cwd: join(repo, 'subdir') }).digest)
  execFileSync('mkfifo', [join(repo, 'pipe')])
  assert.doesNotThrow(() => workspaceIdentity({ cwd: repo }), 'Git-invisible FIFO must not be read')
  rmSync(join(repo, 'pipe'))
  writeFileSync(join(repo, '.gitattributes'), 'file diff=stable\n')
  writeFileSync(join(root, 'textconv.sh'), '#!/bin/sh\nprintf stable\n')
  git(repo, 'config', 'diff.stable.textconv', 'sh ' + join(root, 'textconv.sh'))
  git(repo, 'add', '.gitattributes'); git(repo, 'commit', '-qm', 'textconv fixture')
  writeFileSync(join(repo, 'file'), 'dirty before')
  const beforeTextconv = workspaceIdentity({ cwd: repo }).digest
  writeFileSync(join(repo, 'file'), 'dirty after')
  assert.notEqual(workspaceIdentity({ cwd: repo }).digest, beforeTextconv, 'presentation-only textconv cannot hide tracked content drift')
  const mutation = spawnSync(join(process.argv[2], 'bin/verdict-run.sh'), ['--guard-mutation', '--', 'sh', '-c', 'printf third > file'], { cwd: repo, encoding: 'utf8', env: { ...process.env, LOOP_DIR: '.loop' } })
  assert.equal(mutation.status, 1, mutation.stdout + mutation.stderr)
  git(repo, 'checkout', '--', 'file')
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'dependency'); git(repo, 'commit', '-qam', 'submodule')
  writeFileSync(join(repo, 'dependency/file'), 'dirty one')
  const first = workspaceIdentity({ cwd: repo }).digest
  writeFileSync(join(repo, 'dependency/file'), 'dirty two')
  assert.notEqual(workspaceIdentity({ cwd: repo }).digest, first, 'changes inside an already-dirty submodule must affect identity')
  git(repo, 'submodule', 'deinit', '-f', '--all')
  assert.throws(() => workspaceIdentity({ cwd: repo }), /not initialized/)
  console.log('PASS: workspace-root identity, Git-invisible special files, dirty and uninitialized submodules')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
