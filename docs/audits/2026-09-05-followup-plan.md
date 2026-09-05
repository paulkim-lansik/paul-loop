# 배포 후 적용·실환경 검증 계획

사용자 요청: 남은 작업을 추천 방향으로 진행한다. 기준 provider main은
`d2d78c6ac91b9dc76fc5c387d01cc4fdea15847b`다. 구현과 검증, 소비 적용분의
검토 가능한 정식 반영 준비를 수행한다. 새 PR의 병합, 앱 배포, 원격 보호 정책 변경,
optional memory 도입은 이 실행에서 자동으로 수행하지 않는다.

## 구현 범위와 결정

1. 공급자에 재사용 가능한 프로젝트 실행·설치 갱신 도구를 추가한다. 프로젝트가 지정한
   runtime, marketplace/plugin identity, version을 검사하고 공식 CLI 설치 결과로 경로를
   해석한다. 프로젝트 설정에 사용자 이름/캐시 절대 경로를 고정하지 않는다.
   `exec`/`doctor`는 설치하지 않으며, `update`만 사용자가 지정한 설치를 갱신한다.
   기존 vendored 포트는 명시적으로 구분하고 로컬 수정을 덮어쓰지 않는다.
2. Codex 일반 배포는 재현 가능한 생성 패키지와 명시적인 marketplace 등록 명령을
   제공한다. Zine marketplace identity와 별도 포트를 유지한다. 권한/신뢰를 변경하지 않는다.
3. Zine은 현재 origin/main 기반 별도 worktree에 이전 검증된 포트와 필요한 updater/gate만
   반영한다. Digging은 별도 worktree에서 프로젝트 공통 실행 도구와 portable 설정만 반영한다.
   기존 main 및 26개 작업 폴더의 범위 밖 변경·index·HEAD를 보존한다.
4. Codex/Claude CLI의 실제 세션 자격 검증과 20개 행동 회귀 시나리오 실행 경로를 만든다.
   target과 grader를 분리하고 실제 도구/산출물/host 관측을 근거로 채점한다. 이전/현재
   동일 모델·fixture·설정 비교를 시도한다. 인증·hook trust·사건 계측이 없으면 해당 결과를
   blocked/incomplete로 기록한다. 없는 비용·성능·격리 증거를 만들지 않는다.
5. 과거 감사 문서는 당시 관측을 유지하면서 최종 main CI/설치 보고서에 연결한다.

## 검증 계약

이 문서는 여러 저장소의 진행 순서를 담은 umbrella다. 전달 단위는 provider 도구·문서,
Zine 포트, Digging portable 설정의 세 별도 변경이다. 각 소비 단위는 자체 root gate를
통과해야 한다. provider의 즉시 구현 단위는 아래 launcher의 두 AC다.

공개 CLI seam: `project-plugin.mjs --project <root> doctor|exec|sync|update`.
테스트는 임시 HOME/프로젝트와 fake host CLI를 실행해 실제 파일·argv·종료 코드를 검사한다.
Codex CLI 0.146의 JSON은 설치 경로를 제공하지 않으므로 버전 한정 cache-layout adapter를
명시하고, CLI 등록 identity/version과 실제 cache manifest 모두 일치할 때만 실행한다.
프로젝트 lock은 portable identity/version만 저장하고 절대 registry는 local generated 파일이다.
`doctor`와 `exec`는 프로젝트 설정·설치를 변경하지 않으며 `sync`만 local registry를 갱신한다.
`update`는 명시된 id만 CLI로 갱신하고 새 버전 검증 후 lock/registry를 반영한다.
동시 편집 충돌·disabled Codex 설치·변경된 vendored 파일은 쓰기 전에 거부한다.

AC: portable launcher resolves exact plugin identities and rejects missing/wrong/ambiguous installs without changing config | verify: node --test scripts/project-plugin.test.mjs
AC: updater preserves unrelated project values and local vendored edits and distinguishes Git/local marketplaces | verify: node --test scripts/project-plugin.test.mjs
AC: generated runtime inventory and provider engine contracts remain valid | verify: bash tools/loop-engine/test/run.sh
AC: Zine overlay preserves Codex-only policy and project registry after relocation | verify: node --test tools/verify-paul-loop-port.test.mjs

Native/eval seam은 `scripts/native-eval/`의 CLI adapter, 독립 grader와 report validator다.
각 20개 case에 target 실행/명시적 미실행 사유, runtime/model/plugin identity, 실제 관측
이벤트, target/grader 종료 상태를 기록한다. report validator는 누락된 이벤트를 PASS로
승격한 보고서를 거부한다. baseline/current를 같은 모델로 대조하며 실행 불가능한 조건은
결과 테이블에 별도 표시한다. 로그는 private `.loop/`에 보존하고 공개 보고서는 비밀값 없이
hash와 수치/한계를 기록한다. target 자체의 prose는 성공 판정 근거로 사용하지 않는다.

소비 PR에는 각 저장소의 필수 root verifier를 별도로 실행한다. 제한된 검사 통과는 이를
대체하지 않는다. 실제 모델 평가의 성공 여부는 미리 PASS로 요구하지 않는다. 실행 대상,
세션 설정, 종료 상태와 관측 누락을 빠짐없이 기록한 결과를 산출하는 것이 완료 조건이다.

## 계획 작성 시점의 외부 조건

- Codex는 ChatGPT 인증이 있다. 실제 세션은 아직 이번 후속 실행에서 관측하지 않았다.
- Claude `auth status`는 loggedIn=false다. 사용자에게 로그인 완료를 요청했고, 다른 작업을 계속한다.
- Zine/Digging의 origin/main이 이전 로컬 main보다 앞서 있으므로 새 origin/main에서 준비한다.
- 동시 진행 중인 기존 프로젝트의 dirty 파일은 이번 실행의 소유물이 아니다.
