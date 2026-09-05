# ADR-0008: 실행 상태·검증 근거·런타임 어댑터의 책임 분리

상태: accepted for the user-approved hardening implementation; publication remains separate.

2026-09-05 전체 감사에서 판정 출력/종료 상태 불일치, 총예산 이후 PASS, 취소 후 자식 프로세스,
누락된 리뷰의 통과 처리, 오래된 메모리의 재사용을 재현했다. 지침 강화만으로 해결되지 않는
실행 계약 문제이므로 다음 책임을 코드로 나눈다.

- 엔진은 실행 소유권, 시도 횟수, 절대 deadline, 취소 및 재개의 상태를 보존한다.
- 검증기는 시작/종료 대상, 명령 및 판정 출력에 귀속된 근거를 생성한다.
- 워크플로우는 요구 AC와 리뷰 범위, 실제 완료 조건을 정한다. 누락된 단계는 미완료다.
- 런타임 어댑터는 native hook payload, 플러그인 경로, 도구·격리·취소 지원 여부를 맡는다.
- 메모리는 검증 근거와 현재 수명주기를 확인하며, 학습 횟수를 실제 검증 횟수로 꾸미지 않는다.

실행·근거·지식의 관계는 로컬 JSON과 명시적인 edge로 표현한다. ADR-0001의 외부 그래프
데이터베이스 도입 보류를 유지한다. 관측 원장은 위조 가능한 telemetry이며 승인이나 예산의
정본으로 사용하지 않는다. 로컬 content hash 역시 같은 사용자 권한의 악의적 writer에 대한
서명이 아니다. 이 한계를 숨기지 않는다.

공통 지침은 이미 주어진 작업 범위와 승인을 재사용한다. 일상적인 테스트 설계와 제한된 하위
인터뷰에서 반복 확인을 줄이지만, merge/deploy/send 승인 및 검증기 보호를 약화하지 않는다.
산출물 버전이 달라진 경우 이전 승인을 자동 확장하지 않는다.

ADR-0004의 소스/소비 저장소 구분을 유지한다. 코드와 fixture 테스트는 provider 구현의 근거다.
native 런타임 qualification 및 소비 저장소의 장기 효과는 별도의 실제 실행 결과로만 주장한다.

관련 구현 계약: [실행 수명주기](../../tools/loop-engine/docs/loop-fix.md),
[근거 그래프](../../tools/loop-engine/docs/evidence-graphs.md),
[에이전트 평가](../../tools/loop-engine/docs/agent-evaluation.md).
