#!/usr/bin/env node
// classify-risk.mjs — the DETERMINISTIC front end of the human-in-the-loop gate (ADR-0061 §2/§3).
//
// gate.mjs answers "does this need a human?" from three dimensions. It never judged; it only applied
// `rev=none OR blast=high OR cost=high → REQUIRE`. The judgement was always in the OTHER half: WHO
// assigns the dimensions. When /ship-feature absorbed /orchestrate the answer became "the agent doing
// the work" — and an agent that scores its own blast radius turns the gate into decoration. That is
// the same vulnerability `loop-fix.sh --protect` closes with a sha256 snapshot instead of trusting
// "I didn't touch the tests".
//
// So the dimensions are derived from the CHANGE ITSELF first — file paths, commands, stage name —
// and the agent may only ESCALATE, never soften:
//
//   final(dim) = max(rule(dim), agent(dim))          severity-ordered per dimension
//
// Anything no rule covers is left UNSET and handed to gate.mjs, which fails closed to REQUIRE. The
// decision rule itself is not reimplemented here: this tool computes dimensions and then execs
// gate.mjs, so there is exactly one place that decides AUTO vs REQUIRE.
//
// Rule table = externalized (BAC-698 / BAC-563 C5). This file ships NO product-specific rules — the
// dimension-raising rows (which paths are a migration, which are auth, etc.) are domain knowledge
// that belongs to each consumer repo, not to the portable plugin. Point `--rules` at a JSON file (or
// set CLASSIFY_RISK_RULES, or drop `risk-rules.json` at the CWD) shaped like:
//   { "pathRules": [{ "id", "startsWith"?, "endsWith"?, "exact"?, "excludeStartsWith"?,
//                      "dims": {"blast"|"revers"|"cost": <level>}, "deep"?: [<gate>...], "why" }],
//     "commandRules": [{ "id", "patterns": [<regex source>...], "dims", "why" }] }
// With no rules file present, only the structural baselines below apply (docs-only, app-code-low-risk,
// many-files, human-only-stage) — everything else that isn't a human-only stage or an oversized sweep
// resolves to the low-risk baseline, and unmatched *commands* still fail closed to REQUIRE.
//
// Usage:
//   classify-risk.mjs [--from-git [<base>]] [--path <p>]... [--command "<cmd>"]... [--stage <name>]
//                     [--rules <path>]
//                     [--agent-blast-radius <l|m|h> --agent-reversibility <full|partial|none>
//                      --agent-cost <l|m|h>] [--action "<desc>"] [--no-gate] [--json] [--render-md]
//
// Output: a `=== RISK ===` block (rule vs agent vs final, matched rules, track, deep gates) followed
// by gate.mjs's own `=== GATE ===` block. `--render-md` instead renders the verdict as one
// PR-body-ready markdown block with a greppable `<!-- gate-verdict: … -->` marker (BAC-584 AC3 —
// post-hoc audit was body-grep with a 36% hit rate before this).
// Exit: mirrors gate.mjs — 0 = AUTO, 10 = REQUIRE, 11 = DENY_AND_LOG, 2 = usage error.
// `--no-gate` classifies only (0).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const BLAST = ['low', 'medium', 'high']
const REVERS = ['full', 'partial', 'none']
const COST = ['low', 'medium', 'high']
const DIMS = {
  blast: { scale: BLAST, flag: '--blast-radius', label: 'blast_radius' },
  revers: { scale: REVERS, flag: '--reversibility', label: 'reversibility' },
  cost: { scale: COST, flag: '--cost', label: 'cost' },
}

function usage(msg) {
  if (msg) process.stderr.write(`classify-risk: ${msg}\n`)
  process.stderr.write(
    'Usage: classify-risk.mjs [--from-git [<base>]] [--path <p>]... [--command "<cmd>"]... [--stage <name>]\n' +
      '                        [--rules <path>]\n' +
      '                        [--agent-blast-radius <v>] [--agent-reversibility <v>] [--agent-cost <v>]\n' +
      '                        [--action "<desc>"] [--no-gate] [--json] [--render-md]\n',
  )
  process.exit(2)
}

// Deploy / merge / send: irreversible when RUN (editing the script is a repo-specific "ci-deploy"
// path rule, supplied via --rules).
const HUMAN_ONLY_STAGES = new Set(['merge', 'deploy', 'release', 'send'])

// Docs that are neither the constitution (CLAUDE.md) nor decisions (docs/adr/**) carry no runtime
// risk. Giving them a deterministic LOW baseline is what makes the abbreviated track (§3) real —
// otherwise every doc typo would fail closed to REQUIRE and the gate would be pure noise.
// `docs/adr/**` is excluded here because it is a structural constant, not a consumer-supplied rule —
// a repo without ADRs still gets this exemption tightened correctly if it names a different decisions
// directory in its own path rules (a match there simply out-prioritizes this baseline).
const isDocPath = (p) =>
  (p.startsWith('docs/') && !p.startsWith('docs/adr/')) ||
  (p.endsWith('.md') && !p.includes('/') && p !== 'CLAUDE.md')

const MANY_FILES = 10 // gate.mjs guidance: blast `high` ≈ >10 files

// ── args ──────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = {
  paths: [],
  commands: [],
  stage: '',
  action: '',
  agent: { blast: null, revers: null, cost: null },
  fromGit: null,
  rulesPath: null,
  gate: true,
  json: false,
  renderMd: false,
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    if (i + 1 >= argv.length) usage(`${a} requires a value`)
    return argv[++i]
  }
  const optVal = () => (i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : '')
  switch (a) {
    case '--path':
      opt.paths.push(val())
      break
    case '--command':
      opt.commands.push(val())
      break
    case '--stage':
      opt.stage = val()
      break
    case '--action':
      opt.action = val()
      break
    case '--rules':
      opt.rulesPath = val()
      break
    case '--agent-blast-radius':
      opt.agent.blast = val()
      break
    case '--agent-reversibility':
      opt.agent.revers = val()
      break
    case '--agent-cost':
      opt.agent.cost = val()
      break
    case '--from-git':
      opt.fromGit = optVal() || 'origin/develop'
      break
    case '--no-gate':
      opt.gate = false
      break
    case '--json':
      opt.json = true
      break
    case '--render-md':
      opt.renderMd = true
      break
    case '-h':
    case '--help':
      usage()
      break
    default:
      usage(`unknown arg ${a}`)
  }
}

// ── rule table — loaded from JSON, compiled into the same {id, match, dims, deep, why} shape the
// classifier below expects. No file present (and no --rules/CLASSIFY_RISK_RULES) is not an error —
// it just means this consumer hasn't injected any domain rules yet, so only the structural baselines
// apply. A file that fails to parse IS an error (usage exit 2): a rules file the tool silently
// ignored would under-report risk the same way an unresolvable --from-git base would.
function resolveRulesPath() {
  if (opt.rulesPath) return opt.rulesPath
  if (process.env.CLASSIFY_RISK_RULES) return process.env.CLASSIFY_RISK_RULES
  const cwdDefault = join(process.cwd(), 'risk-rules.json')
  return existsSync(cwdDefault) ? cwdDefault : null
}

function loadRulesFile() {
  const path = resolveRulesPath()
  if (!path) return { pathRules: [], commandRules: [] }
  if (!existsSync(path)) usage(`--rules file not found: ${path}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    usage(`--rules file is not valid JSON (${path}): ${String(e.message || e).split('\n')[0]}`)
  }
  return { pathRules: parsed.pathRules || [], commandRules: parsed.commandRules || [] }
}

function compilePathRule(r) {
  const starts = r.startsWith || []
  const ends = r.endsWith || []
  const exact = r.exact || []
  const exclude = r.excludeStartsWith || []
  return {
    id: r.id,
    match: (p) => {
      if (exclude.some((pre) => p.startsWith(pre))) return false
      if (exact.includes(p)) return true
      if (starts.some((pre) => p.startsWith(pre))) return true
      if (ends.some((suf) => p.endsWith(suf))) return true
      return false
    },
    dims: r.dims || {},
    deep: r.deep || [],
    why: r.why || r.id,
  }
}

function compileCommandRule(r) {
  const regexes = (r.patterns || []).map((p) => new RegExp(p))
  return {
    id: r.id,
    match: (c) => regexes.some((re) => re.test(c)),
    dims: r.dims || {},
    why: r.why || r.id,
  }
}

const rulesFile = loadRulesFile()
const PATH_RULES = rulesFile.pathRules.map(compilePathRule)
const COMMAND_RULES = rulesFile.commandRules.map(compileCommandRule)

if (opt.fromGit) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  const base = git(['merge-base', opt.fromGit, 'HEAD']).trim()
  // A base ref we cannot resolve would silently yield "no committed changes" — which under-reports
  // the diff, skips every path rule, and lets a risky change out as AUTO. That is the one direction
  // this tool must never fail in, so an unresolvable base is a usage error, not a warning.
  if (!base) usage(`cannot resolve a merge-base with "${opt.fromGit}" — fetch it, or pass --path explicitly`)
  opt.gitBase = base
  // NUL(-z) 파싱 필수: 비-ASCII·특수문자 경로는 -z 없이는 git이 따옴표로 감싸 내보내고("...\355..."),
  // 그 선행 따옴표가 모든 PATH_RULE startsWith를 비껴간다. BAC-584 이전엔 미매치=fail-closed라
  // 무해했지만, 앱코드 베이스라인 도입 후 미매치 소규모 changeset은 AUTO다 — 따옴표 경로는
  // 규칙 회피 채널이 된다(한글 파일명이 현실적인 레포다). -z는 경로를 원문 그대로 내보낸다.
  // diff/status 실패도 여기선 조용히 삼키지 않는다 — 부분 수집된 미매치 소집합이 AUTO로 새는
  // 방향이라, merge-base와 동일하게 usage 에러(exit 2)로 크게 실패한다.
  const gitStrict = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8' })
    } catch (e) {
      usage(`git ${args[0]} failed in --from-git — ${String(e.message || e).split('\n')[0]}`)
    }
  }
  const committed = gitStrict(['diff', '--name-only', '-z', base, 'HEAD']).split('\0')
  // porcelain -z 포맷: `XY PATH\0`, rename/copy(X∈{R,C})는 뒤에 `ORIGPATH\0`가 하나 더 따른다 —
  // 옛 경로도 만진 표면이다(하네스 파일을 앱 경로로 rename하는 우회 방지).
  const statusTokens = gitStrict(['status', '--porcelain', '--untracked-files=all', '-z']).split('\0')
  const working = []
  for (let i = 0; i < statusTokens.length; i++) {
    const t = statusTokens[i]
    if (!t) continue
    working.push(t.slice(3))
    if (t[0] === 'R' || t[0] === 'C') {
      i += 1
      if (statusTokens[i]) working.push(statusTokens[i])
    }
  }
  for (const p of [...committed, ...working]) {
    if (p && !opt.paths.includes(p)) opt.paths.push(p)
  }
}

// ── classify ──────────────────────────────────────────────────────────────────────────────────────
const rule = { blast: '', revers: '', cost: '' }
const matched = []

const raise = (key, value) => {
  const { scale } = DIMS[key]
  const cur = scale.indexOf(rule[key])
  if (scale.indexOf(value) > cur) rule[key] = value
}
const applyDims = (dims) => {
  for (const [k, v] of Object.entries(dims)) raise(k, v)
}

const deep = new Set()
for (const p of opt.paths) {
  for (const r of PATH_RULES) {
    if (!r.match(p)) continue
    applyDims(r.dims)
    for (const g of r.deep) deep.add(g)
    matched.push(`${r.id} (${p}) — ${r.why}`)
  }
}
for (const c of opt.commands) {
  for (const r of COMMAND_RULES) {
    if (!r.match(c)) continue
    applyDims(r.dims)
    matched.push(`${r.id} (${c}) — ${r.why}`)
  }
}
if (opt.stage && HUMAN_ONLY_STAGES.has(opt.stage)) {
  applyDims({ revers: 'none' })
  matched.push(`human-only-stage (${opt.stage}) — merge/deploy/send are never a classification question (ADR-0061 §5)`)
}
if (opt.paths.length > MANY_FILES) {
  applyDims({ blast: 'high' })
  matched.push(`many-files (${opt.paths.length} > ${MANY_FILES}) — broad change`)
}

const docsOnly = opt.paths.length > 0 && opt.paths.every(isDocPath)
if (docsOnly && matched.length === 0) {
  applyDims({ blast: 'low', revers: 'full', cost: 'low' })
  matched.push('docs-only-baseline — no runtime surface (excludes CLAUDE.md · docs/adr/**)')
}

// App-code low-risk baseline (BAC-584 AC1, symmetric with docs-only): a changeset of ≤MANY_FILES
// files that no rule matched is low/full/low. A 40-sample audit found REQUIRE on 36/40 (90%), and the
// majority of those were "no rule matched → 3 dims unset → fail-closed" — a gate that gives the same
// answer 39 times out of 40 carries no routing signal. "unclassified = REQUIRE" survives only for
// surfaces the rule table has no opinion on at all (an unmatched command, or a >MANY_FILES unmatched
// sweep) — that is the genuine fail-closed intent. Not applied when a command is also present — an
// unmatched command still fails closed.
const appCodeLowRisk =
  !docsOnly &&
  matched.length === 0 &&
  opt.commands.length === 0 &&
  opt.paths.length > 0 &&
  opt.paths.length <= MANY_FILES
if (appCodeLowRisk) {
  applyDims({ blast: 'low', revers: 'full', cost: 'low' })
  matched.push(`app-code-low-risk-baseline — no path rule matched + ≤${MANY_FILES} files (BAC-584)`)
}

// Agent input: escalate-only. An UNRECOGNISED agent value blanks the dimension rather than being
// ignored — an ignored bad value could leave a rule's `low` standing and yield AUTO; an unknown one
// reaches gate.mjs and fails closed.
const final = { ...rule }
const agentNotes = []
const blanked = new Set() // dimensions blanked by garbage agent input — the completion step below must not revive them
for (const [key, { scale, label }] of Object.entries(DIMS)) {
  const v = opt.agent[key]
  if (v === null) continue
  if (!scale.includes(v)) {
    final[key] = ''
    blanked.add(key)
    agentNotes.push(`${label}="${v}" unrecognised → left unset (fail closed)`)
    continue
  }
  if (scale.indexOf(v) > scale.indexOf(final[key])) {
    final[key] = v
    agentNotes.push(`${label}: ${rule[key] || '(no rule)'} → ${v} (agent escalated)`)
  } else if (v !== final[key]) {
    agentNotes.push(`${label}: "${v}" ignored — below the rule value ${final[key]} (no de-escalation)`)
  }
}

// Dimension completion (BAC-584 3-tier): a matched surface that comes from a real rule (PATH/COMMAND
// — not the size-only many-files/baseline rows) has its unset dimensions completed to low/full/low.
// Without this completion, a missing rev/cost on every rule match would fail closed to REQUIRE, and
// the DENY_AND_LOG tier would be structurally unreachable. many-files does not trigger completion — a
// ">MANY_FILES unmatched sweep" stays fail-closed REQUIRE (a surface the rule table has no opinion
// on). A dimension blanked by garbage agent input is not completed either — that blank is the
// intended fail-closed signal.
const knownSurface = matched.some(
  (m) =>
    !m.startsWith('docs-only-baseline') &&
    !m.startsWith('app-code-low-risk-baseline') &&
    !m.startsWith('many-files'),
)
if (knownSurface) {
  const COMPLETE = { blast: 'low', revers: 'full', cost: 'low' }
  for (const k of Object.keys(DIMS)) if (!final[k] && !blanked.has(k)) final[k] = COMPLETE[k]
}

const track = matched.some(
  (m) => !m.startsWith('docs-only-baseline') && !m.startsWith('app-code-low-risk-baseline'),
)
  ? 'risky'
  : docsOnly
    ? 'docs-only'
    : 'standard'
const deepGates = [...deep]

const fmt = (o) => `blast_radius=${o.blast || '?'} reversibility=${o.revers || '?'} cost=${o.cost || '?'}`
const gateArgs = []
for (const [key, { flag }] of Object.entries(DIMS)) {
  if (final[key]) gateArgs.push(flag, final[key])
}
if (opt.action || opt.stage) gateArgs.push('--action', opt.action || `stage: ${opt.stage}`)

if (opt.renderMd) {
  if (!opt.gate) usage('--render-md needs the gate verdict — do not combine with --no-gate')
  if (opt.json) usage('--render-md and --json are mutually exclusive output modes')
  // Delegate to the gate in capture mode (single decision point) and render its verdict as
  // PR-body-ready markdown.
  const res = spawnSync(process.execPath, [join(HERE, 'gate.mjs'), ...gateArgs], { encoding: 'utf8' })
  // No marker on a failed verdict (spawn error / out-of-contract exit code) — a GATE=? marker landing
  // in a PR would let a post-hoc audit grep count it as "evidence loaded" when it wasn't. Capture mode
  // would otherwise swallow gate's stderr, so pass it through for debugging.
  if (res.status !== 0 && res.status !== 10 && res.status !== 11) {
    if (res.stderr) process.stderr.write(res.stderr)
    process.stderr.write(
      `[classify-risk] gate verdict failed (status=${res.status ?? 'spawn-error'}) — no marker emitted (evidence-pollution guard)\n`,
    )
    process.exitCode = 2
  } else {
    const gateOut = res.stdout || ''
    const line = (name) => (gateOut.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1] || '?'
    const verdict = line('GATE')
    // The marker carries STAGE·BASE (merge-base sha) so "which diff was this a verdict on" is
    // self-verifiable.
    const provenance = `STAGE=${opt.stage || '-'} BASE=${opt.gitBase ? opt.gitBase.slice(0, 12) : '-'}`
    process.stdout.write(
      [
        '### Gate verdict — classify-risk (ADR-0061 · 3-tier)',
        '',
        '| Field | Value |',
        '|---|---|',
        `| GATE | **${verdict}** |`,
        `| TRACK | ${track} |`,
        `| FINAL | ${fmt(final)} |`,
        `| DEEP_GATES | ${deepGates.length ? deepGates.join(' · ') : '(none)'} |`,
        `| PATHS | ${opt.paths.length} |`,
        '',
        '**MATCHED**',
        ...(matched.length ? matched.map((m) => `- ${m}`) : ['- (no rule matched)']),
        '',
        `**REASON**: ${line('REASON')}`,
        '',
        `<!-- gate-verdict: GATE=${verdict} TRACK=${track} ${fmt(final)} PATHS=${opt.paths.length} ${provenance} -->`,
        '',
      ].join('\n'),
    )
    process.exitCode = res.status
  }
} else if (opt.json) {
  process.stdout.write(
    `${JSON.stringify({ rule, agent: opt.agent, final, matched, agentNotes, track, deepGates, gateArgs }, null, 2)}\n`,
  )
} else {
  process.stdout.write('=== RISK ===\n')
  process.stdout.write(`STAGE: ${opt.stage || '(unspecified)'}\n`)
  process.stdout.write(`PATHS: ${opt.paths.length}\n`)
  process.stdout.write(`RULE: ${fmt(rule)}\n`)
  process.stdout.write(`FINAL: ${fmt(final)}\n`)
  process.stdout.write(`MATCHED: ${matched.length ? matched.join('; ') : '(no rule matched)'}\n`)
  process.stdout.write(`AGENT: ${agentNotes.length ? agentNotes.join('; ') : '(no agent input)'}\n`)
  process.stdout.write(`TRACK: ${track}\n`)
  process.stdout.write(`DEEP_GATES: ${deepGates.length ? deepGates.join(' ') : '(none)'}\n`)
  process.stdout.write('=== END RISK ===\n')
}

if (!opt.renderMd) {
  if (!opt.gate) process.exit(0)

  // Delegate the AUTO/DENY_AND_LOG/REQUIRE decision to gate.mjs — one decision rule, one place
  // (--render-md delegated above in capture mode). Under --json the gate block goes to stderr so
  // stdout stays parseable; the exit code still carries the verdict.
  // exitCode (not process.exit): exit() terminates before pending stdout flushes, silently
  // truncating large --json output (>64KB pipe buffer) into invalid JSON for the consumer. This is
  // the last statement, so setting exitCode preserves the 0/10/11/2 contract on natural exit.
  const stdio = opt.json ? ['ignore', 2, 2] : 'inherit'
  const res = spawnSync(process.execPath, [join(HERE, 'gate.mjs'), ...gateArgs], { stdio })
  process.exitCode = res.status === null ? 2 : res.status
}
