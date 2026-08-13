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
// Usage:
//   classify-risk.mjs [--from-git [<base>]] [--path <p>]... [--command "<cmd>"]... [--stage <name>]
//                     [--agent-blast-radius <l|m|h>] [--agent-reversibility <full|partial|none>]
//                     [--agent-cost <l|m|h>] [--action "<desc>"] [--no-gate] [--json] [--render-md]
//
// Output: a `=== RISK ===` block (rule vs agent vs final, matched rules, track, deep gates) followed
// by gate.mjs's own `=== GATE ===` block. `--render-md` instead renders the verdict as one
// PR-body-ready markdown block with a greppable `<!-- gate-verdict: … -->` marker (BAC-584 AC3 —
// post-hoc audit was body-grep with a 36% hit rate before this).
// Exit: mirrors gate.mjs — 0 = AUTO, 10 = REQUIRE, 11 = DENY_AND_LOG, 2 = usage error.
// `--no-gate` classifies only (0).

import { execFileSync, spawnSync } from 'node:child_process'
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
      '                        [--agent-blast-radius <v>] [--agent-reversibility <v>] [--agent-cost <v>]\n' +
      '                        [--action "<desc>"] [--no-gate] [--json] [--render-md]\n',
  )
  process.exit(2)
}

// ── The rule table ────────────────────────────────────────────────────────────────────────────────
// One row = one reason a change is risky, with the dimension(s) it forces and the deep gates the
// change makes mandatory. Rows are additive: every match contributes, the strictest value wins.
// Keep this list SHORT and tied to the surfaces ADR-0061 §3 names (마이그레이션·인증·RLS·하네스·배포)
// — a sprawling table stops being auditable, which is the whole point of being deterministic.

const PATH_RULES = [
  {
    id: 'db-migration',
    match: (p) => p.startsWith('packages/db/drizzle/'),
    dims: { revers: 'none' },
    deep: ['verify:rls'],
    why: '적용된 마이그레이션은 되돌릴 수 없다',
  },
  {
    id: 'db-schema',
    // packages/db/test/** 포함 — RLS 격리 *증명* 테스트의 희석은 스키마 변경만큼 게이트를 약화한다
    // (require-tests.sh는 삭제만 막고 희석은 못 본다).
    match: (p) => p.startsWith('packages/db/src/') || p.startsWith('packages/db/test/'),
    dims: { blast: 'high' },
    deep: ['verify:rls'],
    why: 'RLS·테넌트 격리 표면 (ADR-0001/0003)',
  },
  {
    id: 'auth',
    match: (p) =>
      p.startsWith('apps/api/src/auth/') ||
      p.startsWith('apps/api/src/partner-auth/') ||
      p.startsWith('apps/api/src/impersonation/') ||
      p.endsWith('.guard.ts'),
    dims: { blast: 'high' },
    deep: ['verify:auth', 'verify:e2e'],
    why: '인증·인가 불변식 (ADR-0026/0027/0032)',
  },
  {
    id: 'outbound',
    match: (p) =>
      p.startsWith('apps/api/src/alimtalk-send/') || p.startsWith('apps/api/src/revisit-calls/'),
    dims: { blast: 'high' },
    deep: [],
    why: '실제 환자에게 나가는 발송·통화 표면',
  },
  {
    id: 'harness',
    // .loop/lessons/**는 제외 — 교훈 데이터 파일은 검증기를 좌우하지 않는다(guard-off·protect.globs·
    // looping 센티넬 등 .loop/의 나머지는 가드 설정 그 자체다). tools/**·.husky/**는 검증기·게이트
    // 스크립트의 집이라 전부 하네스다(BAC-584 리뷰: 베이스라인 도입으로 규칙 표의 완전성이
    // load-bearing이 됐다 — 가드 자기설정이 AUTO로 새면 안 된다).
    match: (p) =>
      p.startsWith('.claude/') ||
      p === 'CLAUDE.md' ||
      p.startsWith('tools/') ||
      p.startsWith('.husky/') ||
      (p.startsWith('.loop/') && !p.startsWith('.loop/lessons/')) ||
      p.startsWith('docs/adr/'),
    dims: { blast: 'high' },
    deep: [],
    why: '하네스·헌법 층 — 이후 모든 작업에 영향',
  },
  {
    id: 'ci-deploy-infra',
    // infra/**(Terraform·secret_keys 스키마)와 apps/api/src/env.ts(부팅 env zod)는 배포 시점에야
    // 터지는 표면이다(CLAUDE.md §7 — 2회 재발 실측). 베이스라인 도입 후 여기 없으면 AUTO로 샌다.
    match: (p) =>
      p.startsWith('.github/') ||
      p.startsWith('tools/deploy/') ||
      p.startsWith('infra/') ||
      p === 'apps/api/src/env.ts',
    dims: { blast: 'high' },
    deep: [],
    why: 'CI·배포·인프라 파이프라인 자체',
  },
  {
    id: 'workspace-root',
    match: (p) =>
      p === 'package.json' ||
      p === 'pnpm-workspace.yaml' ||
      p === 'pnpm-lock.yaml' ||
      p === 'turbo.json' ||
      p === 'biome.json',
    dims: { blast: 'high' },
    deep: [],
    why: '워크스페이스 루트 설정 — 전 패키지 영향',
  },
]

// Deploy / merge / send: irreversible when RUN (editing the script is `ci-deploy-infra` above).
const COMMAND_RULES = [
  {
    id: 'cmd-irreversible',
    match: (c) =>
      /\bgh\s+pr\s+merge\b/.test(c) ||
      /\bgit\s+push\b[^|;&]*\b(main|develop)\b/.test(c) ||
      // `pnpm run deploy`/`pnpm run redeploy`가 레포 정본 별칭(루트 package.json scripts)이다 —
      // bare-`pnpm deploy`만 매칭하면 그 별칭이 AUTO로 샌다(BAC-563에서 실측, BAC-616 ask 규칙과 정합).
      /\bpnpm\s+(run\s+)?(deploy|redeploy)\b/.test(c) ||
      /tools\/deploy\//.test(c) ||
      /\b(vercel|flyctl)\s+deploy\b/.test(c),
    dims: { revers: 'none' },
    why: '배포·머지 명령 — 실행 즉시 공유 상태를 바꾼다',
  },
]

// ADR-0061 §5: merge/deploy/release/send are NEVER a classification question. Always a human.
const HUMAN_ONLY_STAGES = new Set(['merge', 'deploy', 'release', 'send'])

// Docs that are neither the constitution (CLAUDE.md) nor decisions (docs/adr/**) carry no runtime
// risk. Giving them a deterministic LOW baseline is what makes the abbreviated track (§3) real —
// otherwise every doc typo would fail closed to REQUIRE and the gate would be pure noise.
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
  matched.push(`human-only-stage (${opt.stage}) — 머지·배포·발송은 분류 대상이 아니다 (ADR-0061 §5)`)
}
if (opt.paths.length > MANY_FILES) {
  applyDims({ blast: 'high' })
  matched.push(`many-files (${opt.paths.length} > ${MANY_FILES}) — 광범위 변경`)
}

const docsOnly = opt.paths.length > 0 && opt.paths.every(isDocPath)
if (docsOnly && matched.length === 0) {
  applyDims({ blast: 'low', revers: 'full', cost: 'low' })
  matched.push('docs-only-baseline — 런타임 표면 없음 (CLAUDE.md·docs/adr/** 제외)')
}

// 앱코드 저위험 베이스라인 (BAC-584 AC1, docs-only와 대칭 — 사용자 승인 2026-08-05): 어떤 규칙도
// 안 걸린 ≤MANY_FILES 파일 changeset은 low/full/low. 실측 40건 표본에서 REQUIRE 36/40(90%)의 다수가
// "규칙 미매치 → 3축 미지정 → fail-closed"였다 — 40번 물어 39번 같은 답을 내는 게이트는 라우팅
// 신호가 아니다. "미분류=REQUIRE"는 규칙 테이블이 아예 모르는 표면(미매치 명령·>MANY_FILES 미매치
// 스윕)에만 남는다(진짜 fail-closed 의도). 명령이 함께 있으면 적용하지 않는다 — 미매치 명령은
// 여전히 fail-closed다.
const appCodeLowRisk =
  !docsOnly &&
  matched.length === 0 &&
  opt.commands.length === 0 &&
  opt.paths.length > 0 &&
  opt.paths.length <= MANY_FILES
if (appCodeLowRisk) {
  applyDims({ blast: 'low', revers: 'full', cost: 'low' })
  matched.push(`app-code-low-risk-baseline — PATH_RULE 미매치 + ≤${MANY_FILES}파일 (BAC-584)`)
}

// Agent input: escalate-only. An UNRECOGNISED agent value blanks the dimension rather than being
// ignored — an ignored bad value could leave a rule's `low` standing and yield AUTO; an unknown one
// reaches gate.mjs and fails closed.
const final = { ...rule }
const agentNotes = []
const blanked = new Set() // 에이전트 garbage 값으로 블랭크된 차원 — 아래 완성 단계가 되살리면 안 된다
for (const [key, { scale, label }] of Object.entries(DIMS)) {
  const v = opt.agent[key]
  if (v === null) continue
  if (!scale.includes(v)) {
    final[key] = ''
    blanked.add(key)
    agentNotes.push(`${label}="${v}" 인식 불가 → 미지정 처리(fail closed)`)
    continue
  }
  if (scale.indexOf(v) > scale.indexOf(final[key])) {
    final[key] = v
    agentNotes.push(`${label}: ${rule[key] || '(규칙 없음)'} → ${v} (에이전트 상향)`)
  } else if (v !== final[key]) {
    agentNotes.push(`${label}: "${v}" 무시 — 규칙값 ${final[key]}보다 낮다 (하향 불가)`)
  }
}

// 차원 완성 (BAC-584 3-tier): 실질 규칙(PATH/COMMAND — 크기만 아는 many-files·베이스라인 제외)이
// 매치된 표면은 미지정 차원을 low/full/low로 완성한다. 이 완성 없이는 rev/cost 누락 fail-closed가
// 모든 규칙 매치를 REQUIRE로 밀어 DENY_AND_LOG 티어가 구조적으로 도달 불가다. many-files는 완성
// 트리거가 아니다 — ">MANY_FILES 미매치 스윕"은 여전히 fail-closed REQUIRE(규칙 테이블이 모르는
// 표면). 에이전트 garbage 값으로 블랭크된 차원은 완성하지 않는다(그 블랭크가 fail-closed 의도다).
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
  // 게이트를 캡처 모드로 위임(단일 결정지점 유지)한 뒤 그 판정을 PR-body용 마크다운으로 렌더한다.
  const res = spawnSync(process.execPath, [join(HERE, 'gate.mjs'), ...gateArgs], { encoding: 'utf8' })
  // 판정 실패(스폰 에러·계약 밖 종료코드)에는 마커를 찍지 않는다 — GATE=? 마커가 PR에 실리면
  // 사후 감사 grep이 그것을 "증거 적재됨"으로 세는 오염이 된다. 캡처 모드라 삼켜질 뻔한 gate
  // stderr도 그대로 통과시켜 디버깅 단서를 남긴다.
  if (res.status !== 0 && res.status !== 10 && res.status !== 11) {
    if (res.stderr) process.stderr.write(res.stderr)
    process.stderr.write(
      `[classify-risk] gate 판정 실패(status=${res.status ?? 'spawn-error'}) — 마커 미출력(증거 오염 방지)\n`,
    )
    process.exitCode = 2
  } else {
    const gateOut = res.stdout || ''
    const line = (name) => (gateOut.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1] || '?'
    const verdict = line('GATE')
    // 마커에 STAGE·BASE(merge-base sha)를 실어 "어느 diff에 대한 판정인가"를 자기검증 가능하게 한다.
    const provenance = `STAGE=${opt.stage || '-'} BASE=${opt.gitBase ? opt.gitBase.slice(0, 12) : '-'}`
    process.stdout.write(
      [
        '### 게이트 판정 — classify-risk (ADR-0061 · 3-tier)',
        '',
        '| 항목 | 값 |',
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
