#!/usr/bin/env node
// run-ledger.mjs — append-only 런 이벤트 원장 (BAC-570, ouroboros O1).
//
// 수정·삭제 함수는 없다 — 상태는 fold(bin/run-metrics.mjs)로만 복원한다(append-only 규약).
// 스키마 v1: {id, type(dot.past_tense), ts(ISO), aggregate_id(run-id), payload, version:1}
//   - 런 경계 = 세션 경계(1 session = 1 run): SessionStart=run.started, SessionEnd=run.ended.
//   - 토큰 귀속 필드(token_source 등)는 v1에 없음 — BAC-587/582에서 이벤트 확장 시 예약.
//   - compaction(PreCompact=auto|manual, BAC-746): payload={cwd, trigger, custom_instructions}. 압축
//     빈도·직후 RED 상관을 bin/run-metrics.mjs가 fold한다(체크포인트 여부 판단의 실측 근거).
// payload는 기록 시점에 BAC-628 sanitize(sanitizeRecord)를 통과한다 — 시크릿 키 blocklist 낙하 +
// 장문 sha256+preview 캡. .loop/runs/*는 gitignore(로컬 텔레메트리, 커밋 금지).
//
// 소비자: .claude/hooks/record-run-event.mjs(계측 훅, 동적 import) · bin/ledger-append.mjs(bash
// CLI — verdict-run.sh) · bin/run-metrics.mjs(fold 집계) · lib/regression-signals.mjs(BAC-631 —
// verdict.* 이벤트만 fold, version 1만, 게이트 정체성=payload.cmd). throw는 호출자가 흡수한다
// (훅=catch no-op, CLI=exit 1 후 호출부 || true) — lib 자체는 던져도 된다.
//
// ⚠️ 신뢰 경계(하류 소비자 필독 — BAC-626 ③·BAC-631): 이 원장(.loop/runs/*.jsonl·current)은
// **위조 가능하다** — 미보호·gitignore 파일이라 에이전트가 Bash 리다이렉트 한 줄로 verdict.passed
// 등 임의 이벤트를 흘려넣을 수 있다. verdict.* 의 *산출기*(verdict-run.sh)만 protect.globs로
// 보호될 뿐 저장소는 텔레메트리 한정 신뢰다(ADR-0036 "가드레일≠경계"). 이 원장을 게이트/루프
// 제어 입력(stall 판정·승격 신호 등)으로 승격하려면 protect 편입 또는 산출기 서명을 먼저 결정할
// 것 — 머지 게이트의 진실은 여전히 verdict-state.json + Stop 훅이다.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sanitizeRecord } from './sanitize.mjs'

export function runsDir(root) {
  return join(root, '.loop', 'runs')
}

// gate-stop-verdict.mjs의 session_id 파일명 안전화와 동일 기법: 비허용 문자 제거, 40자 캡,
// 빈 결과는 'unknown'(집계에서 귀속 불가 버킷으로 가시화).
export function runIdFrom(sessionId) {
  return String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'unknown'
}

// stdin이 없는 bash 호출자(verdict-run.sh --auto-run-id)의 run 귀속용 current 포인터를 읽는다.
// 부재/파손 시 'unknown' — verdict 이벤트가 버려지지 않고 별도 버킷으로 남는다.
export function readCurrentRunId(root) {
  try {
    const line = readFileSync(join(runsDir(root), 'current'), 'utf8').split('\n')[0].trim()
    // 파손 값은 계약대로 'unknown'으로 강등 — 정상 포인터는 항상 runIdFrom 산출물이라 자기
    // 재적용에 불변이다. 검증 없이 통과시키면 경로 문자('../' 등)가 섞인 파손 포인터가 보호
    // 파일(verdict-run.sh)의 쓰기 경로를 .loop/runs 밖으로 조향하거나, ENOENT로 verdict
    // 이벤트를 다음 SessionStart까지 무음 유실시킨다(리뷰 실측 2건).
    return line && line === runIdFrom(line) ? line : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function appendRunEvent(root, { type, sessionId, runId, payload, writeCurrentPointer, clearCurrentPointer }) {
  const dir = runsDir(root)
  mkdirSync(dir, { recursive: true })
  const rid = runId ?? runIdFrom(sessionId)
  const event = {
    id: randomUUID(),
    type,
    ts: new Date().toISOString(),
    aggregate_id: rid,
    payload: sanitizeRecord(payload ?? {}),
    version: 1,
  }
  appendFileSync(join(dir, `${rid}.jsonl`), `${JSON.stringify(event)}\n`)
  // current 포인터는 확장자 없음 — run-metrics의 *.jsonl 글롭에 걸리면 파싱이 오염된다.
  // 갱신은 run.started(SessionStart)만. 같은 워크트리 동시 세션이면 last-writer-wins로 verdict
  // 귀속이 섞일 수 있다 — 워크트리당 1작업 규약(CLAUDE.md §8) 전제로 수용.
  if (writeCurrentPointer) writeFileSync(join(dir, 'current'), `${rid}\n`)
  // run.ended 후 잔존 포인터는 이후 터미널 verdict를 이미 끝난 런에 계속 귀속시킨다(리뷰) —
  // 자기 run-id일 때만 제거(동시 세션이 새로 쓴 포인터는 보존). 이후 verdict는 unknown 버킷으로
  // 남는다(의미상 정직 — 세션 밖 검증은 귀속 불가가 맞다).
  if (clearCurrentPointer && readCurrentRunId(root) === rid) {
    try {
      unlinkSync(join(dir, 'current'))
    } catch {
      /* best-effort — 포인터 정리 실패가 이벤트 기록을 깨면 안 된다 */
    }
  }
  return event
}

// ── verdict 이벤트 귀속 해소 (BAC-778) ───────────────────────────────────────────────────────
// 문제(실측): 계측 훅(record-run-event.mjs)은 CLAUDE_PROJECT_DIR 아래 원장에 쓰는데 verdict-run.sh는
// **cwd** 아래에 쓴다. 워크트리 격리 규약을 지키는 레포에선 이 둘이 상시로 갈린다 — 검증은 링크된
// 워크트리에서 돌고 세션 이벤트는 메인 워크트리에 남는다. 게다가 워크트리엔 `.loop/runs/current`가
// 없어 run-id까지 'unknown'으로 떨어진다. 결과: 세션 원장에 verdict.* 이벤트가 한 건도 없고
// run-metrics의 Q1(first-pass)·Q2가 전 런 INSUFFICIENT_DATA가 된다. (glucofit-partners 7일 실측:
// 메인 원장 = 3,096 이벤트 / 111 런 / verdict.* 0건. 같은 시점 워크트리 하나의 unknown.jsonl =
// verdict.passed 14 + verdict.failed 2 — 이벤트는 산출되고 있었고, 원장이 갈려 있었을 뿐이다.)
//
// 해소는 **추측이 아니라 확증(corroboration)**으로 한다: 후보 루트 중 `<root>/.loop/runs/<run-id>.jsonl`이
// **이미 존재하는** 곳에만 붙인다 — 그 파일 자체가 "훅이 이 세션의 이벤트를 여기 쓰고 있다"는 증거다.
// 확증이 하나도 없으면 기존 동작(cwd + current 포인터 + unknown 버킷)이 한 글자도 안 바뀐다.
//
// run-id 우선순위: ① CLAUDE_CODE_SESSION_ID ② `.loop/runs/current` ③ 'unknown'.
//   ①은 Bash 툴 호출 환경에 실제로 주입된다(실측 확인) — 훅이 stdin으로 받는 session_id와 같은 값이라
//   세션 원장 파일명과 일치하고, current 포인터의 동시-세션 last-writer-wins 오귀속에 면역이다.
// 루트 후보: CLAUDE_PROJECT_DIR → cwd → 메인 워크트리 루트.
//   ⚠️ CLAUDE_PROJECT_DIR는 **훅 프로세스에만** 주입되고 Bash 툴 호출에는 없다(실측: UNSET) — 그래서
//   `git rev-parse --git-common-dir`로 메인 워크트리를 유추하는 세 번째 후보가 필요하다. git 호출은
//   best-effort(2초 타임아웃 — 실패하면 그 후보가 없는 것으로 친다).
function mainWorktreeRoot(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    if (!common) return null
    const abs = resolve(cwd, common)
    // 통상 형태는 `<메인 워크트리>/.git` — bare repo 등 그 외 형태는 메인 워크트리가 없다고 본다.
    return abs.endsWith('/.git') ? dirname(abs) : null
  } catch {
    return null
  }
}

export function resolveLedgerTarget({ cwd, env } = {}) {
  const base = cwd ?? process.cwd()
  const e = env ?? {}
  const roots = []
  const push = (d) => {
    if (typeof d === 'string' && d && !roots.includes(d)) roots.push(d)
  }
  push(e.CLAUDE_PROJECT_DIR)
  push(base)
  push(mainWorktreeRoot(base))

  const sid = runIdFrom(e.CLAUDE_CODE_SESSION_ID)
  if (sid !== 'unknown') {
    for (const r of roots) {
      // 확증: 훅이 이미 이 세션 파일을 쓰고 있는 원장에만 붙는다.
      if (existsSync(join(runsDir(r), `${sid}.jsonl`))) {
        return { root: r, runId: sid, source: 'session-id' }
      }
    }
  }
  for (const r of roots) {
    const rid = readCurrentRunId(r)
    if (rid !== 'unknown') return { root: r, runId: rid, source: 'current-pointer' }
  }
  return { root: base, runId: 'unknown', source: 'unattributed' }
}
