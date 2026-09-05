#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/../hooks/gate-risky-commands.mjs" <<'JS'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'risky-read-'))
try {
  writeFileSync(join(root, 'risk-rules.json'), JSON.stringify({ version: 1, pathRules: [], commandRules: [{ id: 'cmd-irreversible', patterns: ['tools/deploy/', 'gh\\s+pr\\s+merge'], dims: { revers: 'none' }, why: 'shared action' }] }))
  const run = command => spawnSync(process.execPath, [process.argv[2]], { encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) })
  for (const command of ['cat tools/deploy/README.md', 'head -20 tools/deploy/script.sh', 'ls tools/deploy/']) {
    const r = run(command); assert.equal(r.status, 0); assert.equal(r.stdout, '')
  }
  for (const command of ['bash tools/deploy/release.sh', 'cat tools/deploy/README.md; gh pr merge 1', 'cat tools/deploy/README.md > result.txt', 'cat "$(tools/deploy/release.sh)"', 'gh pr merge 1']) {
    const r = run(command); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask', command)
  }
  console.log('PASS: plain deploy-document reads defer; execution, redirection, substitution and merge retain approval')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
