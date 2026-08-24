#!/usr/bin/env node
// boundary-surfaces.mjs — H1 제외 경계 표면 목록의 단일 소스 (BAC-570 AC "제외 목록 코드 명시").
//
// H1(런당 인간 개입 수)에서 merge/deploy/send를 반드시 제외한다: 제외하지 않으면 "사람 개입
// 줄이기" 최적화가 우리가 지키기로 한 사람-승인 경계(ADR-0061 §5 — 머지·배포·발송은 항상
// REQUIRE) 자체를 최적화해 없앤다(이슈 원문). classify-risk COMMAND_RULES cmd-irreversible의
// 근사 미러 + 발송(send) 표면.
//
// 정규식 *근사*인 이유: gate-risky-commands의 토크나이저 판정은 deny 정확성이 필요해서고, 여기는
// 지표 제외라 과잉매치가 안전 방향이다(경계 프롬프트가 H1에 섞이는 것보다 과잉 제외가 낫다).
// 태깅은 기록 시점(.claude/hooks/record-run-event.mjs) — BAC-628 preview cap 이후엔 장문 명령의
// 판정이 불가할 수 있어서다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const H1_EXCLUDED_SURFACES = [
  { surface: 'merge', re: /\bgh\b[^\n;|&]*\bpr\b[^\n;|&]*\bmerge\b/ },
  { surface: 'merge', re: /\bgit\s+push\b[^\n]*\b(main|develop)\b/ },
  { surface: 'deploy', re: /\bpnpm\s+(run\s+)?(deploy|redeploy)\b/ },
  { surface: 'deploy', re: /tools\/deploy\// },
  { surface: 'deploy', re: /\b(vercel|flyctl)\s+deploy\b/ },
  // 발송 표면 = 레포 outbound 경로 토큰(classify-risk outbound 규칙과 정합). 일반 단어 send는
  // 과잉 제외(git send-email류 오탐)라 배제.
  { surface: 'send', re: /alimtalk|biz-?message|revisit-calls/i },
]

// 위 `send` 토큰들은 이 하네스가 처음 자란 레포의 outbound 경로 이름이다 — 다른 소비 레포에선 절대
// 매치되지 않아 *그 레포의* 발송 명령이 H1에서 제외되지 않는다. 즉 이 파일이 막으려던 실패(사람-승인
// 경계가 H1 최적화 대상이 되는 것)가 그 레포에선 그대로 열려 있다. 그래서 소비 레포가 자기 발송
// 어휘를 `.claude/ship-flow.config.json` -> `sendSurfacePattern`(정규식 문자열)로 선언하면 여기에
// 추가 규칙으로 붙는다. loop-engine 훅들이 repo-specific 값에 쓰는 관례와 동일
// (gate-verify-pipe `verifyCommandPattern`, gate-before-merge `releaseBranch`). 기본 규칙은 그대로
// 남는다 — 설정은 *확장*이지 교체가 아니다(과잉 제외가 안전 방향이라는 위 판단 그대로).
try {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const cfg = JSON.parse(readFileSync(join(root, '.claude', 'ship-flow.config.json'), 'utf8'))
  if (typeof cfg.sendSurfacePattern === 'string' && cfg.sendSurfacePattern.trim()) {
    H1_EXCLUDED_SURFACES.push({ surface: 'send', re: new RegExp(cfg.sendSurfacePattern, 'i') })
  }
} catch {
  /* 설정 없음·판독 불가·잘못된 정규식 -> 내장 기본값만 사용(fail-open, 지표 전용 경로) */
}

// 명령이 경계 표면에 닿으면 그 surface 이름을, 아니면 null을 반환한다(H1은 null만 센다).
export function boundarySurface(toolName, command) {
  if (typeof command !== 'string') return null
  for (const { surface, re } of H1_EXCLUDED_SURFACES) {
    if (re.test(command)) return surface
  }
  return null
}
