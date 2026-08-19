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

## 알려진 한계 — 의도적으로 남겨둠 (적대적 검증 라운드2에서 발견, 코드로 안 막음)

이 메커니즘이 못 잡는 두 클래스를 정직하게 기록한다. 둘 다 diff 경로 스캔이라는 접근 자체의 구조적
한계이거나 GitHub 플랫폼 동작의 결과라, `verifier-pinned-review.sh` 안에서 고칠 수 없다 — 과설계로
쫓아가지 않고 여기 문서화만 하는 걸 선택했다.

**1. 교차 디렉터리 우회.** `CODEOWNERS`는 정적이고 유한한 경로 prefix 목록이다. 검증 로직이 그
prefix 목록 **전부의 바깥**으로(이미 머지된, 그 자체로는 무해해 보이는 이전 PR이 만든 안정적인 위임
shim을 통해) 옮겨지면, 그 로직을 실제로 약화시키는 후속 PR은 오직 그 바깥 파일만 건드리므로
`touched=0`으로 조용히 스킵된다 — 스크립트는 변경된 경로를 prefix 목록에 grep할 뿐 도달가능성/호출
그래프 분석을 하지 않기 때문이다. 재현 확인: base 커밋에 `tools/loop-engine/bin/` 안의 안정적인
1줄짜리 shim이 `tools/loop-engine/` 바깥의 파일에 위임하도록 만든 뒤, 공격 PR이 그 바깥 파일만
고치자 `verifier-pinned-review: no verifier-defining paths touched — skipping` (exit 0)이 나왔다. 지금
이 레포엔 그런 위임 패턴이 실제로 없어 당장은 잠재적 gap이다.

**2. CI 워크플로우 정의 자체는 pin되지 않는다.** `.github/workflows/loop-engine-test.yml`은
CODEOWNERS의 민감 경로라 그걸 건드리는 PR은 pinned-baseline 체크가 정상적으로 실행되지만(`touched=1`),
`pull_request` 트리거는 GitHub이 **PR 자신의 head/merge ref**에서 워크플로우 파일 내용을 읽어 실행한다
— base의 얼어붙은 신뢰 사본이 아니다. 즉 PR이 자기 자신의 워크플로우 파일을 고쳐(`verifier-pinned-review`
job을 통째로 지우거나, `--base` 인자를 HEAD 자신으로 바꿔 diff를 비워버리는 식으로) 그 검사 자체를
무력화하면, 그 고쳐진 정의가 바로 그 PR의 체크로 실행된다. `verifier-pinned-review.sh`는 이걸 자기
내부에서 고칠 수 없다 — job이 워크플로우에서 사라지면 스크립트 자체가 CI에서 아예 호출되지 않으니
스스로를 복원할 방법이 없다. 진짜 방어는 GitHub 브랜치 보호의 필수 상태체크(job 이름으로 지정) —
필수 job이 워크플로우에서 사라지면 GitHub은 그걸 "Expected — waiting for status"로 보고해 머지를
막는다(자동으로 통과 처리하지 않는다). **이 레포의 `main`은 현재 브랜치 보호가 전혀 설정돼 있지
않다**(2026-08-19 확인, `gh api repos/.../branches/main/protection` → 404) — 켤지 여부는 레포 소유자가
따로 결정할 몫이라 이 PR이 대신 켜지 않는다.

**3. 이 PR 자신은 자기 diff를 pinned-baseline으로 못 걸 수 있다(부트스트래핑).** `CODEOWNERS`를 base
리비전에서 읽도록 고친(round 4) 이후, `CODEOWNERS`를 **처음 도입하는 PR** 자신은 base에 아직
`CODEOWNERS`가 없으므로 "민감 경로 없음 — PASS"로 스킵된다 — 이건 버그가 아니라 정확히 의도한
동작이다(이 PR이 소급해서 자기 자신을 보호할 방법은 원리적으로 없다). 보호는 이 PR이 머지되어
`main`에 `CODEOWNERS`가 생긴 **다음 PR부터** 실제로 발동한다. 잘못 읽으면 "이 메커니즘이 자기 PR도
검사한다"는 착각을 줄 수 있어 여기 명시한다.

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
- **교차 디렉터리 위임 패턴이 실제로 도입되면**(예: 공유 로직을 `tools/loop-engine/` 바깥의
  `scripts/`류 디렉터리로 추출), 그 도입 PR 자체에 사람이 "이 경로가 검증 로직을 옮기는 게 아닌가"
  의도적으로 더 주의 깊게 스크루티니한다. 이 클래스 공격이 실무에서 문제가 되는 게 확인되면,
  민감 prefix 안쪽에서 그 바깥을 가리키는 새 `source`/`exec`/`bash`/`node` 호출을 flag하는 lint성
  휴리스틱을 별도로 검토한다(지금은 과설계로 판단해 안 만듦).
- **`main`에 브랜치 보호(필수 상태체크)를 켤 때까지**, 이 ADR의 모든 방어는 강제가 아니라
  권고(advisory)다 — `verifier-pinned-review.sh`가 완벽해도 그걸 우회한 PR을 막을 서버단 장치가
  없다. 브랜치 보호를 켜면 이 재검토 트리거는 닫힌 것으로 본다.

## 참고

- 이슈 #14. `tools/loop-engine/bin/verifier-pinned-review.sh`,
  `tools/loop-engine/test/verifier-pinned-review.test.sh`, `/CODEOWNERS`,
  `.github/workflows/loop-engine-test.yml`.
