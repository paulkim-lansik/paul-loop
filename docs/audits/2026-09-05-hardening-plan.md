# 하네스 전체 점검 후속 구현

상태: 구현 중. 기준 소스 `39b6d87fbfcc9a0d4de442e898dee41cbbd8df27`.
2026-09-05 검토안을 제시한 뒤 사용자가 전체 작업 진행을 승인했다.
구현 위치는 별도 `codex/harness-audit-hardening` 작업 트리다.

## 완료 계약

| 범위 | 구현 및 검증할 결과 | 상태 |
|---|---|---|
| 판정 | 중첩 출력·실제 종료·상태 일치, 시작 대상에 귀속, digest 실패 차단 | 진행 중 |
| 내부 루프 | 루트 glob 보호, worktree 귀속, 승인 재시도, 취소·총예산·동시 실행·재개 | 진행 중 |
| 지침 | 기존 승인 재사용, 제한된 명확화, 승인 경계 보존, 부분 완료 명시 | 진행 중 |
| 런타임 | 공통 코어/어댑터, Claude/Codex payload, 경로 해석·실행·패키징 계약 | 진행 중 |
| 메모리 | 수명주기·저장소 격리·출처·모델 식별·환경·개인정보·실제 검증 근거 | 진행 중 |
| 리뷰·평가 | 누락을 통과로 해석하지 않음, 유효 정족수, 전체 비용 경계, baseline 동일성 | 진행 중 |
| 그래프 | 실행 상태와 관측 로그 분리, 산출물에 귀속된 근거·승인 및 무효화 | 진행 중 |
| 운영 | 보존적 branch-protection 변경안, 배포 산출물 일치, 문서·버전·회귀 평가 | 진행 중 |

명시적 merge/deploy/send 승인, 검증기 보호, 미완료 리뷰 BLOCK을 유지한다.
일상적인 테스트 설계·제한된 하위 인터뷰·사용자의 목표 변경에서 반복 확인을
줄이는 것은 검토안에서 밝힌 절차상 자율성 확장에 해당한다.

## 검증

- 엔진의 기존 shell 테스트와 재현된 실패 사례의 회귀 테스트.
- 메모리 typecheck, unit/integration fixtures, build 및 배포 bundle 일치.
- Claude/Codex adapter 입력과 실제 생성 패키지의 계약 검사.
- 누락/분할 투표/예산 초과/중단/재개/산출물 변경 시 실패 동작.
- 지침 참조·문서·의존 버전·벤더 lock 정합성 및 독립 리뷰.

소스 테스트 통과는 실제 소비 저장소의 장기 효과나 모든 에이전트의 native E2E를
입증하지 않는다. 실환경 확인이 필요한 항목은 최종 결과에 따로 기록한다.
원격 브랜치 보호, 설치된 플러그인 변경, 릴리스 배포는 아직 수행하지 않았다.

## 참고 근거

- [OpenAI 모델 가이드](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI 하네스 엔지니어링](https://openai.com/index/harness-engineering/)
- [Anthropic 에이전트 평가](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic 장기 실행 하네스](https://www.anthropic.com/engineering/harness-design-long-running-apps)

검토의 실제 재현 결과와 구현 후 검증 기록은 이 문서에 연결한다.
