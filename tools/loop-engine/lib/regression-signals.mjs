#!/usr/bin/env node
// regression-signals.mjs — .loop/runs 원장(BAC-570)의 verdict 이벤트를 결정론 fold해 "한 번
// PASS했던 게이트의 FAIL 회귀"를 부상시킨다 (BAC-631, ouroboros O10 RegressionDetector).
// LLM 판단 0 — 순수 이력 비교. 소비자 = bin/regression-signals.mjs(CLI)·lessons.mjs promote --runs.
//
// ── 원장 소비자 계약 (AC③ — 산출기 실물 기준 핀: verdict-run.sh write_state · lib/run-ledger.mjs) ──
//   경로: <runs-dir>/*.jsonl — run당 1파일(파일명=run-id). `current` 포인터는 확장자 없음이라
//     글롭에서 자연 제외된다(run-ledger.mjs의 파싱 오염 방지 규약과 동일).
//   이벤트: {id, type(dot.past_tense), ts(ISO-8601), aggregate_id(run-id), payload, version: 1}
//   verdict 이벤트: type = "verdict.passed" | "verdict.failed" (판정은 type이 정본),
//     payload = {verdict:"PASS"|"FAIL", exit, cmd, log} — BAC-628 sanitizeRecord 통과 후 착지.
//     **게이트 정체성 = normalizeGateKey(payload.cmd)** — raw cmd는 호출 경로마다 문자열이 다르다:
//     `pnpm verdict` 직행은 "pnpm verify", loop-fix 경로(loop-fix.sh가 `-- sh -c "$VERIFY"`로 래핑)는
//     "sh -c pnpm verify"로 착지해 같은 게이트가 두 정체성으로 쪼개진다(경로 교차 PASS→FAIL을 놓침 —
//     리뷰 실측). normalizeGateKey가 선행 `sh -c ` 래퍼를 벗기고 원장 절단 규칙(아래)에 맞춰 수렴시킨다.
//     lessons record --gate도 같은 함수로 정규화해 교차 참조 키가 어긋나지 않는다.
//     ledger-append.mjs는 stdin 파싱 실패 시 payload={}로 기록한다(best-effort) → cmd 비문자열은
//     게이트 귀속 불가로 skip+카운트(skipped_events).
//   내성 규약 (run-metrics.mjs fold 이디엄 — 절대 throw하지 않는다):
//     JSON 파싱 실패 줄·type 비문자열 → skipped_lines / 파일 읽기 실패 → skipped_files /
//     verdict.*인데 version!==1·미지 subtype·cmd 비문자열·ts 비문자열 → skipped_events /
//     aggregate_id "unknown"(귀속 불가 버킷)의 verdict → **fold 포함** + unknown_verdict_events 카운터.
//     run-metrics의 unknown *overall 제외*는 런 단위 분모/평균 왜곡(Q1·Q2·H1) 방지가 근거인데, 이
//     fold는 런 분모가 없는 게이트별 시계열이라 그 근거가 적용되지 않는다 — 세션 밖 verdict(pre-push
//     훅·run.ended 후 등, run-ledger.mjs가 명시한 흔한 경로)도 "그 게이트가 그 시각에 통과/실패했다"는
//     유효한 증거다. 제외하면 세션내 PASS → 세션밖 FAIL 회귀가 삼켜진다(리뷰 실측). aggregate_id는
//     regressions[].runs 표기에만 쓰인다('unknown' 그대로 노출).
//   판정: (ts, id) 오름차순 정렬 후 게이트별 fold — 회귀 = "passed가 1회 이상 존재 AND 마지막
//     passed 이후의 최신 이벤트가 failed"(PASS→FAIL 전이). failed만 있는 게이트는 회귀가 아니라
//     insufficient(한 번도 증명된 적 없음 — INSUFFICIENT를 1급 결과로, frugality proof). 복구
//     (passed로 끝남)는 회귀 아님. 출력은 게이트명 정렬 고정 — 재실행 byte-identical(결정론).
//
// ⚠️ 신뢰 경계 (run-ledger.mjs 헤더 필독): 이 원장은 **위조 가능하다** — 미보호·gitignore 파일이라
// Bash 리다이렉트 한 줄로 verdict.passed/failed를 흘려넣을 수 있다. 따라서 회귀 신호는 lessons
// 승격 파이프라인의 *후보 입력*일 뿐 자동 승격이 아니다 — 회의적 challenge 게이트(lessons
// challenge --verdict accept)는 그대로 유지된다. 이 신호를 게이트/루프 제어 입력으로 승격하려면
// protect 편입 또는 산출기 서명이 선행돼야 한다(머지 게이트의 진실은 verdict-state.json + Stop 훅).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 게이트 키 정규화 — 두 표면(원장 payload.cmd ↔ lessons record --gate)의 정체성 수렴 규칙(계약).
// ① 선행 `sh -c ` 래퍼 제거: loop-fix 경로의 CMD_STR("sh -c pnpm verify")과 직접 실행("pnpm verify")
//    이 같은 게이트로 수렴한다. ② 원장 cmd는 verdict-run json_esc(500자 컷) → sanitizeRecord(256자
//    preview + `<truncated len=…>` 마커)를 거치지만 --gate는 sanitizeText만 거친다 — 마커 이후를
//    버리고 256자로 맞춰 장문 명령도 양 표면 키가 일치한다(래퍼+초장문 조합의 꼬리 어긋남은 수용 —
//    전형 게이트 문자열은 무영향). 빈 결과는 게이트 귀속 불가(호출자가 skip 처리).
export function normalizeGateKey(cmd) {
  let s = String(cmd ?? '').trim()
  while (s.startsWith('sh -c ')) s = s.slice(6).trim()
  const cut = s.indexOf('<truncated len=')
  if (cut !== -1) s = s.slice(0, cut)
  return s.slice(0, 256).trim()
}

// <runs-dir>/*.jsonl → 줄 단위 파싱. 손상 줄·파일 읽기 실패는 skip+카운트(침묵 탈락 금지),
// 디렉토리 부재/읽기 실패는 missing:true (호출자가 fail-open 경고를 낼 수 있게).
export function readRunEvents(runsDir) {
  let files = []
  let missing = false
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { events: [], missing: true, skipped_lines: 0, skipped_files: 0 }
  }
  files.sort()
  const events = []
  let skippedLines = 0
  let skippedFiles = 0
  for (const f of files) {
    let raw = ''
    try {
      raw = readFileSync(join(runsDir, f), 'utf8')
    } catch {
      skippedFiles++
      continue
    }
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
  }
  return { events, missing, skipped_lines: skippedLines, skipped_files: skippedFiles }
}

// 게이트별 verdict 이력의 순수 fold — 입력 순서 무관 (ts, id) 정렬로 결정론 보장.
export function detectRegressions(events) {
  let skippedEvents = 0
  let unknownVerdictEvents = 0
  const usable = []
  for (const e of Array.isArray(events) ? events : []) {
    if (typeof e?.type !== 'string' || !e.type.startsWith('verdict.')) continue
    const passed = e.type === 'verdict.passed'
    const gate = typeof e.payload?.cmd === 'string' ? normalizeGateKey(e.payload.cmd) : ''
    if (
      (!passed && e.type !== 'verdict.failed') || // 미지 verdict subtype
      e.version !== 1 || // 계약은 version 1만
      !gate || // 게이트 귀속 불가(ledger-append best-effort payload={} · 빈 정규화 결과)
      typeof e.ts !== 'string' ||
      !e.ts // 정렬 불능 — 결정론이 깨진다
    ) {
      skippedEvents++
      continue
    }
    // 'unknown' 런 귀속 verdict도 게이트 증거로는 유효 — fold 포함, 카운터로 가시화(헤더 계약).
    if (e.aggregate_id === 'unknown') unknownVerdictEvents++
    usable.push({ ...e, gate })
  }
  usable.sort(
    (x, y) => String(x.ts).localeCompare(String(y.ts)) || String(x.id).localeCompare(String(y.id)),
  )
  const byGate = new Map()
  for (const e of usable) {
    const g = byGate.get(e.gate) ?? []
    g.push(e)
    byGate.set(e.gate, g)
  }
  const regressions = []
  const insufficient = []
  for (const gate of [...byGate.keys()].sort()) {
    const hist = byGate.get(gate)
    let lastPassIdx = -1
    for (let i = 0; i < hist.length; i++) if (hist[i].type === 'verdict.passed') lastPassIdx = i
    if (lastPassIdx === -1) {
      insufficient.push(gate) // 한 번도 PASS한 적 없음 — 회귀가 아니라 증거 부족(1급)
      continue
    }
    if (lastPassIdx === hist.length - 1) continue // 최신이 passed — 건강/복구, 회귀 아님
    const fails = hist.slice(lastPassIdx + 1) // 마지막 passed 이후는 정의상 전부 failed
    const runs = []
    for (const e of fails) if (!runs.includes(e.aggregate_id)) runs.push(e.aggregate_id)
    regressions.push({
      gate,
      last_pass_ts: hist[lastPassIdx].ts,
      first_fail_ts: fails[0].ts,
      fail_count: fails.length,
      runs,
    })
  }
  return {
    regressions,
    insufficient,
    skipped_events: skippedEvents,
    unknown_verdict_events: unknownVerdictEvents,
  }
}
