# 고정 기준 테스트의 호환성 검토

**결과: FAIL, exit 1 — 66/80 PASS, 14개 스크립트 실패.**

후보 commit `b4ed9d56a4dfc21affdaf7f85700496487a360da`에 대해 기존
`verifier-pinned-review.sh --base 39b6d87fbfcc9a0d4de442e898dee41cbbd8df27`를 그대로
실행했다. 이 도구는 별도 detached worktree에서 기존 기준의 전체 test 디렉터리를 복원한 뒤
새 구현을 검사한다. 고정 runner와 기준 테스트를 통과시키려고 수정하거나 생략하지 않았다.

원본 로그는 로컬 `.loop/hardening-validation/pinned-baseline-b4ed9d5.log`에 있다.
마지막 출력은 `loop-engine selftest: 66/80 passed`다. 중간의 `FAIL: mktemp -d failed`는
성공한 환경 오류 검사 내부 출력이므로 14개 실패에 추가로 세지 않는다.

## 14개 실패의 계약 변경과 대체 근거

| 개수 | 기준 테스트 | 실패 원인과 의도한 계약 | 현재 검사에서 유지한 검증 |
|---:|---|---|---|
| 1 | `adversarial-review-fanout` | 기준 mock은 `{refuted:false, reason:"r"}`를 반환한다. 새 투표는 명시적 status와 관측 evidence/reason이 있어야 유효하다. 따라서 옛 mock으로는 confirmed finding이 나오지 않는다. | mock을 새 응답 계약으로 이전. 기존 severity 순서·cap·누락 보고 assertion 유지, 정족수·missing lane·전체 예산 회귀 추가 |
| 1 | `dotenv-allowlist` | 기준은 실제 hook을 직접 실행한 뒤 삭제된 debug 문구 `dotenv: loaded`로 읽기 여부를 판단한다. 문구가 없어 실패하며, dotenv를 읽지 않았다는 관측은 아니다. | 격리된 실제 hook의 child 환경에서 dotenv 자격 증명 전달과 NODE_OPTIONS 제외를 관측. payload 비실행 assertion 유지; debug 문구 대신 행동 근거로 확인. allowlist 복사본 일치도 별도 검사 |
| 5 | `lessons-category`, `lessons-evidence-integrity`, `lessons-hygiene`, `lessons-recall`, `lessons-retire` | 사람이 쓴 verdict 텍스트·`verified:true`만으로 검증 지위를 주던 기준과 충돌한다. 새 구현은 실제 FAIL/PASS backing과 내용/작업 위치에 결속된 seal을 요구한다. | 실제 producer 경로 및 격리된 유효 backing fixture로 positive control 복구. 증거 없음·위조·다른 root·내용 변경·무효화는 거부. 원래 category/recall/retire 의미는 이 검증 조건 아래 유지 |
| 2 | `loop-fix-fail-channel`, `loop-fix-mark-clean` | 기준에도 `touch fixed`/`touch converged`라는 실제 fixer가 있었지만 Git 저장소가 없어 새 receipt의 Git target identity 조건을 만족하지 못한다. | 기존 실제 수정 동작과 병합/clean assertion을 유지하고 격리 Git fixture 및 receipt 근거를 추가 |
| 1 | `loop-fix-infra-exempt` | 이 기준의 convergence case만 verifier 카운터가 진행하고 no-op fixer 뒤 PASS를 낸다. 실제 구현 변경의 근거가 없다. | 안정된 verifier와 Git에 보이는 wrong→fixed 변경으로 교체. infra 제외·실패 신호·검증된 교훈 assertion 유지 |
| 2 | `regression-signals`, `sanitize` | 두 검사도 증거 없는 `--verified` record에 의존하여 신호/정제 assertion에 도달하기 전에 거부된다. | 실제 admitted lesson fixture 사용. gate 귀속·회귀 표시·민감 문자열 정제 assertion을 삭제하지 않음. legacy bool은 historical/unverified로 표시 |
| 1 | `plugin-path` | 기준은 존재하지 않는 `/cache/...` 문자열을 설치 경로로 반환하기를 기대한다. 새 resolver는 실제 manifest/이름/런타임/버전을 검증한다. | 유효한 임시 manifest로 기존 우선순위·worktree·공백 경로 동작 유지. 존재하지 않는 경로, 버전 drift, 다른 runtime, bin escape 거부 추가 |
| 1 | `worktree-session-scope` | 기준은 첫 생성 요청이 실제로 실행되지 않아도 두 번째 요청에 생성 예산이 소진되었다고 간주한다. | 실제 Git worktree 생성 후 escalation을 확인. 실패/거부된 요청과 성공을 분리하고, 승인 없는 반복 요청이 승인으로 바뀌지 않음을 검사 |

이 분류는 **고정 검사 PASS를 대신하지 않는다.** 원래 고정 검사는 의도적인 계약 변경도 실패로
남기도록 설계되었으며, 다음 요구를 그대로 보존했다.

> “If this failure is an intended behaviour change, say so explicitly in the PR description — a human must sign off on it.”

출처: [verifier-pinned-review.sh](../../tools/loop-engine/bin/verifier-pinned-review.sh), 실패 출력 부분.
향후 PR 설명에는 위 14개 이전 계약과 [전체 변경·검증 결과](2026-09-05-hardening-results.md)를
포함해야 한다. 자동으로 기준을 재설정하거나 CI green, merge 승인, 릴리스 준비 완료로 바꾸지 않는다.
원격 branch protection 적용이나 required check 우회도 수행하지 않았다.

## 검토 경계

현재 suite의 전체 결과는 별도의 최종 검증 로그로 남긴다. 새로운 테스트의 PASS만으로
기존 요구를 조용히 축소하지 않도록 독립 무결성 리뷰가 fixture 이전과 검증 강화 이유를
확인했다. 최종 분류 리뷰에서 dotenv debug 문구와 두 실제 fixer의 설명을 원본에 맞게 바로잡았다.
검토된 소스의 순환 신뢰 위험을 숨기지 않기 위해 이 FAIL 결과를 최종 보고서에도
명시한다. 이 변경의 설치·기준 채택·원격 정책 적용에는 각 구체적인 대상의 검토가 남아 있다.
