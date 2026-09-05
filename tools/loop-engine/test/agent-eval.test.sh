#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/../bin/agent-eval.mjs" <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'agent-eval-test-'))
try {
  const dataset = join(root, 'cases.jsonl'), target = join(root, 'target.cjs'), grader = join(root, 'grader.cjs')
  writeFileSync(dataset, JSON.stringify({ id: 'edit', prompt: 'Write the requested result', criteria: { expected: 'correct' } }) + '\n')
  writeFileSync(target, `const fs=require('fs');if(process.env.LOOP_LEARNING_OFF!=='1'||process.env.LOOP_MEMORY_OFF!=='1')process.exit(4);fs.writeFileSync('result.txt',process.env.TEST_BAD?'wrong':'correct');console.log('VERDICT: PASS');`)
  writeFileSync(grader, `const fs=require('fs'), crypto=require('crypto');const b=fs.readFileSync('result.txt');console.log(JSON.stringify({task_success:b.toString()==='correct',unnecessary_questions:0,unauthorized_actions:0,false_pass:b.toString()==='correct'?0:1,unfinished_steps:0,evidence:[{path:'result.txt',sha256:crypto.createHash('sha256').update(b).digest('hex')}]}));`)
  let i = 0
  const run = (extra = [], env = {}) => {
    const report = join(root, 'report-' + (++i) + '.json')
    const r = spawnSync(process.execPath, [process.argv[2], '--dataset', dataset, '--target', 'node ' + target, '--grader', 'node ' + grader, '--runtime-id', 'fixture-v1', '--model-id', 'fixture-no-model', '--report', report, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } })
    return { ...r, report: JSON.parse(readFileSync(report)) }
  }
  let r = run(['--k', '2']); assert.equal(r.status, 0, r.stderr); assert.equal(r.report.summary.pass_caret_k, 1); assert.equal(r.report.learning, 'disabled')
  r = run([], { TEST_BAD: '1' }); assert.equal(r.status, 1); assert.equal(r.report.results[0].metrics.false_pass, 1, 'target self-report cannot outweigh observed wrong artifact')
  const foreign = join(root, 'foreign'); mkdirSync(foreign)
  const cleanGitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: foreign, env: cleanGitEnv, encoding: 'utf8' })
  git('init', '-q'); writeFileSync(join(foreign, 'keep.txt'), 'original'); git('add', '.')
  git('-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'foreign repository')
  writeFileSync(join(foreign, 'keep.txt'), 'uncommitted user work')
  const foreignHead = git('rev-parse', 'HEAD'), foreignIndex = readFileSync(join(foreign, '.git/index'))
  writeFileSync(target, `const fs=require('fs'),cp=require('child_process');const top=cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();if(fs.realpathSync(top)!==fs.realpathSync(process.cwd()))process.exit(5);fs.writeFileSync('result.txt','correct');`)
  r = run([], { GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_COMMON_DIR: join(foreign, '.git'), GIT_INDEX_FILE: join(foreign, '.git/index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: foreign })
  assert.equal(r.status, 0, r.stderr); assert.equal(git('rev-parse', 'HEAD'), foreignHead)
  assert.deepEqual(readFileSync(join(foreign, '.git/index')), foreignIndex); assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'uncommitted user work')
  writeFileSync(grader, `const fs=require('fs'),crypto=require('crypto');fs.writeFileSync('한.txt','evidence');const b=fs.readFileSync('한.txt');const data=Buffer.from(JSON.stringify({task_success:true,unnecessary_questions:0,unauthorized_actions:0,false_pass:0,unfinished_steps:0,evidence:[{path:'한.txt',sha256:crypto.createHash('sha256').update(b).digest('hex')}]}));const split=data.indexOf(Buffer.from('한'))+1;process.stdout.write(data.subarray(0,split));setTimeout(()=>process.stdout.write(data.subarray(split)),30);`)
  r = run(); assert.equal(r.status, 0, 'split UTF8 JSON grader paths retain their exact identity')
  writeFileSync(dataset, JSON.stringify({ id: 'missing-host-event', prompt: 'Observe cancellation', required_events: ['host-cancellation'], criteria: { expected: 'correct' } }) + '\n')
  r = run(); assert.equal(r.status, 1); assert.equal(r.report.results[0].status, 'incomplete'); assert.deepEqual(r.report.results[0].missing_events, ['host-cancellation'], 'a correct generic artifact cannot pass an unexercised scenario')
  writeFileSync(target, "setInterval(()=>{},1000)")
  r = run(['--timeout-ms', '50']); assert.equal(r.status, 1); assert.equal(r.report.results[0].status, 'incomplete'); assert.equal(r.report.results[0].target.fault, 'timeout')
  console.log('PASS: isolated repeatable agent-eval fixtures, frozen learning, independent artifact grading and timeout status')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
