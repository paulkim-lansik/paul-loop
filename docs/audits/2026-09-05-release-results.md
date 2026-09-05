# 2026-09-05 배포 결과와 증거 범위

이 문서는 구현 당시 감사 기록과 이후 배포 결과를 구분한다. 후속 코드 변경은 별도
검증 결과를 필요로 하며, 아래 결과를 다른 커밋의 검증으로 재사용하지 않는다.

## 공급자와 설치

- [PR #93](https://github.com/reach0908/paul-loop/pull/93)은 main
  `d2d78c6ac91b9dc76fc5c387d01cc4fdea15847b`에 병합되었다.
- `loop-engine--v0.15.0`, `ship-flow--v0.11.0`, `loop-memory--v0.7.0` 태그가
  같은 커밋을 가리킨다. optional memory의 태그 발행은 사용 환경의 설치나 활성화가 아니다.
- main의 [엔진](https://github.com/reach0908/paul-loop/actions/runs/33967408453),
  [메모리](https://github.com/reach0908/paul-loop/actions/runs/33967408458),
  [runtime packaging](https://github.com/reach0908/paul-loop/actions/runs/33967408472),
  [gitleaks](https://github.com/reach0908/paul-loop/actions/runs/33967408455),
  [태그 발행](https://github.com/reach0908/paul-loop/actions/runs/33967408652)이 통과했다.
  packaging에는 Linux/macOS × Node22/24 및 Claude pinned/latest schema 검사가 포함된다.
- 이 실행의 Mac에서 Claude project 설치 2개와 Codex user 설치 2개를 갱신했다.
  Claude는 0.15.0/0.11.0, Codex Zine 포트는 0.15.0+zine.1/0.11.0+zine.1이다.
  Claude의 기존 disabled 상태와 Codex의 enabled 상태를 보존했다.
- source/cache 내용과 파일 권한은 Claude 245개, Codex 271개 파일 모두 일치했다.
  Zine 계열 8개와 Digging 계열 18개 작업 폴더의 포트/실행 경로를 갱신했다.
  당시 소비 변경은 로컬 상태로 남겼고 앱 commit/push/merge/deploy는 수행하지 않았다.

## 검증 해석

최종 엔진 검사는 80/80이다. 고정된 과거 계약 검사는 66/80 FAIL로 보존했으며, 14개
의도적 계약 변경의 내용과 사용자의 채택 요청은 PR에 기록했다. 최초 Linux pinned 실행의
두 추가 실패는 후속 실행에서 재현되지 않았고 이후 PR/main 전체 검사는 통과했다.
이는 과거 기준 FAIL을 PASS로 바꾸는 의미가 아니다.

Zine 포트의 의미 보존/이동성 회귀는 10/10, Digging의 실제 설치 문서 진입은 18/18 통과했다.
이전 Zine 업그레이드 작업 폴더의 fast gate도 실제 실행 exit 0을 확인했다. 소비 앱 전체
QA, native hook 신뢰·차단, 독립 agent 격리, 모델 완료율/비용 개선은 이 배포의 증거 범위 밖이다.

원본 결과 JSON, 파일별 해시, 로그와 private 백업은 해당 실행의 로컬
`.loop/rollout-2026-09-05/`에 보존한다. 개인정보와 전역 설정 백업은 공개 저장소에 싣지 않는다.

후속 구현의 범위와 검증 계약: [배포 후 계획](2026-09-05-followup-plan.md).
