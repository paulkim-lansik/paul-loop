#!/usr/bin/env node
// sanitize.mjs — 루프 기록 경로의 저장 시점 redaction (BAC-628, ouroboros O5).
//
// 역할 분리(ADR-0078 M0과 상보 — 새 ADR 없음):
//   - ADR-0078 M0 살균 게이트(gitleaks) = **커밋 시점** 방어 — 시크릿이 레포 밖으로 나가는 것을 막는다.
//   - 이 유틸 = **기록 시점** 방어 — .loop 로그·lessons 등 디스크 착지 자체에서 시크릿을 지운다.
//     (.loop/*는 .gitignore로 미커밋이지만, 로컬 디스크 잔존·loop-fix 프롬프트 재주입·향후 원장
//      승격(BAC-570 .loop/runs) 경로가 있어 기록 지점 방어가 상보로 필요하다.)
//
// 스위치: LOOP_SANITIZE_OFF — 정확히 '1'일 때만 OFF. 그 외 모든 값(미설정·'0'·미지값)은 ON
//   (ouroboros privacy 스위치의 fail-closed 규약: 미지 값은 가장 보수적인 쪽).
//
// 소비자: verdict-run.sh(LOG in-place), lessons.mjs(서명/fix/title), (후속) BAC-570 .loop/runs 원장.
//
// 하류 소비 계약(회귀는 sanitize.test.sh가 잠근다): 살균은 줄 구조를 보존한다 — 개행을 추가/삭제하지
// 않고, 시크릿이 없는 줄(첫 줄·프레임워크 요약 줄 포함)은 불변이다. verdict-run의 passthrough 첫줄
// 검사·카운트 추출·FAIL 추출이 전부 살균 *후* 텍스트를 보기 때문이다.

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CAP = 256                                   // preview 캡 (ouroboros 256자)
const h16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// 레코드 키 blocklist — ouroboros 5종(prompt/stdout/stderr/token/secret) + 우리 확장(BAC-628).
// 매치는 경계 기반 — 부분문자열 포함은 계측 키(input_tokens·token_source·stdout_bytes, BAC-570 원장
// payload)까지 낙하시켜 수치를 파괴한다(리뷰). 키를 세그먼트(camelCase·[-_.] 경계)로 쪼개 ①전체 결합
// ②마지막 세그먼트 ③인접 2-세그먼트 결합(apiKey→apikey)만 대조한다: access_token·client_secret·
// set-cookie는 낙하, input_tokens·token_source·promptVersion은 통과.
export const BLOCKLIST_KEYS = ['prompt', 'stdout', 'stderr', 'token', 'secret',
  'password', 'passwd', 'authorization', 'cookie', 'apikey']
const segsOf = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const isBlocked = (k) => {
  const s = segsOf(k)
  if (s.length === 0) return false
  const cands = [s.join(''), s[s.length - 1]]
  for (let i = 0; i + 1 < s.length; i++) cands.push(s[i] + s[i + 1])
  return cands.some((c) => BLOCKLIST_KEYS.includes(c))
}

export const sanitizeOff = (env = process.env) => env.LOOP_SANITIZE_OFF === '1'   // 미지값=ON(fail-closed)

// 텍스트 마스킹 — 원문 로그용. blocklist 중 "값이 곧 시크릿"인 부분집합의 key=value / "key": "value"
// (JSON 한 줄 — 로그의 최빈 시크릿 착지 모양) / Bearer / URL 내장 자격증명(scheme://user:pass@)만
// 마스킹하고 절단은 하지 않는다(로그의 진단 가치 보존 — 절단은 레코드 모드만). prompt/stdout/stderr는
// 레코드 *필드명* blocklist지 텍스트 안의 시크릿 키가 아니므로 텍스트 모드에선 제외(진단 줄 파괴 방지).
// 공백/인용 클래스는 개행을 배제([ \t]·[^"\n]) — 값 매치가 줄 경계를 넘으면 뒤따르는 FAIL 진단 줄이
// 통째로 삼켜진다(리뷰 실측: 미닫힘 따옴표).
const TEXT_KEY = /(["']?[A-Za-z0-9_.-]*(?:token|secret|passwd|password|api[-_]?key|authorization|cookie)[A-Za-z0-9_.-]*["']?[ \t]*)([=:])([ \t]*)((?:Bearer|Basic)[ \t]+[^\s"']+|"[^"\n]*"|'[^'\n]*'|\S+)/gi
const BEARER = /\b(bearer)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_CRED = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s@]+)@/gi
// 값 판별 — assertion operand(undefined/null/true/false/NaN/숫자)와, 콜론 구분·비인용·짧은 순수
// 알파벳 단어(진단 어휘: `id_token: expired`·`Authorization: header missing`·`SESSION_SECRET: Required`)는
// 마스킹하지 않는다 — lessons 서명의 "operand를 지우지 않는다" 불변식과 loop-fix stall 서명 오탐
// (진짜 전진을 동일 실패로 오인) 방지(리뷰). 콜론+순수 알파벳 장문/인용값/=값은 여전히 마스킹.
const OPERAND = /^(?:undefined|null|true|false|nan|\d+)$/i
export function sanitizeText(text, env = process.env) {
  if (sanitizeOff(env) || typeof text !== 'string') return text
  return text
    .replace(TEXT_KEY, (m, key, sep, ws, val) => {
      const quoted = /^["']/.test(val)
      const inner = quoted ? val.slice(1, -1) : val
      if (OPERAND.test(inner)) return m
      if (sep === ':' && !quoted && val.length < 16 && /^[A-Za-z]+$/.test(val)) return m
      return `${key}${sep}${ws}[REDACTED]`
    })
    .replace(BEARER, '$1 [REDACTED]')
    .replace(URL_CRED, '$1:[REDACTED]@')
}

// 레코드 살균 — 비파괴(입력 불변, 항상 새 값 반환). blocklist 키는 값을 마커로 낙하(감사 가능하게
// sha256 16자+길이는 남긴다), CAP 초과 문자열은 preview+절단 마커, 나머지는 재귀 통과.
export function sanitizeRecord(v, env = process.env) {
  if (sanitizeOff(env)) return v
  if (typeof v === 'string') {
    const s = sanitizeText(v, env)
    return s.length > CAP ? `${s.slice(0, CAP)}<truncated len=${s.length} sha256=${h16(s)}>` : s
  }
  if (Array.isArray(v)) return v.map((x) => sanitizeRecord(x, env))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      // 숫자/불리언/null은 정의상 시크릿이 아니다 — blocklist 키여도 통과(input_tokens=1200 같은
      // 계측치가 마커로 낙하해 BAC-570 O1 베이스라인 측정을 불가능하게 만드는 것을 방지, 리뷰).
      const prim = val === null || typeof val === 'number' || typeof val === 'boolean'
      out[k] = isBlocked(k) && !prim
        ? `[REDACTED len=${JSON.stringify(val)?.length ?? 0} sha256=${h16(JSON.stringify(val) ?? '')}]`
        : sanitizeRecord(val, env)
    }
    return out
  }
  return v   // number/bool/null 통과
}

// ---- CLI (bash 소비자용 — node -e 없이 파일 경로로 호출) ----
// --in-place <file> : 텍스트 파일을 살균해 원자적(tmp+rename) 재작성
// --text            : stdin 텍스트 → stdout
// --record          : stdin JSON 1건 → stdout 살균 JSON
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2)
  if (mode === '--in-place' && file) {
    const raw = readFileSync(file, 'utf8')
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, sanitizeText(raw))
    renameSync(tmp, file)                        // 동일 디렉토리 원자 교체
  } else if (mode === '--text') {
    process.stdout.write(sanitizeText(readFileSync(0, 'utf8')))
  } else if (mode === '--record') {
    process.stdout.write(`${JSON.stringify(sanitizeRecord(JSON.parse(readFileSync(0, 'utf8'))))}\n`)
  } else {
    process.stderr.write('usage: sanitize.mjs --in-place <file> | --text | --record\n')
    process.exit(2)
  }
}
