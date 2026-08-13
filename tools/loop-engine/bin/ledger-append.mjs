#!/usr/bin/env node
// ledger-append.mjs — bash 소비자(verdict-run.sh write_state)용 원장 append CLI (BAC-570).
//
// Usage: echo '<payload-json>' | ledger-append.mjs --type <dot.past_tense> [--run-id <id> | --auto-run-id]
//   --auto-run-id : .loop/runs/current에서 run-id를 읽음(부재/파손 시 'unknown' 버킷).
// payload는 argv가 아니라 stdin으로 받는다 — 초대형 cmd 문자열의 argv 전달은 E2BIG로 죽는다
// (웨이브2 검증 교훈과 동일 실패 모드 예방).
// exit 0=기록됨, 1=실패(호출자는 || true로 무시 — best-effort, verdict·exit 불변), 2=usage.
// root = cwd — verdict-run.sh가 검증 대상 레포/워크트리에서 실행되므로 원장도 그 곁에 남는다.

import { readFileSync } from 'node:fs'
import { appendRunEvent, readCurrentRunId } from '../lib/run-ledger.mjs'

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
  const root = process.cwd()
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    payload = {} // payload는 best-effort — 파싱 불가여도 이벤트 자체(type)는 기록한다
  }
  const rid = autoRunId ? readCurrentRunId(root) : runId || 'unknown'
  appendRunEvent(root, { type, runId: rid, payload })
  process.exit(0)
} catch (e) {
  process.stderr.write(`ledger-append: ${e?.message ?? e}\n`)
  process.exit(1)
}
