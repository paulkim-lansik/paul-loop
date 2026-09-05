# 설치·프로젝트 적용 후속 개선 결과

PR #93의 릴리스 이후, 프로젝트 경로 고정과 Codex 배포 의존성을 줄이고 실제 모델
평가의 실행·증거 기록을 추가했다. 이번 변경은 source plugin 버전을 다시 올리거나
기존 사용자 설치·hook trust·optional memory 인프라를 자동 변경하지 않는다.

## 구현

| 대상 | 결과 |
|---|---|
| 프로젝트 launcher | lock의 runtime·marketplace/plugin identity·version과 native 등록·실제 cache manifest를 대조한다. `exec`는 shell 재해석 없이 argv·종료 코드를 보존한다. |
| 프로젝트 갱신 | Git/LOCAL marketplace를 구분한다. disabled/unknown Codex 상태, vendored 소유권, 동시 파일 편집을 보존하며, 부분 실패와 복구 파일 위치를 명시한다. |
| 일반 Codex 설치 | 생성 패키지를 독립된 LOCAL marketplace에 배포하고 공식 CLI로 core 2개만 설치한다. source inventory·mode, 기존 소유권, 활성 상태, 최종 cache 전체를 검사한다. |
| 실제 모델 평가 | CLI target·독립 grader·report validator를 분리한다. 지원되지 않은 host 사건, 인증 실패, timeout과 실행 누락을 기록하며 PASS로 바꾸지 않는다. |
| 문서·CI | 설치/갱신 명령을 추가하고 과거 감사 기록을 최종 릴리스 근거에 연결했다. 새 도구와 native 평가 회계 테스트를 Linux/macOS × Node 22/24 CI에 추가했다. |

사용법은 [일반 Codex 설치](../codex-installation.md)와
[프로젝트 갱신](../project-installations.md)을 따른다. 일반 설치는 생성된 LOCAL
marketplace 경로를 사용한다. provider Git URL을 native marketplace로 직접 등록하는
지원까지 추가한 것은 아니다.

## 독립 검토에서 수정한 결함

- 프로젝트 파일 검사와 공개 사이의 동시 편집, 복구 검사와 pathname 삭제 사이의
  교체 경합을 재현했다. 실제 inode를 복구 디렉터리에 먼저 보존하고 no-replace hard
  link로 공개·복구하여 다른 편집을 잃지 않도록 수정했다. 복구 실패는 INCOMPLETE다.
- symlink 실행 진입점, host 버전 미검증, 갱신 전 쓰기 조건 누락과 실패 테스트의
  잘못된 종료 코드 판별을 수정했다.
- 두 번째 plugin 설치가 먼저 검사한 cache를 바꾸는 사례를 재현했다. 마지막 CLI
  호출 이후 두 cache의 전체 hash·mode를 다시 검사한다.
- 채점 예외가 완료된 target 원본을 삭제하던 경로, report와 원본 trial ID 불일치,
  손상된 JSONL 행의 조용한 누락을 수정했다. 원본 보존·ID 대조·명시적인 불완전 상태를
  회귀 테스트로 확인한다.

수정 전 실패 재현과 수정 후 통과, 독립 재리뷰를 각각 보존했다. 독립 리뷰는 구현
세션과 분리했으며, 각 결과가 전체 테스트나 사용자 병합 승인을 대신하지 않는다.

## 확인한 로컬 검증

| 검사 | 결과와 범위 |
|---|---|
| 프로젝트 launcher | 18/18 PASS; fake native CLI 경계에서 파일 보존·경합·argv·activation·버전 검증 |
| 일반 installer | 86/86 PASS; 공식 Codex 0.146.0의 임시 HOME clean install/재갱신 포함 |
| native 평가 회계 | 22/22 PASS; timeout·탈출 자식의 열린 출력·잘못된 산출물·trial/trace 바인딩·원본 보존·손상 trace·완료 통계 승격 거부 |
| packaging/resolver/adapters | 29/29 PASS; 생성물 재생성 및 `--check`, skill lock 대조 통과 |
| manifest | Claude 2.1.229 strict catalog/plugin 4개 검사와 Codex plugin 3개 schema 검사 통과 |
| 엔진 | 80/80 PASS; optional memory 의존성 설치 후 BAC-580/lesson retire도 별도 통과 |
| memory 패키지 | typecheck/build PASS, 테스트 159 PASS·2 SKIP; 실제 embedding API와 인프라 활성화 증거가 아님 |
| 앱 Codex 0.153.1 설치 경로 | 임시 HOME 공식 CLI LOCAL 등록·설치의 identity, canonical cache path, payload bytes/mode 일치 |
| 기존 릴리스 payload 보존 | 재생성한 Codex 346개·Claude 329개 plugin 파일의 hash·mode가 PR #93 생성물과 일치 |

launcher는 기존 0.146.x와 실제 관측한 0.153.1을 허용한다. 미래 0.153 버전 전체를
확인한 것은 아니다. 설치 경로의 확인은 native hook 실행·차단의 확인과 다르다.
이력 안내는 provider 문서에 두고 패키지에 복사되는 compatibility 문서의 바이트는
유지했다. 같은 release version에 다른 plugin payload를 배포하지 않는다.

새 PR의 CI·pinned baseline·최종 커밋 통합 검사 결과는 PR 본문과 로컬
`.loop/followup-validation/`에 기록한다. 위의 개별 검사 결과를 해당 실행 전에
전체 최종 gate 통과로 해석하지 않는다.

## 소비 프로젝트와 실환경 평가

Zine 포트는 [PR #12](https://github.com/reach0908/zine/pull/12)에서 별도로 검토한다.
앱 소스와 root verifier를 유지한 최종 커밋에서 전체 root가 통과했다. 초기 Xcode
sandbox 실패와 전역 DerivedData 설정 변경·복구의 한계도 해당 PR 문서에 공개했다.

Digging은 [PR #67](https://github.com/reach0908/digging-n-ditto/pull/67)에 별도
origin/main 기반 worktree의 portable lock/launcher를 반영했다.
기존 fast gate의 preflight 사유 불일치와 connection metadata 노출을 바로잡았으며,
DB 허용 목록과 실패 조건은 유지했다. 화면 wrapper 9개를 다시 실행한 뒤 전체
`pnpm verify`가 통과했으며, 코드 지문이 시작·종료·커밋 후 모두 일치했다. 최종
화면 검증표도 13개 route·11개 wrapper·20개 fixture를 통과했고 독립 리뷰가 완료됐다.
기존 26개 작업 폴더의 범위 밖 dirty 파일·index·HEAD는 보존한다.

실환경 재시도의 원인·시간 예산·사례별 실행 및 채점 한계는
[native 평가 보고서](2026-09-05-native-evaluation.md)에 기록했다. 최신 앱 Codex와
사례당 최대 5분 제한으로 Astra 지원 사례 8개와 grader 8개가 정상 종료했다.
채점 오탐 1건의 정의를 명확히 한 뒤 해당 사례만 다시 채점했고, 원래 판단도 보존했다.
기존 1분 timeout 기록은 유지하며, 전체 모델·리뷰 실행 예산은 1,281,675/1,500,000ms다.
지원되지 않은 사건, 미인증 Claude, 불완전한 baseline 또는 채점 근거에서 완료율·비용
개선 수치를 만들지 않는다.
