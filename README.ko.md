# paul-loop

자가개선 개발 루프 하네스를 위한 Claude Code 플러그인 마켓플레이스. 핵심 아이디어는 **검증기가
천장이다** — 테스트·타입·린트 등 근거가 되는 검증이 무엇이든, 에이전트 자신의 자기보고가 그것을
대신하지 않는다. 나머지 전부(검증된 수정만 기록하는 메모리, 위험도 게이트, 닫힌 검증→수정 루프)는
이 불변식 위에 쌓인다.

> 상태: **M0(비공개 스캐폴드)**. 이 저장소는 공개 발표 전 살균·검증 단계에 있다. 아래
> [마일스톤](#마일스톤) 참고.

## 플러그인

모놀리스 하나 대신 관심사별로 분리된 플러그인을 낸다 — 켠 것만큼만 토큰 비용을 지불한다
(`claude plugin details <name>`가 플러그인별 예상 토큰 비용을 보여준다).

- **`loop-engine`**(이번 마일스톤) — 핵심 메커니즘:
  - `verdict-run` — 임의의 검증 명령을 감싸 기계가 읽을 수 있는 `PASS`/`FAIL` 계약을 방출
    ([`docs/verdict-contract.md`](tools/loop-engine/docs/verdict-contract.md) 참고)
  - `loop-fix` — 하드 예산을 가진 닫힌 검증→수정→재검증 루프
  - `lessons` — 검증기가 확인한 수정만 기록하고, 비슷한 실패 시그니처가 다시 나타나면 그걸
    떠올리며, 반복되는 것만 코디파이 후보로 승격 ([`docs/lessons.md`](tools/loop-engine/docs/lessons.md) 참고)
  - `classify-risk`/`require-tests`/`gate` — 에이전트 자신의 판단이 아니라 결정론적 위험도 분류와
    가짜-그린 방지 가드

배달 루프 스킬 묶음, opt-in 의미 회상, 이슈 트래커 브릿지 같은 나머지 플러그인은 이후 마일스톤에서
낸다 — 아래 참고.

## 설치

```bash
claude plugin marketplace add paulkim-lansik/paul-loop
claude plugin install loop-engine@paul-loop
```

개발기(`M1` 이전)엔 릴리스 버전 대신 이 저장소를 직접 핀 고정하고, 사전 고지 없는 breaking
change를 각오할 것.

## 마일스톤

- **M0(이번)** — 비공개 스캐폴드: 시크릿/PII 스윕 + gitleaks CI + `loop-engine` bin·test 무수정
  이식 + `claude plugin validate --strict` 그린 + `--plugin-dir` dogfood `verdict-run` 1회 완주.
- **M1** — `loop-engine` 공개: 영어 문서화 + `classify-risk` 룰 테이블 소비자별 외부화 + 마켓
  공개(SHA 핀 채널).
- **M2** — `ship-flow`(배달 루프 스킬 묶음) + `templates/`(소비 레포에 setup 스킬이 배선하는 헌법
  층 템플릿 — 플러그인 루트 `CLAUDE.md`는 프로젝트 컨텍스트로 로드되지 않아 파일 하나로는 안 됨).
- **M3(선택)** — `loop-memory`(pgvector 의미 회상, opt-in/`defaultEnabled: false`) +
  `anthropics/claude-plugins-community` 제출 검토.

## 라이선스

MIT — [LICENSE](LICENSE) 참고.
