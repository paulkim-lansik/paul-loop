#!/usr/bin/env node
// eval-gate.mjs — Phase 2 of loop-engine: a golden-dataset eval gate with pass@k / pass^k.
//
// Runs each case in a small golden dataset against a target command k times, grades the output
// with multi-type assertions, and computes:
//   pass@k   — fraction of cases where AT LEAST ONE of k trials passed (the ceiling)
//   pass^k   — fraction of cases where ALL k trials passed            (the floor / reliability)
// Research: a system with high pass@k but low pass^k is NOT production-ready (Sierra τ-bench).
//
// It emits the SAME machine-readable VERDICT block as verdict-run.sh (docs/verdict-contract.md),
// so it works both as a CI merge gate (exit 0/1) and as a --verify target for loop-fix.sh.
//
// Usage:
//   eval-gate.mjs --dataset <dir|file.jsonl> --target "<cmd>" [--k N] [--judge "<cmd>"]
//                 [--min-pass-at-k F] [--min-pass-caret-k F] [--allow-skip-semantic]
//                 [--baseline <file>] [--update-baseline] [--log <path>]
//
//   --target runs once per trial: case input on STDIN, output on STDOUT, exit code observed.
//            Env per trial: EVAL_TRIAL (1..k), EVAL_CASE_ID. Run via `sh -c`.
//   --judge  optional SEPARATE evaluator for `semantic` assertions (generator != evaluator):
//            output on STDIN, criterion in env EVAL_CRITERION; exit 0 = pass.
//            Without --judge, a `semantic` assertion FAILS closed unless --allow-skip-semantic.
//   --baseline  regression gate: fail if pass@k / pass^k dropped below the stored baseline.
//   --update-baseline  RECORD mode: write metrics and an explicit non-gating result (exit 1).
//
// Defaults: --k 1, --min-pass-at-k 1.0, --min-pass-caret-k 1.0  (strict: every case green every trial).
// Exit: 0 = gate PASS, 1 = gate FAIL, 2 = usage error.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runEvalProcess } from '../lib/agent-eval-process.mjs'

function usage(msg) {
  if (msg) process.stderr.write(`eval-gate: ${msg}\n`)
  process.stderr.write(
    'Usage: eval-gate --dataset <dir|file.jsonl> --target "<cmd>" [--k N] [--judge "<cmd>"]\n' +
    '       [--min-pass-at-k F] [--min-pass-caret-k F] [--allow-skip-semantic]\n' +
    '       [--baseline <file> --target-id <version>] [--update-baseline] [--judge-id <version>] [--log <path>] [--budget-ms N]\n')
  process.exit(2)
}

// ---- arg parse ----
const argv = process.argv.slice(2)
const opt = { k: 1, minAtK: 1, minCaretK: 1, log: '', dataset: '', target: '', judge: '', baseline: '', updateBaseline: false, allowSkipSemantic: false, targetId: '', judgeId: '', budgetMs: 300000 }
function ratio(s, name) { const v = Number(s); if (!Number.isFinite(v) || v < 0 || v > 1) usage(`${name} must be a number in [0,1] (got ${JSON.stringify(s)})`); return v }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { if (i + 1 >= argv.length) usage(`${a} requires a value`); return argv[++i] }
  switch (a) {
    case '--dataset': opt.dataset = val(); break
    case '--target': opt.target = val(); break
    case '--k': opt.k = Number(val()); break
    case '--judge': opt.judge = val(); break
    case '--min-pass-at-k': opt.minAtK = ratio(val(), '--min-pass-at-k'); break
    case '--min-pass-caret-k': opt.minCaretK = ratio(val(), '--min-pass-caret-k'); break
    case '--allow-skip-semantic': opt.allowSkipSemantic = true; break
    case '--budget-ms': opt.budgetMs = Number(val()); break
    case '--target-id': opt.targetId = val(); break
    case '--judge-id': opt.judgeId = val(); break
    case '--baseline': opt.baseline = val(); break
    case '--update-baseline': opt.updateBaseline = true; break
    case '--log': opt.log = val(); break
    case '-h': case '--help': usage(); break
    default: usage(`unknown arg ${a}`)
  }
}
if (!opt.dataset) usage('--dataset is required')
if (!opt.target) usage('--target is required')
if (!Number.isSafeInteger(opt.k) || opt.k < 1) usage('--k must be a positive integer')

if (!Number.isSafeInteger(opt.budgetMs) || opt.budgetMs < 1) usage('--budget-ms must be a positive integer')
const evaluationDeadline = Date.now() + opt.budgetMs
let cancelled = false
if (opt.updateBaseline && !opt.baseline) usage('--update-baseline requires --baseline')
if (opt.baseline && !opt.targetId) usage('--baseline requires --target-id identifying the model/config/tool revision')
if (opt.baseline && opt.judge && !opt.judgeId) usage('--baseline with a judge requires --judge-id')

// ---- load the golden dataset (dir of *.json, or a .jsonl) ----
const ASSERT_KEYS = ['contains', 'not_contains', 'regex', 'equals', 'semantic', 'max_ms', 'exit_zero']
function effectiveAsserts(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 0
  for (const key of Object.keys(a)) if (!ASSERT_KEYS.includes(key)) usage(`unknown assertion ${key}`)
  for (const key of ['contains', 'not_contains']) if (key in a && (!Array.isArray(a[key]) || a[key].some(v => typeof v !== 'string' || !v.length))) usage(`${key} requires non-empty strings`)
  for (const key of ['regex', 'semantic']) if (key in a && (typeof a[key] !== 'string' || !a[key].trim())) usage(`${key} requires a non-empty string`)
  if ('exit_zero' in a && typeof a.exit_zero !== 'boolean') usage('exit_zero must be boolean')
  if ('max_ms' in a && (!Number.isFinite(a.max_ms) || a.max_ms <= 0)) usage('max_ms must be positive')
  if ('equals' in a && (a.equals == null || !['string', 'number', 'boolean'].includes(typeof a.equals))) usage('equals requires a scalar')
  return (a.exit_zero === true ? 1 : 0) + (a.contains?.length || 0) + (a.not_contains?.length || 0)
    + (a.regex ? 1 : 0) + ('equals' in a ? 1 : 0) + (a.max_ms ? 1 : 0)
    + (a.semantic && !(opt.allowSkipSemantic && !opt.judge) ? 1 : 0)
}
function loadCases(ds) {
  const out = []
  if (ds.endsWith('.jsonl')) {
    readFileSync(ds, 'utf8').split('\n').forEach((l, idx) => {
      if (!l.trim()) return
      let c; try { c = JSON.parse(l) } catch (e) { usage(`bad JSON in ${ds} line ${idx + 1}: ${e.message}`) }
      if (!c.id) c.id = `case-${idx + 1}`; out.push(c)
    })
  } else {
    for (const f of readdirSync(ds).filter(f => f.endsWith('.json')).sort()) {
      let c; try { c = JSON.parse(readFileSync(join(ds, f), 'utf8')) } catch (e) { usage(`bad JSON in ${f}: ${e.message}`) }
      if (!c.id) c.id = f.replace(/\.json$/, ''); out.push(c)
    }
  }
  for (const c of out) if (effectiveAsserts(c.assert) === 0) usage(`case ${JSON.stringify(c.id)} has no assertions (nothing to grade)`)
  if (new Set(out.map(c => c.id)).size !== out.length) usage('duplicate case ids')
  return out
}
let cases
try { cases = loadCases(opt.dataset) } catch (e) { usage(`cannot load dataset: ${e.message}`) }
if (cases.length === 0) usage('dataset has no cases')

// ---- run + grade ----
const notes = []
let semanticSkipped = false

// Bound a (possibly catastrophic-backtracking) dataset regex in a child node with a wall-clock
// timeout, so a poisoned `regex` assertion can't ReDoS-hang the whole gate on the main thread.
function regexMatch(pattern, text) {
  const remaining = evaluationDeadline - Date.now()
  if (remaining <= 0) return { match: false, error: 'regex not run: total budget exhausted' }
  const child = "let re;try{re=new RegExp(process.env.RX)}catch(e){process.exit(2)}" +
    "let t='';process.stdin.on('data',d=>t+=d);process.stdin.on('end',()=>process.exit(re.test(t)?0:1))"
  const r = spawnSync(process.execPath, ['-e', child], { input: String(text), encoding: 'utf8', timeout: Math.min(2000, remaining), maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RX: pattern } })
  if (r.status === 0) return { match: true }
  if (r.status === 1) return { match: false }
  if (r.status === 2) return { match: false, error: `invalid regex /${pattern}/` }
  if (r.status == null) return { match: false, error: `regex timed out — possible ReDoS /${pattern}/` }
  return { match: false, error: `regex eval error /${pattern}/` }
}

async function runTrial(c, trial) {
  const hardTimeout = Math.max((c.assert?.max_ms || 0) * 5, 30000)
  const r = await runEvalProcess(opt.target, {
    cwd: process.cwd(), input: String(c.input ?? ''), deadline: Math.min(evaluationDeadline, Date.now() + hardTimeout), maxBytes: 64 * 1024 * 1024,
    env: { ...process.env, EVAL_TRIAL: String(trial), EVAL_CASE_ID: String(c.id) },
  })
  cancelled ||= r.fault === 'cancelled'
  return { out: r.output, code: r.exit ?? 124, ms: r.duration_ms, fault: r.fault }
}

async function grade(c, res) {
  const a = c.assert || {}, fails = []
  if (res.fault) { res.incomplete = true; fails.push(res.fault); return fails }   // a faulted run fails outright; don't grade truncated output
  if (a.exit_zero !== false && res.code !== 0) fails.push(`exit_zero: exited ${res.code}`)
  for (const s of (a.contains || [])) if (!res.out.includes(s)) fails.push(`contains: missing ${JSON.stringify(s)}`)
  for (const s of (a.not_contains || [])) if (res.out.includes(s)) fails.push(`not_contains: found ${JSON.stringify(s)}`)
  if (a.regex) { const m = regexMatch(a.regex, res.out); if (m.error) { res.incomplete = true; fails.push(m.error) } else if (!m.match) fails.push(`regex: no match /${a.regex}/`) }
  if (a.equals != null && res.out.trim() !== String(a.equals).trim()) fails.push(`equals: got ${JSON.stringify(res.out.trim().slice(0, 60))}`)
  if (a.max_ms != null && res.ms > a.max_ms) fails.push(`max_ms: ${res.ms}ms > ${a.max_ms}ms`)
  if (a.semantic) {
    if (!opt.judge) {
      if (opt.allowSkipSemantic) semanticSkipped = true
      else fails.push(`semantic: no --judge configured (pass --allow-skip-semantic to skip intentionally)`)
    } else {
      const jr = await runEvalProcess(opt.judge, { cwd: process.cwd(), input: res.out, deadline: Math.min(evaluationDeadline, Date.now() + 60000), maxBytes: 16 * 1024 * 1024, env: { ...process.env, EVAL_CRITERION: a.semantic } })
      cancelled ||= jr.fault === 'cancelled'
      if (jr.fault) res.incomplete = true
      if (jr.fault || jr.exit !== 0) fails.push(`semantic: judge rejected or incomplete (${jr.fault || jr.exit})`)

    }
  }
  return fails
}

const logLines = []
let trialsTotal = 0, trialsPassed = 0, notRun = 0, incompleteTrials = 0
const perCase = []
for (const c of cases) {
  let anyPass = false, allPass = true
  const detail = []
  for (let t = 1; t <= opt.k; t++) {
    if (cancelled || Date.now() >= evaluationDeadline) {
      notRun += opt.k - t + 1; allPass = false; detail.push('not_run: cancelled or total budget exhausted'); break
    }
    const res = await runTrial(c, t)
    const fails = await grade(c, res)
    if (res.incomplete || Date.now() >= evaluationDeadline) incompleteTrials++
    const ok = fails.length === 0
    trialsTotal++; if (ok) trialsPassed++
    anyPass = anyPass || ok; allPass = allPass && ok
    logLines.push(`[${c.id} trial ${t}/${opt.k}] ${ok ? 'PASS' : 'FAIL'} code=${res.code} ${res.ms}ms ${fails.join('; ')}`.trim())
    if (!ok) detail.push(`trial ${t}: ${fails.join('; ')}`)
  }
  perCase.push({ id: c.id, anyPass, allPass, detail })
}
if (notRun) notes.push(`${notRun} trials not run: total budget/cancellation`)
if (semanticSkipped) notes.push('semantic assertions skipped (--allow-skip-semantic; no --judge)')

const N = cases.length
const passAtK = perCase.filter(c => c.anyPass).length / N
const passCaretK = perCase.filter(c => c.allPass).length / N
const EPS = 1e-9
const f4 = x => x.toFixed(4)

// Baselines bind the dataset and execution identities. A new dataset/model/judge needs an
// explicit new baseline, never a warning followed by a successful comparison.
const hash = value => createHash('sha256').update(value).digest('hex')
const identity = {
  dataset_hash: hash(JSON.stringify(cases)), target_id: opt.targetId, target_hash: hash(opt.target),
  judge_id: opt.judgeId, judge_hash: hash(opt.judge), grader_hash: hash(readFileSync(new URL(import.meta.url))), process_runner_hash: hash(readFileSync(new URL('../lib/agent-eval-process.mjs', import.meta.url))),
  k: opt.k, cases: N, budget_ms: opt.budgetMs, allow_skip_semantic: opt.allowSkipSemantic,
}
const recording = opt.updateBaseline
const gateFails = []
if (notRun || incompleteTrials || cancelled || Date.now() >= evaluationDeadline) gateFails.push('evaluation incomplete: trial fault, total budget or cancellation')
if (passAtK < opt.minAtK - EPS) gateFails.push(`pass_at_k ${f4(passAtK)} < min ${opt.minAtK}`)
if (passCaretK < opt.minCaretK - EPS) gateFails.push(`pass_caret_k ${f4(passCaretK)} < min ${opt.minCaretK}`)
if (opt.baseline && !recording) {
  let b
  try { b = JSON.parse(readFileSync(opt.baseline, 'utf8')) }
  catch (e) { gateFails.push(`baseline missing or unreadable: ${e.message}`) }
  if (!b || typeof b !== 'object' || Array.isArray(b)) gateFails.push('baseline malformed: expected a non-null object')
  else {
    if (b.schema_version !== 2 || JSON.stringify(b.identity) !== JSON.stringify(identity)) gateFails.push('baseline identity mismatch: dataset, target, judge, grader or trial configuration changed')
    if (![b.pass_at_k, b.pass_caret_k].every(x => Number.isFinite(x) && x >= 0 && x <= 1)) gateFails.push('baseline malformed: metrics not finite in [0,1]')
    else {
      if (passAtK < b.pass_at_k - EPS) gateFails.push(`regression: pass_at_k ${f4(passAtK)} < baseline ${b.pass_at_k}`)
      if (passCaretK < b.pass_caret_k - EPS) gateFails.push(`regression: pass_caret_k ${f4(passCaretK)} < baseline ${b.pass_caret_k}`)
    }
  }
}
const qualityStatus = gateFails.length ? 'FAIL' : 'PASS'
if (recording) gateFails.push('baseline recorded; RECORD is not verification — rerun without --update-baseline')

// ---- write log + (record mode) baseline ----
const logPath = opt.log || join(process.env.LOOP_DIR || '.loop', 'eval-last.log')
mkdirSync(dirname(resolve(logPath)), { recursive: true })
writeFileSync(logPath, logLines.join('\n') + '\n')
if (recording) {
  mkdirSync(dirname(resolve(opt.baseline)), { recursive: true })
  writeFileSync(opt.baseline, JSON.stringify({ schema_version: 2, identity, pass_at_k: passAtK, pass_caret_k: passCaretK, quality_status: qualityStatus, operation_status: 'recorded' }, null, 2) + '\n')
  notes.push(`quality_status=${qualityStatus}; operation_status=recorded; baseline recorded -> ${opt.baseline} (pass_at_k=${f4(passAtK)} pass_caret_k=${f4(passCaretK)})`)
}

// ---- emit the VERDICT block (same contract as verdict-run.sh) ----
const verdict = gateFails.length === 0 ? 'PASS' : 'FAIL'
const exit = verdict === 'PASS' ? 0 : 1
const lines = ['=== VERDICT ===', `VERDICT: ${verdict}`, `EXIT: ${exit}`,
  `SUMMARY: cases=${N} k=${opt.k} pass_at_k=${passAtK.toFixed(2)} pass_caret_k=${passCaretK.toFixed(2)} trials=${trialsPassed}/${trialsTotal}`]
if (verdict === 'FAIL') {
  for (const g of gateFails) lines.push(`FAIL: gate: ${g}`)
  for (const c of perCase.filter(c => !c.allPass).slice(0, 20)) lines.push(`FAIL: ${c.id}: ${c.detail[0] || 'not all trials passed'}`)
}
for (const n of notes) lines.push(`NOTE: ${n}`)
lines.push(`LOG: ${resolve(logPath)}`, '=== END VERDICT ===')
process.stdout.write(lines.join('\n') + '\n')
process.exit(exit)
