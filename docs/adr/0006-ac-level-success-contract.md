# ADR-0006: AC 단위 success contract(`ac-verify.sh`) — plan 파일이 정본

**상태**: accepted (구현 완료 — `bin/ac-verify.sh`)

**출처**: glucofit-partners ADR-0104(2026-08-19 grill 세션, BAC-625)에서 이관·요약. 결정 5("구현은
paul-loop 소유")가 이미 실행돼 `ac-verify.sh`가 이 레포 `tools/loop-engine/bin/`에 착지했으므로,
그 레포에만 있던 근거를 이 레포 자신의 ADR로 옮겨 플러그인이 자기 결정 근거를 자기 안에 갖게 한다
(BAC-758 A8). 원문 근거·기각 대안의 전체 논증은 원본 ADR-0104를 참고 — 여기서는 이 레포 관점의
결정 골자만 정리한다.

## 컨텍스트

`/ship-feature`의 3단계(Runtime verify)는 원래 에이전트의 자유형식 자기판단이었다 — "앱을 실행하고
확인했다"는 자기보고를, 검증기가 아니라 에이전트 자신이 판정했다. ouroboros(별도 하네스)의
`_run_ac_verify_gate`가 AC마다 `verify_command`/`expected_artifacts`/`output_assertion` 계약을
오케스트레이터가 직접 subprocess로 판정하는 패턴을 실물로 검증했지만, 동시에 함정도 실측했다 — 선택적
계약 필드는 crystallize 시점 LLM이 채우지 않는 경우가 흔해, 결정론 게이트가 있어도 아무도 안 쓰면
장식이 된다(seed AC 9건 전부 contract 0건).

## 결정

이슈/플랜 AC에 기계 판독 가능한 한 줄 계약 문법을 도입한다:

```
AC: <설명> | verify: <명령> | artifacts: <경로1>,<경로2> | expect: <부분문자열>
```

1. **정본은 워크트리 plan 파일**(ship-feature step 1 산출물). 트래커(Linear 등) AC prose는 같은
   문법의 사람이 읽는 사본일 뿐 — verify 루프가 매 반복 트래커 API에 의존하면 CI·fresh clone에서
   못 돈다(재현성 원칙과 동형).
2. **repo-wide verify 명령을 대체하지 않는 추가 게이트** — ship-feature 3단계를 형식화한다. 계약이
   선언된 AC에 한해 결정론 subprocess 판정이 에이전트 자기판단을 대체하고, repo-wide verify는 매
   커밋 무조건 걸리는 별개의 바닥으로 남는다.
3. **실행 주체는 `ac-verify.sh`** — AC마다 `verdict-run.sh`를 하위 호출해 재사용하고 그 위에 아티팩트
   실존·output substring 판정과 전체 집계를 얹는다. `verdict-run.sh` 자신은 "ANY 단일 명령" 계약을
   유지하며 확장하지 않는다.
4. **계약 0건 = fail-closed**(`require-tests.sh`의 "0테스트=RED"와 동형). 런타임 표면이 없는
   docs-only 트랙은 면제. 런타임 표면이 있는 트랙(consuming repo의 위험 분류 기준으로)은 plan
   전체에 최소 1개 이상 계약이 있어야 3단계 게이트가 PASS(SKIP 아님)한다 — 모든 AC 개별에 계약을
   요구하지는 않는다.

## 근거

ouroboros가 실물로 증명한 함정("선택적 계약 필드는 아무도 안 채운다")과 이 레포에 이미 있는 선례
(`require-tests.sh`의 "0=RED" 강제)가 같은 결론을 가리킨다 — fail-closed 없이는 결정론 게이트가
장식이 된다.

## 고려했으나 기각한 대안

- **트래커 AC prose 직접 파싱** — 트래커 API 의존(CI 미접근) + 리치텍스트 에디터의 raw pipe 문법
  이스케이프 위험.
- **`verdict-run.sh` 확장** — 단일-명령 계약이 깨지고 로직이 과밀해진다.
- **계약 없는 AC 허용 + self-review 표식만** — ouroboros가 이미 실패를 실측으로 증명한 경로.

## 재검토 트리거

`ac-verify.sh`가 소비 레포의 실제 ship-feature 플로우에 배선되는 사례가 누적되면, 위 4개 결정이
실제 사용 패턴과 정합하는지 재확인한다(특히 "최소 1건" 기준이 너무 느슨/엄격하지 않은지).

## 참고

- 원본: glucofit-partners `docs/adr/0104-ac-level-success-contract-plan-file-is-source-paul-loop-owns-implementation.md`
- 구현: `bin/ac-verify.sh`, `test/ac-verify.test.sh`
- BAC-625(원 이슈), [2026-08-04 ouroboros benchmarking §4.1](glucofit-partners docs/research/2026-08-04-ouroboros-benchmarking.md)(채택 O2)
