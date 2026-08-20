# ADR-0007: 수동 의미 회상 CLI(`loop-memory recall`)는 훅과 같은 env를 보고, 못 보면 fail-closed

**상태**: accepted (구현 완료 — `tools/loop-memory/src/cli.ts`)

**출처**: glucofit-partners ADR-0062 결정 9에서 이관·요약(BAC-758 A8). 원문 근거·트레이드오프의 전체
논증은 원본 ADR-0062를 참고 — 여기서는 이 레포(loop-memory 구현체) 관점의 결정 골자만 정리한다.

## 컨텍스트

loop-memory는 SessionStart/UserPromptSubmit 훅이 자동으로 임베딩 API 키(`OPENAI_API_KEY`/
`GEMINI_API_KEY`)를 읽어 verified 파일-lesson을 벡터 스토어로 graduate하고, 세미antically 가까운
lesson을 프롬프트에 주입한다. 이와 별개로, 사람이 손으로 질의하는 `loop-memory recall` CLI가 있다 —
이 CLI가 훅과 **다른** 방식으로 env를 읽으면(예: 셸 export 의존), 훅은 실 임베더로 정상 동작하는데
수동 CLI만 키를 못 찾아 스텁 임베더로 조용히 돌아가는 상황이 생긴다. 스토어는 실 임베더 벡터로 채워져
있는데 질의만 스텁이면, 결과는 *비어 있는* 게 아니라 코사인 거리가 무의미해진 채로 **조용히 틀린**
결과를 정상처럼 반환한다.

## 결정

두 겹으로 고친다:

1. **`.env`를 훅과 같은 소스에서 로드한다** — CLI가 훅의 env 로더와 동일한 파일(예:
   `tools/loop-memory/.env`)을 읽어, 문서화된 수동 명령이 셸 export 없이도 훅과 **같은 임베더**로
   돈다.
2. **그래도 키가 없으면 거부한다(fail-closed)** — 명시적 opt-in(`--allow-stub`) 없이는 조회하지
   않고 0이 아닌 종료코드로 끝난다. stderr 경고 한 줄로는 부족하다 — JSON 출력 자체는 정상처럼
   보이기 때문이다. `--allow-stub`을 켜면 경고와 함께 스텁으로 진행하되, "이건 의미 회상이 아니다"를
   명시적으로 알린다.

이것은 파일 기반 서명 회상의 miss 처리(정확한 실패를 stderr 힌트로만 알리고 exit code는 그대로 두는
것)와 **의도적으로 비대칭**이다. 서명 회상의 miss는 *없음*을 정확히 보고하므로 힌트로 충분하지만,
스텁 질의는 *틀린 것을 있음으로* 보고한다. 조용한 오답에는 fail-closed가 맞다.

## 근거

- 조용한 오답은 침묵보다 나쁘다 — 없는 결과는 사람이 다시 찾아보게 만들지만, 그럴듯하게 틀린 결과는
  신뢰되고 그대로 쓰인다.
- 훅과 CLI가 다른 env를 보면, "왜 훅은 되는데 수동 질의는 안 되지"라는 디버깅 비용이 반복 발생한다 —
  같은 소스를 보게 하는 것 자체가 그 계열의 혼란을 구조적으로 없앤다.

## 고려했으나 기각한 대안

- **스텁 임베더로 항상 조용히 진행 + stderr 경고 한 줄** — 기각. JSON이 정상처럼 보여 경고를 놓치기
  쉽고, "결과가 있음"이 곧 "신뢰할 만함"으로 오인되기 쉽다.
- **CLI가 셸 export만 신뢰(훅과 별개 env 소스 유지)** — 기각. 훅/CLI 간 동작 불일치가 반복 재발하는
  근본 원인을 안 고친다.

## 재검토 트리거

CLI와 훅이 다시 다른 env 소스를 보게 되는 변경(예: 훅 쪽 로더 리팩터)이 생기면, 이 ADR의 "같은
소스" 전제가 여전히 성립하는지 재확인한다.

## 참고

- 원본: glucofit-partners `docs/adr/0062-signature-recall-vs-semantic-recall-liveness.md` 결정 9
- 구현: `tools/loop-memory/src/cli.ts`, `tools/loop-memory/test/cli-embedder-gate.test.ts`
