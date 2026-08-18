#!/usr/bin/env bash
# Regression test for regression-signals (BAC-631) — .loop/runs 원장(BAC-570)의 verdict 이벤트를
# 순수 이력 비교(LLM 판단 0)로 fold해 "한 번 PASS했던 게이트의 FAIL 회귀"를 부상시키고,
# lessons promote가 그 신호를 기존 재발 카운트 [N×]와 시각적으로 구분해 병기하는지 잠근다.
# 원장은 위조 가능(신뢰 경계 — lib/run-ledger.mjs 헤더)이므로 회귀 신호는 승격 *후보 입력*일 뿐
# 자동 승격이 아니다 — 회의적 challenge 게이트는 불변. fold 이디엄은 run-metrics 기반:
# INSUFFICIENT(FAIL-only=증거 부족) 1급, 깨진 줄 skip+카운트. 단 unknown 버킷은 run-metrics와 달리
# fold에 포함한다(런 분모가 없는 게이트 시계열이라 제외 근거가 적용되지 않음 — lib 헤더 계약).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
SIGNALS="$ROOT/tools/loop-engine/bin/regression-signals.mjs"
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$SIGNALS" ] || fail "regression-signals.mjs not found at $SIGNALS"
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# ── T1) PASS 후 FAIL (한 게이트) → 회귀 1건, 필드 정확, 텍스트 REGRESSION 줄 ────────────────
A="$DIR/a"
mkdir -p "$A"
cat > "$A/runA.jsonl" <<'EOF'
{"id":"a1","type":"run.started","ts":"2026-08-08T00:00:00.000Z","aggregate_id":"runA","payload":{},"version":1}
{"id":"a2","type":"verdict.passed","ts":"2026-08-08T00:01:00.000Z","aggregate_id":"runA","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v1.log"},"version":1}
{"id":"a3","type":"verdict.failed","ts":"2026-08-08T00:02:00.000Z","aggregate_id":"runA","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v2.log"},"version":1}
EOF
# 실전 .loop/runs에는 세션 중 `current` 포인터(확장자 없음)가 상존한다 — *.jsonl 필터가 회귀해
# 이 파일을 파싱하면 skipped_lines가 오염된다. fixture에 두고 skipped_lines=0으로 잠근다.
printf 'runA\n' > "$A/current"
JSON="$(node "$SIGNALS" --runs-dir "$A" --json)" || fail "T1 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 1) throw new Error("T1 must detect exactly 1 regression, got " + m.regressions.length);
  if (m.skipped_lines !== 0) throw new Error("T1 the extensionless current pointer must not pollute skipped_lines, got " + m.skipped_lines);
  const r = m.regressions[0];
  if (r.gate !== "pnpm verify") throw new Error("T1 gate must be payload.cmd, got " + r.gate);
  if (r.last_pass_ts !== "2026-08-08T00:01:00.000Z") throw new Error("T1 last_pass_ts wrong: " + r.last_pass_ts);
  if (r.first_fail_ts !== "2026-08-08T00:02:00.000Z") throw new Error("T1 first_fail_ts wrong: " + r.first_fail_ts);
  if (r.fail_count !== 1) throw new Error("T1 fail_count must be 1, got " + r.fail_count);
  if (JSON.stringify(r.runs) !== JSON.stringify(["runA"])) throw new Error("T1 runs attribution wrong: " + JSON.stringify(r.runs));
  if (m.insufficient.length !== 0) throw new Error("T1 insufficient must be empty");
' "$JSON" || fail "T1 regression fields wrong"
OUT="$(node "$SIGNALS" --runs-dir "$A")"; rc=$?
[ "$rc" = "0" ] || fail "T1 text mode must exit 0, got $rc"
printf '%s' "$OUT" | grep -q "=== GATE REGRESSIONS ===" || fail "T1 text output must open with the block marker"
printf '%s' "$OUT" | grep -q "REGRESSION: pnpm verify PASS→FAIL" || fail "T1 text output must show the REGRESSION line, got: $OUT"
echo "PASS: T1 PASS→FAIL is detected with exact gate/ts/count/run attribution"

# ── T1b) 게이트 키 정규화 — 직접 실행("pnpm verify")과 loop-fix 경로("sh -c pnpm verify")는 같은
#         게이트다. raw cmd 비교는 정체성을 쪼개 경로 교차 PASS→FAIL을 놓친다(리뷰 실측). ────────
N="$DIR/norm"
mkdir -p "$N"
cat > "$N/runN.jsonl" <<'EOF'
{"id":"n1","type":"verdict.passed","ts":"2026-08-08T00:10:00.000Z","aggregate_id":"runN","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
{"id":"n2","type":"verdict.failed","ts":"2026-08-08T00:11:00.000Z","aggregate_id":"runN","payload":{"verdict":"FAIL","exit":1,"cmd":"sh -c pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$N" --json)" || fail "T1b --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 1) throw new Error("T1b cross-path PASS→FAIL must fold to ONE gate identity, got " + JSON.stringify(m));
  if (m.regressions[0].gate !== "pnpm verify") throw new Error("T1b gate key must be normalized (sh -c stripped), got " + m.regressions[0].gate);
  if (m.insufficient.length !== 0) throw new Error("T1b normalization must not leave a split insufficient bucket, got " + JSON.stringify(m.insufficient));
' "$JSON" || fail "T1b gate-key normalization wrong"
# record --gate도 같은 정규화를 거쳐 교차 참조 키가 일치해야 한다(lessons 쪽 표면).
LDIRN="$DIR/lessons-norm"
node "$LESSONS" record --signature "FAIL: norm cross-ref" --verified --gate "sh -c pnpm verify" --lessons "$LDIRN" >/dev/null || fail "T1b record --gate failed"
node "$LESSONS" record --signature "FAIL: norm cross-ref" --verified --lessons "$LDIRN" >/dev/null
node "$LESSONS" record --signature "FAIL: norm cross-ref" --verified --lessons "$LDIRN" >/dev/null
PNORM="$(node "$LESSONS" promote --runs "$N" --lessons "$LDIRN" 2>/dev/null)" || fail "T1b promote --runs must exit 0"
printf '%s' "$PNORM" | grep -q "\[REGRESSION: pnpm verify PASS→FAIL" || fail "T1b record --gate 'sh -c pnpm verify' must cross-reference the normalized gate, got: $PNORM"
echo "PASS: T1b gate identity converges across call paths (sh -c wrapper normalized, both surfaces)"

# ── T2) FAIL 후 PASS (복구) → 회귀 0건 (현재 상태 기준) ─────────────────────────────────────
B="$DIR/b"
mkdir -p "$B"
cat > "$B/runB.jsonl" <<'EOF'
{"id":"b1","type":"verdict.failed","ts":"2026-08-08T01:00:00.000Z","aggregate_id":"runB","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
{"id":"b2","type":"verdict.passed","ts":"2026-08-08T01:01:00.000Z","aggregate_id":"runB","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$B" --json)" || fail "T2 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 0) throw new Error("T2 recovered gate must not be a regression");
  if (m.insufficient.length !== 0) throw new Error("T2 recovered gate has a PASS on record — not insufficient");
' "$JSON" || fail "T2 recovery must not report a regression"
echo "PASS: T2 FAIL→PASS recovery is not a regression"

# ── T2b) PASS→FAIL→PASS (회귀 후 복구) → 회귀 0건 — "마지막 PASS" 앵커링 잠금(첫 PASS 앵커링
#         변이는 복구된 게이트에 fails를 날조한다 — 리뷰 변이 시뮬레이션) ─────────────────────
B2="$DIR/b2"
mkdir -p "$B2"
cat > "$B2/runB2.jsonl" <<'EOF'
{"id":"b21","type":"verdict.passed","ts":"2026-08-08T01:10:00.000Z","aggregate_id":"runB2","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
{"id":"b22","type":"verdict.failed","ts":"2026-08-08T01:11:00.000Z","aggregate_id":"runB2","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
{"id":"b23","type":"verdict.passed","ts":"2026-08-08T01:12:00.000Z","aggregate_id":"runB2","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$B2" --json)" || fail "T2b --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 0) throw new Error("T2b PASS→FAIL→PASS must anchor on the LAST pass (recovered), got " + JSON.stringify(m.regressions));
  if (m.insufficient.length !== 0) throw new Error("T2b recovered gate has PASSes on record — not insufficient");
' "$JSON" || fail "T2b recovery-after-regression must not report a regression"
echo "PASS: T2b PASS→FAIL→PASS anchors on the last PASS (no fabricated fails)"

# ── T3) FAIL만 존재 → 회귀 0 + insufficient 등재 (frugality — 조작 PASS 대신 증거 부족) ─────
C="$DIR/c"
mkdir -p "$C"
cat > "$C/runC.jsonl" <<'EOF'
{"id":"c1","type":"verdict.failed","ts":"2026-08-08T02:00:00.000Z","aggregate_id":"runC","payload":{"verdict":"FAIL","exit":1,"cmd":"verify:rls","log":"/tmp/v.log"},"version":1}
{"id":"c2","type":"verdict.failed","ts":"2026-08-08T02:01:00.000Z","aggregate_id":"runC","payload":{"verdict":"FAIL","exit":1,"cmd":"verify:rls","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$C" --json)" || fail "T3 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 0) throw new Error("T3 FAIL-only gate must not be a regression (never proven)");
  if (JSON.stringify(m.insufficient) !== JSON.stringify(["verify:rls"])) throw new Error("T3 FAIL-only gate must be insufficient, got " + JSON.stringify(m.insufficient));
' "$JSON" || fail "T3 FAIL-only must be insufficient, not regression"
OUT="$(node "$SIGNALS" --runs-dir "$C")"
printf '%s' "$OUT" | grep -q "insufficient (no PASS on record): verify:rls" || fail "T3 text output must name the insufficient gate, got: $OUT"
echo "PASS: T3 FAIL-only history is INSUFFICIENT (first-class), never a fabricated regression"

# ── T4) 여러 run 파일·파일명 순서가 ts 역순 → (ts,id) 정렬 판정 + 2회 실행 결정론 ──────────
D="$DIR/d"
mkdir -p "$D"
# 파일명 사전순(aaa < zzz)이 시간순과 반대: FAIL이 파일상 먼저 읽히지만 ts는 나중이다.
cat > "$D/aaa-late-fail.jsonl" <<'EOF'
{"id":"d2","type":"verdict.failed","ts":"2026-08-08T03:05:00.000Z","aggregate_id":"aaa-late-fail","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
cat > "$D/zzz-early-pass.jsonl" <<'EOF'
{"id":"d1","type":"verdict.passed","ts":"2026-08-08T03:00:00.000Z","aggregate_id":"zzz-early-pass","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$D" --json)" || fail "T4 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 1) throw new Error("T4 must detect the regression regardless of file order");
  const r = m.regressions[0];
  if (r.last_pass_ts !== "2026-08-08T03:00:00.000Z" || r.first_fail_ts !== "2026-08-08T03:05:00.000Z")
    throw new Error("T4 must order by (ts,id), not file order: " + JSON.stringify(r));
  if (JSON.stringify(r.runs) !== JSON.stringify(["aaa-late-fail"])) throw new Error("T4 failing run attribution wrong: " + JSON.stringify(r.runs));
' "$JSON" || fail "T4 (ts,id) ordering wrong"
OUT1="$(node "$SIGNALS" --runs-dir "$D")"
OUT2="$(node "$SIGNALS" --runs-dir "$D")"
[ "$OUT1" = "$OUT2" ] || fail "T4 two invocations must produce byte-identical output (determinism)"
echo "PASS: T4 cross-file (ts,id) ordering + byte-identical reruns (deterministic)"

# ── T4b) 다중 게이트 교차 판별 — 한 원장에 회귀 게이트와 건강 게이트가 섞여도 귀속이 정확해야
#         한다(게이트 버킷을 병합하는 변이는 건강 게이트에 회귀를 날조 — 리뷰 변이 시뮬레이션) ──
G="$DIR/g"
mkdir -p "$G"
cat > "$G/runG.jsonl" <<'EOF'
{"id":"g1","type":"verdict.passed","ts":"2026-08-08T03:10:00.000Z","aggregate_id":"runG","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
{"id":"g2","type":"verdict.passed","ts":"2026-08-08T03:11:00.000Z","aggregate_id":"runG","payload":{"verdict":"PASS","exit":0,"cmd":"verify:rls","log":"/tmp/v.log"},"version":1}
{"id":"g3","type":"verdict.failed","ts":"2026-08-08T03:12:00.000Z","aggregate_id":"runG","payload":{"verdict":"FAIL","exit":1,"cmd":"verify:rls","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$G" --json)" || fail "T4b --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 1) throw new Error("T4b exactly the regressed gate must surface, got " + JSON.stringify(m.regressions));
  if (m.regressions[0].gate !== "verify:rls") throw new Error("T4b regression must attribute to verify:rls, got " + m.regressions[0].gate);
  if (m.insufficient.length !== 0) throw new Error("T4b the healthy gate must not appear anywhere, got " + JSON.stringify(m.insufficient));
' "$JSON" || fail "T4b multi-gate attribution wrong"
echo "PASS: T4b mixed-gate ledger attributes the regression to the right gate only"

# ── T5) 손상 줄·비-verdict type·version=2·cmd 결손 → throw 없이 skip+카운트, 정상분만 집계 ──
E="$DIR/e"
mkdir -p "$E"
{
  printf '{"id":"e0","type":"run.started","ts":"2026-08-08T04:00:00.000Z","aggregate_id":"runE","payload":{},"version":1}\n'
  printf 'this line is not json {{{\n'
  printf '{"id":"e1","type":"verdict.passed","ts":"2026-08-08T04:01:00.000Z","aggregate_id":"runE","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}\n'
  printf '{"id":"e2","type":"verdict.passed","ts":"2026-08-08T04:02:00.000Z","aggregate_id":"runE","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":2}\n'
  printf '{"id":"e3","type":"verdict.failed","ts":"2026-08-08T04:03:00.000Z","aggregate_id":"runE","payload":{},"version":1}\n'
  printf '{"id":"e4","type":"verdict.exploded","ts":"2026-08-08T04:04:00.000Z","aggregate_id":"runE","payload":{"cmd":"pnpm verify"},"version":1}\n'
  printf '{"id":"e5","type":"verdict.failed","ts":"2026-08-08T04:05:00.000Z","aggregate_id":"runE","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}\n'
} > "$E/runE.jsonl"
JSON="$(node "$SIGNALS" --runs-dir "$E" --json)" || fail "T5 corrupt ledger must not kill the fold"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.skipped_lines !== 1) throw new Error("T5 skipped_lines must be 1, got " + m.skipped_lines);
  if (m.skipped_events !== 3) throw new Error("T5 skipped_events (version=2, cmd missing, unknown verdict subtype) must be 3, got " + m.skipped_events);
  if (m.regressions.length !== 1) throw new Error("T5 valid events around corruption must still fold to 1 regression");
  if (m.regressions[0].fail_count !== 1) throw new Error("T5 only the valid FAIL counts, got " + m.regressions[0].fail_count);
' "$JSON" || fail "T5 fail-soft skip counting wrong"
echo "PASS: T5 corrupt/contract-violating events are skipped and counted, never thrown"

# ── T5b) unknown 버킷(런 귀속 불가 verdict)은 fold **포함** + 카운터 보고 — 세션내 PASS 후
#         세션밖 FAIL(pre-push 훅·run.ended 후 = unknown 착지, run-ledger 명시 경로)은 진짜
#         회귀다. run-metrics식 제외는 런 분모 왜곡 방지 근거라 이 fold엔 적용되지 않는다. ─────
U="$DIR/u"
mkdir -p "$U"
cat > "$U/runU.jsonl" <<'EOF'
{"id":"u1","type":"verdict.passed","ts":"2026-08-08T05:00:00.000Z","aggregate_id":"runU","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
cat > "$U/unknown.jsonl" <<'EOF'
{"id":"u2","type":"verdict.failed","ts":"2026-08-08T05:01:00.000Z","aggregate_id":"unknown","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
{"id":"u3","type":"verdict.failed","ts":"2026-08-08T05:02:00.000Z","aggregate_id":"unknown","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":1}
EOF
JSON="$(node "$SIGNALS" --runs-dir "$U" --json)" || fail "T5b unknown-bucket fold must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.unknown_verdict_events !== 2) throw new Error("T5b unattributed verdicts must be counted, got " + m.unknown_verdict_events);
  if (m.regressions.length !== 1) throw new Error("T5b in-session PASS then out-of-session FAIL IS a regression — unknown must fold, got " + JSON.stringify(m.regressions));
  const r = m.regressions[0];
  if (r.fail_count !== 2) throw new Error("T5b both unknown FAILs must count, got " + r.fail_count);
  if (!r.runs.includes("unknown")) throw new Error("T5b runs attribution must expose the unknown bucket, got " + JSON.stringify(r.runs));
' "$JSON" || fail "T5b unknown bucket must fold as gate evidence (counter stays visible)"
echo "PASS: T5b unknown bucket folds as gate evidence, reported via counter + runs attribution"

# ── T6) runs 디렉토리 부재/빈 디렉토리 → exit 0, 회귀 0, 크래시 없음 ────────────────────────
OUT="$(node "$SIGNALS" --runs-dir "$DIR/does-not-exist")"; rc=$?
[ "$rc" = "0" ] || fail "T6 missing dir must exit 0, got $rc"
printf '%s' "$OUT" | grep -q "=== GATE REGRESSIONS ===" || fail "T6 missing dir must still print the block"
EMPTY="$DIR/empty"
mkdir -p "$EMPTY"
JSON="$(node "$SIGNALS" --runs-dir "$EMPTY" --json)" || fail "T6 empty dir --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.regressions.length !== 0 || m.insufficient.length !== 0) throw new Error("T6 empty ledger must report nothing");
' "$JSON" || fail "T6 empty ledger must fold to nothing"
echo "PASS: T6 missing/empty runs dir is handled without crash, exit 0"

# ── T7) lessons record --gate ×3 → promote --runs: [3×] 카운트와 [REGRESSION:] 줄이 구분 병기 ─
LDIR="$DIR/lessons7"
for i in 1 2 3; do
  node "$LESSONS" record --signature "FAIL: rls policy missing on tenant table" --verified \
    --fix "add pgPolicy + FORCE" --title "rls policy fix" --gate "pnpm verify" --lessons "$LDIR" >/dev/null \
    || fail "T7 record #$i failed"
done
ID_PLAIN="$(node "$LESSONS" promote --lessons "$LDIR" 2>/dev/null | grep -oE '[0-9a-f]{16}' | head -1)"
[ -n "$ID_PLAIN" ] || fail "T7 could not extract lesson id from plain promote output"
POUT="$(node "$LESSONS" promote --runs "$A" --lessons "$LDIR" 2>/dev/null)" || fail "T7 promote --runs must exit 0"
printf '%s' "$POUT" | grep -q "\[3×\]" || fail "T7 recurrence count [3×] must stay, got: $POUT"
printf '%s' "$POUT" | grep -q "\[REGRESSION: pnpm verify PASS→FAIL" || fail "T7 candidate must carry a distinct [REGRESSION:] line, got: $POUT"
printf '%s' "$POUT" | grep -q "gate regressions (deterministic" || fail "T7 independent regression section must appear, got: $POUT"
# 기존 소비자 계약: promote 출력의 첫 16-hex 토큰은 여전히 후보 lesson id다 (retire 테스트의 추출 방식).
ID_RUNS="$(printf '%s' "$POUT" | grep -oE '[0-9a-f]{16}' | head -1)"
[ "$ID_RUNS" = "$ID_PLAIN" ] || fail "T7 first 16-hex token must still be the candidate id (got $ID_RUNS want $ID_PLAIN)"
echo "PASS: T7 promote --runs carries [N×] and [REGRESSION:] as visually distinct signals"

# ── T8) gate_history 없는 구형 lesson → 전 명령 종전 동작 + REGRESSION 병기 없음(하위호환) ──
LDIR8="$DIR/lessons8"
mkdir -p "$LDIR8"
cat > "$LDIR8/0123456789abcdef.json" <<'EOF'
{
  "id": "0123456789abcdef",
  "signature": ["legacy failure line"],
  "title": "legacy lesson without gate_history",
  "fix": "legacy fix",
  "source": "manual",
  "verified": true,
  "count": 3,
  "iterations": [2],
  "first_seen": "2026-01-01T00:00:00.000Z",
  "last_seen": "2026-01-02T00:00:00.000Z"
}
EOF
SOUT="$(node "$LESSONS" stats --lessons "$LDIR8")" || fail "T8 stats on legacy lesson must exit 0"
printf '%s' "$SOUT" | grep -q "total=1 verified=1" || fail "T8 stats must read the legacy lesson, got: $SOUT"
node "$LESSONS" record --signature "FAIL: fresh failure" --verified --lessons "$LDIR8" >/dev/null || fail "T8 record without --gate must work"
ROUT="$(node "$LESSONS" recall --signature "FAIL: fresh failure" --lessons "$LDIR8" 2>/dev/null)" || fail "T8 recall must exit 0"
printf '%s' "$ROUT" | grep -q "Past lesson" || fail "T8 recall must behave as before, got: $ROUT"
POUT8="$(node "$LESSONS" promote --runs "$A" --lessons "$LDIR8" 2>/dev/null)" || fail "T8 promote --runs must exit 0"
printf '%s' "$POUT8" | grep -q "0123456789abcdef" || fail "T8 legacy candidate must still list, got: $POUT8"
printf '%s' "$POUT8" | grep -q "\[REGRESSION:" && fail "T8 legacy lesson (no gate_history) must not get a [REGRESSION:] line, got: $POUT8"
echo "PASS: T8 legacy lessons (no gate_history) keep prior behavior across commands"

# ── T9) promote (--runs 미지정) → 기존 출력 그대로 (회귀 섹션·REGRESSION 줄 0건) ────────────
POUT9="$(node "$LESSONS" promote --lessons "$LDIR" 2>/dev/null)" || fail "T9 plain promote must exit 0"
printf '%s' "$POUT9" | grep -q "REGRESSION" && fail "T9 promote without --runs must not mention REGRESSION, got: $POUT9"
printf '%s' "$POUT9" | grep -q "gate regressions" && fail "T9 promote without --runs must not print the regression section, got: $POUT9"
printf '%s' "$POUT9" | grep -q "\[3×\]" || fail "T9 plain promote must keep the legacy format, got: $POUT9"
echo "PASS: T9 promote without --runs is byte-compatible with the legacy format"

# ── T10) promote --runs <부재 원장> → stderr 경고 1줄 + 본연 listing 정상 (fail-open) ───────
ERRF="$DIR/t10.stderr"
POUT10="$(node "$LESSONS" promote --runs "$DIR/no-such-ledger" --lessons "$LDIR" 2>"$ERRF")" || fail "T10 promote with missing ledger must exit 0"
grep -q "회귀 신호 없이 진행" "$ERRF" || fail "T10 must warn on stderr about the unreadable ledger, got: $(cat "$ERRF")"
printf '%s' "$POUT10" | grep -q "\[3×\]" || fail "T10 listing must stay intact (fail-open), got: $POUT10"
printf '%s' "$POUT10" | grep -q "\[REGRESSION:" && fail "T10 must not fabricate regression lines without a ledger, got: $POUT10"
echo "PASS: T10 unreadable ledger warns on stderr and never breaks the promote listing"

# ── T11) 위조 게이트명("constructor")·"__proto__" — 프로토타입 체인 오귀속/무음 유실 차단 ──────
#   원장은 위조 가능(신뢰 경계) — 이 코드의 몫은 거짓 출력을 안 만드는 것: truthy 검사는
#   Object.prototype을 타고 gate_history 없는 후보 전원에 허위 [REGRESSION:] 줄을 붙인다(리뷰 실측).
P="$DIR/p"
mkdir -p "$P"
cat > "$P/runP.jsonl" <<'EOF'
{"id":"p1","type":"verdict.passed","ts":"2026-08-08T06:00:00.000Z","aggregate_id":"runP","payload":{"verdict":"PASS","exit":0,"cmd":"constructor","log":"/tmp/v.log"},"version":1}
{"id":"p2","type":"verdict.failed","ts":"2026-08-08T06:01:00.000Z","aggregate_id":"runP","payload":{"verdict":"FAIL","exit":1,"cmd":"constructor","log":"/tmp/v.log"},"version":1}
EOF
LDIRP="$DIR/lessons-proto"
for i in 1 2 3; do
  node "$LESSONS" record --signature "FAIL: no gate attribution here" --verified --lessons "$LDIRP" >/dev/null || fail "T11 record #$i failed"
done
POUTP="$(node "$LESSONS" promote --runs "$P" --lessons "$LDIRP" 2>/dev/null)" || fail "T11 promote --runs must exit 0"
printf '%s' "$POUTP" | grep -q "\[REGRESSION: constructor" && fail "T11 candidate WITHOUT gate_history must never get a per-candidate line via the prototype chain, got: $POUTP"
printf '%s' "$POUTP" | grep -q "REGRESSION: constructor" || fail "T11 the independent section must still surface the forged-name regression, got: $POUTP"
# record --gate "__proto__"의 일반 대입은 프로토타입 세터를 타 무음 유실된다 — own property로 남아야 한다.
node "$LESSONS" record --signature "FAIL: proto gate lesson" --verified --gate "__proto__" --lessons "$LDIRP" >/dev/null || fail "T11 record --gate proto #1 failed"
node "$LESSONS" record --signature "FAIL: proto gate lesson" --verified --gate "__proto__" --lessons "$LDIRP" >/dev/null || fail "T11 record --gate proto #2 failed"
node -e '
  const { readdirSync, readFileSync } = require("node:fs");
  const dir = process.argv[1];
  let found = false;
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const l = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    if (l.gate_history && Object.hasOwn(l.gate_history, "__proto__") && l.gate_history["__proto__"].count === 2) found = true;
  }
  if (!found) throw new Error("T11 __proto__ gate attribution must persist as an OWN property with count=2");
' "$LDIRP" || fail "T11 __proto__ gate_history entry lost (prototype setter)"
echo "PASS: T11 forged gate names cannot false-attribute (hasOwn) and __proto__ records persist"

# ── T12) 후보 0건 + 회귀 존재 → 독립 섹션은 그래도 나온다 (lesson 미귀속 회귀 표면화 — AC 취지) ─
LDIR12="$DIR/lessons-empty"
mkdir -p "$LDIR12"
POUT12="$(node "$LESSONS" promote --runs "$A" --lessons "$LDIR12" 2>/dev/null)" || fail "T12 promote must exit 0"
printf '%s' "$POUT12" | grep -q "no open recurring" || fail "T12 empty pool line must stay, got: $POUT12"
printf '%s' "$POUT12" | grep -q "gate regressions (deterministic" || fail "T12 regression section must surface even with zero candidates, got: $POUT12"
echo "PASS: T12 zero-candidate promote still surfaces the regression section"

# ── T13) 계약 위반 원장(version 전량 불일치) → promote가 부분 결손을 stderr로 병기 — 손상 원장이
#         '회귀 없음'과 byte-identical해지는 무음 무력화 차단(리뷰 실측) ────────────────────────
V="$DIR/v"
mkdir -p "$V"
cat > "$V/runV.jsonl" <<'EOF'
{"id":"v1","type":"verdict.passed","ts":"2026-08-08T07:00:00.000Z","aggregate_id":"runV","payload":{"verdict":"PASS","exit":0,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":2}
{"id":"v2","type":"verdict.failed","ts":"2026-08-08T07:01:00.000Z","aggregate_id":"runV","payload":{"verdict":"FAIL","exit":1,"cmd":"pnpm verify","log":"/tmp/v.log"},"version":2}
EOF
ERRF13="$DIR/t13.stderr"
POUT13="$(node "$LESSONS" promote --runs "$V" --lessons "$LDIR" 2>"$ERRF13")" || fail "T13 promote must stay exit 0 (fail-open)"
grep -q "부분 결손" "$ERRF13" || fail "T13 dropped-event counters must surface on stderr, got: $(cat "$ERRF13")"
grep -q "skipped_events=2" "$ERRF13" || fail "T13 the warning must carry the counts, got: $(cat "$ERRF13")"
printf '%s' "$POUT13" | grep -q "\[3×\]" || fail "T13 listing must stay intact, got: $POUT13"
echo "PASS: T13 a contract-violating ledger is loudly distinguishable from a healthy no-regression one"

echo "PASS: regression-signals — deterministic PASS→FAIL detection + promote signal wiring (BAC-631)"
exit 0
