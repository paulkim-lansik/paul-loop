# ADR-0005: 원시 가드는 opt-in 유지, ship-flow 오케스트레이션은 기본으로 둘 다 켠다

**상태**: accepted

## 컨텍스트

`verdict-run.sh`의 `--guard-mutation`(검증 전후 git-가시 상태 변조 탐지)과 `loop-fix.sh`의 `--protect`
(수정자가 검증기/테스트 자신을 고치는 보상해킹 탐지)는 이 하네스의 헤드라인 위협모델(검증/수정 단계가
실제로 고치는 대신 속인다)에 대한 자체 방어 장치인데, 둘 다 opt-in이고 기본은 OFF다.

감사(`docs/audits/2026-08-20-harness-maturity-audit.md`, dimension "loop-engine code" gap #1, major)가
직접 재현했다: `--guard-mutation` 없이 실행하면 git-가시 상태를 변조해 자기 통과 조건을 만드는 검증
명령이 조용히 VERDICT PASS(exit 0)를 낸다. 같은 플래그를 주면 정확히 "workspace mutated during
verify … verify must not change git-visible state"로 FAIL(exit 1)로 뒤집힌다. `loop-fix.sh --protect`도
마찬가지 이야기다 — 플래그 없이는 검증기/테스트 자신을 고치는 수정자(고전적 보상해킹)를 전혀 잡지
못한다.

이 opt-in 기본값 자체는 실수가 아니라 명시적 설계다 — `verdict-run.sh` 헤더 주석이 말하듯
`GUARD_MUT=0`은 "켜지 않으면 기존 계약 완전 불변"이 목적이다. `verdict-run.sh`·`loop-fix.sh`는
버전이 매겨진 공개 계약이라 임의의 외부 호출자(loop-engine 플러그인을 이미 소비하는 다른 레포 포함)가
오늘의 기본-OFF 동작에 이미 의존하고 있을 수 있다. 이 기본값을 조용히 뒤집으면, 그런 호출자의 CI가
아무 경고 없이 갑자기 새로운 FAIL 판정을 받는 breaking change가 된다.

하지만 그 보존 논리가 지키는 건 "임의의 외부 호출자와의 하위호환"이지, "이 레포 자신이 그 가드를 안
쓸 이유"가 아니다. 실제로 확인해보면 이 레포 안에서 `loop-fix.sh`를 직접 부르는 곳은
`tools/ship-flow/skills/retrospect/SKILL.md`의 예시 호출과, 같은 예시를 그대로 복제해 둔
`tools/loop-engine/docs/lessons.md`("Wired into the loop" 절) 두 곳뿐이었고(전자가 "Full reference"로
후자를 가리키므로 둘 다 실사용 경로다), 둘 다 이미 `--protect "**/*.test.*"`가 붙어 있는데도
`--guard-mutation`은 빠져 있었다 — 이 스킬 문서를 그대로 따르는 실사용자는 보상해킹 가드는 얻고 변조
가드는 못 얻는, 아무 근거 없는 비대칭을 그대로 물려받는다. 두 곳 모두 고쳤다.

## 결정

**두 층을 분리한다.**

1. **원시 프리미티브(`verdict-run.sh`의 `--guard-mutation`, `loop-fix.sh`의 `--protect`/
   `--guard-mutation` 자체)는 계속 opt-in·기본 OFF로 둔다.** 이건 되돌리지 않는다 — 파일 상단 주석에
   이미 문서화된 대로, 임의의 외부 호출자를 위한 버전 계약이라 여기서 기본값을 뒤집는 순간 하위호환이
   깨진다.
2. **이 레포 자신의 ship-flow 오케스트레이션이 loop-engine bin을 직접 호출하는 지점은 두 가드를 기본으로
   켠다.** 구체적으로 `tools/ship-flow/skills/retrospect/SKILL.md`의 예시 `loop-fix.sh` 호출에
   `--guard-mutation`을 추가했다(`--protect "**/*.test.*"`는 이미 있었다) — 이제 이 문서화된 정본 경로를
   그대로 따르면 두 가드가 함께 켜진다. 원시 바이너리의 기본값은 그대로 두고, **그걸 부르는 이 레포의
   문서화된 사용처**에서만 명시적으로 플래그를 얹는 방식이라 "opt-in 계약"과 "이 레포는 안전한 기본값을
   쓴다"가 동시에 성립한다.

## 왜 이게 맞는 경계인가

- opt-in 기본값을 지키는 목적은 "이미 존재하는 외부 호출자를 안 깨는 것"이다. 이 레포 자신의
  ship-flow 예시 문서를 고치는 건 그 목적과 정면충돌하지 않는다 — 다른 레포의 CI를 건드리지 않고,
  이 레포를 처음부터 새로 따라하는 사용자에게만 적용된다.
- 반대로 `verdict-run.sh`/`loop-fix.sh`의 코드 자체 기본값을 뒤집었다면, 이미 이 플러그인을 pin해
  쓰는 모든 소비 레포(그중엔 오늘의 기본-OFF 동작에 의존해 CI를 짠 곳이 있을 수 있다)가 다음 플러그인
  업데이트에서 아무 경고 없이 새 FAIL을 만나게 된다 — 이건 이 이슈가 요구하는 수정의 범위를 넘는
  breaking change다.
- 감사가 지목한 실제 gap은 "가드가 존재하는데 이 레포의 정본 사용 예시가 그걸 빠뜨렸다"는 것이지
  "가드의 기본값 설계가 틀렸다"가 아니다 — 좁게 고치는 게 문제의 크기에 맞는다.

## 고려했으나 기각한 대안

- **`verdict-run.sh`/`loop-fix.sh`의 코드 기본값 자체를 ON으로 뒤집는다** — 기각. 문제 자체가 파일
  헤더에 "기존 계약 완전 불변" 목적으로 명시된 설계 결정이고, 뒤집으면 이미 기본-OFF 동작에 의존하는
  외부 소비 레포의 CI를 예고 없이 깬다. 이슈가 요구하는 것보다 큰 변경.
- **아무것도 안 고치고 감사 결과만 기록한다** — 기각. `retrospect/SKILL.md`가 실사용자가 그대로 복사해
  쓰는 정본 예시인데, 이미 `--protect`는 있으면서 `--guard-mutation`만 빠진 데 대한 설계적 근거가
  전혀 없었다 — 방치하면 이 스킬을 따르는 모든 실행이 계속 변조 가드 없이 돈다.
- **원시 바이너리에 별도의 "strict 모드" 플래그나 환경변수(예: `LOOP_STRICT=1`)를 새로 만들어 그걸
  ship-flow가 기본으로 켠다** — 기각(과설계). 이미 존재하는 `--guard-mutation`/`--protect` 플래그를
  호출부에서 그냥 붙이면 되는 문제라, 원시 바이너리에 새 스위치 레이어를 얹을 이유가 없다.

## 재검토 트리거

- ship-flow 오케스트레이션이 `loop-fix.sh`/`verdict-run.sh`를 직접 호출하는 지점이 `retrospect`
  예시 하나를 넘어 늘어나면(예: `tdd`나 `ship-feature` 스킬이 직접 배선하게 되면), 그 새 호출부에도
  동일하게 두 가드를 기본으로 얹는다 — 이 ADR의 원칙(원시는 opt-in, 이 레포의 호출부는 기본 ON)을
  그대로 적용하고 별도 ADR은 필요 없다.
- 다른 레포가 이 플러그인을 pin하며 기본-OFF 동작에 의도적으로 의존하지 않는 것으로 확인되면(예:
  전체 소비 레포 설문 결과 전원이 이미 두 플래그를 스스로 켜고 있다면), 그때는 원시 기본값 자체를
  ON으로 뒤집는 별도 이슈/ADR을 재검토할 수 있다 — 지금은 확인된 바 없어 보수적으로 유지한다.

## 참고

- 이슈 #33 해결(resolves). 근거: `docs/audits/2026-08-20-harness-maturity-audit.md` dimension
  "loop-engine code" gap #1 (major).
- `tools/ship-flow/skills/retrospect/SKILL.md`(예시 호출에 `--guard-mutation` 추가),
  `tools/loop-engine/bin/verdict-run.sh`(`GUARD_MUT=0` 기본값과 그 근거 주석),
  `tools/loop-engine/bin/loop-fix.sh`(`--protect`/`--guard-mutation` 플래그와 `$VERDICT_RUN`으로의
  passthrough), `tools/loop-engine/test/verdict-mutation-guard.test.sh` case 9(이 passthrough가 실제로
  가드를 켠다는 회귀 테스트, 이 ADR 이전부터 이미 존재).
