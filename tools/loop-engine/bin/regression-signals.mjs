#!/usr/bin/env node
// regression-signals.mjs — .loop/runs 원장에서 게이트 PASS→FAIL 회귀를 결정론 집계하는 read-only
// CLI (BAC-631). 로직은 lib/regression-signals.mjs(순수 fold — 계약·신뢰 경계는 그 헤더 필독).
//
// Usage: node regression-signals.mjs [--runs-dir <dir>] [--json]
// 항상 exit 0(usage만 2) — 계측 조회가 파이프라인을 깨면 안 된다(run-metrics 관례이자, 소비
// 레포의 health-check 스크립트 관례 — 예: loop-doctor. 이 플러그인이 직접 제공하지는 않는다).
// 출력은 게이트명 정렬·키 순서 고정 — 같은 원장에 대한 재실행은 byte-identical(결정론).

import { join } from 'node:path'
import { detectRegressions, readRunEvents } from '../lib/regression-signals.mjs'

const argv = process.argv.slice(2)
let runsDir = join('.loop', 'runs')
let asJson = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--runs-dir') runsDir = argv[++i] ?? ''
  else if (a === '--json') asJson = true
  else {
    process.stderr.write('usage: regression-signals.mjs [--runs-dir <dir>] [--json]\n')
    process.exit(2)
  }
}
if (!runsDir) {
  process.stderr.write('usage: regression-signals.mjs [--runs-dir <dir>] [--json]\n')
  process.exit(2)
}

const src = readRunEvents(runsDir)
const reg = detectRegressions(src.events)
const out = {
  regressions: reg.regressions,
  insufficient: reg.insufficient,
  skipped_events: reg.skipped_events,
  unknown_verdict_events: reg.unknown_verdict_events,
  skipped_lines: src.skipped_lines,
  skipped_files: src.skipped_files,
  missing: src.missing,
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
} else {
  const lines = []
  lines.push('=== GATE REGRESSIONS ===')
  lines.push(`runs_dir: ${runsDir}${src.missing ? ' (missing — no ledger)' : ''}`)
  if (reg.regressions.length === 0) {
    lines.push('no PASS→FAIL regressions')
  } else {
    for (const r of reg.regressions) {
      lines.push(
        `REGRESSION: ${r.gate} PASS→FAIL (last_pass=${r.last_pass_ts}, first_fail=${r.first_fail_ts}, fails=${r.fail_count}, runs=${r.runs.join(',')})`,
      )
    }
  }
  if (reg.insufficient.length) {
    lines.push(`insufficient (no PASS on record): ${reg.insufficient.join(', ')}`)
  }
  lines.push(`unknown_verdict_events: ${reg.unknown_verdict_events} (런 귀속 불가 — fold 포함, runs 표기만 unknown)`)
  lines.push(
    `skipped: events=${reg.skipped_events} lines=${src.skipped_lines} files=${src.skipped_files}`,
  )
  lines.push('=== END GATE REGRESSIONS ===')
  process.stdout.write(`${lines.join('\n')}\n`)
}
process.exit(0)
