#!/usr/bin/env node
// check-rules-always-on.mjs — .claude/rules/**/*.md 중 조건부 로딩이 실제로 안 걸리는 파일의 바이트
// 합계를 리포트하는 기계 체크 (BAC-695, ADR-0034 §2-bis "기계 체크 의무").
//
// 배경: `.claude/rules/*.md` + `paths:` frontmatter는 매칭 파일을 **Read**할 때만 조건부로 로드된다.
// 그런데 `paths:`가 없거나 `["**"]"`이면 Claude Code가 무조건 로드(=always-on)로 강등한다(실측,
// BAC-567 적대적 리뷰 2026-07-31). 즉 "CLAUDE.md를 여러 파일로 나눴다"는 사실만으로는 절감이 보장되지
// 않는다 — 이 체크가 없으면 파일을 나눈 것 자체를 절감으로 착시 보고할 수 있다.
//
// 판정: 파일이 다음 중 하나면 "always-on 잔류"로 집계한다.
//   (a) frontmatter 자체가 없거나 `paths:` 키가 없음
//   (b) `paths:`가 빈 배열
//   (c) `paths:`가 정확히 `["**"]"`(단일 원소 "**") — 광역 glob("apps/web/**" 등)은 해당 안 됨
// `.claude/rules/*.md`는 전부 `paths:` 필수(ADR-0034 §2-bis) → 이 세 경우는 컨벤션 위반이라 게이트
// 대상(기본 exit 1). --report-only로 리포트만 하고 exit 0 강제 가능.
//
// Usage: node check-rules-always-on.mjs [--root <dir>] [--json] [--report-only]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

function usage(msg) {
  if (msg) process.stderr.write(`check-rules-always-on: ${msg}\n`)
  process.stderr.write(
    'Usage: check-rules-always-on.mjs [--root <dir>] [--json] [--report-only]\n',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const opt = { root: process.cwd(), json: false, reportOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opt.root = argv[++i]
    else if (a === '--json') opt.json = true
    else if (a === '--report-only') opt.reportOnly = true
    else usage(`unknown argument: ${a}`)
  }
  if (!opt.root) usage('--root requires a value')
  return opt
}

function walkMarkdown(dir) {
  let out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walkMarkdown(p))
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
  }
  return out
}

// 최소 YAML frontmatter 파서 — `paths:` 키 하나만 필요. 정식 YAML 파서를 끌어오지 않고 이 레포 관례
// (스킬 frontmatter도 정규식 기반, context-budget.mjs 참고)를 따른다.
function extractPaths(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { hasFrontmatter: false, paths: null }
  const fm = m[1]
  // flow-style: paths: ["a", "b"] / paths: [] — optional trailing "# comment" tolerated
  const flow = fm.match(/^paths:\s*\[([^\]]*)\]\s*(?:#.*)?$/m)
  if (flow) {
    const items = flow[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0)
    return { hasFrontmatter: true, paths: items }
  }
  // block-style:
  // paths:
  //   - "a"
  //   - "b"
  const blockHeader = fm.match(/^paths:\s*(?:#.*)?$/m)
  if (blockHeader) {
    const items = []
    const lines = fm.split(/\r?\n/)
    const startIdx = lines.findIndex((l) => /^paths:\s*(?:#.*)?$/.test(l))
    for (let i = startIdx + 1; i < lines.length; i++) {
      const l = lines[i]
      if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue // blank/comment lines between items
      const item = l.match(/^\s*-\s*["']?([^"'\n]+?)["']?\s*(?:#.*)?$/)
      if (item) items.push(item[1].trim())
      else break
    }
    return { hasFrontmatter: true, paths: items }
  }
  return { hasFrontmatter: true, paths: null }
}

function isAlwaysOnLeak({ hasFrontmatter, paths }) {
  if (!hasFrontmatter) return true
  if (paths === null) return true // frontmatter present but no `paths:` key
  if (paths.length === 0) return true
  if (paths.length === 1 && paths[0] === '**') return true
  return false
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  const rulesDir = join(opt.root, '.claude', 'rules')
  const files = walkMarkdown(rulesDir).sort()

  const leaking = []
  const scoped = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const bytes = statSync(f).size
    const { hasFrontmatter, paths } = extractPaths(text)
    const rel = relative(opt.root, f)
    if (isAlwaysOnLeak({ hasFrontmatter, paths })) {
      leaking.push({ file: rel, bytes, reason: !hasFrontmatter ? 'no-frontmatter' : paths === null ? 'no-paths-key' : paths.length === 0 ? 'empty-paths' : 'match-all' })
    } else {
      scoped.push({ file: rel, bytes, paths })
    }
  }

  const leaking_bytes = leaking.reduce((s, f) => s + f.bytes, 0)
  const scoped_bytes = scoped.reduce((s, f) => s + f.bytes, 0)
  const report = {
    root: opt.root,
    total_files: files.length,
    scoped_files: scoped.length,
    scoped_bytes,
    leaking_files: leaking.length,
    leaking_bytes,
    leaking: leaking,
  }

  if (opt.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write('=== .claude/rules always-on 잔류 체크 ===\n')
    process.stdout.write(`총 ${report.total_files}개 파일 — 조건부 로딩 ${report.scoped_files}개(${scoped_bytes}B) / `)
    process.stdout.write(`always-on 잔류(착시 위험) ${report.leaking_files}개(${leaking_bytes}B)\n`)
    for (const f of leaking) {
      process.stdout.write(`  LEAK: ${f.file} — ${f.bytes}B (${f.reason})\n`)
    }
    process.stdout.write('=== END ===\n')
  }

  if (leaking.length > 0 && !opt.reportOnly) process.exit(1)
  process.exit(0)
}

main()
