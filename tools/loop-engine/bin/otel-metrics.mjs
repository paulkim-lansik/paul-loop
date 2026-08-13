#!/usr/bin/env node
// otel-metrics.mjs — .loop/otel/*.jsonl(otel-receiver 착지분) fold 집계 (BAC-587 H2·C1·C2). read-only.
//
// Usage: node otel-metrics.mjs [--otel-dir <dir>] [--since <ISO>] [--json]
// 항상 exit 0(usage만 2) — 계측 조회가 파이프라인을 깨면 안 된다(run-metrics.mjs 관례).
//
// 의미(정직 서술 — 3축 리뷰): 이 수치는 **수집 구간 누적**이다("런당" 아님) — 디렉토리의 모든 jsonl을
// fold하고, 한 수신기에 병렬 워크트리 세션들이 합류할 수 있다. 시간 창은 --since <ISO>(수신 ts 기준),
// 세션 귀속은 h2_by_session(resource attr session.id)로 분리한다. 런 단위 귀속은 후속(소비 이슈) 몫.
//
// 지표(이슈 570b):
//   H2 = 사람 대기 span 수 = trace span 중 name === 'claude_code.tool.blocked_on_user'에서 경계
//        표면(merge/deploy/send) 매치분 제외 — 제외 판정은 수신기가 기록 시점(절단 전)에 태깅한
//        boundary_surface를 우선하고(장문 명령 꼬리 유실 방지), 태그 없으면(구버전 착지분) 저장된
//        속성 텍스트로 폴백. 제외 목록은 H1과 **동일 원천**(lib/boundary-surfaces.mjs 단일 소스):
//        제외 없인 "사람 개입 줄이기" 최적화가 지키기로 한 사람-승인 경계(ADR-0061 §5) 자체를
//        없앤다. 제외 내역은 항상 표시(침묵 제외 금지).
//        ⚠️ 베타 의존: 이 span은 CLAUDE_CODE_ENABLE_TELEMETRY=1 + CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
//        + OTEL_TRACES_EXPORTER 설정을 전부 요구한다. INSUFFICIENT_DATA는 trace 레코드가 0건일 때만
//        나온다 — trace는 흐르는데 대상 span만 0건이면(베타 span 개명 가능성) h2=0 + h2_reason으로
//        모호성을 표기한다(조용한 0으로 위장 금지 — "0 = 안전"이 아니라 "0 + 사유 = 판단 재료").
//   C1 = claude_code.cost.usage 합 (USD)   C2 = claude_code.token.usage 합 by `type` 속성
//        temporality-aware: delta 스트림은 합산, cumulative(각 export가 러닝 토탈 재전송 — OTLP 기본값)
//        는 시리즈(resource+attrs+startTime)별 최댓값 채택. 무표기(gauge 등)는 cumulative로 보수 처리
//        — 무조건 합산은 export 배치 수만큼 배수 과대보고를 낳는다(3축 리뷰 재현).
// 결손 축은 INSUFFICIENT_DATA를 1급 결과로(조작된 0 대신 증명 불가를 정직하게 — run-metrics 관례).
// 파싱은 줄 단위 fail-soft(깨진 줄 skip + 카운트, 파일 단위 실패는 skipped_files로 분리 카운트),
// unparsed 레코드(수신기 fail-open 착지)도 카운트.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundarySurface, H1_EXCLUDED_SURFACES } from '../lib/boundary-surfaces.mjs'

const INSUFFICIENT = 'INSUFFICIENT_DATA'
const H2_SPAN = 'claude_code.tool.blocked_on_user'
const COST_METRIC = 'claude_code.cost.usage'
const TOKEN_METRIC = 'claude_code.token.usage'

const argv = process.argv.slice(2)
let otelDir = join('.loop', 'otel')
let asJson = false
let since = null // ISO 하한(수신 ts 기준) — 병렬 세션/전일 착지분 합산을 시간 창으로 자른다
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--otel-dir') otelDir = argv[++i] ?? ''
  else if (a === '--since') since = argv[++i] ?? ''
  else if (a === '--json') asJson = true
  else {
    process.stderr.write('usage: otel-metrics.mjs [--otel-dir <dir>] [--since <ISO>] [--json]\n')
    process.exit(2)
  }
}
if (!otelDir || (since !== null && Number.isNaN(Date.parse(since)))) {
  process.stderr.write('usage: otel-metrics.mjs [--otel-dir <dir>] [--since <ISO>] [--json]\n')
  process.exit(2)
}

let files = []
try {
  files = readdirSync(otelDir).filter((f) => f.endsWith('.jsonl'))
} catch {
  files = [] // 디렉토리 부재 = 데이터 0 → 전 축 INSUFFICIENT_DATA로 흐른다
}
files.sort()

const kindOf = (f) =>
  f.endsWith('.traces.jsonl')
    ? 'traces'
    : f.endsWith('.metrics.jsonl')
      ? 'metrics'
      : f.endsWith('.logs.jsonl')
        ? 'logs'
        : null

// 알려진 표면은 0으로 시작해 미발생도 표시되게 한다(제외가 보이게 — run-metrics 관례).
const excluded = {}
for (const r of H1_EXCLUDED_SURFACES) {
  if (!(r.surface in excluded)) excluded[r.surface] = 0
}

let skippedLines = 0
let skippedFiles = 0 // 파일 단위 결손은 줄 단위와 규모가 다르다 — 섞으면 결손 크기를 오도(3축 리뷰)
let unparsedRecords = 0
const fileCounts = { traces: 0, metrics: 0, logs: 0 }
let traceRecords = 0 // 파싱된 trace payload 수 — 0이면 H2는 측정 축 부재(INSUFFICIENT)
let h2 = 0
let h2SpanSeen = 0 // 대상 span 관측 수(제외 전) — trace는 흐르는데 0이면 베타 span 개명 의심 신호
const h2BySession = {} // resource attr session.id 귀속 — 병렬 세션 합류를 분리 가시화
let costPoints = 0
let c1 = 0 // delta 스트림 합
let tokenPoints = 0
const c2 = {} // delta 스트림 합 by type
// cumulative 스트림: 시리즈별 최댓값(러닝 토탈 재전송이라 합산 금지). 키에 startTimeUnixNano 포함
// — 프로세스 재시작(카운터 리셋)마다 새 시리즈가 되어 세션 간 최댓값이 서로 삼켜지지 않는다.
const costSeries = new Map() // key → max value
const tokenSeries = new Map() // key → { type, max }

const seriesKey = (rm, m, dp) =>
  `${JSON.stringify(rm?.resource?.attributes ?? [])}|${m?.name}|${JSON.stringify(dp?.attributes ?? [])}|${dp?.startTimeUnixNano ?? ''}`
const isDelta = (m) => {
  const t = m?.sum?.aggregationTemporality
  return t === 1 || /(^|_)DELTA$/i.test(String(t ?? ''))
}
const resAttr = (rm, key) =>
  (rm?.resource?.attributes ?? []).find((a) => a?.key === key)?.value?.stringValue

for (const f of files) {
  const kind = kindOf(f)
  if (!kind) continue
  fileCounts[kind]++
  let raw = ''
  try {
    raw = readFileSync(join(otelDir, f), 'utf8')
  } catch {
    skippedFiles++ // 파일 단위 결손도 침묵 탈락 금지 — 단, 줄 1개로 오표기하지 않는다
    continue
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      skippedLines++
      continue
    }
    if (!rec || typeof rec !== 'object') {
      skippedLines++
      continue
    }
    if (rec.unparsed) {
      unparsedRecords++ // 수신기 fail-open 착지(비JSON body) — 결손을 가시화만 하고 집계 불가
      continue
    }
    if (since && (typeof rec.ts !== 'string' || Date.parse(rec.ts) < Date.parse(since))) continue
    if (kind === 'traces') {
      traceRecords++
      for (const rs of rec.payload?.resourceSpans ?? []) {
        const session = resAttr(rs, 'session.id') ?? 'unknown'
        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) {
            if (span?.name !== H2_SPAN) continue
            h2SpanSeen++
            // 경계 판정: 수신기가 기록 시점(절단 전) 태깅한 boundary_surface 우선 — 저장 속성은
            // sanitize CAP=256으로 장문 명령 꼬리가 잘려 사후 판정이 불가할 수 있다. 태그가 없는
            // 레코드(구버전 착지분)만 저장 텍스트 폴백 — 속성 전체를 이어붙여 보는 건 CC의 속성
            // 스키마(command 위치)가 베타 중 흔들려도 매치가 유지되게(과잉매치는 안전 방향, H1 동일).
            let surface
            if ('boundary_surface' in span) surface = span.boundary_surface
            else {
              const text = (span.attributes ?? [])
                .map((a) => a?.value?.stringValue)
                .filter((v) => typeof v === 'string')
                .join(' ')
              surface = boundarySurface(null, text)
            }
            if (surface) excluded[surface] = (excluded[surface] ?? 0) + 1
            else {
              h2++
              h2BySession[session] = (h2BySession[session] ?? 0) + 1
            }
          }
        }
      }
    } else if (kind === 'metrics') {
      for (const rm of rec.payload?.resourceMetrics ?? []) {
        for (const sm of rm.scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) {
            const dps = m?.sum?.dataPoints ?? m?.gauge?.dataPoints ?? []
            if (m?.name !== COST_METRIC && m?.name !== TOKEN_METRIC) continue
            const delta = isDelta(m)
            for (const dp of dps) {
              const v = Number(dp?.asDouble ?? dp?.asInt ?? 0)
              if (m.name === COST_METRIC) {
                costPoints++
                if (delta) c1 += v
                else {
                  const k = seriesKey(rm, m, dp)
                  costSeries.set(k, Math.max(costSeries.get(k) ?? 0, v))
                }
              } else {
                tokenPoints++
                const type =
                  (dp?.attributes ?? []).find((a) => a?.key === 'type')?.value?.stringValue ??
                  'unknown'
                if (delta) c2[type] = (c2[type] ?? 0) + v
                else {
                  const k = seriesKey(rm, m, dp)
                  const prev = tokenSeries.get(k)
                  tokenSeries.set(k, { type, max: Math.max(prev?.max ?? 0, v) })
                }
              }
            }
          }
        }
      }
    }
  }
}

// cumulative 시리즈 최댓값을 delta 합에 합류 — 시리즈가 서로 다르면(세션/리셋별) 합이 곧 총계다.
for (const v of costSeries.values()) c1 += v
for (const { type, max } of tokenSeries.values()) c2[type] = (c2[type] ?? 0) + max

const round6 = (n) => Math.round(n * 1e6) / 1e6 // 부동소수 합산 잔차 제거(µUSD 정밀도)
const result = {
  files: fileCounts,
  h2: traceRecords > 0 ? h2 : INSUFFICIENT,
  h2_span_seen: h2SpanSeen, // 제외 전 대상 span 관측 수 — 0인데 trace가 흐르면 개명 드리프트 의심
  h2_by_session: h2BySession,
  h2_excluded_by_surface: excluded,
  h2_reason:
    traceRecords > 0
      ? h2SpanSeen > 0
        ? null
        : 'trace는 흐르나 blocked_on_user span 0건 — 실제 대기 0 또는 베타 span 개명/미발화(구분 불가, CC 버전 확인)'
      : 'no trace data — CLAUDE_CODE_ENHANCED_TELEMETRY_BETA/OTEL_TRACES_EXPORTER 미설정 또는 베타 플래그 변경?',
  c1_usd: costPoints > 0 ? round6(c1) : INSUFFICIENT,
  c2_tokens_by_type: tokenPoints > 0 ? c2 : INSUFFICIENT,
  unparsed_records: unparsedRecords,
  skipped_lines: skippedLines,
  skipped_files: skippedFiles,
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(result)}\n`) // 한 줄 — loop-doctor jsonLineOf 이디엄과 호환
} else {
  const lines = []
  lines.push('=== OTEL METRICS ===')
  lines.push(`files: traces=${fileCounts.traces} metrics=${fileCounts.metrics} logs=${fileCounts.logs}`)
  lines.push(
    result.h2 === INSUFFICIENT || result.h2_reason
      ? `H2 (blocked_on_user 사람 대기, merge·deploy·send 제외): ${result.h2} (${result.h2_reason})`
      : `H2 (blocked_on_user 사람 대기, merge·deploy·send 제외): ${result.h2}`,
  )
  if (Object.keys(h2BySession).length > 1) {
    lines.push(
      `h2_by_session: ${Object.keys(h2BySession)
        .map((k) => `${k}=${h2BySession[k]}`)
        .join(' ')}`,
    )
  }
  lines.push(
    `excluded_by_surface: ${Object.keys(excluded)
      .map((k) => `${k}=${excluded[k]}`)
      .join(' ')}`,
  )
  lines.push(`C1 (비용 USD 합): ${result.c1_usd === INSUFFICIENT ? INSUFFICIENT : result.c1_usd}`)
  lines.push(
    result.c2_tokens_by_type === INSUFFICIENT
      ? `C2 (토큰 합 by type): ${INSUFFICIENT}`
      : `C2 (토큰 합 by type): ${Object.keys(c2)
          .map((k) => `${k}=${c2[k]}`)
          .join(' ')}`,
  )
  lines.push(`unparsed_records: ${unparsedRecords}`)
  lines.push(`skipped_lines: ${skippedLines} skipped_files: ${skippedFiles}`)
  lines.push('=== END OTEL METRICS ===')
  process.stdout.write(`${lines.join('\n')}\n`)
}
process.exit(0)
