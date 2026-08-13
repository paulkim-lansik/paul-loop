# paul-loop

자가개선 개발 루프 하네스를 위한 Claude Code 플러그인 마켓플레이스.

## 왜 만들었나

에이전틱 코딩 루프는 특정한 방식으로, 반복적으로 실패한다 — 에이전트가 자기 작업의 통과 여부를
스스로 판정하는 것. 자기채점 루프는 "실제로 맞는 것"이 아니라 "완료라고 주장하기 가장 쉬운 것" 쪽으로
흘러간다 — 코드를 고치는 대신 테스트가 약해지고, "맞는 것 같다"가 소리소문없이 "맞다"를 대체한다.

**paul-loop의 유일한 불변식: 검증기가 천장이다.** 테스트 스위트든, 타입 체커든, lint 규칙이든, RLS
격리 증명이든 — 근거가 되는 검증이 무엇이든 그 종료 코드만이 판정을 만든다. 에이전트의 자기보고는
참고되지도, 가중치를 갖지도, 동점 상황의 타이브레이커로도 신뢰받지 않는다. 이 저장소가 내는 나머지
전부(검증된 수정만 기록하는 메모리, 결정론적 위험도 게이트, 하드 정지 조건을 가진 닫힌 검증→수정
루프)는 이 규칙 하나의 **결과**로 만들어진 것이지, 별개의 기능 목록이 아니다.

이 저장소가 **모놀리스 하나 대신 여러 개의 작은 플러그인**으로 나뉜 이유도 같다 — 이 천장 불변식
(`loop-engine`)만 받아들이고 특정 색깔의 배달 워크플로(`ship-flow`)나 의미 메모리 데이터베이스
(`loop-memory`)는 안 받아들일 수 있다. 쓸 것만 설치하면 된다 — `claude plugin details <name>`가
결정 전에 플러그인별 예상 토큰 비용을 보여준다.

> **상태: M1(공개 진행 중).** 명시적 semver(`0.2.0`), 릴리스마다 `claude plugin tag`로 태깅한다.
> `1.0` 이전이라 마이너 버전 사이에도 breaking change가 있을 수 있다 — 신경 쓰인다면 버전을 고정할
> 것. [마일스톤](#마일스톤) 참고.

## `loop-engine`에 들어있는 것

지금까지 낸 유일한 플러그인. *어떻게* 배달할지에 대해서는 아무 의견이 없다 — 이슈 트래커 연동도,
배달 스킬도, 메모리 데이터베이스도 없이, 그 밑에 깔린 검증/수정/기억 메커니즘만 있다. 아래 명령은
전부 `tools/loop-engine/bin/`에 있고, 플러그인이 로드되면 자동으로 `PATH`에 등록된다(공식 플러그인
스펙이 `bin/`을 알아서 등록한다 — 수동 `PATH` 배선 불필요).

### `verdict-run.sh` — 임의의 검증 명령을 기계가 읽을 수 있는 계약으로 감싼다

하류의 전부(`loop-fix`, lesson 기록, CI)가 원문 stdout이 아니라 이 계약을 읽으므로, pytest든
vitest든 `go test`든 셸 스크립트든 종료 코드가 있는 무엇이든 형식 하나로 통일돼야 한다.

```bash
verdict-run.sh -- pnpm test
verdict-run.sh --log /tmp/run.log --max-fails 10 -- pnpm typecheck
verdict-run.sh --guard-mutation -- pnpm verify   # verify가 추적 파일을 바꾸면 verdict를 FAIL로 강제
```

```
=== VERDICT ===
VERDICT: PASS
EXIT: 0
SUMMARY: passed= failed= skipped= duration_ms=8
LOG: /path/to/.loop/last-run.log
=== END VERDICT ===
```

- `VERDICT`/`EXIT`는 감싼 명령의 종료 코드에서 그대로 온다 — 출력에서 추론하지 않는다.
- `SUMMARY`는 best-effort 카운트 추출(jest/vitest/pytest/`node --test` 포맷)이다. 판정을 바꾸는
  일은 절대 없고, 읽는 사람이 더 빨리 훑도록 돕기만 한다.
- `FAIL`일 때는 로그에서 greppable한 `FAIL: ...` 줄을 추출한다(`✕`·`not ok`·`AssertionError`·
  `panic:` 등 엄선된 마커) — LLM 리더가 스택 트레이스 원문에 빠지지 않고 방향을 잡게 한다.
- `--guard-mutation`은 실행 전후로 git-가시 워크스페이스 상태를 스냅샷하고, verify 자체가 추적
  파일을 바꿨으면 `FAIL`을 강제한다 — "수정이 코드 대신 테스트를 바꿨다"라는 구멍을 막는다.
- 다른 도구가 의존할 수 있는 wire format을 포함한 전체 문서는
  [`docs/verdict-contract.md`](tools/loop-engine/docs/verdict-contract.md)에 있다.

### `loop-fix.sh` — 하드 정지 조건을 가진 닫힌 검증→수정→재검증 루프

```bash
loop-fix.sh --verify "pnpm test" --fix "claude -p 'fix the failing test'" --max-iter 8
loop-fix.sh --verify "pnpm typecheck" --stall 3 --infra-retries 2 --budget-sec 900
```

- **생성자 ≠평가자**: `--fix` 명령은 절대 성공을 판정하지 않는다. 오직 `--verify`의 종료 코드
  (`verdict-run.sh`를 통해)만 판정한다.
- **감(느낌)이 아니라 하드 정지**: `--max-iter`(항상 켜짐), `--budget-sec`(wall clock), `--stall`
  (실패 시그니처가 N회 반복되고 *동시에* pass/fail 카운트가 더 이상 움직이지 않을 때만 중단 — 같은
  에러 메시지라도 카운트가 움직이면 진행 중으로 취급).
- **인프라 장애는 이터레이션 예산을 안 태운다**: 실제 테스트 러너 실패 마커 없이 docker 데몬/포트
  다운 시그니처만 있으면 예외 처리(`--infra-retries`, 기본 2회)한다 — `--max-iter`를 깎지도, lessons
  저장소를 오염시키지도 않는다.
- **리워드 해킹 없음**: 밑단 verify 명령에 `--guard-mutation`을 같이 쓰면, 코드 대신 테스트를
  고치는 "수정"이 보상받지 않고 잡힌다.
- 매 이터레이션마다 `--fix` 명령이 읽을 수 있는 구조화된 핸드오프를 `.loop/`에 쓴다
  (`$LOOP_PROMPT_FILE`/`$LOOP_VERDICT_FILE`/`$LOOP_LOG_FILE`) — 실전에서는 `claude -p`를 감싸
  진짜 에이전틱 수정기로, 테스트에서는 결정론적 스크립트로 쓴다.

### `lessons.mjs` — 검증기가 실제로 확인한 것만 기록하고, 다음에 그걸 떠올린다

```bash
lessons.mjs record --signature "FAIL: ..." --verified --fix "..." --title "..." --lessons .loop/lessons
lessons.mjs recall  --signature "FAIL: ..." --lessons .loop/lessons
lessons.mjs promote --min-count 3 --lessons .loop/lessons          # 반복 후보
lessons.mjs challenge --id <key> --verdict accept|reject --reason "..."   # 별도의 회의적 평가
lessons.mjs promote --codify --lessons .loop/lessons               # accept된 것만, fail-closed
lessons.mjs retire --id <key> --ref "docs/where-this-got-codified.md"
```

- 수정기 자신의 주장이 아니라 **검증기**가 확인했을 때만 lesson이 기록된다. 검증 안 된 자기보고는
  recall 시점에도 신뢰할 만한 것으로 취급되지 않는다.
- `recall`은 실패 시그니처를 우선 매칭하고, 그 위에 의미 회상 여지를 둔다
  ([`docs/lessons.md`](tools/loop-engine/docs/lessons.md) 참고).
- 승격은 2단계·2주체 프로토콜이다: `promote`가 *후보*(N회 이상 반복)를 드러내고, 후보를 뽑은 것과
  **의도적으로 다른** 별도의 `challenge` 패스가 `accept`해야만 `--codify`가 방출한다. accept 없이
  코디파이 0건 — codify 경로는 fail-closed다.
- `retire`는 종결 동작이다: accept+codify된 lesson만 은퇴할 수 있어, 이미 가이드라인/스킬로 산
  것이 다시 떠오르지 않게 한다.

### `classify-risk.mjs` / `gate.mjs` — 에이전트 자기채점이 아니라 결정론적 위험도 게이트

이게 막는 문제: 에이전트가 자기 blast radius를 스스로 채점하면 안전 게이트가 장식이 된다. 그래서
차원은 **변경 자체**(건드린 파일 경로·실행한 명령·파이프라인 단계)에서 도출하고, 에이전트는 이미
룰이 도출한 값보다 낮추는 건 절대 못하고 오직 **상향**만 할 수 있다:

```
final(차원) = max(rule(차원), agent(차원))
```

```bash
classify-risk.mjs --from-git --stage pr --action "PR against main"
classify-risk.mjs --from-git --stage implement \
  --agent-blast-radius high --agent-reversibility partial   # 상향만 가능, 하향 불가
gate.mjs --blast-radius high --reversibility partial --cost low
```

- 종료 코드가 계약이다: `0`=AUTO, `10`=REQUIRE(사람이 실행 전에 승인해야 함 — reversibility가
  `none`이거나 어느 차원이든 미설정이면 발동: 미지값은 fail-closed로 처리되지 조용히 AUTO로 새지
  않는다), `11`=DENY_AND_LOG(가역이지만 넓거나 비싸면 — 기본 거부하되 사람이 나중에 검토할 판정
  증거를 첨부, 사람을 기다리며 블로킹하지 않는다), `2`=사용법 오류.
- `--render-md`는 greppable한 `<!-- gate-verdict: ... -->` 마커가 붙은, PR 본문에 바로 붙일 수
  있는 마크다운 블록 하나를 방출한다 — 라우팅 판단이 스크롤돼 사라지는 터미널이 아니라 감사 가능한
  기록으로 남는다.
- `classify-risk.mjs`는 차원을 계산한 뒤 `gate.mjs`를 exec한다 — 차원을 라우팅 판단으로 바꾸는
  자리가 정확히 하나이지, 서로 어긋날 수 있는 사본 두 개가 아니다.
- **경로/명령 룰 테이블은 빈 채로 배포된다.** 어떤 경로가 마이그레이션이고, 어떤 경로가 인증이고,
  어떤 경로가 CI 파이프라인 자체인지는 *당신 레포* 고유의 도메인 지식이지, 이식 가능한 플러그인이
  하드코딩할 게 아니다. `--rules <path>`(또는 `CLASSIFY_RISK_RULES`, 또는 레포 루트에
  `risk-rules.json`을 두는 것)로 당신의 룰 테이블을 넣는다:
  ```json
  { "pathRules": [{ "id": "db-migration", "startsWith": ["db/migrations/"],
                     "dims": { "revers": "none" }, "deep": ["your-migration-check"],
                     "why": "적용된 마이그레이션은 되돌릴 수 없다" }],
    "commandRules": [{ "id": "cmd-deploy", "patterns": ["\\bdeploy\\b"],
                        "dims": { "revers": "none" }, "why": "실행 즉시 공유 상태를 바꾼다" }] }
  ```
  룰 파일이 전혀 없어도 구조적 베이스라인은 그대로 적용된다(문서 전용·소규모 changeset은 AUTO,
  다파일 변경은 상향, merge/deploy/send는 항상 사람 결정) — 룰을 한 줄도 안 써도 도구는 바로 쓸 수
  있다, 다만 아직 당신 레포의 구체적 위험 구역은 모를 뿐이다.

### `require-tests.sh` — 테스트를 0개 돌리는 검증기는 조용히 그린이 아니라 RED가 되어야 한다

```bash
require-tests.sh "*.integration.test.ts" "RLS isolation proof"
```

*무언가를 증명하는 것*이 전부인 단계 앞에 이걸 둔다. 증명할 테스트가 삭제됐거나 애초에 없었다면
`vitest --passWithNoTests` 류의 플래그는 아무것도 없이 기꺼이 `0`으로 끝난다 — 이 가드는 그걸
명시적인 `FAILED:` 줄로 바꾼다.

## 설치

```bash
claude plugin marketplace add paulkim-lansik/paul-loop
claude plugin install loop-engine@paul-loop
```

## 설치 없이 먼저 써보기

`--plugin-dir`는 세션 하나에만 플러그인을 로드한다 — 마켓플레이스 등록이 필요 없다. 클론해서
먼저 써보거나, 이 저장소 자체를 개발할 때 쓰기 좋다:

```bash
git clone https://github.com/paulkim-lansik/paul-loop
claude --plugin-dir paul-loop/tools/loop-engine
# 세션 안에서 bin/은 이미 PATH에 등록돼 있다:
#   verdict-run.sh -- echo hi
```

## 저장소 구조

```
.claude-plugin/marketplace.json   # 마켓플레이스 매니페스트 — 이 저장소가 내는 플러그인 전체 목록
tools/loop-engine/
  .claude-plugin/plugin.json      # 이 플러그인의 매니페스트
  bin/                            # 명령들 — 플러그인 로드 시 PATH 자동 등록
  lib/                            # bin/ 스크립트가 import하는 공유 헬퍼
  test/                           # 자체 테스트 스위트(bash+node, docker 0) — test/run.sh가 전부 실행
  docs/                           # verdict 계약·lessons 모델·eval-gate·otel 메모
```

`plugins/loop-engine`이 아니라 `tools/loop-engine`인 건 스타일 선택이 아니다 — 이 플러그인은
모노레포에서 추출됐는데, 그 자체 테스트 스위트가 `test/`에서 세 단계 위인 이 상대경로를
하드코딩하고 있었다. 디렉토리 이름을 바꾸면 "무수정 이식"이 더 이상 사실이 아니게 됐을 것이라
경로를 그대로 유지했다.

## 개발 상태

- **살균은 끝났지만 아직 공개 전.** M0은 원본 모노레포 안에서만 말이 되던 것들을 전부 제거했다 —
  외부 import를 가진 훅 하나, 그 레포 자신의 CI/훅 배선을 단정하는 테스트들, 그리고 프로덕션
  코드베이스의 실제(시크릿만 제거된) PR 제목·파일 경로를 담고 있던 fixture 파일 하나. 남은 건
  독립 실행된다 — `tools/loop-engine/test/run.sh`가 이 저장소 밖의 것 없이 15/15 그린이다.
- CI(`.github/workflows/`)가 매 `main` push마다 `gitleaks`와 자체 테스트 스위트 +
  `claude plugin validate --strict`를 돌린다.
- **버저닝: 흐르는 SHA 채널이 아니라 명시적 semver.** Claude Code 자체의 버전 해석 순서
  ([Plugins reference § Version management](https://code.claude.com/docs/en/plugins-reference#version-management)
  참고)는 `plugin.json`과 마켓 엔트리 둘 다에서 `version`을 생략했을 때만 "해석된 커밋이 바뀔 때마다
  업데이트"로 폴백한다 — 공식 문서는 이 폴백을 "활발히 개발 중인 내부·팀 플러그인"에 맞는 방식으로,
  명시적 버전 상향은 "안정적 릴리스 주기를 가진 공개 플러그인"에 맞는 방식으로 구분한다. M1은
  후자다. 이 선택은 실제 툴링 충돌도 해소한다: 위 CI에 배선된 `claude plugin validate --strict`는
  `version` 부재를 경고가 아니라 하드 에러로 취급한다 — "version 생략"과 "CI에 `--strict` 유지"는
  동시에 성립할 수 없다. 릴리스마다 `plugin.json`의 `version`을 올리고 `claude plugin tag`로 태깅한다.

## 마일스톤

- **M0(완료)** — 비공개 스캐폴드: 시크릿/PII 스윕 + gitleaks CI + `loop-engine` bin·test 무수정
  이식 + `claude plugin validate --strict` 그린 + `--plugin-dir` dogfood `verdict-run` 1회 완주.
- **M1(현재)** — `loop-engine` 공개: `docs/`에 남은 한국어 프로즈 영어화(완료), `classify-risk`의
  룰 테이블을 소비자가 `--rules`/`CLASSIFY_RISK_RULES`/레포 루트 `risk-rules.json`으로 직접 넣을 수
  있게 외부화(완료), 저장소 비공개 → 공개 전환은 명시적 semver로([개발 상태](#개발-상태)에 SHA 채널
  대신 이걸 택한 이유).
- **M2** — `ship-flow`(배달 루프 스킬 묶음) + `templates/`(소비 레포에 setup 스킬이 배선하는 헌법
  층 템플릿 — 플러그인 루트 `CLAUDE.md`는 Claude Code가 프로젝트 컨텍스트로 로드하지 않아, 파일
  하나로 플러그인 안에 그냥 두는 걸로는 안 됨).
- **M3(선택)** — `loop-memory`(pgvector 의미 회상, opt-in/`defaultEnabled: false`) +
  `anthropics/claude-plugins-community` 제출 검토.

## 라이선스

MIT — [LICENSE](LICENSE) 참고.
