#!/usr/bin/env bash
# BAC-587 — 로컬 OTLP/HTTP(json) 수신기 + H2/C1/C2 집계 회귀.
#   - 수신기는 127.0.0.1 전용 바인딩(외부 노출 금지, AC①) — 소스(단일 listen 경로)와 런타임(기동
#     배너의 실 바인드 주소) 이중 단언.
#   - 비JSON body에도 200 + unparsed 마킹(fail-open) — CC 텔레메트리 실패가 세션을 방해하면 안 된다.
#   - 집계기(otel-metrics)는 H2에서 경계 표면(merge/deploy/send)을 제외하고(H1과 동일 원천 =
#     lib/boundary-surfaces.mjs), 결손 축은 조작된 0 대신 INSUFFICIENT_DATA를 정직 보고한다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
RECV="$ROOT/tools/loop-engine/bin/otel-receiver.mjs"
METRICS="$ROOT/tools/loop-engine/bin/otel-metrics.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$RECV" ] || fail "otel-receiver.mjs not found at $RECV"
[ -f "$METRICS" ] || fail "otel-metrics.mjs not found at $METRICS"

TMP="$(mktemp -d)"
RECVPID=""
trap '[ -n "$RECVPID" ] && kill "$RECVPID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- 소스 레벨: 바인딩은 127.0.0.1 상수 경로 하나뿐 + 기본 포트는 레포 전용 비표준(44318) ---
grep -q "const HOST = '127.0.0.1'" "$RECV" || fail "receiver must hardcode HOST='127.0.0.1'"
[ "$(grep -c "\.listen(" "$RECV")" = "1" ] || fail "receiver must have exactly one listen() call (no alternate bind path)"
grep -q "listen(PORT, HOST" "$RECV" || fail "the single listen() must bind HOST (127.0.0.1)"
# 표준 4318은 타 프로젝트 collector(외부 포워딩 구성)가 상주하기 쉽다 — 기본 포트가 표준으로
# 돌아가면 수신기 미기동 시 무음 유출/타 프로젝트 세션 합류 양방향 리스크가 되살아난다.
grep -q "process.env.LOOP_OTEL_PORT || 44318" "$RECV" || fail "receiver default port must be the repo-reserved 44318 (not the standard 4318)"

# --- 런타임: 기동 배너의 실 바인드 주소(address())가 127.0.0.1 ---
LOG="$TMP/recv.log"
LOOP_OTEL_PORT=0 LOOP_OTEL_DIR="$TMP/otel" node "$RECV" >"$LOG" 2>&1 &
RECVPID=$!
PORT=""
for _ in $(seq 1 50); do
  PORT="$(sed -n 's/.*listening on 127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$LOG" | head -1)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || fail "receiver never printed its 127.0.0.1 startup banner: $(cat "$LOG")"

# --- OTLP/JSON metrics POST → 200 + jsonl 1줄 착지 ---
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/metrics" \
  -H 'Content-Type: application/json' \
  -d '{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","sum":{"dataPoints":[{"asDouble":0.3}]}}]}]}]}')"
[ "$CODE" = "200" ] || fail "metrics POST must return 200; got $CODE"
sleep 0.2
METRICS_FILE="$(ls "$TMP/otel"/*.metrics.jsonl 2>/dev/null | head -1)"
[ -n "$METRICS_FILE" ] || fail "no *.metrics.jsonl landed in LOOP_OTEL_DIR: $(ls "$TMP/otel" 2>/dev/null)"
[ "$(wc -l < "$METRICS_FILE" | tr -d ' ')" = "1" ] || fail "expected exactly 1 jsonl line, got: $(cat "$METRICS_FILE")"
grep -q 'claude_code.cost.usage' "$METRICS_FILE" || fail "payload must be recorded in the jsonl line"

# --- 비JSON body → 200 + unparsed 마킹(fail-open, 크래시 없음) ---
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/traces" \
  -H 'Content-Type: application/x-protobuf' --data-binary 'not-json')"
[ "$CODE" = "200" ] || fail "non-JSON POST must still return 200 (fail-open); got $CODE"
sleep 0.2
TRACES_FILE="$(ls "$TMP/otel"/*.traces.jsonl 2>/dev/null | head -1)"
[ -n "$TRACES_FILE" ] || fail "unparsed record must still land as *.traces.jsonl"
grep -q '"unparsed":true' "$TRACES_FILE" || fail "non-JSON body must be marked unparsed:true: $(cat "$TRACES_FILE")"

# --- 장문 명령 경계 태깅 e2e: merge 토큰이 sanitize CAP(256자) 뒤에 있어도 기록 시점 태깅으로 제외 ---
# (절단 후 사후 판정이었다면 merge 토큰 유실 → 사람-승인 경계 대기가 H2에 산입 — 3축 리뷰가 잡은 함정)
BODY="$(node -e '
  const cmd = "cd /w && pnpm verify && " + "x".repeat(300) + " && gh pr merge 630";
  console.log(JSON.stringify({resourceSpans:[{resource:{attributes:[{key:"session.id",value:{stringValue:"e2e"}}]},scopeSpans:[{spans:[{name:"claude_code.tool.blocked_on_user",attributes:[{key:"command",value:{stringValue:cmd}}]}]}]}]}));
')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/traces" \
  -H 'Content-Type: application/json' -d "$BODY")"
[ "$CODE" = "200" ] || fail "long-command traces POST must return 200; got $CODE"
sleep 0.2
grep -q '"boundary_surface":"merge"' "$TRACES_FILE" || fail "receiver must tag boundary_surface at record time (pre-truncation): $(cat "$TRACES_FILE")"
grep -q 'truncated len=' "$TRACES_FILE" || fail "long command attribute must still be capped by sanitize (tag must not disable the cap)"

# 수신기가 위 요청들 후에도 살아 있는가(fail-open 계약) — 종료는 테스트가 한다.
kill -0 "$RECVPID" 2>/dev/null || fail "receiver died while serving (must stay up across bad bodies)"
kill "$RECVPID" 2>/dev/null
wait "$RECVPID" 2>/dev/null
RECVPID=""

# --- 수신기 착지분을 그대로 집계: 기록 시점 태그가 절단을 이기고 merge 제외로 반영되는가(e2e) ---
JSON="$(node "$METRICS" --otel-dir "$TMP/otel" --json)" || fail "otel-metrics --json must exit 0 on receiver output"
printf '%s' "$JSON" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const die = (m) => { console.error(m + ": " + JSON.stringify(j)); process.exit(1); };
  if ((j.h2_excluded_by_surface || {}).merge !== 1) die("long-command merge span must be excluded via record-time tag");
  if (j.h2 !== 0) die("no non-boundary blocked_on_user span was posted — H2 must be 0");
' || fail "record-time boundary tagging did not survive the e2e path: $JSON"

# --- otel-metrics: fixture → H2(경계 제외 반영)·C1·C2 (delta 스트림 — 합산 경로) ---
FIX="$TMP/fix"
mkdir -p "$FIX"
cat > "$FIX/2026-08-09.traces.jsonl" <<'EOF'
{"ts":"2026-08-09T00:00:00Z","kind":"traces","payload":{"resourceSpans":[{"resource":{"attributes":[{"key":"session.id","value":{"stringValue":"s1"}}]},"scopeSpans":[{"spans":[{"name":"claude_code.tool.blocked_on_user","attributes":[{"key":"tool_name","value":{"stringValue":"Bash"}},{"key":"command","value":{"stringValue":"pnpm verify"}}]},{"name":"claude_code.tool.blocked_on_user","attributes":[{"key":"tool_name","value":{"stringValue":"Edit"}}]},{"name":"claude_code.api_request","attributes":[]}]}]}]}}
{"ts":"2026-08-09T00:01:00Z","kind":"traces","payload":{"resourceSpans":[{"resource":{"attributes":[{"key":"session.id","value":{"stringValue":"s1"}}]},"scopeSpans":[{"spans":[{"name":"claude_code.tool.blocked_on_user","attributes":[{"key":"tool_name","value":{"stringValue":"Bash"}},{"key":"command","value":{"stringValue":"gh pr merge 630"}}]}]}]}]}}
EOF
cat > "$FIX/2026-08-09.metrics.jsonl" <<'EOF'
{"ts":"2026-08-09T00:00:00Z","kind":"metrics","payload":{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","sum":{"aggregationTemporality":1,"dataPoints":[{"asDouble":0.3},{"asDouble":0.12}]}},{"name":"claude_code.token.usage","sum":{"aggregationTemporality":1,"dataPoints":[{"asInt":"1200","attributes":[{"key":"type","value":{"stringValue":"input"}}]},{"asInt":"300","attributes":[{"key":"type","value":{"stringValue":"output"}}]}]}}]}]}]}}
{"ts":"2026-08-09T00:02:00Z","kind":"metrics","unparsed":true,"bytes":10}
EOF

JSON="$(node "$METRICS" --otel-dir "$FIX" --json)" || fail "otel-metrics --json must exit 0"
printf '%s' "$JSON" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const die = (m) => { console.error(m + ": " + JSON.stringify(j)); process.exit(1); };
  if (j.h2 !== 2) die("H2 must be 2 (3 blocked_on_user spans - 1 merge-surface excluded)");
  if (j.h2_span_seen !== 3) die("h2_span_seen must count matched spans before exclusion");
  if ((j.h2_by_session || {}).s1 !== 2) die("H2 must be attributable per session.id (병렬 세션 합류 분리)");
  if ((j.h2_excluded_by_surface || {}).merge !== 1) die("merge exclusion must be visible (침묵 제외 금지)");
  if (j.c1_usd !== 0.42) die("C1 must sum delta cost dataPoints to 0.42");
  if ((j.c2_tokens_by_type || {}).input !== 1200 || (j.c2_tokens_by_type || {}).output !== 300) die("C2 must sum tokens by type (asInt string form included)");
  if (j.unparsed_records !== 1) die("unparsed record must be counted, not silently dropped");
' || fail "otel-metrics aggregation wrong: $JSON"

# --- cumulative 스트림(OTLP 기본): 매 export가 러닝 토탈 재전송 — 합산이 아니라 시리즈 최종값 채택 ---
# (무조건 합산이면 아래가 C1=0.75/입력 7500으로 1.9배 과대보고된다 — 3축 리뷰 재현 케이스를 회귀로 고정)
FIX2="$TMP/fix-cumulative"
mkdir -p "$FIX2"
cat > "$FIX2/2026-08-09.metrics.jsonl" <<'EOF'
{"ts":"2026-08-09T01:00:00Z","kind":"metrics","payload":{"resourceMetrics":[{"resource":{"attributes":[{"key":"session.id","value":{"stringValue":"s1"}}]},"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","sum":{"aggregationTemporality":2,"dataPoints":[{"asDouble":0.10,"startTimeUnixNano":"100"}]}},{"name":"claude_code.token.usage","sum":{"aggregationTemporality":2,"dataPoints":[{"asInt":"1000","startTimeUnixNano":"100","attributes":[{"key":"type","value":{"stringValue":"input"}}]}]}}]}]}]}}
{"ts":"2026-08-09T01:01:00Z","kind":"metrics","payload":{"resourceMetrics":[{"resource":{"attributes":[{"key":"session.id","value":{"stringValue":"s1"}}]},"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","sum":{"aggregationTemporality":2,"dataPoints":[{"asDouble":0.25,"startTimeUnixNano":"100"}]}},{"name":"claude_code.token.usage","sum":{"aggregationTemporality":2,"dataPoints":[{"asInt":"2500","startTimeUnixNano":"100","attributes":[{"key":"type","value":{"stringValue":"input"}}]}]}}]}]}]}}
{"ts":"2026-08-09T01:02:00Z","kind":"metrics","payload":{"resourceMetrics":[{"resource":{"attributes":[{"key":"session.id","value":{"stringValue":"s1"}}]},"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","sum":{"aggregationTemporality":2,"dataPoints":[{"asDouble":0.40,"startTimeUnixNano":"100"}]}},{"name":"claude_code.token.usage","sum":{"aggregationTemporality":2,"dataPoints":[{"asInt":"4000","startTimeUnixNano":"100","attributes":[{"key":"type","value":{"stringValue":"input"}}]}]}}]}]}]}}
EOF
JSON="$(node "$METRICS" --otel-dir "$FIX2" --json)" || fail "otel-metrics --json must exit 0 (cumulative)"
printf '%s' "$JSON" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const die = (m) => { console.error(m + ": " + JSON.stringify(j)); process.exit(1); };
  if (j.c1_usd !== 0.4) die("cumulative C1 must be the series last total (0.4), not the batch sum (0.75)");
  if ((j.c2_tokens_by_type || {}).input !== 4000) die("cumulative C2 must be the series last total (4000), not 7500");
' || fail "cumulative temporality handling wrong: $JSON"

# --- 개명 드리프트 엣지: trace는 흐르는데 대상 span 0건 → h2=0 + reason 동반(조용한 0으로 위장 금지) ---
FIX3="$TMP/fix-renamed"
mkdir -p "$FIX3"
cat > "$FIX3/2026-08-09.traces.jsonl" <<'EOF'
{"ts":"2026-08-09T02:00:00Z","kind":"traces","payload":{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"claude_code.api_request","attributes":[]}]}]}]}}
EOF
JSON="$(node "$METRICS" --otel-dir "$FIX3" --json)" || fail "otel-metrics --json must exit 0 (renamed edge)"
printf '%s' "$JSON" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const die = (m) => { console.error(m + ": " + JSON.stringify(j)); process.exit(1); };
  if (j.h2 !== 0) die("traces flowing without the target span must yield h2=0 (numeric)");
  if (!j.h2_reason) die("h2=0 with zero matched spans must carry a reason (rename/no-fire ambiguity must be visible)");
  if (j.h2_span_seen !== 0) die("h2_span_seen must be 0 in the renamed-span edge");
' || fail "renamed-span edge not honest: $JSON"

# --- 빈 디렉토리 → 전 축 INSUFFICIENT_DATA (베타 미활성/수집 0을 조작된 0으로 보고 금지) ---
EMPTY="$TMP/empty"
mkdir -p "$EMPTY"
HUMAN="$(node "$METRICS" --otel-dir "$EMPTY")" || fail "otel-metrics must exit 0 on an empty dir"
printf '%s' "$HUMAN" | grep -q "INSUFFICIENT_DATA" || fail "empty dir must report INSUFFICIENT_DATA, not fabricated zeros: $HUMAN"

echo "PASS: otel-receiver 127.0.0.1-only (source+runtime), OTLP/json landing + fail-open unparsed, otel-metrics H2(경계 제외)/C1/C2 + INSUFFICIENT_DATA"
exit 0
