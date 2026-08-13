# 로컬 OTel 수집 (BAC-587) — Claude Code 텔레메트리 → 127.0.0.1 수신기 → H2/C1/C2

Claude Code의 OpenTelemetry 텔레메트리를 **로컬 전용**으로 수집해 하네스 지표(H2·C1·C2)를
산출하는 기반. 원칙: **어떤 content payload도 수집 경로에 싣지 않고, 텔레메트리는 루프백 밖으로
직접 내보내지 않는다.** 기계 게이트가 증명하는 범위는 "첫 홉의 목적지가 루프백 + content 플래그
off"까지다 — 수신기 미기동 시 그 포트에 다른 로컬 리스너가 있는지는 게이트 대상이 아니어서,
포트를 레포 전용 비표준 값(**44318**)으로 두어 표준 4318에 상주하는 타 프로젝트 collector(외부
포워딩 구성)와의 무음 교차(유출/합류)를 구조적으로 차단한다. 수신기 기동 전 점검 한 줄:
`lsof -iTCP:44318 -sTCP:LISTEN`(이미 리스너가 있으면 우리 수신기는 EADDRINUSE로 명확 실패).
(경고문 대체 금지 — 경고문 추가는 리서치가 기각한 안티패턴.)

## 구성

| 조각 | 역할 | 잠금 |
|---|---|---|
| `.claude/settings.json` `env` 블록 | Claude Code 프로세스 스코프 OTel 설정(셸 전역 export 금지) | `test/otel-hygiene.test.sh` |
| `bin/otel-receiver.mjs` | OTLP/HTTP(json) 수신기 — **127.0.0.1 전용 바인딩**, zero-dep, docker 0 | `test/otel-receiver.test.sh` |
| `bin/otel-metrics.mjs` | `.loop/otel/*.jsonl` → H2/C1/C2 집계(read-only, 결손=INSUFFICIENT_DATA) | `test/otel-receiver.test.sh` |
| `bin/loop-doctor.mjs` OTEL 행 | content 플래그 하나라도 켜지면 crit(계기판, read-only) | `test/otel-hygiene.test.sh` |

## 수신기 기동 — opt-in(기본 안 띄움)

```sh
node tools/loop-engine/bin/otel-receiver.mjs        # 127.0.0.1:44318 (settings env 블록 endpoint와 동일)
LOOP_OTEL_PORT=<port> node tools/loop-engine/bin/otel-receiver.mjs   # 포트 오버라이드(endpoint도 함께 바꿀 것)
LOOP_OTEL_DIR=<dir>   node tools/loop-engine/bin/otel-receiver.mjs   # 착지 디렉토리 오버라이드(기본 .loop/otel/)
```

- 착지: `.loop/otel/<YYYY-MM-DD>.<kind>.jsonl` (`kind` = metrics|logs|traces). `.gitignore`의
  `.loop/*`로 미커밋. 기록 전 `lib/sanitize.mjs`의 `sanitizeRecord`를 통과한다 — 단 실효를 과장하지
  않는다: OTLP 구조의 키는 `key`/`value`/`stringValue`뿐이라 키 이름 blocklist는 매치되지 않고,
  실제 효과는 **길이 캡(256자 절단) + `key=value` 형태 시크릿 마스킹**까지다. content 차단의 실
  방어선은 위생 게이트(content 플래그 off)다.
- **보존 정책 없음(무제한 append)** — 날짜별 파일이 계속 쌓인다(export 주기 60초 × 시그널 3종 ×
  세션 수). 오래된 날짜 파일은 수동 삭제한다: `rm .loop/otel/<YYYY-MM-DD>.*.jsonl`(전체 초기화는
  `rm -rf .loop/otel/`). 자동 회전은 상시 데몬화와 같은 후속 이슈 몫.
- 수신기가 경계 표면(merge/deploy/send) 태깅을 **기록 시점(절단 전)**에 수행해 span에
  `boundary_surface`로 동봉한다 — 절단된 저장 텍스트로는 장문 명령 꼬리의 merge/deploy 토큰 판정이
  불가하기 때문(H1의 기록 시점 태깅과 동일 원칙). 집계기는 이 태그를 우선한다.
- **수신기 미기동은 정상 상태다** — Claude Code의 OTLP export 실패는 세션에 무음(fail-open)이고,
  수집만 안 될 뿐이다. 상시 데몬화(SessionStart spawn 등)는 범위 밖(수명주기·중복기동 문제 — 별도 이슈).
- 비JSON body(protobuf 등)는 200 + `unparsed:true`로 기록만 한다(재시도 폭주 방지). 정상 경로는
  env 블록의 `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` 고정이 보장한다.
- 집계: `node tools/loop-engine/bin/otel-metrics.mjs [--otel-dir <dir>] [--json]`

## H2 지표표 (AC ⑧)

| 항목 | 값 |
|---|---|
| span 정확 명칭 | `claude_code.tool.blocked_on_user` |
| 의미 | 도구 실행이 사람 승인을 기다리며 블록된 구간의 **수집 구간 누적 수**("런당" 아님 — 집계기는 디렉토리 전체를 fold하고, 한 수신기에 병렬 워크트리 세션이 합류할 수 있다). 시간 창은 `--since <ISO>`, 세션 귀속은 `h2_by_session`(resource `session.id`)으로 분리. 런 단위 귀속은 소비 이슈(후속) 몫 |
| 활성 조건 3개 | `CLAUDE_CODE_ENABLE_TELEMETRY=1` **+** `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` **+** `OTEL_TRACES_EXPORTER` 설정 |
| 제외 | 경계 표면(merge/deploy/send) 매치 span은 H2에서 제외하되 `excluded_by_surface`로 항상 표시 — 제외 목록은 H1과 **동일 원천**(`lib/boundary-surfaces.mjs` 단일 소스). 제외 없인 "사람 개입 줄이기" 최적화가 사람-승인 경계(ADR-0061 §5) 자체를 없앤다 |

**베타 의존 리스크**: 이 span은 베타 플래그(`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`) 뒤에 있다.
감지 범위를 정직하게: `INSUFFICIENT_DATA`는 **trace 레코드가 0건일 때만** 나온다(trace export 자체가
멎는 경우 — 베타/exporter 미설정). trace는 흐르는데 대상 span만 사라지는 드리프트(예: CC 업데이트로
span 개명)는 H2가 0으로 남되 **`h2_reason`이 "span 0건 — 개명/미발화 구분 불가"를 항상 동반**하고
`h2_span_seen`(제외 전 관측 수)으로 드리프트를 가시화한다 — 0을 무조건 "대기 없음"으로 읽지 말 것.
C1(`claude_code.cost.usage` USD 합)·C2(`claude_code.token.usage` type별 합)도 같은 규약이며, 메트릭
명칭은 첫 실수신 payload 대조로 검증한다 — 드리프트 시 역시 INSUFFICIENT_DATA로 드러난다.
**temporality**: env 블록이 `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`를 고정한다
(OTLP 기본 cumulative는 매 export가 러닝 토탈을 재전송 — 무조건 합산하면 배치 수만큼 배수
과대보고). 집계기도 방어적으로 temporality를 읽어 delta는 합산, cumulative/무표기는 시리즈별
최댓값을 채택한다(회귀 fixture로 잠금).
H2/C1/C2의 하네스 지표 소비(전후 비교 등)는 후속 이슈 몫 — 이 이슈는 수집 기반+안전장치까지다.

## content 플래그 5종 — 전부 금지 (기계 강제)

`OTEL_LOG_USER_PROMPTS` · `OTEL_LOG_ASSISTANT_RESPONSES` · `OTEL_LOG_TOOL_DETAILS` ·
`OTEL_LOG_TOOL_CONTENT` · `OTEL_LOG_RAW_API_BODIES` — 어떤 값으로도 켜지 않는다.

- `OTEL_LOG_ASSISTANT_RESPONSES`는 **명시적으로 `"0"`을 박는다** — 독립 기본값이 없어 unset이면
  `OTEL_LOG_USER_PROMPTS`로 폴백하는 문서화된 함정이 있다(부재 ≠ 안전). 나머지 4종은 unset=off라
  의도적으로 미기재.
- `OTEL_LOG_RAW_API_BODIES`는 `file:<dir>` 모드로 네트워크 없이 디스크로 API 원문을 무절단 덤프한다
  — 이 하나가 나머지 4종의 노출을 함의한다. canonical 금지 디렉토리는 `.loop/otel-raw/`이며, 어느
  경로에 떨어져도 커밋되지 않게 `.gitignore`에 `**/otel-raw/`를 선제 등재했다(심층방어 — 활성화
  자체가 이미 금지).
- 감시: `pnpm loop:doctor`의 OTEL 행이 process env + settings **3파일**(user `~/.claude/settings.json`
  < project `.claude/settings.json` < local `.claude/settings.local.json`, CC 병합 우선순위로 최종
  유효값 판정)을 검사해 하나라도 켜지면 **crit**을 낸다. local은 gitignore라 위생 게이트가 못 보는
  사각 — 이 계기판이 유일한 감시 지점이다. **한계(정직 서술)**: Claude 세션 안에서 실행하면 플랫폼이
  Bash 자식 env에서 `OTEL_*`를 필터해 process env 팔은 무력하다(아래 전파 실측) — 셸 전역 export
  위반은 세션 밖(사용자 셸에서 `pnpm loop:doctor`) 실행만 잡고, settings 3파일 검사가 실효 범위다.

## env 스코프 — Claude Code 프로세스 한정 (AC ⑥·⑦)

설정은 `.claude/settings.json`의 최상위 `env` 블록(셸 전역 export 금지). **전파 실측(2026-08-09,
Claude Code 2.1.226 — headless `claude -p` + Bash `printenv` + 2단 node 자식, 수신기 미기동)**:

- `CLAUDE_CODE_ENABLE_TELEMETRY`·`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`는 Bash 자식에 **상속된다**
  (부모 셸 baseline엔 없던 값이 printenv에 노출 — env 블록이 실제 적용된다는 증거이기도 하다).
- **`OTEL_*` 변수는 Bash 자식·2단 자식에 상속되지 않았다**(printenv에 OTEL_ 0줄, 2단 node
  `process.env.OTEL_METRICS_EXPORTER === undefined`) — 플랫폼이 tool 자식 env에서 `OTEL_*`를
  필터링한다. 우려했던 유출 표면(Claude 세션 안 apps/api 부팅이 exporter를 물려받아 제품 메트릭이
  로컬 수신기로 흐름)은 현 버전에선 플랫폼 레벨에서 이미 닫혀 있다.
- 단, 이 필터링은 **미문서 동작**(버전 의존)이라 규율은 그대로 유지한다: 셸 전역 export 금지,
  Claude 세션 안에서 `apps/api`를 부팅할 땐 `env -u OTEL_METRICS_EXPORTER -u OTEL_LOGS_EXPORTER`
  (심층방어 습관). `apps/api/src/tracing-sdk.js`는 두 exporter를 `??= 'none'`으로 고정하는데
  `??=`는 이미 설정된 값을 **관통**시킨다 — 이 유출 표면은 `test/otel-env-scope.test.sh`가 회귀로
  고정한다(clean env → `none` / 선지정 → 관통). traces는 tracing-sdk가 NoopSpanProcessor를 명시해
  export 경로가 없다.
- 수신기 미기동 세션의 export 실패는 **완전 무음**이었다(headless 실행 stderr 0바이트) — collector
  없는 셸에서 세션이 시끄러워지지 않는다(fail-open).
- QA·dev 부팅의 정본 경로는 메인 워크트리의 사용자 셸(CLAUDE.md §8)이라 env 블록의 영향권 밖이다.
- 노출 창은 "이 레포에서 뜨는 Claude Code 세션"으로 좁다 — 대안(셸 전역 export)은 머신 전체가
  노출 창이 되어 기각.

## 범위 밖 기록

- PostHog로 집계 지표만 내보내는 경로 검토(로컬 collector 원칙 유지 전제) — 이슈 비구속 코멘트,
  이번 구현에서 비채택. PR 본문에 기록.
- H2/C1/C2를 소비하는 전후 비교(BAC-567·573 계열)는 후속.
