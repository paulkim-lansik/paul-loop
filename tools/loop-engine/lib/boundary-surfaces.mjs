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

// 명령이 경계 표면에 닿으면 그 surface 이름을, 아니면 null을 반환한다(H1은 null만 센다).
export function boundarySurface(toolName, command) {
  if (typeof command !== 'string') return null
  for (const { surface, re } of H1_EXCLUDED_SURFACES) {
    if (re.test(command)) return surface
  }
  return null
}
