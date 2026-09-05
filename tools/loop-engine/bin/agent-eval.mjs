#!/usr/bin/env node
// Held-out behavioral evaluation: isolated fixtures, frozen learning, a separate artifact grader.
// Target prose is never a PASS signal. This runner does not supply model credentials or claim
// native runtime coverage without an explicit adapter command, runtime ID and model/config ID.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, relative } from 'node:path'
import { runEvalProcess } from '../lib/agent-eval-process.mjs'

const hash = v => createHash('sha256').update(v).digest('hex')
// A caller may itself be inside a Git hook/worktree operation. None of its repository, index,
// object-store, template or injected-config environment may redirect fixture commits elsewhere.
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
Object.assign(fixtureEnv, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
const canonicalPath = (root, path) => {
  const abs = resolve(root, path), rel = relative(root, abs)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) throw new Error('fixture/evidence path must be inside workspace')
  return abs
}
try {
  const args = process.argv.slice(2), opt = { k: 1, timeoutMs: 120000, budgetMs: 1800000, memory: 'off' }
  const fields = { '--dataset': 'dataset', '--target': 'target', '--grader': 'grader', '--runtime-id': 'runtime', '--model-id': 'model', '--report': 'report', '--memory': 'memory', '--k': 'k', '--timeout-ms': 'timeoutMs', '--budget-ms': 'budgetMs' }
  for (let i = 0; i < args.length; i++) {
    const key = fields[args[i]], value = args[++i]
    if (!key || !value) throw new Error('Usage: agent-eval.mjs --dataset cases.jsonl --target <adapter> --grader <independent grader> --runtime-id <version> --model-id <model/config> --report result.json [--k N --memory off|frozen --timeout-ms N --budget-ms N]')
    opt[key] = ['k', 'timeoutMs', 'budgetMs'].includes(key) ? Number(value) : value
  }
  for (const key of ['dataset', 'target', 'grader', 'runtime', 'model', 'report']) if (!opt[key]) throw new Error(`missing ${key}`)
  if (existsSync(opt.report)) throw new Error('report already exists; choose a new artifact path')
  for (const key of ['k', 'timeoutMs', 'budgetMs']) if (!Number.isSafeInteger(opt[key]) || opt[key] < 1) throw new Error(`${key} must be positive`)
  if (!['off', 'frozen'].includes(opt.memory) || opt.target === opt.grader) throw new Error('use off/frozen memory and a separate grader')
  const bytes = readFileSync(opt.dataset), cases = bytes.toString().split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
  if (!cases.length || cases.some(c => typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c.id) || typeof c.prompt !== 'string' || !c.prompt.trim() || !c.criteria || typeof c.criteria !== 'object' || Array.isArray(c.criteria)
      || (c.required_events !== undefined && (!Array.isArray(c.required_events) || c.required_events.some(e => typeof e !== 'string' || !e.trim()) || new Set(c.required_events).size !== c.required_events.length)))
      || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('dataset needs unique IDs, prompts, grading criteria and valid required events')
  const deadline = Date.now() + opt.budgetMs, results = [], base = realpathSync(mkdtempSync(join(tmpdir(), 'loop-agent-eval-')))
  let cancelled = false
  try {
    for (const c of cases) for (let trial = 1; trial <= opt.k; trial++) {
      if (cancelled || Date.now() >= deadline) { results.push({ case_id: c.id, trial, status: 'not_run', reason: cancelled ? 'cancelled' : 'budget_exhausted' }); continue }
      const workspace = mkdtempSync(join(base, 'trial-')), stateDir = join(workspace, '.eval-state')
      mkdirSync(stateDir)
      for (const [path, value] of Object.entries(c.files || {})) {
        if (typeof value !== 'string') throw new Error('fixture contents must be strings')
        const abs = canonicalPath(workspace, path), rel = relative(workspace, abs)
        if (['.git', '.eval-state'].some(p => rel === p || rel.startsWith(p + '/'))) throw new Error('fixture may not override runner Git/state directories')
        mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, value)
      }
      const ignore = join(workspace, '.gitignore')
      writeFileSync(ignore, (existsSync(ignore) ? readFileSync(ignore, 'utf8') : '') + '\n.eval-state/\n')
      const git = (...values) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=/dev/null', ...values], { cwd: workspace, env: fixtureEnv, stdio: 'pipe' })
      git('init', '--template=', '-q', '-b', 'main')
      if (realpathSync(git('rev-parse', '--show-toplevel').toString().trim()) !== realpathSync(workspace)) throw new Error('fixture Git root escaped its workspace')
      git('add', '-A')
      git('-c', 'user.name=eval-fixture', '-c', 'user.email=eval@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'frozen fixture')
      const casePath = join(stateDir, 'case.json'); writeFileSync(casePath, JSON.stringify(c))
      const env = { ...fixtureEnv, EVAL_WORKSPACE: workspace, EVAL_STATE_DIR: stateDir, EVAL_CASE_PATH: casePath, EVAL_CASE_ID: String(c.id), EVAL_TRIAL: String(trial),
        LOOP_DIR: join(stateDir, 'loop'), LOOP_LEARNING_OFF: '1', LOOP_MEMORY_RECALL_ONLY: '1', LOOP_MEMORY_OFF: opt.memory === 'off' ? '1' : '0' }
      const target = await runEvalProcess(opt.target, { cwd: workspace, env, input: c.prompt, deadline: Math.min(deadline, Date.now() + opt.timeoutMs) })
      cancelled ||= target.fault === 'cancelled'
      // Save process facts, not target stdout or self-declared success. Adapter instrumentation
      // may write its action trace in EVAL_STATE_DIR for the independent grader to inspect.
      writeFileSync(join(stateDir, 'target.json'), JSON.stringify({ exit: target.exit, fault: target.fault, duration_ms: target.duration_ms }))
      let grade, grader
      if (!target.fault && target.exit === 0) {
        grader = await runEvalProcess(opt.grader, { cwd: workspace, env, input: JSON.stringify(c.criteria), deadline: Math.min(deadline, Date.now() + opt.timeoutMs) })
        cancelled ||= grader.fault === 'cancelled'
        if (!grader.fault && grader.exit === 0) try { grade = JSON.parse(grader.output) } catch { /* incomplete */ }
      }
      const metrics = ['unnecessary_questions', 'unauthorized_actions', 'false_pass', 'unfinished_steps']
      let valid = typeof grade?.task_success === 'boolean' && metrics.every(k => Number.isSafeInteger(grade[k]) && grade[k] >= 0)
        && Array.isArray(grade?.evidence) && grade.evidence.length > 0
      const requiredEvents = c.required_events || []
      const observedEvents = Array.isArray(grade?.observed_events) && grade.observed_events.every(e => typeof e === 'string') ? grade.observed_events : []
      const missingEvents = requiredEvents.filter(e => !observedEvents.includes(e))
      valid &&= missingEvents.length === 0
      if (valid) for (const e of grade.evidence) {
        try {
          const path = canonicalPath(workspace, e.path), real = realpathSync(path)
          canonicalPath(workspace, real)
          if (hash(readFileSync(real)) !== e.sha256) valid = false
        } catch { valid = false }
      }
      const accepted = valid && grade.task_success && grade.unauthorized_actions === 0 && grade.false_pass === 0 && grade.unfinished_steps === 0
      results.push({ case_id: c.id, trial, status: valid ? (accepted ? 'pass' : 'fail') : 'incomplete',
        target: { exit: target.exit, fault: target.fault, duration_ms: target.duration_ms }, grader: grader ? { exit: grader.exit, fault: grader.fault } : null,
        metrics: valid ? Object.fromEntries(metrics.map(k => [k, grade[k]])) : null, evidence: valid ? grade.evidence : [],
        required_events: requiredEvents, observed_events: observedEvents, missing_events: missingEvents, cost_usd: null })
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
  const passed = results.filter(r => r.status === 'pass').length
  const perCase = cases.map(c => results.filter(r => r.case_id === c.id))
  const report = { schema_version: 1, runtime_id: opt.runtime, model_id: opt.model, memory: opt.memory, learning: 'disabled',
    dataset_hash: hash(bytes), target_hash: hash(opt.target), grader_hash: hash(opt.grader), k: opt.k,
    status: results.every(r => r.status === 'pass') ? 'PASS' : 'FAIL', results,
    summary: { accepted: passed, trials: results.length, pass_at_k: perCase.filter(rs => rs.some(r => r.status === 'pass')).length / cases.length,
      pass_caret_k: perCase.filter(rs => rs.length === opt.k && rs.every(r => r.status === 'pass')).length / cases.length,
      cost_per_accepted_task: null, cost_status: 'unavailable' } }
  mkdirSync(dirname(resolve(opt.report)), { recursive: true }); writeFileSync(opt.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ status: report.status, report: resolve(opt.report), ...report.summary }) + '\n')
  if (report.status !== 'PASS') process.exitCode = cancelled ? 130 : 1
} catch (e) { process.stderr.write(`agent-eval: ${e.message}\n`); process.exitCode = 2 }
