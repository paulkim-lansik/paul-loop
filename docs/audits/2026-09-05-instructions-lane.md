# 지침 lane 구현 결과 — 2026-09-05

지침 충돌 11개 항목의 구현과 집중 검증을 완료했다. 엔진 교차 검토에서 재현한 3건은 부모에게 전달했으며, **이 lane의 상태는 모두 `PENDING_RECHECK`**다. 담당자의 수정 완료 통보나 다른 테스트의 PASS를 이 3건의 재검증 결과로 대신하지 않는다. 전체 통합 결과는 [부모 보고서](2026-09-05-hardening-results.md)에서 별도로 관리한다.

작업 위치는 `/Users/jinhokim/dev/paul-loop-hardening`, 브랜치는 `codex/harness-audit-hardening`이다. 원본 `/Users/jinhokim/dev/paul-loop`, 설치된 플러그인, 원격 설정은 변경하지 않았고 commit/push/publish도 하지 않았다. 이전 구현의 소유 범위는 ship-flow 지침 44개 파일과 협의한 테스트 2개였다. **이 보고서 작성 턴에서 허용된 쓰기는 이 새 문서 1개뿐**이며, 소스 변경이나 테스트 재실행을 포함하지 않는다.

## 근거와 읽는 방법

이 문서는 [harness-maturity-audit 방법론](../../tools/ship-flow/skills/harness-maturity-audit/SKILL.md)의 관측 근거, 강점 병기, 적용 범위와 불완전 coverage 구분 원칙을 따른다. 전체 6개 lane의 L0–L5 평가가 아니라 지침 lane의 구현 인계 기록이다. Provider 저장소의 로컬 증거를 consumer 활성화나 실제 운영 효과로 해석하지 않는다.

- **원문 기준:** 구현 전 commit `39b6d87fbfcc9a0d4de442e898dee41cbbd8df27`. 아래 ‘기준 L…’는 `git show <commit>:<repo-relative-path>`로 다시 확인한 줄 번호다.
- **변경 후 기준:** 이 문서를 작성하면서 읽은 공유 worktree의 지침 파일. ‘현재 L…’ 링크는 이 버전의 줄 번호다. 이후 다른 수정으로 줄 번호가 이동할 수 있다.
- 파일 링크는 현재 worktree를 연다. 과거 인용문은 파일 경로와 기준 commit으로 복원해야 하며, 현재 파일의 같은 줄에 과거 문장이 남아 있다는 뜻이 아니다.
- 테스트 표는 **앞서 실제 관측한 실행 결과**다. 문서 작성 중 재실행한 결과나 부모의 최종 전체 테스트 결과로 표현하지 않는다.

## 11개 충돌: 원문 → 변경 동작 → 권한 영향

| ID | 원문 인용과 기준 위치 | 변경 후 동작과 현재 근거 | 명시적 권한 변화 |
|---|---|---|---|
| I01 | “No test is written at an unconfirmed seam.” / “Get user approval on the plan” — [TDD 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/tdd/SKILL.md), 기준 L30·L91. | [현재 L32](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/tdd/SKILL.md:32): 승인된 계획·seam·우선순위를 상속한다. 필요한 가역적 seam 선택은 근거를 기록하고 진행한다. 제품 계약·범위·예약된 결정이 달라질 때만 질문한다. | **기존 승인 범위 안의 절차 완화.** 반복 승인을 제거하며 새 제품 범위나 verifier 변경 권한을 만들지 않는다. |
| I02 | “The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed.” — [grilling 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/grilling/SKILL.md), 기준 L49–50. | [현재 L18](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/grilling/SKILL.md:18): 직접 요청한 interview와 workflow의 caller 모드를 나눈다. caller 모드는 지정된 미결정 사항·반환 조건까지만 처리하고 상위 작업으로 복귀한다. 이미 받은 전체 승인을 다시 요구하지 않는다. | **질문·위임 범위 축소.** 범위 내 가역적 선택의 자율성은 명확히 하되 인터뷰 종료가 구현·게시 승인은 아니다. |
| I03 | “whenever the plan wasn't already sharpened by grill-with-docs” — [planner 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/agents/planner.md), 기준 L3. | [현재 L19](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/agents/planner.md:19): 인터뷰 여부와 무관하게 AC·seam·계약을 확인한다. 계획 digest/revision, 관련 코드 revision, track, AC별 증거와 완료 verdict가 맞을 때만 기존 검증을 재사용한다. 변경 영향을 받은 증거는 갱신한다. | **검증 강화, 권한 확대 없음.** planner 재검증과 사용자 재승인을 구분한다. |
| I04 | “exit 0  = AUTO         → proceed autonomously”, “exit 10 = REQUIRE      → stop before running that step, get human approval”, “If it's REQUIRE, put the reason at the very top of the PR body” — [ship-feature 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/ship-feature/SKILL.md), 기준 L128–129·L272–273. | [공통 계약 L63](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/AUTHORIZATION.md:63): 실제 실행 전에 분류한다. AUTO는 기존 허용 범위에서만 진행한다. REQUIRE는 해당 행동의 기존 승인을 확인하고, 없을 때만 검토 가능한 결과를 준비한 뒤 묻는다. DENY의 verdict 채널과 명령 실행 채널을 구분한다. usage/resolution 오류는 미해결이다. | **묵시적 실행 권한 축소, 동일 승인 재사용.** PR 본문 경고는 승인 대체물이 아니며 다른 도구로 실행 거부를 우회할 수 없다. |
| I05 | “Run command 1, then command 2 and capture the PR URL it prints, then command 3.” / “do not decide to skip or reorder a command because it seems unnecessary.” — [publisher 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/agents/publisher.md), 기준 L138·L84–85. | [현재 L42](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/agents/publisher.md:42): 각 결과를 확인하고 실패한 작업의 종속 명령은 중단한다. 성공·실패·blocked·not-run을 구분한다. 외부 결과가 불확실하면 Builder가 읽기 전용으로 확인한다. 성공한 게시를 반복하지 않고, 무효과가 확인된 실패만 해당 승인 아래 복구한다. [실행 예시 L65](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/agents/publisher.md:65)는 실제 실패 전파와 literal 파일 입력을 사용한다. | **외부 권한 확대 없음.** 필요한 복구 조회는 Builder에게 반환하며 publisher의 별도 컨텍스트·완성된 입력·허용된 행동 제한을 유지한다. |
| I06 | “a human approves those, every time.”와 “let a human (or the required CI checks) approve it there.” — [template 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/templates/CLAUDE.md.template), 기준 L77–78·L84–85. 또한 “not standing approval, not a PR opened later in the same session, and not a retry.” — [ship-feature 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/ship-feature/SKILL.md), 기준 L309. | [template 현재 L91](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/templates/CLAUDE.md.template:91), [ship-feature 현재 L339](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/ship-feature/SKILL.md:339): CI·agent review·AFK는 merge 승인을 제공하지 않는다. PR·검토 head/base·대상에 결속된 승인은 그대로인 무효과 실패에 재사용할 수 있다. 변경된 검토 대상과 bypass에는 해당 승인이 필요하다. git-flow의 release 단계도 별도 승인 대상이다. | **명시적 merge/release/deploy/send 보호 보존.** 실패 자체가 승인을 소모한다는 규칙만 제거한다. 다른 PR·환경·우회로 승인을 확장하지 않는다. |
| I07 | “Create a new project for this PRD.” / “Write the PRD using the template below and publish it as a **document under the project created in step 3**” — [to-prd 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/to-prd/SKILL.md), 기준 L24·L42–43. | [현재 L27](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/to-prd/SKILL.md:27): read/report/draft는 요청된 로컬 산출물 또는 대화 초안으로 완료한다. tracker 프로젝트·문서·issue·comment 생성은 요청된 게시 범위와 목적지를 확인한 뒤 수행한다. to-issues·triage·vendor-sync의 연계 지침에도 같은 구분을 적용했다. | **외부 게시 권한 축소.** 초안 승인을 게시 승인으로 바꾸지 않는다. 이미 게시가 명시적으로 허용된 작업에는 별도 초안 승인 절차를 새로 만들지 않는다. |
| I08 | “Issue tracker” 질문과 설정의 `"trackerName": "Linear",`만 제공 — [setup 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/setup/SKILL.md), 기준 L58–59·L79. 반면 “If neither exists, ask the user which tracker this repo uses and how issues should be filed there before continuing. Don't guess.” — [to-issues 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/to-issues/SKILL.md), 기준 L26–27. | [setup 현재 L121](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/setup/SKILL.md:121): 확인된 설정을 재사용하고 optional `trackerDoc`에 실제 ID·operation·역할/상태 매핑을 기록한다. 누락은 unresolved로 남기며 로컬 drafting/review는 진행한다. 인증된 서비스 계정을 사용자의 신원으로 간주하지 않는다. | **로컬 setup 계약 명확화.** 문서 작성 권한이 label/project/issue/comment 생성 권한은 아니다. 오래된 설정은 기존 integration 문서 fallback을 유지한다. |
| I09 | “Always resolve; never `--abort`.” / “Stage everything and commit.” — [conflicts 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/resolving-merge-conflicts/SKILL.md), 기준 L17·L21. | [현재 L21](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/resolving-merge-conflicts/SKILL.md:21): 승인된 hunk와 작업 브랜치만 처리하고 관련 파일만 stage/commit한다. 기존 작업 보존을 확인한 승인된 취소·abort는 허용한다. 분리가 안전하지 않으면 구체적인 blocker를 반환한다. | **승인 범위 내 복구 자율성 확대, 무관한 변경 권한 축소.** 파괴적 복구, 공유 브랜치 merge, push/publish 권한은 새로 부여하지 않는다. |
| I10 | “on conflict, this file wins for this repo.” — [template 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/templates/CLAUDE.md.template), 기준 L5. ADR 재개에는 “not "on reflection" or a plain change of preference.” — [domain-modeling 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/domain-modeling/SKILL.md), 기준 L101. | [template 현재 L3](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/templates/CLAUDE.md.template:3), [domain-modeling 현재 L103](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/domain-modeling/SKILL.md:103): host의 지침 계층과 현재 사용자 범위를 우선한다. 에이전트가 ADR을 찾아 영향을 설명한다. 사실 판단 변경에 필요한 증거와 사용자가 명시한 목표·우선순위 변경을 구분하고, 허용된 문서 범위에서 superseding ADR을 남긴다. | **사용자의 정당한 결정 권한 복원.** 과거 ADR·template이 상위 지시를 거부하지 못한다. 역사 삭제·검증 약화·구현·배포 권한은 자동으로 생기지 않는다. |
| I11 | “Hard termination — the run ends when the PR URL exists.” / “The one exception is step 6, this issue's own lessons pass.” — [ship-feature 원본 경로](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/ship-feature/SKILL.md), 기준 L302·L305. | [현재 L327](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/ship-feature/SKILL.md:327): 요청된 필수 행동이 실제로 완료되어야 완료를 선언한다. PR 생성 뒤 필수 comment 실패는 partial이다. helper는 caller에 반환하고, lesson·새 worktree·새 issue·후속 PR은 기존 승인에 포함된 경우에만 진행한다. | **거짓 완료와 후속 범위 확장 차단.** 미완료된 승인 작업을 계속하는 것은 재승인을 요구하지 않지만, 완료한 작업이 새 작업의 권한을 만들지는 않는다. |

I08의 producer/consumer 불일치는 없는 문장을 인용한 주장이 아니다. 기준 setup 파일의 설정 예시에는 `trackerName`만 있고 역할/operation 문서 생성 단계가 없었던 반면, 소비 skill은 그 문서를 필요로 했다는 파일 간 계약의 공백이다.

## 공통 계약의 보완과 보존한 보호

새 [AUTHORIZATION.md](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/AUTHORIZATION.md)를 30개 skill entry와 5개 agent가 참조한다. publisher는 독자적으로 저장소를 다시 읽는 대신 Builder가 제공한 계약·허용 범위를 받는다. 이것은 모델이 따를 지침이며 새 기술적 sandbox라고 주장하지 않는다.

- [L16–23](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/AUTHORIZATION.md:16): read-only의 보호 대상은 조사 대상 자원과 외부 시스템이다. 필요한 격리 disposable fixture, 임시 보고서, browser profile/cache, test output은 요청 범위에서 허용할 수 있다. live state·설치 cache와 분리해야 하며 **명시적인 모든 쓰기 금지는 fixture에도 우선**한다.
- [L41–53](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/AUTHORIZATION.md:41): **구현 승인은 승인 범위의 필수 source/plan/test 편집으로 소진되지 않는다.** 검토된 merge/publish/deploy/send 및 명시적으로 artifact에 결속된 행동만 해당 artifact/head/base 승인을 검사한다. 변경된 구현에는 영향받은 검증을 갱신한다.
- [L55–59](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/AUTHORIZATION.md:55): per-PR human merge 승인, 별도 deploy/send 승인, 이유가 있는 protected-file window, 독립 verifier·lesson accept 검증을 유지한다. 테스트·AC·risk rule 약화로 PASS를 만들 수 없다.
- [L94–117](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/AUTHORIZATION.md:94): check 실패, invocation/environment 실패, 외부 명령 실패, 불확실한 외부 결과를 구분한다. 정본 `VERDICT:`/`EXIT:` 블록을 중복 생성하거나 FAIL을 PASS로 바꾸지 않는다. 누락·모순된 증거는 unresolved다.

권한 변화의 요지는 **승인된 가역적 작업의 반복 질문·복구 제한은 완화하고, 외부 행동의 묵시적 허용은 축소**한 것이다. merge/release/deploy/send·protection bypass·독립 검증에 대한 의도적인 사람 승인 경계는 완화하지 않았다.

## 연관 수정, 호환성, 범위

| 항목 | 반영 내용 / 제한 |
|---|---|
| Harness source skill | [L95](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/harness-maturity-audit/SKILL.md:95): prior audit·ADR·provider/consumer role·적용 범위를 조사 전에 확인. optional `args.outputLanguage`와 config/user-language fallback. N/A·L0·INCOMPLETE 구분 및 누락 lane 노출. 허용된 보고서는 기존 `docs/audits/` 또는 timestamp 비덮어쓰기 경로 사용, 반복 위치 질문 제거. Workflow JS의 실제 구현은 부모 소유다. |
| Setup 경로와 원격 설정 | [setup L118](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/setup/SKILL.md:118): ship-flow와 sibling loop-engine의 실제 resolver 사용을 설명. resolver 구현은 portability 소유다. [L203](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/setup/SKILL.md:203): branch protection의 기본 동작은 계획 생성이고 실제 변경에는 검토된 `--apply-plan reviewed.json --approve-plan <sha256>`를 사용한다. setup·CI 자체는 원격 설정 승인이 아니다. |
| Auxiliary dangling refs | [HTML-REPORT L46](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/improve-codebase-architecture/HTML-REPORT.md:46)·L115·L132의 존재하지 않던 `LANGUAGE.md` 참조 3개를 실제 `../codebase-design/LANGUAGE.md`로 연결했다. [L112](/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/improve-codebase-architecture/HTML-REPORT.md:112)는 caller/config의 `outputLanguage`, 없으면 사용자 언어를 사용한다. 코드·명령·인용 증거는 그대로 둔다. validator 예외를 추가하지 않았다. |
| 다른 caller 지침 | grill-with-docs·domain-modeling·to-prd/to-issues·triage·vendor-sync·prototype·wayfinder·wizard·retrospect에 같은 범위/반환/게시 구분을 적용했다. 누락 도구가 설치·권한 확대나 독립 review 대체를 허용하지 않는다. verified lesson에는 실제 verifier receipt가 필요하다. |
| 루트 contributor 안내 | 부모가 작성한 [AGENTS.md L7](/Users/jinhokim/dev/paul-loop-hardening/AGENTS.md:7)와 [CLAUDE.md L1](/Users/jinhokim/dev/paul-loop-hardening/CLAUDE.md:1)의 `@AGENTS.md`를 읽기 전용 검토했다. host/user 범위 우선, 공통 계약 참조, provider/consumer 분리가 일치한다. 이 lane이 두 파일을 수정하지 않았으며, 문서 생성은 자기 승인이나 consumer 활성화가 아니다. |
| Vendor / generated packages | 마지막 확인에서 source `skills-lock.json`의 `computedHash`와 로컬 skill 본문 SHA-256 불일치는 **0개**였다. lock 변경은 portability 담당자와 조율했고 이 lane에서 편집하지 않았다. 최종 generated package와 전체 통합 검증은 해당 담당자·부모 결과로 확인해야 한다. |

이전 구현의 경로 범위는 `/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/skills/**`, `/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/agents/**`, `/Users/jinhokim/dev/paul-loop-hardening/tools/ship-flow/templates/CLAUDE.md.template`였다. 테스트 예외는 아래 두 파일이며 파일명을 사전에 공유했다.

- [ship-flow-executable-contract.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/ship-flow-executable-contract.test.sh): 공통 계약 연결 및 문서에 실린 publisher shell 예시의 실행 검증 추가.
- [check-skill-refs.test.sh L101](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/check-skill-refs.test.sh:101): integration-1의 `missing shared authorization contract`는 stale regex가 아니라 테스트 cleanup의 `git checkout`이 공유 소스의 미커밋 ship-feature 변경을 지운 문제였다. 원래 10개 검사를 유지하고 11번째를 실제 provider 구조와 source bytes의 격리 복사로 변경했다. clean 0 → dangling ref 1 → 원복 0과 원본 소스 bytes 보존을 확인한다. ship-feature는 당시 provenance hash가 일치한 generated Claude 원문에서 복원했다.

## 관측한 집중 테스트

아래 실행은 보고서 작성 전 같은 worktree에서 수행했다. root test runner 전체는 부모가 담당했으며 이 lane은 재실행하지 않았다. 각각의 fixture 성공은 실제 외부 게시·배포·consumer 사용의 증거가 아니다.

| 정확한 테스트 / 명령 | 관측한 결과와 수량 | 검증 범위 |
|---|---|---|
| `bash` [ship-flow-executable-contract.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/ship-flow-executable-contract.test.sh) | exit 0. F1–F8 지침 연결 검사 통과, F9 publisher **10/10 시나리오 PASS**. | 실제 문서 shell 예시를 가짜 git/gh로 실행. success; push-fail 17; pr-fail 18; empty-url 1; comment-fail 19; empty-branch, multiline-title, option-branch, missing-body, existing-result 각각 2. 종속 명령 중단, 원래 comment 보존, 한글·개행·따옴표·heredoc 종료자처럼 보이는 내용·명령 치환 문자열의 비실행 확인. |
| `bash` [check-skill-refs.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/check-skill-refs.test.sh) | exit 0, **11/11 PASS**. | 실제 source handoff, 없는 skill/agent 참조, provider/doc/ref가 0인 입력의 fail-closed, source 보존 및 RED-first 복구. |
| `bash` [skill-guard-prose-wiring.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/skill-guard-prose-wiring.test.sh) | exit 0, **3개 PASS 항목**. | TDD guard-off, ship-feature 보호 window 설명, 수동 sentinel 무장 지침 재도입 방지. |
| `node --test --test-name-pattern 'exclusive workspace lease\|cancel kills TERM\|resume rejects modified\|cancel during fixer\|explicit crash recovery\|Stop judges\|unapproved second worktree\|hard budget'` [loop-lifecycle.cases.mjs](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/loop-lifecycle.cases.mjs) | **8/8 PASS**, fail/cancelled/skipped 0, 약 10.47초. 표의 `\|`는 Markdown 셀 구분 회피 표기이며 실제 정규식 인수는 `|`였다. | 아래의 독립 엔진 검토에서 실행. 별도 worktree의 Stop, 두 번째 worktree 승인, hard budget, workspace lease, TERM 저항 자식 취소, config/HEAD 변경 후 resume 거부, fixer 취소 복구, crash 회복을 검사. 새로 발견한 3건의 통과 증거가 아니다. |
| `bash` [toctou-node-entry-overwrite.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/toctou-node-entry-overwrite.test.sh) | exit 0, fixture 회귀 **1개 스크립트 PASS**. | Shell snapshot과 Node/plain 및 `--test` entry, URL/argv/import 보존, capture 실패 시 중단. |
| `bash` [toctou-sibling-overwrite.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/toctou-sibling-overwrite.test.sh) | exit 0, fixture 회귀 **1개 스크립트 PASS**. | sibling이 디스크 소스를 바꿔도 이미 캡처된 원래 실패 내용이 실행됨. |
| `node` [check-skill-refs.mjs](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/bin/check-skill-refs.mjs) `--root .` | exit 0, **61개 handoff / 56개 문서 모두 해결**. | 실제 source 참조 확인. |
| generator의 `localMarkdownLinks`로 HTML-REPORT 검사 | **3개 실제 링크 target 모두 존재**. | parser 예외로 링크를 숨기지 않음. |
| source vendor hash 대조 / `git diff --check` | **불일치 0 / exit 0**. | 마지막 소스 정합성 확인. |

앞선 구현 검증에서 아래 4개 스크립트도 exit 0을 관측했다. 세부 assertion 수를 수집하지 않았으므로 임의의 총 검사 수에 합산하지 않는다.

- `bash` [skill-frontmatter-bac757.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/skill-frontmatter-bac757.test.sh)
- `bash` [lesson-codification-bac756.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/lesson-codification-bac756.test.sh)
- `bash` [verdict-wrap-required.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/verdict-wrap-required.test.sh)
- `bash` [runtime-verify-evidence-bac749.test.sh](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/test/runtime-verify-evidence-bac749.test.sh)

문서 hygiene 검사에서는 오류 0을 관측했다. 긴 source skill 4개(retrospect/setup/ship-feature/wayfinder)와 generated mirror의 길이 경고는 남았다. 문구의 의미적 일관성은 원문 대조 검토이며, 모델이 모든 상황에서 지침을 지킨다는 행동 평가 PASS는 아니다.

## 독립 엔진 교차 검토 — 3건 모두 재검증 대기

2026-09-05 20:27–20:33 KST의 실제 격리 재현을 기록한다. 그 후 부모가 Laplace에게 전달했다고 알려왔다. **아래 파일/줄은 발견 당시 위치이며 수정 후 상태를 인증하지 않는다.** 이 문서 작성에서는 엔진을 다시 탐색하거나 수정·재실행하지 않았다. 부모가 별도로 검증한 7건의 PASS도 아래 3건에 대한 결과가 아니다.

공통 조건: 원본 엔진 `/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/bin/loop-fix.sh`를 별도 임시 cwd에서 실행했다. `LOOP_*`, `VERDICT_RUN_*`, `CLAUDE_*`, `GIT_*` 환경 영향을 분리하고 `LOOP_PROTECT_GRACE_SEC=0`으로 빠르게 재현했다. 외부 파일이라는 표현도 실제 사용자 파일이 아니라 임시 cwd 옆의 disposable fixture다. 재현 종료 후 fixture를 삭제했다.

### E01 — P1: 보호 복구가 symlink를 따라 외부 파일을 덮어씀

- **상태:** `PENDING_RECHECK` — 부모 전달 완료, Laplace 담당. 수정 후 이 lane 재검증 없음.
- **발견 위치:** [loop-fix.sh:468](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/bin/loop-fix.sh:468)의 `cp -p`와 [loop-lifecycle.mjs:43](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/lib/loop-lifecycle.mjs:43)의 동일 hash 조기 반환. Bash 복사가 상위 symlink를 따르고, 이미 같아진 bytes 때문에 supervisor의 상위 symlink 검사까지 생략했다.
- **작은 재현:** fixture `work/tests/check.test.sh`에 `original protected test\n`, sibling `outside/check.test.sh`에 `outside sentinel unchanged\n`를 저장한다. `work`에서 `--verify false --fix 'mv tests saved-tests; ln -s ../outside tests' --protect 'tests/*.test.sh' --max-iter 2`로 실행한다.
- **관측:** exit 3이지만 `outside/check.test.sh`가 원본 test 내용으로 바뀌었다. `tests`는 symlink인 채 남고 `protect-compromised`는 없었다. 로그는 `restored 1 protected file(s) to their pre-run state.`라고 기록했다.
- **재검증 기준:** 외부 fixture bytes 불변, 복사·hash 생략 전에 상위 symlink 거부, 복구 불확실성을 compromised로 기록, SUCCESS 불가. 단순 exit 3만으로 수정 완료가 아니다.

### E02 — P1: 마지막 검사 뒤 추가된 보호 파일로도 succeeded

- **상태:** `PENDING_RECHECK` — 부모 전달 완료, Laplace 담당. 수정 후 이 lane 재검증 없음.
- **발견 위치:** [loop-lifecycle.mjs:155](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/lib/loop-lifecycle.mjs:155). process-group 종료 후 기존 baseline 원소만 검사하여 새 glob 매칭 파일이 빠졌다. [loop-fix.sh:801](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/bin/loop-fix.sh:801)의 마지막 Bash 검사 뒤 lesson 명령 실행 구간에서 생성할 수 있었다.
- **작은 재현:** fixture에 `tests/base.test.sh`와 빈 `lessons.jsonl`을 준비한다. 아래 문자열을 `--verify`의 한 인수로 전달하고 `--protect 'tests/*.test.sh' --lessons lessons.jsonl --max-iter 1`로 실행한다.

```sh
(while ! grep -q "^iter [0-9].*PASS — stopping" .loop/history.log; do sleep .01; done; printf late > tests/late.test.sh) >/dev/null 2>&1 & true
```

- **관측:** Python 대기 fixture 3/3회와 위 shell fixture 1회에서 새 보호 파일이 남은 채 exit 0·`succeeded`·SUCCESS 로그를 관측했다.
- **재현 주의:** `^iter` anchor가 필요하다. 단순 `PASS — stopping` 검색은 시작 로그에 출력된 verifier 명령 자체를 감지하여 파일을 너무 일찍 만들 수 있다. 이 잘못된 단순 검색은 exit 3으로 차단되었으며 false-PASS 근거로 세지 않았다.
- **재검증 기준:** 자식 종료 후 glob을 다시 열거하여 경로 집합과 내용을 모두 대조하고 추가 파일도 보호 위반으로 처리한다. 늦은 파일 정리와 terminal 실패 상태를 확인해야 한다.

### E03 — P2: receipt 저장 실패도 lifecycle 완료

- **상태:** `PENDING_RECHECK` — 부모 전달 완료, Laplace 담당. 수정 후 이 lane 재검증 없음.
- **발견 위치:** [loop-lifecycle-state.mjs:97](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/lib/loop-lifecycle-state.mjs:97)의 receipt 오류 무시, [loop-fix.sh:756](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/bin/loop-fix.sh:756)의 `|| true`, [loop-lifecycle.mjs:156](/Users/jinhokim/dev/paul-loop-hardening/tools/loop-engine/lib/loop-lifecycle.mjs:156)의 종료 코드 기반 성공 확정.
- **작은 재현:** fixture의 `.loop/evidence`를 **디렉터리가 아닌 일반 파일**로 만든 뒤 `--verify true --max-iter 1`로 실행한다.
- **관측:** exit 0·`succeeded`, lifecycle `evidence: []`, `.loop/verdict-state.json` 없음, sentinel 없음, SUCCESS 로그. 실제 `true` 명령이 실패했다는 주장이 아니라 실행 증거를 저장하지 못한 lifecycle이 완료로 확정된 문제다.
- **재검증 기준:** 원래 명령의 canonical PASS와 lifecycle 완료 가능 여부를 구분한다. 해당 run/attempt의 유효한 receipt를 확인하지 못하면 명시적 불완전 상태와 비정상 종료를 기록하며 완료 증거를 만들지 않는다. standalone verdict wrapper의 의도적인 best-effort 호환성은 별도로 설명한다.

## 유지된 강점과 남은 한계

문서화된 publisher의 literal 파일 입력, 독립 reviewer/publisher 역할 분리, agent risk 상향만 허용하는 분류, human merge와 verifier 보호는 유지했다. 집중 실행에서는 lease 배타성, TERM 저항 자식의 취소, resume 예산/대상 보호, worktree별 Stop 분리, Shell/Node test entry snapshot이 통과했다.

지침 구현 완료와 전체 하네스 검증 완료는 구분한다. E01–E03 수정 후 집중 재검증, 부모의 전체 통합 suite, 최종 generated package 검증은 이 보고서에서 완료로 선언하지 않는다. read-only 재검토 범위는 이 3건의 수정된 lifecycle/protection 경로에 한정하며 새 광범위 탐색을 시작하지 않는다.
