#!/usr/bin/env node
// run-metrics.mjs — .loop/runs/*.jsonl 원장 fold 집계 (BAC-570 H1·Q1·Q2). read-only.
//
// Usage: node run-metrics.mjs [--runs-dir <dir>] [--json]
// 항상 exit 0(usage만 2) — 계측 조회가 파이프라인을 깨면 안 된다(소비 레포의 health-check 스크립트
// 관례 — 예: loop-doctor. 이 플러그인이 직접 제공하지는 않는다).
//
// 지표(이슈 570a):
//   H1 = 런당 인간 개입 수 = permission.requested 중 경계 표면(merge/deploy/send) 제외분 —
//        제외 목록은 lib/boundary-surfaces.mjs 단일 소스(기록 시점 surface 태깅을 신뢰).
//        제외 내역(excluded_by_surface)은 항상 표시한다 — 침묵 제외 금지.
//   Q1 = first-pass green 비율 = (첫 verdict.*가 verdict.passed인 런) / (verdict 보유 런)
//   Q2 = 재작업 = 런당 verdict.* 호출 수
//   압축 상관(BAC-746) = 런당 compaction 이벤트 수 + "압축 직후 RED 비율" — 런 타임라인을
//        (compaction ∪ verdict.*) ts순으로 걸어, compaction 뒤 처음 만나는 verdict 1건만
//        "post-compaction"으로 표시한다(압축이 여러 번 연달아 와도 "최근 압축됨" 불리언 상태로
//        취급 — 압축마다 같은 다음 verdict를 중복 카운트하지 않는다). 이 표본들 중 verdict.failed
//        비율이 post_compaction_red — 체크포인트(별도 조건부 이슈) 착수 여부의 실측 근거.
//   서브에이전트(BAC-778) = started / stopped_paired / stopped_unattributed 3분할. 플랫폼이
//        SubagentStart가 안 뜨는 종류에도 SubagentStop을 쏘고 그 이벤트엔 agent_type이 없다(실측) —
//        stopped 총계는 "서브에이전트 수"를 뒷받침하지 못하므로 짝이 맞은 것만 따로 센다.
// 결손 축은 INSUFFICIENT_DATA를 1급 결과로(frugality proof — 측정 축이 빠지면 조작된 PASS 대신
// 증명 불가를 정직하게): run.started 없는 런(계측 생존 마커 부재)의 H1, verdict 0 런의 Q2,
// 해당 런이 0인 전체 축. 'unknown' 런(귀속 불가 verdict 버킷)은 별도 행+카운터로만 보고하고
// **overall 집계(Q1·Q2·H1)에서 제외한다** — append-only 누적 버킷이 '런 1개'로 산입되면 분모를
// 영구 희석하고 Q2 평균에 극단값을 싣는다(리뷰 실측: 진짜 Q1=1/1이 0.50으로 보고됨).
// 파싱은 줄 단위 fail-soft(깨진 줄 skip + 카운트 보고) — 원장 오염이 집계를 죽이면 안 된다.
// 파일 단위 읽기 실패도 침묵 제외 금지 — skipped_files로 카운트해 결손을 가시화한다.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { H1_EXCLUDED_SURFACES } from '../lib/boundary-surfaces.mjs'

const INSUFFICIENT = 'INSUFFICIENT_DATA'

const argv = process.argv.slice(2)
let runsDir = join('.loop', 'runs')
let asJson = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--runs-dir') runsDir = argv[++i] ?? ''
  else if (a === '--json') asJson = true
  else {
    process.stderr.write('usage: run-metrics.mjs [--runs-dir <dir>] [--json]\n')
    process.exit(2)
  }
}
if (!runsDir) {
  process.stderr.write('usage: run-metrics.mjs [--runs-dir <dir>] [--json]\n')
  process.exit(2)
}

let files = []
try {
  files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'))
} catch {
  files = [] // 디렉토리 부재 = 데이터 0 → 전 축 INSUFFICIENT_DATA로 흐른다
}
files.sort()

// 알려진 표면은 0으로 시작해 미발생도 표시되게 한다(제외가 보이게).
const knownSurfaces = []
for (const r of H1_EXCLUDED_SURFACES) {
  if (!knownSurfaces.includes(r.surface)) knownSurfaces.push(r.surface)
}
const excludedTotal = {}
for (const s of knownSurfaces) excludedTotal[s] = 0

let skippedLines = 0
let skippedFiles = 0
const runs = []
for (const f of files) {
  const runId = f.slice(0, -'.jsonl'.length)
  let raw = ''
  try {
    raw = readFileSync(join(runsDir, f), 'utf8')
  } catch {
    skippedFiles++ // 파일 단위 결손도 침묵 탈락 금지 — 부분 데이터 집계임을 카운터로 정직하게
    continue
  }
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (!e || typeof e.type !== 'string') {
        skippedLines++
        continue
      }
      events.push(e)
    } catch {
      skippedLines++
    }
  }
  const instrumented = events.some((e) => e.type === 'run.started')
  let perm = 0
  const excluded = {}
  const verdicts = []
  const compactions = []
  const startedAgentIds = new Set()
  const stoppedAgentIds = []
  for (const e of events) {
    if (e.type === 'subagent.started') {
      if (e.payload?.agent_id) startedAgentIds.add(e.payload.agent_id)
    } else if (e.type === 'subagent.stopped') {
      stoppedAgentIds.push(e.payload?.agent_id ?? null)
    }
    if (e.type === 'permission.requested') {
      const s = e.payload?.surface
      if (typeof s === 'string' && s) {
        excluded[s] = (excluded[s] ?? 0) + 1
        excludedTotal[s] = (excludedTotal[s] ?? 0) + 1
      } else {
        perm++
      }
    } else if (e.type.startsWith('verdict.')) {
      verdicts.push(e)
    } else if (e.type === 'compaction') {
      compactions.push(e)
    }
  }
  verdicts.sort((x, y) => String(x.ts).localeCompare(String(y.ts))) // ts 순 안정 정렬(파일 순 보조)

  // 압축 상관(BAC-746): (compaction ∪ verdict.*)를 ts순으로 걸어, 압축 뒤 처음 만나는 verdict 1건만
  // "post-compaction"으로 태그한다(헤더 참조 — 압축 연타는 "최근 압축됨" 불리언 상태 취급).
  const timeline = [...compactions, ...verdicts].sort((x, y) =>
    String(x.ts).localeCompare(String(y.ts)),
  )
  let pendingCompaction = false
  const postCompactionRed = []
  for (const e of timeline) {
    if (e.type === 'compaction') {
      pendingCompaction = true
    } else if (pendingCompaction) {
      postCompactionRed.push(e.type === 'verdict.failed')
      pendingCompaction = false
    }
  }

  // 서브에이전트 짝 맞추기(BAC-778) — stopped를 통째로 세면 안 되는 이유는 record-run-event.mjs
  // 헤더의 실측 그대로다: 플랫폼이 SubagentStart가 안 뜨는 에이전트 종류에도 SubagentStop을 쏘고,
  // 그런 이벤트엔 agent_type이 아예 없다(실측 7일: stopped 2,307 중 1,896이 무-타입, 그 1,901개
  // 고유 id 중 started가 있는 건 0개 / 타입 있는 405개는 405개 전부 started가 있다). 그래서
  // "stopped 수 = 서브에이전트 수"는 뒷받침되지 않는 숫자다 — 짝이 맞은 것과 귀속 불가를 분리해
  // 보고하고, 지속시간/성공률 같은 파생은 짝 맞은 모집단에서만 도출하게 한다.
  const stoppedPaired = stoppedAgentIds.filter((id) => id && startedAgentIds.has(id)).length
  runs.push({
    run_id: runId,
    instrumented,
    h1: instrumented ? perm : INSUFFICIENT,
    q2: verdicts.length > 0 ? verdicts.length : INSUFFICIENT,
    first_pass: verdicts.length > 0 ? verdicts[0].type === 'verdict.passed' : null,
    excluded,
    compactions: compactions.length,
    post_compaction_red: postCompactionRed,
    subagents: {
      started: startedAgentIds.size,
      stopped_paired: stoppedPaired,
      stopped_unattributed: stoppedAgentIds.length - stoppedPaired,
    },
  })
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// 'unknown' 버킷은 overall에서 제외 — 세션 무제한 누적 의사-런이 분모·평균을 왜곡한다(헤더 참조).
const attributed = runs.filter((r) => r.run_id !== 'unknown')
const unknownRun = runs.find((r) => r.run_id === 'unknown')
const unknownVerdictEvents = unknownRun && typeof unknownRun.q2 === 'number' ? unknownRun.q2 : 0
const instrumentedRuns = attributed.filter((r) => r.instrumented)
const verdictRuns = attributed.filter((r) => typeof r.q2 === 'number')
const firstPassRuns = verdictRuns.filter((r) => r.first_pass === true)
const h1Values = instrumentedRuns.map((r) => r.h1)
const compactionsTotal = attributed.reduce((sum, r) => sum + r.compactions, 0)
const postCompactionSamples = attributed.flatMap((r) => r.post_compaction_red)
const postCompactionRedCount = postCompactionSamples.filter(Boolean).length

const overall = {
  runs: runs.length,
  instrumented_runs: instrumentedRuns.length,
  verdict_runs: verdictRuns.length,
  h1_mean: instrumentedRuns.length ? mean(h1Values) : INSUFFICIENT,
  h1_median: instrumentedRuns.length ? median(h1Values) : INSUFFICIENT,
  q1: verdictRuns.length
    ? {
        ratio: firstPassRuns.length / verdictRuns.length,
        first_pass_runs: firstPassRuns.length,
        verdict_runs: verdictRuns.length,
      }
    : INSUFFICIENT,
  q2_mean: verdictRuns.length ? mean(verdictRuns.map((r) => r.q2)) : INSUFFICIENT,
  subagents: {
    started: attributed.reduce((s, r) => s + r.subagents.started, 0),
    stopped_paired: attributed.reduce((s, r) => s + r.subagents.stopped_paired, 0),
    stopped_unattributed: attributed.reduce((s, r) => s + r.subagents.stopped_unattributed, 0),
  },
  excluded_by_surface: excludedTotal,
  unknown_verdict_events: unknownVerdictEvents,
  skipped_lines: skippedLines,
  skipped_files: skippedFiles,
  compactions_total: compactionsTotal,
  post_compaction_red: postCompactionSamples.length
    ? {
        ratio: postCompactionRedCount / postCompactionSamples.length,
        red: postCompactionRedCount,
        total: postCompactionSamples.length,
      }
    : INSUFFICIENT,
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ runs, overall }, null, 2)}\n`)
} else {
  const fmt = (v) =>
    typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v)
  const lines = []
  lines.push('=== RUN METRICS ===')
  lines.push(
    `runs: ${overall.runs} (instrumented=${overall.instrumented_runs} with-verdict=${overall.verdict_runs})`,
  )
  lines.push(
    `H1 (인간 개입/런, merge·deploy·send 제외): mean=${fmt(overall.h1_mean)} median=${fmt(overall.h1_median)}`,
  )
  lines.push(
    typeof overall.q1 === 'object'
      ? `Q1 (first-pass green 비율): ${fmt(overall.q1.ratio)} (${overall.q1.first_pass_runs}/${overall.q1.verdict_runs})`
      : `Q1 (first-pass green 비율): ${overall.q1}`,
  )
  lines.push(`Q2 (verdict 호출/런): mean=${fmt(overall.q2_mean)}`)
  const surf = Object.keys(excludedTotal)
    .map((k) => `${k}=${excludedTotal[k]}`)
    .join(' ')
  lines.push(`excluded_by_surface: ${surf}`)
  lines.push(`unknown_verdict_events: ${unknownVerdictEvents} (귀속 불가 — overall 집계 제외)`)
  lines.push(
    `subagents: started=${overall.subagents.started} stopped_paired=${overall.subagents.stopped_paired} ` +
      `stopped_unattributed=${overall.subagents.stopped_unattributed} ` +
      '(unattributed = SubagentStart가 안 뜬 종류의 SubagentStop — agent_type 부재, 짝 맞추기 불가. ' +
      '에이전트별 지속시간/성공률은 stopped_paired에서만 도출할 것)',
  )
  lines.push(`skipped_lines: ${skippedLines}`)
  lines.push(`skipped_files: ${skippedFiles}`)
  lines.push(`compactions_total: ${overall.compactions_total}`)
  lines.push(
    typeof overall.post_compaction_red === 'object'
      ? `post_compaction_red (압축 직후 첫 verdict가 RED인 비율): ${fmt(overall.post_compaction_red.ratio)} (${overall.post_compaction_red.red}/${overall.post_compaction_red.total})`
      : `post_compaction_red (압축 직후 첫 verdict가 RED인 비율): ${overall.post_compaction_red}`,
  )
  for (const r of runs) {
    const tag = r.run_id === 'unknown' ? ' (귀속 불가 verdict — current 포인터 부재분)' : ''
    lines.push(
      `  ${r.run_id}: H1=${fmt(r.h1)} Q2=${fmt(r.q2)} first_pass=${r.first_pass} compactions=${r.compactions}${tag}`,
    )
  }
  lines.push('=== END RUN METRICS ===')
  process.stdout.write(`${lines.join('\n')}\n`)
}
process.exit(0)
