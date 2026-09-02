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
//   recall 건전성 = loop-memory의 memory.recall 원장(hooks/recall-lessons.mjs가 UserPromptSubmit
//        마다 1줄 남긴다) fold. 이 훅은 **fail-open 계약**(항상 exit 0)이라 "안 붙었다"와 "고장났다"가
//        겉으로 같다 — 원장만이 둘을 가른다. 그런데 이 축을 아무도 fold하지 않아, 소비 레포에서
//        cli_failed가 6일간 attempted의 89%였는데 무증상으로 지나갔다(2026-08-27~09-01 실측 626건).
//        그래서 여기서 세 가지를 따로 보고한다:
//        · 실패율 = error / attempted. **분모는 fired가 아니라 attempted**(= fired − skipped) —
//          키 부재·짧은 프롬프트 같은 self-gate는 고장이 아니므로 실패율을 희석하면 안 된다.
//        · 컷오프 실효성 = hit 단위 dropped/candidates. `above_cutoff` 사유(=후보 전부 탈락)만 세면
//          과소보고된다: 실측에서 above_cutoff는 958건 중 1건이었지만 hit 단위로는 456개 중 55개
//          (12%)가 탈락했다. 코퍼스별로 갈라 보고한다 — lessons와 knowledge는 임베딩 분포가 달라
//          한 숫자로 합치면 둘 다 못 읽는다(실측: lessons 4.4% vs knowledge 19.7%).
//        · nearest distance 분포(min/median/max)와 관측된 컷오프값. 컷오프는 임베더 의존이라
//          코드 기본값 0.65가 맞는지 알려면 **관측 분포와 나란히 놓는 것 말고 방법이 없다**.
//          여기서 교정값을 자동으로 정하지는 않는다(표본이 임베더 1종에 묶여 있다) — 사람이 읽고
//          userConfig로 정한다.
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

// recall 원장이 쓰는 두 코퍼스. 하나로 합치지 않는 이유는 헤더 참조(임베딩 분포가 다르다).
const RECALL_CORPORA = ['lessons', 'knowledge']

// memory.recall 이벤트 배열 1런분 fold. hooks/recall-lessons.mjs가 쓰는 payload 스키마를 그대로
// 읽는다: outcome(injected|no_match|skipped|error) · reason(고정 슬러그) · <corpus>{candidates,near,
// nearest} · cutoffs{<corpus>} · injected_chars. 필드 부재는 0/미집계로 흘리고 절대 날조하지 않는다
// (훅이 페이로드를 비관적으로 시드하므로 예기치 못한 종료 경로도 reason 슬러그는 남긴다).
function foldRecall(events) {
  const byReason = {}
  const corpus = {}
  const cutoffs = {}
  for (const c of RECALL_CORPORA) {
    corpus[c] = { candidates: 0, passed: 0, nearest: [] }
    cutoffs[c] = []
  }
  let injected = 0
  let skipped = 0
  let failed = 0
  let injectedChars = 0
  for (const e of events) {
    const p = e.payload ?? {}
    // reason이 없는 줄도 'unknown'으로 세어 표에 남긴다 — 침묵 탈락 금지(파일 관례).
    const reason = typeof p.reason === 'string' && p.reason ? p.reason : 'unknown'
    byReason[reason] = (byReason[reason] ?? 0) + 1
    if (p.outcome === 'skipped') skipped++
    else if (p.outcome === 'error') failed++
    else if (p.outcome === 'injected') {
      injected++
      if (Number.isFinite(p.injected_chars)) injectedChars += p.injected_chars
    }
    for (const c of RECALL_CORPORA) {
      const b = p[c]
      if (b && typeof b === 'object') {
        if (Number.isFinite(b.candidates)) corpus[c].candidates += b.candidates
        if (Number.isFinite(b.near)) corpus[c].passed += b.near
        if (Number.isFinite(b.nearest)) corpus[c].nearest.push(b.nearest)
      }
      const cut = p.cutoffs?.[c]
      // 관측된 컷오프값은 전부 모은다 — 런 도중 userConfig가 바뀌면 여러 값이 보여야 한다.
      if (Number.isFinite(cut) && !cutoffs[c].includes(cut)) cutoffs[c].push(cut)
    }
  }
  return {
    fired: events.length,
    // 분모는 attempted — self-gate(키 부재·짧은 프롬프트)는 고장이 아니다(헤더 참조).
    attempted: events.length - skipped,
    injected,
    failed,
    skipped,
    by_reason: byReason,
    injected_chars: injectedChars,
    corpus,
    cutoffs,
  }
}

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
  const recallEvents = []
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
    } else if (e.type === 'memory.recall') {
      recallEvents.push(e)
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
  const recall = foldRecall(recallEvents)
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
    recall,
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

// recall은 **runs 전체**를 접는다 — Q1/Q2/H1과 달리 'unknown' 버킷을 빼지 않는다. 그 제외 근거는
// "append-only 의사-런이 *런 단위* 분모를 희석한다"인데, recall 지표는 런이 아니라 **이벤트 단위**
// 비율(failed/attempted, dropped/candidates)이라 그 논거가 적용되지 않는다. 오히려 self-gate 발화는
// 세션 귀속이 안 돼 unknown으로 떨어지는 경우가 있어(liveness.mjs 폴백), 빼면 attempted 분모가
// 왜곡된다. regression-signals.mjs가 같은 이유로 같은 분기를 한 선례가 있다.
const recallFolds = runs.map((r) => r.recall)
const recallTotal = {
  fired: 0,
  attempted: 0,
  injected: 0,
  failed: 0,
  skipped: 0,
  injected_chars: 0,
  by_reason: {},
  corpus: {},
  cutoffs: {},
}
for (const c of RECALL_CORPORA) {
  recallTotal.corpus[c] = { candidates: 0, passed: 0, nearest: [] }
  recallTotal.cutoffs[c] = []
}
for (const f of recallFolds) {
  for (const k of ['fired', 'attempted', 'injected', 'failed', 'skipped', 'injected_chars']) {
    recallTotal[k] += f[k]
  }
  for (const [k, v] of Object.entries(f.by_reason)) {
    recallTotal.by_reason[k] = (recallTotal.by_reason[k] ?? 0) + v
  }
  for (const c of RECALL_CORPORA) {
    recallTotal.corpus[c].candidates += f.corpus[c].candidates
    recallTotal.corpus[c].passed += f.corpus[c].passed
    recallTotal.corpus[c].nearest.push(...f.corpus[c].nearest)
    for (const cut of f.cutoffs[c]) {
      if (!recallTotal.cutoffs[c].includes(cut)) recallTotal.cutoffs[c].push(cut)
    }
  }
}

// 결손 축은 INSUFFICIENT_DATA를 1급으로 — 훅 미설치/미발화를 0%처럼 보이게 하지 않는다.
const recallOverall =
  recallTotal.fired === 0
    ? INSUFFICIENT
    : {
        fired: recallTotal.fired,
        attempted: recallTotal.attempted,
        injected: recallTotal.injected,
        failed: recallTotal.failed,
        skipped: recallTotal.skipped,
        // attempted=0(전부 self-gate)이면 비율은 정의되지 않는다 — 0으로 뭉개지 않는다.
        failure_ratio: recallTotal.attempted > 0 ? recallTotal.failed / recallTotal.attempted : INSUFFICIENT,
        injected_chars_total: recallTotal.injected_chars,
        injected_chars_mean:
          recallTotal.injected > 0 ? recallTotal.injected_chars / recallTotal.injected : INSUFFICIENT,
        by_reason: recallTotal.by_reason,
        corpus: Object.fromEntries(
          RECALL_CORPORA.map((c) => {
            const b = recallTotal.corpus[c]
            const dropped = b.candidates - b.passed
            return [
              c,
              {
                candidates: b.candidates,
                passed_cutoff: b.passed,
                dropped_by_cutoff: dropped,
                // 컷오프 실효성. candidates=0이면 비율이 없다(임베더 미가동/코퍼스 공백).
                dropped_ratio: b.candidates > 0 ? dropped / b.candidates : INSUFFICIENT,
                nearest: b.nearest.length
                  ? {
                      n: b.nearest.length,
                      min: Math.min(...b.nearest),
                      median: median(b.nearest),
                      max: Math.max(...b.nearest),
                    }
                  : INSUFFICIENT,
                cutoffs_observed: recallTotal.cutoffs[c],
              },
            ]
          }),
        ),
      }

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
  recall: recallOverall,
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
  if (overall.recall === INSUFFICIENT) {
    lines.push(`recall (loop-memory 시맨틱 회수): ${INSUFFICIENT} (memory.recall 이벤트 0 — 훅 미설치이거나 한 번도 발화하지 않았다)`)
  } else {
    const rc = overall.recall
    lines.push(
      'recall (loop-memory 시맨틱 회수 — 훅이 fail-open이라 원장만이 "안 붙음"과 "고장"을 가른다):',
    )
    lines.push(
      `  fired=${rc.fired} attempted=${rc.attempted} (=fired−skipped) injected=${rc.injected} failed=${rc.failed} ` +
        `failure_ratio=${fmt(rc.failure_ratio)} (attempted 기준 — self-gate는 고장이 아니라 분모에서 뺀다)`,
    )
    lines.push(
      `  by_reason: ${Object.entries(rc.by_reason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    )
    lines.push(
      `  injected_chars: total=${rc.injected_chars_total} mean=${fmt(rc.injected_chars_mean)} (주입 1회당 문자수 — 컨텍스트 세금)`,
    )
    for (const c of RECALL_CORPORA) {
      const b = rc.corpus[c]
      // 거리는 3자리로 — 실측 대역이 0.08~0.27로 좁아 fmt()의 2자리로는 컷오프와의 간격이 뭉갠다.
      const d = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v))
      const near =
        b.nearest === INSUFFICIENT
          ? INSUFFICIENT
          : `min=${d(b.nearest.min)} median=${d(b.nearest.median)} max=${d(b.nearest.max)} (n=${b.nearest.n})`
      lines.push(
        `  ${c.padEnd(9)}: candidates=${b.candidates} passed=${b.passed_cutoff} dropped=${b.dropped_by_cutoff} ` +
          `(${fmt(b.dropped_ratio)}) nearest ${near} cutoff=${b.cutoffs_observed.length ? b.cutoffs_observed.join(',') : 'n/a'}`,
      )
      // 컷오프 교정 nudge. 여기서 값을 자동으로 고치지 않는다 — 표본이 임베더 1종에 묶여 있고,
      // 어떤 컷오프가 옳은지는 임베더/코퍼스마다 다르다(userConfig loop_recall_max_distance).
      // 사실만 부상시키고 판단은 사람에게 남긴다. "게이트가 한 번도 일하지 않았다"는 임계값 판정이
      // 아니라 관측 사실이므로 이 조건만 경고한다.
      if (b.candidates > 0 && b.dropped_by_cutoff === 0) {
        lines.push(
          `    WARN: ${c} 컷오프가 후보 ${b.candidates}개 중 하나도 막지 않았다 — 이 임베더에 대해 느슨할 수 있다(교정: loop_recall_max_distance).`,
        )
      }
    }
  }
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
