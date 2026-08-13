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
//   --update-baseline  RECORD mode: write current metrics to --baseline and PASS (no gating).
//
// Defaults: --k 1, --min-pass-at-k 1.0, --min-pass-caret-k 1.0  (strict: every case green every trial).
// Exit: 0 = gate PASS, 1 = gate FAIL, 2 = usage error.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function usage(msg) {
  if (msg) process.stderr.write(`eval-gate: ${msg}\n`)
  process.stderr.write(
    'Usage: eval-gate --dataset <dir|file.jsonl> --target "<cmd>" [--k N] [--judge "<cmd>"]\n' +
    '       [--min-pass-at-k F] [--min-pass-caret-k F] [--allow-skip-semantic]\n' +
    '       [--baseline <file>] [--update-baseline] [--log <path>]\n')
  process.exit(2)
}

// ---- arg parse ----
const argv = process.argv.slice(2)
const opt = { k: 1, minAtK: 1, minCaretK: 1, log: '', dataset: '', target: '', judge: '', baseline: '', updateBaseline: false, allowSkipSemantic: false }
function ratio(s, name) { const v = Number(s); if (!Number.isFinite(v) || v < 0 || v > 1) usage(`${name} must be a number in [0,1] (got ${JSON.stringify(s)})`); return v }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { if (i + 1 >= argv.length) usage(`${a} requires a value`); return argv[++i] }
  switch (a) {
    case '--dataset': opt.dataset = val(); break
    case '--target': opt.target = val(); break
    case '--k': opt.k = parseInt(val(), 10); break
    case '--judge': opt.judge = val(); break
    case '--min-pass-at-k': opt.minAtK = ratio(val(), '--min-pass-at-k'); break
    case '--min-pass-caret-k': opt.minCaretK = ratio(val(), '--min-pass-caret-k'); break
    case '--allow-skip-semantic': opt.allowSkipSemantic = true; break
    case '--baseline': opt.baseline = val(); break
    case '--update-baseline': opt.updateBaseline = true; break
    case '--log': opt.log = val(); break
    case '-h': case '--help': usage(); break
    default: usage(`unknown arg ${a}`)
  }
}
if (!opt.dataset) usage('--dataset is required')
if (!opt.target) usage('--target is required')
if (!Number.isInteger(opt.k) || opt.k < 1) usage('--k must be a positive integer')

// ---- load the golden dataset (dir of *.json, or a .jsonl) ----
const ASSERT_KEYS = ['contains', 'not_contains', 'regex', 'equals', 'semantic', 'max_ms', 'exit_zero']
function effectiveAsserts(a) {
  if (!a || typeof a !== 'object') return 0
  return ASSERT_KEYS.filter(k => k in a).length
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
  const child = "let re;try{re=new RegExp(process.env.RX)}catch(e){process.exit(2)}" +
    "let t='';process.stdin.on('data',d=>t+=d);process.stdin.on('end',()=>process.exit(re.test(t)?0:1))"
  const r = spawnSync(process.execPath, ['-e', child], { input: String(text), encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RX: pattern } })
  if (r.status === 0) return { match: true }
  if (r.status === 1) return { match: false }
  if (r.status === 2) return { match: false, error: `invalid regex /${pattern}/` }
  if (r.status == null) return { match: false, error: `regex timed out — possible ReDoS /${pattern}/` }
  return { match: false, error: `regex eval error /${pattern}/` }
}

function runTrial(c, trial) {
  const t0 = Date.now()
  const hardTimeout = Math.max((c.assert?.max_ms || 0) * 5, 30000)
  const r = spawnSync('sh', ['-c', opt.target], {
    input: String(c.input ?? ''), encoding: 'utf8', timeout: hardTimeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, EVAL_TRIAL: String(trial), EVAL_CASE_ID: String(c.id) },
  })
  let code = r.status, fault = null
  if (r.status == null) {                       // killed: distinguish the cause, don't call everything a timeout
    const ec = r.error && r.error.code
    if (ec === 'ETIMEDOUT') { fault = 'timeout: target exceeded hard limit'; code = 124 }
    else if (ec === 'ENOBUFS') { fault = 'output_too_large: target stdout exceeded 64MB'; code = 125 }
    else if (ec === 'ENOENT') { fault = 'target_not_found: command not executable'; code = 127 }
    else if (r.signal) { fault = `killed by signal ${r.signal}`; code = 128 }
    else { fault = `spawn error ${ec || 'unknown'}`; code = 126 }
  }
  return { out: r.stdout || '', code, ms: Date.now() - t0, fault }
}

function grade(c, res) {
  const a = c.assert || {}, fails = []
  if (res.fault) { fails.push(res.fault); return fails }   // a faulted run fails outright; don't grade truncated output
  if (a.exit_zero !== false && res.code !== 0) fails.push(`exit_zero: exited ${res.code}`)
  for (const s of (a.contains || [])) if (!res.out.includes(s)) fails.push(`contains: missing ${JSON.stringify(s)}`)
  for (const s of (a.not_contains || [])) if (res.out.includes(s)) fails.push(`not_contains: found ${JSON.stringify(s)}`)
  if (a.regex) { const m = regexMatch(a.regex, res.out); if (m.error) fails.push(m.error); else if (!m.match) fails.push(`regex: no match /${a.regex}/`) }
  if (a.equals != null && res.out.trim() !== String(a.equals).trim()) fails.push(`equals: got ${JSON.stringify(res.out.trim().slice(0, 60))}`)
  if (a.max_ms != null && res.ms > a.max_ms) fails.push(`max_ms: ${res.ms}ms > ${a.max_ms}ms`)
  if (a.semantic) {
    if (!opt.judge) {
      if (opt.allowSkipSemantic) semanticSkipped = true
      else fails.push(`semantic: no --judge configured (pass --allow-skip-semantic to skip intentionally)`)
    } else {
      const jr = spawnSync('sh', ['-c', opt.judge], { input: res.out, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, EVAL_CRITERION: a.semantic } })
      if ((jr.status ?? 1) !== 0) fails.push(`semantic: judge rejected (${a.semantic})`)
    }
  }
  return fails
}

const logLines = []
let trialsTotal = 0, trialsPassed = 0
const perCase = []
for (const c of cases) {
  let anyPass = false, allPass = true
  const detail = []
  for (let t = 1; t <= opt.k; t++) {
    const res = runTrial(c, t)
    const fails = grade(c, res)
    const ok = fails.length === 0
    trialsTotal++; if (ok) trialsPassed++
    anyPass = anyPass || ok; allPass = allPass && ok
    logLines.push(`[${c.id} trial ${t}/${opt.k}] ${ok ? 'PASS' : 'FAIL'} code=${res.code} ${res.ms}ms ${fails.join('; ')}`.trim())
    if (!ok) detail.push(`trial ${t}: ${fails.join('; ')}`)
  }
  perCase.push({ id: c.id, anyPass, allPass, detail })
}
if (semanticSkipped) notes.push('semantic assertions skipped (--allow-skip-semantic; no --judge)')

const N = cases.length
const passAtK = perCase.filter(c => c.anyPass).length / N
const passCaretK = perCase.filter(c => c.allPass).length / N
const EPS = 1e-9
const f4 = x => x.toFixed(4)

// ---- gate (skipped entirely in RECORD mode) ----
const recording = opt.updateBaseline && !!opt.baseline
const gateFails = []
if (!recording) {
  if (passAtK < opt.minAtK - EPS) gateFails.push(`pass_at_k ${f4(passAtK)} < min ${opt.minAtK}`)
  if (passCaretK < opt.minCaretK - EPS) gateFails.push(`pass_caret_k ${f4(passCaretK)} < min ${opt.minCaretK}`)
  if (opt.baseline && existsSync(opt.baseline)) {
    let b = null
    try { b = JSON.parse(readFileSync(opt.baseline, 'utf8')) } catch (e) { gateFails.push(`baseline unreadable: ${e.message}`) }
    if (b) {
      const bat = b.pass_at_k, bct = b.pass_caret_k
      if (![bat, bct].every(x => Number.isFinite(x) && x >= 0 && x <= 1)) {
        gateFails.push('baseline malformed: pass_at_k/pass_caret_k not finite in [0,1]')
      } else {
        if (passAtK < bat - EPS) gateFails.push(`regression: pass_at_k ${f4(passAtK)} < baseline ${bat}`)
        if (passCaretK < bct - EPS) gateFails.push(`regression: pass_caret_k ${f4(passCaretK)} < baseline ${bct}`)
        if (b.k !== opt.k || b.cases !== N) notes.push(`baseline mismatch: recorded k=${b.k} cases=${b.cases}, current k=${opt.k} cases=${N} — comparison may be invalid`)
      }
    }
  }
}

// ---- write log + (record mode) baseline ----
const logPath = opt.log || join(process.env.LOOP_DIR || '.loop', 'eval-last.log')
mkdirSync(dirname(resolve(logPath)), { recursive: true })
writeFileSync(logPath, logLines.join('\n') + '\n')
if (recording) {
  mkdirSync(dirname(resolve(opt.baseline)), { recursive: true })
  writeFileSync(opt.baseline, JSON.stringify({ pass_at_k: passAtK, pass_caret_k: passCaretK, k: opt.k, cases: N }, null, 2) + '\n')
  notes.push(`baseline recorded -> ${opt.baseline} (pass_at_k=${f4(passAtK)} pass_caret_k=${f4(passCaretK)})`)
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
