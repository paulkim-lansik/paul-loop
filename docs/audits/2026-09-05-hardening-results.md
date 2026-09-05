# paul-loop 하네스 개선 결과

상태: 통합 검증과 독립 리뷰 진행 중. 설치·릴리스 승인을 뜻하지 않는다.

사용자는 전체 감사 결과와 편집 제안을 검토한 뒤 구현을 승인했다. 기준은
`39b6d87fbfcc9a0d4de442e898dee41cbbd8df27`, 구현은 별도
`codex/harness-audit-hardening` 작업 트리에서 진행했다. 원래 `main` 작업 트리와
설치된 플러그인 캐시는 변경하지 않았다.

## 개선 범위

| 관점 | 발견한 문제 | 구현한 동작 | 주요 근거 |
|---|---|---|---|
| 내부 루프 | 출력과 종료 코드 모순, 늦은 PASS, 취소 뒤 자식 실행, 동시 실행 충돌 | 완전한 verdict 계약, 전체 프로세스 그룹 취소, 절대 마감, 배타 lease, 상태 무효화 | [verdict](../../tools/loop-engine/docs/verdict-contract.md), [lifecycle](../../tools/loop-engine/docs/loop-fix.md) |
| 재개·보호 | 재개 때 예산 초기화, 루트 glob 누락, 다른 worktree 판정, 요청을 승인으로 캐시 | run ID와 설정/HEAD/보호 파일 검증, 카운터 보존, 실제 Git 생성 관측, root 포함 보호 | `loop-lifecycle*`, `loop-protect-files`, `worktree-session-state` 회귀 검사 |
| 외부 루프 | 리뷰 누락을 무결점으로 해석, 분할 투표 오판, 무제한 fan-out | 필수 리뷰 범위, 근거 있는 정족수, 전체 호출·동시성·시간 상한, incomplete 보존 | [adversarial-review](../../tools/ship-flow/workflows/adversarial-review.js), [harness-audit](../../tools/ship-flow/workflows/harness-audit.js) |
| 지침 | 반복 승인, 무제한 질문, 요청 범위 밖 게시, 부분 성공을 완료로 표시 | 공통 권한 계약, 승인 재사용, 제한된 명확화, 의존 작업 중단과 부분 상태 | [AUTHORIZATION](../../tools/ship-flow/skills/AUTHORIZATION.md), [AGENTS](../../AGENTS.md) |
| 런타임 | Claude 경로·도구 입력 가정, 실행 권한 누락, 깨진 생성 참조 | 공통 코어와 명시적 어댑터, Codex apply_patch 입력, manifest/버전 확인, 생성 참조 검증 | [호환성](../runtime-compatibility.md), `scripts/generate-runtime-packages.mjs` |
| 그래프 | 로그를 실행 상태나 승인으로 오인, 변경된 산출물의 근거 재사용 | 실행 상태와 관측 로그 분리, 내용/명령/작업 위치에 귀속된 receipt와 의존 관계 무효화 | [evidence graph](../../tools/loop-engine/docs/evidence-graphs.md) |
| 메모리 | 오래된 검증 주장, 무효화 누락, 다른 저장소 덮어쓰기, 임베딩 공간 혼합 | 실제 FAIL→수정→PASS 근거, 내용 변경 시 신뢰 초기화, 저장소/모델 식별, 전체 출처 서명 | [memory contract](../../tools/loop-memory/HARDENING.md), [0.7 이전 절차](../../tools/loop-memory/MIGRATION-0.7.md) |
| 평가·학습 | 기록 성공을 품질로 오인, 기준 파일 불일치, 평가 중 학습 오염 | RECORD와 품질 분리, 기준 동일성 검사, 격리된 시험과 frozen learning, 누락 이벤트 차단 | [eval gate](../../tools/loop-engine/docs/eval-gate.md), [agent evaluation](../../tools/loop-engine/docs/agent-evaluation.md) |
| 운영·공급망 | 기존 보호 설정 덮어쓰기, bundle/source 불일치, 한 환경에서만 검사 | 변경 전후 계획 해시와 재조회, 배포 bundle 검사, Linux/macOS×Node22/24 CI 정의 | [보호 변경안](2026-09-05-branch-protection-proposal.json), [의존성 검사](../../tools/loop-memory/DEPENDENCY-AUDIT.md) |

## 권한과 완료 조건

30개 skill과 5개 agent가 같은 공통 계약을 참조한다. 원본에서 파생한 Codex 역할 skill의
참조 경로를 다시 계산하고, 소비 저장소로 옮길 agent template에는 필요한 계약을 포함한다.
공통 문서는 권한의 원천이 아니며 호스트의 지침 우선순위와 사용자의 승인 범위를 따른다.

| 편집 대상 | 바뀐 해석 | 권한 영향 |
|---|---|---|
| TDD·planner | 이미 승인한 범위의 테스트 설계와 같은 근거를 재사용 | 반복 확인 감소. 구현 권한을 새로 부여하지 않음 |
| grilling·grill-with-docs | 상위 작업의 제한된 질문이 해결되면 복귀 | 하위 인터뷰가 전체 작업을 가로막는 경우 감소 |
| ship-feature·hotfix | 현재 승인 범위와 종료점을 먼저 확인; AFK는 merge 승인이 아님 | 가역적 구현의 절차상 자율성 확대, 외부 효과 권한 유지 |
| publisher | 선행 명령 실패 시 후속 명령 중단; 실제 PR URL과 부분 결과 확인 | 게시 권한 확대 없음 |
| to-prd·to-issues·vendor-sync | 읽기/초안 요청은 그 산출물까지 수행 | 요청하지 않은 원격 게시·커밋·push로 확장하지 않음 |
| merge conflict 처리 | 충돌 대상만 stage하고 실제 진행 상태에 맞춰 종료/복구 | 기존 merge 승인 재사용, 새로운 merge를 승인하지 않음 |
| retrospect·ADR | 경험적 주장과 사용자의 목표 변경 구분; 무효화된 교훈 제외 | 목표 변경을 불필요하게 막지 않되 검증·승인을 합성하지 않음 |
| setup·runtime | 현재 도구와 경로를 확인하고 계약을 보존하는 대체 경로만 사용 | 설치·hook trust·외부 인프라 활성화는 별도 범위 |

명시적인 merge/deploy/send 승인, 보호된 검증기, 필수 리뷰 완료 조건은 유지했다.
이미 승인된 작업에서 테스트나 내부 구조를 선택할 때 반복 질문을 줄이는 편집은 사용자가
승인한 **절차상 자율성 확대**다. 승인된 구현의 평범한 편집마다 재승인을 요구하지 않는다.
반면 정확한 산출물을 검토한 merge/배포 승인을 다른 내용이나 다른 대상에 전용하지 않는다.

## 검증 기록

최종 결과가 확정되면 이 표를 갱신한다. 첫 엔진 통합 실행은 71/80이었다. 실패 원인은
이전 계약의 fixture, 생성 문서의 실제 누락 참조, 새 공통 지침의 검사 표현, 실제 생성
관측으로 바뀐 worktree fixture였다. 실제 구현 수정 없이 검증기만 카운터를 바꿔 통과하던
lesson fixture는 안정된 검증기와 Git에 보이는 실제 수정으로 교체했다.

| 검사 | 결과 | 범위 |
|---|---|---|
| 엔진 전체 shell/Node suite | 진행 중 | 판정·보호·수명주기·재개·리뷰·평가·패키징 통합 |
| Memory typecheck | PASS | 개발 소스 타입 검사 |
| Memory unit/process tests | 151 PASS, 2 SKIP | 14개 파일; 실제 임베딩 호출 2개는 선택적 검사 |
| PostgreSQL fixture | 54 PASS | 7개 파일, 실제 pgvector/CLI/migration; 전용 임시 서버 종료·제거 |
| npm audit 전체/production | 각각 0건 | 설치된 advisory snapshot; 취약점 부재의 일반적 증명 아님 |
| Memory bundle | 진행 중 | source rebuild와 배포 dist 일치 |
| Claude/Codex 패키지·schema | 진행 중 | 생성 계약과 schema; native 에이전트 행동 검사와 구분 |
| Skill lock·참조·diff whitespace | 집중 검사 PASS | 최종 생성 후 재확인 |
| 독립 리뷰 | 진행 중 | 기능 교차 리뷰와 별도 새 문맥의 검증기 무결성 리뷰 |
| 기준 commit의 고정 테스트 | 후보 commit 생성 후 실행 | 현재 테스트를 변경해서 우회하지 않음 |

독립 리뷰는 구현자 간의 범위 교차 리뷰와, 구현 대화를 상속하지 않은 별도 검증기 무결성
리뷰로 나눴다. 현재 리뷰에서 발견한 다음 문제들을 최종 검증 전에 추적하고 있다.

| 추가 발견 | 처리 상태 | 재현 및 검증 |
|---|---|---|
| 상속된 `GIT_DIR` 등으로 평가 fixture가 다른 저장소를 commit | 수정·집중 검사 PASS | 외부 임시 저장소 HEAD/index/미커밋 내용 보존, target 자체 Git 루트 확인 |
| JSON `null` 기준 파일, 마지막 trial 시간 초과가 PASS | 수정·집중 검사 PASS | falsy/scalar 기준, 낮은 품질 임계값, 정규식 전체 마감 |
| 한글 UTF-8이 stdout chunk 경계에서 손상 | 수정·집중 검사 PASS | 한글 target 출력과 JSON grader 파일명의 분할 전송 |
| custom log 또는 unignored `.loop`가 자기 receipt를 stale 처리 | 수정·집중 검사 PASS | 생성·확인 측의 동일 identity policy, 물리 경로 비교 |
| Git textconv가 이미 변경된 파일의 추가 변경을 감춤 | 수정·집중 검사 PASS | presentation helper 비활성화, dirty→dirty 및 검증 중 변경 차단 |
| 빈 critic/context/synthesis를 완료 처리 | 수정·집중 검사 PASS | 빈 문자열·공백·객체·배열 응답 모두 incomplete |
| 캡처한 Node test entry를 symlink로 바꿔치기 | 수정 중 | 원래 실패 테스트 보존과 node/`node --test` 진입 경로 확인 |
| fabricated lesson summary와 과거 clean receipt 재사용 | 수정 중 | 실제 근거 재검사, 작업 위치 결속, 재발 뒤 시간 순서 확인 |
| 보호 복구가 symlink 상위 경로를 통해 외부 파일을 덮어씀 | 수정 중 | 외부 임시 파일 보존, compromised 상태 |
| 종료 직전에 추가된 보호 파일과 receipt 저장 실패를 성공 처리 | 수정 중 | 자식 종료 뒤 전체 보호 집합 재검사, 해당 attempt receipt 필수 |

교차 리뷰에서 추가로 발견한 두 eval 결함도 수정했다. JSON으로 파싱 가능한 `null`/`false`/`0`
기준 파일을 거부하고, 마지막 시험의 시간 초과도 품질 임계값과 무관하게 incomplete 처리한다.
정규식 검사 역시 전체 시간 예산을 공유한다. 실제 같은 Git 내용을 다른 작업 위치로 복사한
경우에는 원래 위치의 verification receipt를 재사용할 수 없다.

20개 행동 회귀 시나리오는 개별 입력과 필요한 관측 이벤트를 포함한다. 독립 grader의 이벤트
관측이 빠지면 일반적인 정답 파일이 있어도 incomplete다. 이 실행기의 fixture 검사는 Claude나
Codex 모델이 그 20개 시나리오에 합격했다는 결과가 아니다.

## 배포 전 검토할 호환성 변화

- 소스 plugin 버전: loop-engine `0.15.0`, ship-flow `0.11.0`, loop-memory `0.7.0`.
  메모리의 private 개발 package 버전 `0.1.0`은 배포 plugin 버전과 별개다.
- resolver는 실제 manifest와 최소 버전을 확인한다. 오래된 설치나 다른 marketplace의 파생물을
  조용히 선택하지 않는다. 생성 패키지 위치와 source provenance를 확인한 뒤 설치한다.
- legacy `verified:true`는 역사적 주장으로 남는다. 검증되지 않은 boolean만으로 회상·승격에
  쓰지 않는다. 실제 수정 전후 receipt를 만들 수 없다면 검증된 교훈으로 자동 이전하지 않는다.
- 현재 교훈의 검증 근거는 실제 실행한 작업 위치에 결속된다. feature worktree의 교훈과
  receipt를 main으로 복사하거나 worktree를 삭제해도 검증 지위가 자동 이전되지 않는다.
  같은 저장소의 공유 DB 소유권과는 별개의 제약이다. 영구 보관·이전 절차 없이 feature
  worktree를 정리하는 기존 소비 흐름은 메모리 업데이트 전에 검토해야 한다.
- 기존 소유자 없는 메모리 DB를 자동 채택/삭제하지 않는다. 전용 새 저장소와 signing key/model
  identity를 설정하고 검토한 원본에서 재구축하는 절차를 문서화했다.
- baseline RECORD는 exit 1과 품질 결과를 반환한다. 기준 기록을 merge 검증으로 사용하던 소비
  스크립트는 기록 후 실제 비교 실행으로 변경해야 한다.
- Codex에서 지원하지 않는 hook `ask`는 deny로 처리한다. 같은 요청을 다시 보내도 승인으로
  바뀌지 않는다. 실제 호스트가 지원하는 명시적 승인/실행 경로가 필요하다.
- Native Workflow JS가 없는 런타임에서는 문서화된 대체 경로가 필요한 독립성·검증 조건을
  보존해야 한다. 가능한 경로가 없으면 해당 단계는 incomplete이며 전체 성공으로 숨기지 않는다.

## 검증으로 입증하지 않은 범위

생성된 Claude/Codex 패키지는 로컬 산출물이다. 설치된 캐시 교체, hook 신뢰 변경, 소비 저장소의
DB 이전, 원격 보호 설정 적용, push/PR/merge/tag/release/deploy를 수행하지 않았다.
branch protection은 조회 결과를 보존한 구체적인 JSON 제안으로만 준비했다.

테스트는 로컬 계약과 실패 동작을 입증한다. 모든 native 호스트/모델의 기능 동등성, 장기 과제
완료율 향상, 비용 절감률 또는 메모리의 인과적 효과를 입증하지 않는다. 런타임 자격 검증은
실제 adapter, 명시된 모델/설정과 리뷰한 grader를 묶어 별도의 결과 파일로 남겨야 한다.

로컬 hash와 hook은 실수 및 권한 범위 내 우회를 줄이는 장치다. 무제한 shell이나 DB 관리자,
서명 key 접근자가 만드는 모든 악의적 위조를 차단하는 외부 attestation으로 주장하지 않는다.
Windows native 프로세스 관리와 호스트 Workflow의 강제 취소도 현재 보장 범위 밖이다.

## 설계에 사용한 1차 자료

승인 재사용·완료까지 지속하는 지침은 [OpenAI 최신 모델 가이드](https://developers.openai.com/api/docs/guides/latest-model)를,
명시적인 상태와 환경 구성은 [OpenAI harness engineering](https://openai.com/index/harness-engineering/)을
검토했다. 독립 평가·반복 시험·환경 격리는 [Anthropic agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)와
[long-running harnesses](https://www.anthropic.com/engineering/harness-design-long-running-apps)를 참고했다.
런타임 지원 여부는 [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)와
[Codex hooks](https://learn.chatgpt.com/docs/hooks)를 기준으로 구분했다.
기존 보호 정책 보존은 [GitHub branch protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection)의
필드별 교체 동작을 고려한 구현이다. 자료의 일반적 권고를 이 저장소의 성능 개선 측정값으로
취급하지 않았다.
