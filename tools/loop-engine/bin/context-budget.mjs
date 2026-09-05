#!/usr/bin/env node
// context-budget.mjs — O1(상시 컨텍스트 예산) 3층 분리 계측 (BAC-582). 레포/설정 상태는 안 바꾼다
// (--write-baseline의 baseline 파일 기록만 예외). 단 부수 I/O는 있다: O1b 계측이 실 recall 훅을 1회
// spawn(임베딩 API 호출·pgvector 질의 발생 가능)하고, api 모드는 계측 대상 텍스트를 count_tokens로 전송.
//
// 3층 정의(총합 보고식과 함께 이 헤더가 정의 문서다):
//   O1a(세션 1회 상주) = 세션 시작 시 한 번 주입되어 상주하는 텍스트.
//     · repo 버킷: 루트 CLAUDE.md + 레포 스킬 frontmatter(**/.claude/skills/*/SKILL.md — 상주 주입분은
//       name/description frontmatter뿐, 본문은 온디맨드=O1c).
//     · personal 버킷: 글로벌 ~/.claude/CLAUDE.md + ~/.claude/projects/<key>/memory/MEMORY.md +
//       마켓플레이스 플러그인 스킬 frontmatter(installed_plugins.json → installPath/skills/*/SKILL.md).
//       레포 자산과 개인 레이어 자산은 절대 섞지 않는다(clone 재현성 분리 — 부재 시 null=N/A, 날조 금지).
//       플러그인 수치는 상한 참고치(디스크 합 ≠ 실주입량 — 주입 캡 존재 가능, caveat 필드로 명시).
//   O1b(턴당 반복) = recall-lessons.mjs가 UserPromptSubmit마다 stdout으로 주입하는 텍스트 — 코드 복제
//     없이 훅을 실제 spawn해 계측(실주입 로직 재사용). 훅은 fail-open 계약(항상 exit 0)이라 빈 출력과
//     고장이 겉으로 같다 → 무출력/비0종료/spawn실패 전부 INSUFFICIENT_DATA로 정직 보고.
//   O1c(온디맨드) = 스킬 본문·.loop/lessons·docs/adr·docs/agents — 바이트만 참고 표기, 총합 미포함
//     (docs/agents "상시 read" 통념은 코드로 반증됨 — 훅 grep 0. O1에 넣으면 과대계상).
//   총합 = o1a.total_tokens + o1b.per_turn_tokens × turns — O1b를 빼고 재면 recall 주입 증가가 공짜로
//   보인다(BAC-567 전후 비교가 성립하려면 turns 파라미터까지 동일 조건으로 재실행).
//
// 토큰 실측 = Anthropic POST /v1/messages/count_tokens(모델별 카운트 — tiktoken 금지). ANTHROPIC_API_KEY
// 부재/호출 실패 시 bytes/3 근사로 폴백하되 버킷별 method:"api"|"approx"를 명시 — 근사를 실측으로
// 위장하지 않는다. 키 값은 로그·출력·baseline 어디에도 남기지 않는다. 콜 수는 버킷당 1(총 ≤6).
//
// Usage: node context-budget.mjs [--root <dir>] [--project-dir <dir>] [--model <id>] [--turns <n>]
//        [--o1b-prompt <text>] [--hook <path>] [--plugins-file <path>] [--json]
//        [--write-baseline [<path>]]
//   --project-dir : MEMORY.md 키 도출용(경로의 '/'→'-') — 워크트리에서 돌릴 땐 메인 레포 경로를 넘긴다.
//   --turns       : 기본 30(세션당 턴수 실측이 아직 없어 default-assumption으로 기록 — 출력에 명시).
//   --write-baseline : 기본 <root>/.loop/context-budget/baseline.json (BAC-567 전후 비교 기준점, 커밋 대상).
// 항상 exit 0(usage만 2) — 계측 조회가 파이프라인을 깨면 안 된다(run-metrics 관례).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function usage(msg) {
  if (msg) process.stderr.write(`context-budget: ${msg}\n`)
  process.stderr.write(
    'Usage: context-budget.mjs [--root <dir>] [--project-dir <dir>] [--model <id>] [--turns <n>] [--o1b-prompt <text>] [--hook <path>] [--plugins-file <path>] [--json] [--write-baseline [<path>]]  (see header)\n',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
const opt = {
  root: process.cwd(),
  projectDir: '',
  model: 'claude-opus-5',
  turns: 30,
  turnsSource: 'default-assumption',
  o1bPrompt: 'RLS 테넌트 격리 실패 원인 진단', // loop-doctor CONSUMPTION 스모크와 동일 발상의 대표 질의(≥8자)
  hook: '',
  pluginsFile: '',
  json: false,
  writeBaseline: false,
  baselinePath: '',
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => {
    if (i + 1 >= argv.length) usage(`${a} requires a value`)
    return argv[++i]
  }
  switch (a) {
    case '--root': opt.root = val(); break
    case '--project-dir': opt.projectDir = val(); break
    case '--model': opt.model = val(); break
    case '--turns': {
      const r = val()
      if (!/^[1-9]\d*$/.test(r)) usage('--turns must be a positive integer')
      opt.turns = Number(r)
      opt.turnsSource = '--turns'
      break
    }
    case '--o1b-prompt': opt.o1bPrompt = val(); break
    case '--hook': opt.hook = val(); break
    case '--plugins-file': opt.pluginsFile = val(); break
    case '--json': opt.json = true; break
    case '--write-baseline': {
      opt.writeBaseline = true
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt.baselinePath = argv[++i]
      break
    }
    default: usage(`unknown arg ${a}`)
  }
}
opt.root = resolve(opt.root)
if (!opt.projectDir) opt.projectDir = opt.root
if (!opt.hook) opt.hook = join(opt.root, '.claude', 'hooks', 'recall-lessons.mjs')
if (!opt.pluginsFile) opt.pluginsFile = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
if (!opt.baselinePath) opt.baselinePath = join(opt.root, '.loop', 'context-budget', 'baseline.json')

// ── 토큰 카운트: count_tokens 실측 → 실패/키부재 시 bytes/3 근사(method로 정직 표기) ─────────
const approx = (text) => ({ tokens: Math.round(Buffer.byteLength(text, 'utf8') / 3), method: 'approx' })
async function countTokens(text, model) {
  if (!text) return { tokens: 0, method: 'none' }
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return approx(text) // 키 없으면 fetch 자체를 안 한다
  try {
    const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' // 테스트 모의 서버 seam
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return approx(text) // 비200 → 정직한 폴백(계측 도구는 절대 안 죽는다)
    const j = await res.json()
    if (!Number.isFinite(j?.input_tokens)) return approx(text)
    return { tokens: j.input_tokens, method: 'api' }
  } catch {
    return approx(text)
  }
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ── frontmatter 분리: 첫 줄이 '---'면 닫는 '---'까지가 상주 주입분, 나머지는 본문(O1c) ───────
function splitFrontmatter(text) {
  const lines = text.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return { frontmatter: '', body: text }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---')
      return { frontmatter: lines.slice(0, i + 1).join('\n'), body: lines.slice(i + 1).join('\n') }
  }
  return { frontmatter: '', body: text }
}

// ── 레포 스킬 스캔: <root> 이하 **/.claude/skills/*/SKILL.md (빌드 산출물·의존성 트리 제외) ──
function repoSkillFiles(root) {
  const out = []
  const SKIP = new Set(['node_modules', '.git', '.worktrees', 'dist', '.next', '.turbo', 'coverage'])
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (SKIP.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.name === '.claude') {
        // .claude 하위는 skills/*/SKILL.md만 관심 — hooks 등 다른 트리는 안 걷는다
        let skills = []
        try {
          skills = readdirSync(join(p, 'skills'), { withFileTypes: true })
        } catch {
          skills = []
        }
        for (const s of skills) {
          if (!s.isDirectory()) continue
          const f = join(p, 'skills', s.name, 'SKILL.md')
          if (existsSync(f)) out.push(f)
        }
        continue
      }
      walk(p)
    }
  }
  walk(root)
  return out.sort()
}

// ── 개인 레이어: installed_plugins.json(version 2) → installPath/skills/*/SKILL.md frontmatter ─
// 파일/키 부재·파싱 실패 → null(N/A) — 절대 throw 하지 않는다. 단 '부재'와 '존재하나 해석 불가'는
// 다르다: 스키마 드리프트로 최대 버킷이 조용히 사라지면 BAC-567 비교가 가짜 승리를 보고하므로,
// 해석 불가는 stderr 1줄로 소리 낸다(값은 여전히 null — 날조 금지, exit 0 유지).
function pluginSkillScan(pluginsFile) {
  const raw = readTextOrNull(pluginsFile)
  if (raw === null) return null // 파일 부재 = 진짜 N/A
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {
    process.stderr.write(`context-budget: plugins file exists but is not valid JSON — plugin bucket N/A (스키마 드리프트/손상 의심: ${pluginsFile})\n`)
    return null
  }
  const plugins = j?.plugins
  if (!plugins || typeof plugins !== 'object') {
    process.stderr.write(`context-budget: plugins file parsed but "plugins" key shape unexpected — plugin bucket N/A (스키마 드리프트 의심: ${pluginsFile})\n`)
    return null
  }
  if (j.version !== 2)
    process.stderr.write(`context-budget: plugins file version=${j.version} (expected 2) — 스캔 결과가 부정확할 수 있다\n`)
  const byPlugin = []
  let text = ''
  let skills = 0
  for (const [name, arr] of Object.entries(plugins)) {
    const installPath = Array.isArray(arr) ? arr[0]?.installPath : null
    if (typeof installPath !== 'string' || !installPath) continue
    let entries = []
    try {
      entries = readdirSync(join(installPath, 'skills'), { withFileTypes: true })
    } catch {
      continue // skills 없는 플러그인
    }
    let pluginSkills = 0
    let pluginBytes = 0
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const t = readTextOrNull(join(installPath, 'skills', e.name, 'SKILL.md'))
      if (t === null) continue
      const { frontmatter } = splitFrontmatter(t)
      pluginSkills++
      pluginBytes += Buffer.byteLength(frontmatter, 'utf8')
      text += `${frontmatter}\n`
    }
    if (pluginSkills > 0) byPlugin.push({ plugin: name, skills: pluginSkills, bytes: pluginBytes })
    skills += pluginSkills
  }
  return { plugins: byPlugin.length, skills, text, byPlugin }
}

// ── O1b: 실주입 로직 재사용 — 훅을 실제 spawn(import 금지: 훅은 process.exit 하는 fail-open 프로세스) ─
function measureO1b(hookPath, prompt, root) {
  if (!existsSync(hookPath)) return { text: '', status: 'INSUFFICIENT_DATA', reason: `hook not found: ${hookPath}` }
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ user_input: prompt }),
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  // spawnSync 실패 모드 전수 처리: spawn 자체 실패 / 비0 종료 / 빈 stdout — 훅은 fail-open 계약이라
  // 빈 출력(키 부재·pgvector down·히트 0)과 고장이 겉으로 같다 → 셋 다 INSUFFICIENT_DATA로 정직 보고.
  if (res.error) return { text: '', status: 'INSUFFICIENT_DATA', reason: `spawn failed: ${res.error.message}` }
  if (res.status !== 0) return { text: '', status: 'INSUFFICIENT_DATA', reason: `hook exit ${res.status}` }
  if (!res.stdout || !res.stdout.trim())
    return { text: '', status: 'INSUFFICIENT_DATA', reason: 'hook no-op — 빈 출력(키 부재/pgvector down/히트 0)과 고장이 fail-open 계약상 구분 불가' }
  return { text: res.stdout, status: 'OK', reason: '' }
}

// ── O1c: 참고 표기(바이트만, 디렉토리 직속 파일 합계 — API 콜 0) ────────────────────────────
function dirBytes(dir, ext) {
  let total = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(ext)) continue
    try {
      total += statSync(join(dir, e.name)).size
    } catch {
      /* 파일 단위 결손은 합계에서만 빠진다 */
    }
  }
  return total
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
const skillFiles = repoSkillFiles(opt.root)
let repoFmText = ''
let skillBodiesBytes = 0
for (const f of skillFiles) {
  const { frontmatter, body } = splitFrontmatter(readTextOrNull(f) ?? '')
  repoFmText += `${frontmatter}\n`
  skillBodiesBytes += Buffer.byteLength(body, 'utf8')
}

const claudeMdText = readTextOrNull(join(opt.root, 'CLAUDE.md'))
const globalClaudeMdText = readTextOrNull(join(homedir(), '.claude', 'CLAUDE.md'))
// MEMORY.md 키 = project-dir 경로의 '/'→'-' (실측: /Users/…/glucofit-partners → '-Users-…-glucofit-partners')
const memoryKey = opt.projectDir.replaceAll('/', '-')
const memoryText = readTextOrNull(join(homedir(), '.claude', 'projects', memoryKey, 'memory', 'MEMORY.md'))
const plugin = pluginSkillScan(opt.pluginsFile)
const o1b = measureO1b(opt.hook, opt.o1bPrompt, opt.root)

// 버킷당 1콜(총 ≤6) — 파일당 호출 금지(rate limit·속도). 부재(null 텍스트)는 버킷 자체가 null(N/A).
async function bucket(text) {
  if (text === null) return null
  const bytes = Buffer.byteLength(text, 'utf8')
  const { tokens, method } = await countTokens(text, opt.model)
  return { bytes, tokens, method }
}

const claudeMd = await bucket(claudeMdText)
const skillFm = { files: skillFiles.length, ...(await bucket(repoFmText)) }
const globalClaudeMd = await bucket(globalClaudeMdText)
const memoryMd = await bucket(memoryText)
let pluginFm = null
if (plugin !== null) {
  const b = await bucket(plugin.text)
  pluginFm = {
    plugins: plugin.plugins,
    skills: plugin.skills,
    bytes: b.bytes,
    tokens: b.tokens,
    method: b.method,
    by_plugin: plugin.byPlugin,
    caveat: '디스크 frontmatter 합 ≠ 실주입량(주입 캡 존재 가능) — 상한 참고치',
  }
}

let o1bTokens = null
let o1bMethod = null
if (o1b.status === 'OK') {
  const c = await countTokens(o1b.text, opt.model)
  o1bTokens = c.tokens
  o1bMethod = c.method
}

const numeric = (b) => (b && Number.isFinite(b.tokens) ? b.tokens : 0)
const repoTokens = numeric(claudeMd) + numeric(skillFm)
const personalTokens = numeric(globalClaudeMd) + numeric(memoryMd) + numeric(pluginFm)
const o1aTotal = repoTokens + personalTokens

// method 종합: 전 버킷 api → api, 전부 approx → approx, 혼재 → mixed (버킷별 method는 개별 기록)
const methods = new Set(
  [claudeMd, skillFm, globalClaudeMd, memoryMd, pluginFm]
    .filter((b) => b && b.method !== 'none')
    .map((b) => b.method),
)
if (o1bMethod) methods.add(o1bMethod)
const method = methods.size === 0 ? 'none' : methods.size === 1 ? [...methods][0] : 'mixed'

const report = {
  measured_at: new Date().toISOString(),
  root: opt.root,
  project_dir: opt.projectDir,
  model: opt.model,
  method,
  turns: opt.turns,
  turns_source: opt.turnsSource,
  o1a: {
    repo: { claude_md: claudeMd, skill_frontmatter: skillFm },
    personal: { global_claude_md: globalClaudeMd, memory_md: memoryMd, plugin_skill_frontmatter: pluginFm },
    repo_tokens: repoTokens,
    personal_tokens: personalTokens,
    total_tokens: o1aTotal,
  },
  o1b: {
    per_turn_tokens: o1bTokens,
    status: o1b.status,
    reason: o1b.reason,
    method: o1bMethod,
    // 이론 상한: 2코퍼스 × k=3 × 300자 캡 + 서문/델리미터 ≈ 2,153자 (recall-lessons.mjs 주입 형태 실측)
    theoretical_cap_chars: 2153,
  },
  o1c: {
    note: '온디맨드 — 참고 표기만, 총합 미포함',
    skill_bodies_bytes: skillBodiesBytes,
    lessons_bytes: dirBytes(join(opt.root, '.loop', 'lessons'), '.json'),
    docs_adr_bytes: dirBytes(join(opt.root, 'docs', 'adr'), '.md'),
    docs_agents_bytes: dirBytes(join(opt.root, 'docs', 'agents'), '.md'),
  },
  total: {
    formula: 'o1a.total_tokens + o1b.per_turn_tokens * turns',
    // O1b 결손 시 total은 O1a-only가 된다 — 항 하나가 빠진 값을 완전한 값처럼 두지 않도록 명시 플래그.
    // (baseline 간 비교는 includes_o1b가 같을 때만 성립 — 측정 가용성 변화를 다이어트 효과로 오귀속 금지.)
    includes_o1b: o1bTokens !== null,
    tokens: o1aTotal + (o1bTokens ?? 0) * opt.turns,
  },
}

if (opt.writeBaseline) {
  if (method !== 'api')
    process.stderr.write(
      `context-budget: baseline method=${method} — 비교 기준점으로는 ANTHROPIC_API_KEY 셸에서의 api 실측을 권장. 전후 비교는 반드시 같은 method·model·turns·o1b.status로.\n`,
    )
  mkdirSync(dirname(opt.baselinePath), { recursive: true })
  writeFileSync(opt.baselinePath, `${JSON.stringify(report, null, 2)}\n`)
  process.stderr.write(`context-budget: baseline written to ${opt.baselinePath}\n`)
}

if (opt.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  const fmtB = (label, b, extra = '') =>
    b === null
      ? `  ${label}: N/A(부재)`
      : `  ${label}: ${b.tokens} tokens (${b.bytes}B${extra}, ${b.method})`
  const lines = []
  lines.push('=== CONTEXT BUDGET (O1) ===')
  lines.push(`model: ${opt.model}  method: ${method}  turns: ${opt.turns} (${opt.turnsSource})`)
  lines.push('O1a repo (세션 1회 상주 — 레포 자산):')
  lines.push(fmtB('CLAUDE.md', claudeMd))
  lines.push(fmtB('skill frontmatter', skillFm, `, ${skillFm.files} files`))
  lines.push('O1a personal (세션 1회 상주 — 개인 레이어, 상한 참고치):')
  lines.push(fmtB('~/.claude/CLAUDE.md', globalClaudeMd))
  lines.push(fmtB('MEMORY.md', memoryMd))
  lines.push(
    fmtB(
      'plugin skill frontmatter',
      pluginFm,
      pluginFm ? `, ${pluginFm.plugins} plugins/${pluginFm.skills} skills` : '',
    ),
  )
  lines.push(`O1a subtotal: repo=${repoTokens} personal=${personalTokens} total=${o1aTotal} tokens`)
  lines.push(
    o1b.status === 'OK'
      ? `O1b (recall 주입/턴): ${o1bTokens} tokens (${o1bMethod})`
      : `O1b (recall 주입/턴): INSUFFICIENT_DATA — ${o1b.reason}`,
  )
  lines.push(
    `O1c (온디맨드, 참고 바이트): skill bodies=${report.o1c.skill_bodies_bytes}B lessons=${report.o1c.lessons_bytes}B docs/adr=${report.o1c.docs_adr_bytes}B docs/agents=${report.o1c.docs_agents_bytes}B`,
  )
  lines.push(
    report.total.includes_o1b
      ? `TOTAL = o1a + o1b×turns = ${report.total.tokens} tokens`
      : `TOTAL = o1a only (O1b 결손 — INSUFFICIENT_DATA, o1b항 미포함) = ${report.total.tokens} tokens`,
  )
  lines.push('=== END CONTEXT BUDGET ===')
  process.stdout.write(`${lines.join('\n')}\n`)
}
process.exit(0)
