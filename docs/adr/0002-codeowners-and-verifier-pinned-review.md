# ADR-0002: CODEOWNERS 재해석 + verifier-pinned-review — 검증기 수정 PR의 순환신뢰 차단

**상태**: accepted

## 컨텍스트

이 레포는 1인 레포다. GitHub의 네이티브 "코드오너 승인 필수" 브랜치 보호 게이트는 `CODEOWNERS`가
지목한 경로를 건드리는 PR에 그 경로의 오너 승인을 요구하는데, 오너가 PR 작성자 자신 한 명뿐이면 자기
PR을 자기가 승인할 수 없어(GitHub은 PR 작성자의 자기 승인을 코드오너 승인으로 인정하지 않는다)
구조적으로 머지가 막힌다. 그렇다고 코드오너 승인 요건 자체를 끄면, `tools/loop-engine`(검증기 본체 —
`verdict-run.sh`·`gate.mjs`·`require-tests.sh`·`classify-risk.mjs` 등)을 수정하는 PR을 채점할 방법이
없어진다. 특히 위험한 경로는 **검증기가 스스로를 검증기 자신의 최신(=이 PR이 만든) 버전으로 채점하는
것**이다 — PR이 `verdict-run.sh`의 판정 로직을 느슨하게 고치면서 그걸 감시하는 테스트까지 같이
느슨하게 고치면, 검증기는 자기 자신의 약화를 스스로 PASS로 승인해버린다(순환신뢰). 사람 리뷰가 유일한
방어선이 되는데, 1인 레포에선 사람 리뷰도 같은 사람이다.

## 결정

**1. `CODEOWNERS`는 GitHub 네이티브 승인 게이트로 쓰지 않는다.** 대신 "검증기를 정의하는 민감 경로"
목록 — 기계(아래 verifier-pinned-review 스크립트)가 파싱하는 표시 — 로 재해석한다. 브랜치 보호 설정에
코드오너 승인 필수 옵션은 켜지 않는다. 파일은 표준 위치(`/CODEOWNERS`)에 두어 GitHub UI가 "이 경로는
누구 담당인지" 보여주는 정보성 용도는 그대로 살리되, 머지를 막는 승인 요건으로는 쓰지 않는다.

**2. `verifier-pinned-review` — base 리비전 테스트로 새 코드를 재검증한다.** `CODEOWNERS`가 지목한
경로(`tools/loop-engine/bin/`·`lib/`·`test/`·`.github/workflows/`·`CODEOWNERS` 자신)를 건드리는 PR은,
PR의 **base 리비전**에 있던 기존 `tools/loop-engine/test/*.test.sh` 전체를 그대로 PR의 **새 `bin/`
코드**에 대해 실행해 여전히 통과하는지 확인한다(`tools/loop-engine/bin/verifier-pinned-review.sh`,
CI에서는 `.github/workflows/loop-engine-test.yml`의 `pull_request` 이벤트에서만 실행).

**왜 이게 순환신뢰를 끊는가**: 검증기가 스스로를 느슨하게 고치는 PR은 보통 "판정 로직 변경"과 "그걸
감시하는 테스트 변경"을 한 커밋/PR 안에서 함께 한다 — 새 테스트만 보면 통과하는 게 당연하다(새 테스트
자체가 새 로직에 맞춰졌으므로). 하지만 **고쳐지기 전(base) 버전의 테스트는 그 PR이 손대지 않은
과거의 판단 기준**이다. 그 옛 테스트를 새 `bin/` 코드에 그대로 다시 돌리면, "이 변경이 과거에 옳다고
정의했던 동작을 여전히 만족하는가"를 새 테스트에 의존하지 않고 물을 수 있다. 테스트 파일을 통째로
삭제하는 것도 같은 회피 시도의 한 형태이므로(감시가 사라지면 무엇이든 통과한다), base에 있었지만 PR이
삭제한 테스트 파일도 복원해서 함께 돌린다. base에는 없었고 PR이 새로 추가한 테스트는 대상이 아니다 —
그건 이 PR의 정상적인 발전이고, 이미 일반 CI(`selftest` job)가 통과 여부를 본다.

## 고려한 대안

- **GitHub 네이티브 코드오너 승인 필수를 그대로 켠다** — 기각. 1인 레포에서 자기 PR 자기승인 불가로
  구조적 데드락(위 컨텍스트).
- **`tools/loop-engine`을 아예 보호 대상에서 뺀다(리뷰 요건 없음)** — 기각. 검증기 자신을 아무 감시
  없이 고칠 수 있게 되어, 순환신뢰 문제를 해결하는 게 아니라 포기하는 것이다.
- **PR마다 검증기의 과거 스냅샷(예: 직전 릴리스 태그) 전체를 통째로 체크아웃해 돌린다** — 기각(과설계).
  필요한 건 "판정 기준(테스트)이 흔들리지 않았는가"이지 "구현(`bin/`)이 과거와 동일한가"가 아니다 —
  새 `bin/` 코드는 정당하게 개선될 수 있어야 하므로, 고정할 대상은 테스트만으로 좁힌다.

## 재검토 트리거

- **레포에 오너가 2인 이상이 되면**, `CODEOWNERS`를 진짜 GitHub 코드오너 승인 게이트로 전환하는 걸
  재검토한다 — 그때는 "다른 사람의 승인"이 실제로 가능해지므로 사람 리뷰가 다시 1차 방어선이 될 수
  있고, `verifier-pinned-review`는 보조 장치로 격하될 수 있다.

## 참고

- 이슈 #14. `tools/loop-engine/bin/verifier-pinned-review.sh`,
  `tools/loop-engine/test/verifier-pinned-review.test.sh`, `/CODEOWNERS`,
  `.github/workflows/loop-engine-test.yml`.
