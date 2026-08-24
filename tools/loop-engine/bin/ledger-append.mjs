#!/usr/bin/env node
// ledger-append.mjs — bash 소비자(verdict-run.sh write_state)용 원장 append CLI (BAC-570).
//
// Usage: echo '<payload-json>' | ledger-append.mjs --type <dot.past_tense> [--run-id <id> | --auto-run-id]
//   --auto-run-id : 세션 원장을 확증으로 찾아 run-id·루트를 함께 해소한다(lib/run-ledger.mjs의
//     resolveLedgerTarget — CLAUDE_CODE_SESSION_ID → `.loop/runs/current` → 'unknown' 버킷 순).
//     확증(`<root>/.loop/runs/<run-id>.jsonl` 존재)이 없으면 기존 동작 그대로 cwd + current 포인터다.
//     이게 BAC-778에서 "verdict.* 이벤트가 세션 원장에 한 건도 없다"를 닫은 지점이다 — 워크트리에서
//     돈 검증이 메인 워크트리의 세션 원장에 정상 귀속된다.
// payload는 argv가 아니라 stdin으로 받는다 — 초대형 cmd 문자열의 argv 전달은 E2BIG로 죽는다
// (웨이브2 검증 교훈과 동일 실패 모드 예방).
// exit 0=기록됨, 1=실패(호출자는 || true로 무시 — best-effort, verdict·exit 불변), 2=usage.
// root = cwd — verdict-run.sh가 검증 대상 레포/워크트리에서 실행되므로 원장도 그 곁에 남는다.

import { readFileSync } from 'node:fs'
import { appendRunEvent, resolveLedgerTarget } from '../lib/run-ledger.mjs'

function usage() {
  process.stderr.write(
    'usage: echo <payload-json> | ledger-append.mjs --type <type> [--run-id <id> | --auto-run-id]\n',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
let type = ''
let runId = ''
let autoRunId = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--type') type = argv[++i] ?? ''
  else if (a === '--run-id') runId = argv[++i] ?? ''
  else if (a === '--auto-run-id') autoRunId = true
  else usage()
}
if (!type || (runId && autoRunId)) usage()

try {
  const cwd = process.cwd()
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    payload = {} // payload는 best-effort — 파싱 불가여도 이벤트 자체(type)는 기록한다
  }
  // --run-id는 명시 지정이므로 루트도 cwd 고정(호출자가 이미 어디에 쓸지 정했다).
  const target = autoRunId
    ? resolveLedgerTarget({ cwd, env: process.env })
    : { root: cwd, runId: runId || 'unknown' }
  appendRunEvent(target.root, { type, runId: target.runId, payload })
  process.exit(0)
} catch (e) {
  process.stderr.write(`ledger-append: ${e?.message ?? e}\n`)
  process.exit(1)
}
