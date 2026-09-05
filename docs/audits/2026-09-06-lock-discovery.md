# 프로젝트 lock 조회 오류 처리

Digging PR #67의 최신 main 통합 리뷰에서 공통 launcher의 오류 처리 결함을 발견했다.
`readLock`은 `.codex`와 `.claude`의 lock 후보를 조회하면서 모든 `statSync` 오류를
파일 부재로 취급했다. 읽을 수 있는 Codex lock과 접근할 수 없는 Claude 설정 디렉터리가
함께 있으면, lock의 유일성을 확인하지 못해도 Codex 실행·갱신을 계속할 수 있었다.

## 수정 계약

실제 파일 부재인 `ENOENT`만 후보 없음으로 처리한다. 권한 오류, 심볼릭 링크 순환,
잘못된 디렉터리 경로 등 다른 오류는 그대로 상위 CLI로 전파하여 종료 코드 1과 사유를
반환한다. 이 처리는 host CLI 조회·실행·갱신과 프로젝트 파일 쓰기보다 먼저 수행한다.
정상적인 단일 lock 동작은 유지하며, 실행을 허용하는 범위를 늘리지 않는다.

AC: uncertain lock lookup rejects all project commands before host calls or writes | verify: node --test scripts/project-plugin.test.mjs
AC: existing portable launch and update contracts remain enforced | verify: node --test scripts/project-plugin.test.mjs

## 검증

실제 임시 파일시스템의 `ENOTDIR`, `ELOOP`, `EACCES` 상황을 각각 만들고 `doctor`,
`sync`, `exec`, `update`의 종료·진단과 host trace 및 프로젝트 파일 보존을 검사한다.
수정 전에는 기존 18개 PASS·추가 3개 FAIL이었다. 권한 검사는 root 계정이 권한을
우회하는 환경에서만 명시적으로 SKIP하며, 나머지 경로 검사는 계속 실행한다.
최종 결과는 PR 본문과 private `.loop/lock-discovery/` 원본 로그에 기록한다.

이 변경은 독립적인 프로젝트 launcher와 테스트에 적용한다. 기존 버전의 source plugin
payload, 설치된 cache, hook trust, optional memory 인프라는 변경하지 않는다.
소비 저장소에는 provider 수정과 동일한 launcher 바이트를 반영하고 출처를 대조한다.
