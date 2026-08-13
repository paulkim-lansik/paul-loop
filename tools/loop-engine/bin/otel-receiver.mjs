#!/usr/bin/env node
// otel-receiver — Claude Code OTel(OTLP/HTTP json) 로컬 수신기 (BAC-587). 127.0.0.1 전용 바인딩
// (외부 노출 금지, AC① — otel-receiver.test.sh가 소스+런타임 이중 단언). 기동은 opt-in 수동:
//   node tools/loop-engine/bin/otel-receiver.mjs     # 기본 포트 44318 = settings env 블록 endpoint
// docker 불사용 — verify:loop의 "bash+node, no docker" 계약 안에서 행위 회귀가 가능해야 하고,
// 상시 대기 관측 데몬은 딥게이트 격리 컨테이너 수명주기(ADR-0054)와도 맞지 않다.
// content 플래그는 전부 꺼져 있어(otel-hygiene.test.sh) 수신 payload는 메타데이터/집계값만이지만,
// 기록 전 sanitizeRecord를 한 번 더 통과시킨다. 주의(과장 금지): OTLP 구조의 키는 key/value/
// stringValue뿐이라 blocklist 키 낙하는 매치되지 않는다 — 여기서 실효는 길이 캡(256자 절단)과
// key=value 형태 시크릿 마스킹까지다. content 차단의 실 방어선은 위생 게이트(플래그 off)다.
// 착지: .loop/otel/<YYYY-MM-DD>.<kind>.jsonl — .gitignore `.loop/*`로 미커밋(런타임 텔레메트리라
// protect.globs에도 안 넣는다 — 재기록 파일이 스냅샷 검사에 들어가면 스퓨리어스 실패).
// 소비자: tools/loop-engine/bin/otel-metrics.mjs (H2/C1/C2). 문서: tools/loop-engine/docs/otel.md.
import { appendFileSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundarySurface } from '../lib/boundary-surfaces.mjs'
import { sanitizeRecord } from '../lib/sanitize.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HOST = '127.0.0.1' // 이 상수 외 바인딩 경로 없음 — 테스트가 소스+런타임 이중 단언
// 44318 = 레포 전용 비표준 포트. 표준 4318은 dev 머신에 타 프로젝트 collector(외부 포워딩 구성)가
// 흔히 상주해, 우리 수신기 미기동 시 텔레메트리가 그쪽으로 무음 유출되거나 반대로 우리 수신기가
// 타 프로젝트 세션을 합류시킨다 — 비표준 포트로 두 방향 모두 구조적으로 차단(3축 리뷰).
const PORT = Number(process.env.LOOP_OTEL_PORT || 44318)
const OUT_DIR = process.env.LOOP_OTEL_DIR || join(ROOT, '.loop', 'otel')
const MAX_BODY = 5 * 1024 * 1024 // 413 상한 — 폭주 body로부터 디스크 보호

const KINDS = { '/v1/metrics': 'metrics', '/v1/logs': 'logs', '/v1/traces': 'traces' }
const H2_SPAN = 'claude_code.tool.blocked_on_user'

// 경계(merge/deploy/send) 태깅은 기록 시점 — sanitize CAP=256 절단 *전*이어야 한다. 절단 후 사후
// 판정은 장문 명령 꼬리의 merge/deploy 토큰을 잃어 사람-승인 경계 대기가 H2에 산입된다(H1이
// record-run-event 시점 태깅으로 회피한 것과 동일 함정 — lib/boundary-surfaces.mjs 헤더). 집계기
// (otel-metrics)는 이 태그를 우선 사용한다.
function tagBoundaries(payload) {
  for (const rs of payload?.resourceSpans ?? []) {
    for (const ss of rs?.scopeSpans ?? []) {
      for (const span of ss?.spans ?? []) {
        if (span?.name !== H2_SPAN) continue
        const text = (span.attributes ?? [])
          .map((a) => a?.value?.stringValue)
          .filter((v) => typeof v === 'string')
          .join(' ')
        span.boundary_surface = boundarySurface(null, text)
      }
    }
  }
  return payload
}

function append(kind, record) {
  mkdirSync(OUT_DIR, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  appendFileSync(join(OUT_DIR, `${date}.${kind}.jsonl`), `${JSON.stringify(record)}\n`)
}

function handler(req, res) {
  const kind = KINDS[(req.url || '').split('?')[0]]
  if (req.method !== 'POST' || !kind) {
    res.writeHead(404).end()
    return
  }
  const chunks = []
  let size = 0
  let capped = false
  req.on('data', (c) => {
    if (capped) return // 413 응답 후 버퍼 잔여 청크로 재발화해도 writeHead 재호출(throw→사망) 금지
    size += c.length
    if (size > MAX_BODY) {
      capped = true
      res.writeHead(413).end()
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (capped) return
    const body = Buffer.concat(chunks)
    const ts = new Date().toISOString()
    const isJson = /json/i.test(String(req.headers['content-type'] || ''))
    // 파싱 불가(protobuf/grpc 등)에도 200 — CC 텔레메트리 실패가 세션/재시도 폭주로 번지면 안 된다
    // (fail-open 관측). http/json 고정(settings env 블록)이 정상 경로, 이건 방어선. unparsed 레코드는
    // reason으로 원인(non-json vs bad-json)을 분리해 남긴다.
    let record
    if (isJson) {
      try {
        const payload = JSON.parse(body.toString('utf8'))
        record = { ts, kind, payload: sanitizeRecord(kind === 'traces' ? tagBoundaries(payload) : payload) }
      } catch {
        record = { ts, kind, unparsed: true, reason: 'bad-json', bytes: body.length }
      }
    } else {
      record = { ts, kind, unparsed: true, reason: 'non-json', bytes: body.length }
    }
    try {
      append(kind, record)
    } catch (e) {
      // 응답은 200 유지(fail-open)하되 기록 실패를 무음으로 두면 '잘 돎'과 '전량 유실'이 같아진다
      // (디스크 풀·권한 변경) — stderr 1줄로 가시화. 며칠 뒤 INSUFFICIENT_DATA를 베타 플래그
      // 문제로 오진단하게 만드는 관측 공백을 막는다.
      console.error(`otel-receiver: append failed (${kind}) — ${e?.code ?? e?.message ?? e}`)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}') // OTLP partial-success 규약 최소형
  })
  req.on('error', () => {
    /* 연결 단절 — 수신기는 계속 산다 */
  })
}

const srv = http.createServer(handler)
srv.on('error', (e) => {
  // EADDRINUSE 등 — 수동 데몬이라 명확히 실패한다. 자동 포트 산책은 안 한다(settings env 블록의
  // endpoint와 어긋난 포트는 무의미). 다른 포트가 필요하면 LOOP_OTEL_PORT + endpoint를 함께 바꿀 것.
  console.error(`otel-receiver failed to bind ${HOST}:${PORT} — ${e.code ?? e.message}`)
  process.exit(1)
})
srv.listen(PORT, HOST, () => {
  const a = srv.address()
  console.log(`otel-receiver listening on ${a.address}:${a.port} → ${OUT_DIR}`) // 테스트 파싱용 기동 배너
})
