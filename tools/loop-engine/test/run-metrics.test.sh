#!/usr/bin/env bash
# Regression test for run-metrics.mjs + boundary-surfaces.mjs (BAC-570 H1·Q1·Q2 fold 집계).
#
# H1은 merge/deploy/send 경계 표면을 제외하고 센다(제외 목록 = lib/boundary-surfaces.mjs 단일
# 소스, AC "제외 목록 코드 명시") — 제외하지 않으면 "사람 개입 줄이기" 최적화가 우리가 지키기로
# 한 사람-승인 경계(ADR-0061 §5) 자체를 깎는다. 결손 축은 조작된 PASS 대신 INSUFFICIENT_DATA를
# 1급 결과로 낸다(frugality proof). 파싱은 줄 단위 fail-soft(깨진 줄 skip + 카운트 보고).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
METRICS="$ROOT/tools/loop-engine/bin/run-metrics.mjs"
SURFACES="$ROOT/tools/loop-engine/lib/boundary-surfaces.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$METRICS" ] || fail "run-metrics.mjs not found at $METRICS"
[ -f "$SURFACES" ] || fail "boundary-surfaces.mjs not found at $SURFACES"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# ── 0) 제외 목록이 코드에 명시 — merge/deploy/send 전부 + 판정 함수 행위 ────────────────────
node -e '
  const { pathToFileURL } = require("node:url");
  import(pathToFileURL(process.argv[1]).href).then((m) => {
    const surfaces = new Set(m.H1_EXCLUDED_SURFACES.map((r) => r.surface));
    for (const s of ["merge", "deploy", "send"])
      if (!surfaces.has(s)) throw new Error("H1 exclusion list must name surface: " + s);
    if (m.boundarySurface("Bash", "gh pr merge 7") !== "merge") throw new Error("gh pr merge must classify as merge");
    if (m.boundarySurface("Bash", "pnpm run redeploy") !== "deploy") throw new Error("pnpm run redeploy must classify as deploy");
    if (m.boundarySurface("Bash", "curl -X POST /alimtalk-send") !== "send") throw new Error("alimtalk path must classify as send");
    if (m.boundarySurface("Bash", "ls -la") !== null) throw new Error("plain command must be null");
    if (m.boundarySurface("Bash", undefined) !== null) throw new Error("non-string command must be null");
  }).catch((e) => { console.error(e.message); process.exit(1); });
' "$SURFACES" || fail "H1 exclusion list must be code-explicit with merge/deploy/send"
echo "PASS: boundary-surfaces exclusion list is code-explicit (merge/deploy/send)"

# ── 픽스처: 런 A(개입 3 중 1 merge 제외, verdict fail→pass) + 런 B(개입 0, first-pass) ──────
AB="$DIR/ab"
mkdir -p "$AB"
cat > "$AB/runA.jsonl" <<'EOF'
{"id":"a1","type":"run.started","ts":"2026-08-08T00:00:00.000Z","aggregate_id":"runA","payload":{},"version":1}
{"id":"a2","type":"permission.requested","ts":"2026-08-08T00:01:00.000Z","aggregate_id":"runA","payload":{"surface":null},"version":1}
{"id":"a3","type":"permission.requested","ts":"2026-08-08T00:02:00.000Z","aggregate_id":"runA","payload":{"surface":"merge"},"version":1}
{"id":"a4","type":"permission.requested","ts":"2026-08-08T00:03:00.000Z","aggregate_id":"runA","payload":{"surface":null},"version":1}
{"id":"a5","type":"verdict.failed","ts":"2026-08-08T00:04:00.000Z","aggregate_id":"runA","payload":{},"version":1}
{"id":"a6","type":"verdict.passed","ts":"2026-08-08T00:05:00.000Z","aggregate_id":"runA","payload":{},"version":1}
EOF
cat > "$AB/runB.jsonl" <<'EOF'
{"id":"b1","type":"run.started","ts":"2026-08-08T01:00:00.000Z","aggregate_id":"runB","payload":{},"version":1}
{"id":"b2","type":"verdict.passed","ts":"2026-08-08T01:01:00.000Z","aggregate_id":"runB","payload":{},"version":1}
EOF

# ── 1+2) 런별 H1/Q2/first-pass + 전체 Q1 = 1/2 ─────────────────────────────────────────────
JSON="$(node "$METRICS" --runs-dir "$AB" --json)" || fail "run-metrics --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  const runA = m.runs.find((r) => r.run_id === "runA");
  const runB = m.runs.find((r) => r.run_id === "runB");
  if (!runA || !runB) throw new Error("both fixture runs must appear");
  if (runA.h1 !== 2) throw new Error("runA H1 must be 2 (1 merge prompt excluded), got " + runA.h1);
  if (runA.q2 !== 2) throw new Error("runA Q2 must be 2, got " + runA.q2);
  if (runA.first_pass !== false) throw new Error("runA first_pass must be false (first verdict failed)");
  if (runB.h1 !== 0) throw new Error("runB H1 must be 0, got " + runB.h1);
  if (runB.q2 !== 1) throw new Error("runB Q2 must be 1, got " + runB.q2);
  if (runB.first_pass !== true) throw new Error("runB first_pass must be true");
  if (m.overall.q1.ratio !== 0.5) throw new Error("overall Q1 must be 0.5 (1/2), got " + JSON.stringify(m.overall.q1));
  if (m.overall.excluded_by_surface.merge !== 1) throw new Error("excluded merge count must be 1");
' "$JSON" || fail "H1/Q1/Q2 fold values wrong"
echo "PASS: per-run H1/Q2/first-pass and overall Q1 fold correctly (merge excluded from H1)"

# ── 3) run.started 없는 런 → 그 런의 H1 = INSUFFICIENT_DATA (계측 마커 부재) ────────────────
C="$DIR/c"
mkdir -p "$C"
cat > "$C/runC.jsonl" <<'EOF'
{"id":"c1","type":"verdict.passed","ts":"2026-08-08T02:00:00.000Z","aggregate_id":"runC","payload":{},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$C" --json)" || fail "run-metrics on uninstrumented run must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  const runC = m.runs.find((r) => r.run_id === "runC");
  if (runC.h1 !== "INSUFFICIENT_DATA") throw new Error("uninstrumented run H1 must be INSUFFICIENT_DATA, got " + runC.h1);
  if (m.overall.h1_mean !== "INSUFFICIENT_DATA") throw new Error("overall H1 with 0 instrumented runs must be INSUFFICIENT_DATA");
  if (runC.q2 !== 1) throw new Error("uninstrumented run still counts Q2, got " + runC.q2);
' "$JSON" || fail "missing instrumentation marker must yield INSUFFICIENT_DATA H1"
echo "PASS: runs without run.started report H1=INSUFFICIENT_DATA (no fabricated zero)"

# ── 4) 빈 디렉토리 → 전 지표 INSUFFICIENT_DATA + exit 0 ────────────────────────────────────
E="$DIR/e"
mkdir -p "$E"
OUT="$(node "$METRICS" --runs-dir "$E")"; rc=$?
[ "$rc" = "0" ] || fail "empty runs dir must exit 0, got $rc"
printf '%s' "$OUT" | grep -q "INSUFFICIENT_DATA" || fail "empty dir must report INSUFFICIENT_DATA, got: $OUT"
JSON="$(node "$METRICS" --runs-dir "$E" --json)" || fail "empty dir --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.overall.h1_mean !== "INSUFFICIENT_DATA") throw new Error("empty H1 must be INSUFFICIENT_DATA");
  if (m.overall.q1 !== "INSUFFICIENT_DATA") throw new Error("empty Q1 must be INSUFFICIENT_DATA");
  if (m.overall.q2_mean !== "INSUFFICIENT_DATA") throw new Error("empty Q2 must be INSUFFICIENT_DATA");
' "$JSON" || fail "empty ledger must be all INSUFFICIENT_DATA"
echo "PASS: empty ledger reports INSUFFICIENT_DATA on every axis, exit 0"

# ── 5) 깨진 JSONL 줄 fail-soft — skip 카운트 + 나머지 정상 집계 ─────────────────────────────
B="$DIR/b"
mkdir -p "$B"
{
  printf '{"id":"d1","type":"run.started","ts":"2026-08-08T03:00:00.000Z","aggregate_id":"runD","payload":{},"version":1}\n'
  printf 'this line is not json {{{\n'
  printf '{"id":"d2","type":"verdict.passed","ts":"2026-08-08T03:01:00.000Z","aggregate_id":"runD","payload":{},"version":1}\n'
} > "$B/runD.jsonl"
JSON="$(node "$METRICS" --runs-dir "$B" --json)" || fail "corrupt line must not kill aggregation"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.overall.skipped_lines !== 1) throw new Error("skipped_lines must be 1, got " + m.overall.skipped_lines);
  const runD = m.runs.find((r) => r.run_id === "runD");
  if (runD.h1 !== 0 || runD.q2 !== 1) throw new Error("valid lines around corruption must still aggregate");
' "$JSON" || fail "corrupt-line fail-soft aggregation wrong"
echo "PASS: corrupt ledger lines are skipped, counted, and do not kill the fold"

# ── 5b) unknown 버킷은 overall 집계에서 제외 — 별도 행+카운터로만 보고 ──────────────────────
# unknown.jsonl은 귀속 불가 verdict가 시간 무제한 누적되는 의사-런이다 — 1개 런으로 산입하면
# Q1 분모를 영구 희석하고 Q2 평균에 극단값을 싣는다(리뷰 실측: 진짜 Q1=1/1이 0.50으로 보고).
U="$DIR/u"
mkdir -p "$U"
cp "$AB/runB.jsonl" "$U/runB.jsonl"
cat > "$U/unknown.jsonl" <<'EOF'
{"id":"u1","type":"verdict.failed","ts":"2026-08-08T04:00:00.000Z","aggregate_id":"unknown","payload":{},"version":1}
{"id":"u2","type":"verdict.failed","ts":"2026-08-08T04:01:00.000Z","aggregate_id":"unknown","payload":{},"version":1}
{"id":"u3","type":"verdict.failed","ts":"2026-08-08T04:02:00.000Z","aggregate_id":"unknown","payload":{},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$U" --json)" || fail "unknown-bucket fold must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (!m.runs.find((r) => r.run_id === "unknown")) throw new Error("unknown bucket must still appear as a per-run row");
  if (m.overall.q1.ratio !== 1) throw new Error("overall Q1 must exclude the unknown pseudo-run (want 1/1), got " + JSON.stringify(m.overall.q1));
  if (m.overall.verdict_runs !== 1) throw new Error("verdict_runs must exclude unknown, got " + m.overall.verdict_runs);
  if (m.overall.q2_mean !== 1) throw new Error("Q2 mean must exclude the unknown accumulator, got " + m.overall.q2_mean);
  if (m.overall.unknown_verdict_events !== 3) throw new Error("unattributed verdicts must be counted separately, got " + m.overall.unknown_verdict_events);
' "$JSON" || fail "unknown bucket must not dilute overall Q1/Q2"
echo "PASS: unknown bucket is visible but excluded from overall aggregates"

# ── 5c) 파일 단위 읽기 실패도 침묵 탈락 금지 — skipped_files 카운트 ─────────────────────────
FD="$DIR/fd"
mkdir -p "$FD"
cp "$AB/runB.jsonl" "$FD/runB.jsonl"
cp "$AB/runB.jsonl" "$FD/runX.jsonl"
chmod 000 "$FD/runX.jsonl"
JSON="$(node "$METRICS" --runs-dir "$FD" --json)"; rc=$?
chmod 644 "$FD/runX.jsonl"
[ "$rc" = "0" ] || fail "unreadable run file must not kill aggregation"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.overall.skipped_files !== 1) throw new Error("unreadable file must be counted in skipped_files, got " + m.overall.skipped_files);
  if (m.overall.runs !== 1) throw new Error("readable runs must still aggregate, got " + m.overall.runs);
' "$JSON" || fail "file-level loss must be visible (no silent drop)"
echo "PASS: unreadable run files are counted, not silently dropped"

# ── 6+7) 텍스트 출력 — 블록 마커 + 제외 내역 표시(침묵 제외 금지) ───────────────────────────
OUT="$(node "$METRICS" --runs-dir "$AB")"; rc=$?
[ "$rc" = "0" ] || fail "text mode must exit 0, got $rc"
printf '%s' "$OUT" | grep -q "=== RUN METRICS ===" || fail "text output must open with the block marker"
printf '%s' "$OUT" | grep -q "excluded_by_surface" || fail "text output must show the exclusion breakdown"
printf '%s' "$OUT" | grep -q "merge=1" || fail "text output must show merge exclusion count, got: $OUT"
echo "PASS: text output shows the metrics block and per-surface exclusion breakdown"

# ── 8) 압축 상관(BAC-746) — 런당 compaction 카운트 + 압축 직후 첫 verdict RED 비율 ────────────
# runE: compaction(auto) -> verdict.failed(post-compaction RED) -> compaction(manual) ->
#       compaction(auto, 연타) -> verdict.passed(연타의 다음 verdict 1건만 post-compaction) ->
#       verdict.passed(짝없음 — 앞선 compaction이 이미 다음 verdict에 소비됨, 카운트 제외)
# runF: compaction 없음 — compactions=0, post_compaction_red 표본에 기여 없음
COMP="$DIR/comp"
mkdir -p "$COMP"
cat > "$COMP/runE.jsonl" <<'EOF'
{"id":"e1","type":"run.started","ts":"2026-08-20T00:00:00.000Z","aggregate_id":"runE","payload":{},"version":1}
{"id":"e2","type":"compaction","ts":"2026-08-20T00:01:00.000Z","aggregate_id":"runE","payload":{"trigger":"auto"},"version":1}
{"id":"e3","type":"verdict.failed","ts":"2026-08-20T00:02:00.000Z","aggregate_id":"runE","payload":{},"version":1}
{"id":"e4","type":"compaction","ts":"2026-08-20T00:03:00.000Z","aggregate_id":"runE","payload":{"trigger":"manual"},"version":1}
{"id":"e5","type":"compaction","ts":"2026-08-20T00:04:00.000Z","aggregate_id":"runE","payload":{"trigger":"auto"},"version":1}
{"id":"e6","type":"verdict.passed","ts":"2026-08-20T00:05:00.000Z","aggregate_id":"runE","payload":{},"version":1}
{"id":"e7","type":"verdict.passed","ts":"2026-08-20T00:06:00.000Z","aggregate_id":"runE","payload":{},"version":1}
EOF
cat > "$COMP/runF.jsonl" <<'EOF'
{"id":"f1","type":"run.started","ts":"2026-08-20T01:00:00.000Z","aggregate_id":"runF","payload":{},"version":1}
{"id":"f2","type":"verdict.passed","ts":"2026-08-20T01:01:00.000Z","aggregate_id":"runF","payload":{},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$COMP" --json)" || fail "run-metrics with compaction events must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  const runE = m.runs.find((r) => r.run_id === "runE");
  const runF = m.runs.find((r) => r.run_id === "runF");
  if (runE.compactions !== 3) throw new Error("runE compactions must be 3, got " + runE.compactions);
  if (JSON.stringify(runE.post_compaction_red) !== JSON.stringify([true, false]))
    throw new Error("runE post_compaction_red must be [true(e3 after e2), false(e6 after e4+e5 collapsed)], got " + JSON.stringify(runE.post_compaction_red));
  if (runF.compactions !== 0) throw new Error("runF compactions must be 0, got " + runF.compactions);
  if (m.overall.compactions_total !== 3) throw new Error("overall compactions_total must be 3, got " + m.overall.compactions_total);
  if (m.overall.post_compaction_red.total !== 2) throw new Error("overall post_compaction_red.total must be 2, got " + JSON.stringify(m.overall.post_compaction_red));
  if (m.overall.post_compaction_red.red !== 1) throw new Error("overall post_compaction_red.red must be 1, got " + JSON.stringify(m.overall.post_compaction_red));
  if (m.overall.post_compaction_red.ratio !== 0.5) throw new Error("overall post_compaction_red.ratio must be 0.5, got " + JSON.stringify(m.overall.post_compaction_red));
' "$JSON" || fail "compaction fold values wrong"
OUT="$(node "$METRICS" --runs-dir "$COMP")"
printf '%s' "$OUT" | grep -q "compactions_total: 3" || fail "text output must show compactions_total, got: $OUT"
printf '%s' "$OUT" | grep -q "post_compaction_red" || fail "text output must show post_compaction_red, got: $OUT"
echo "PASS: per-run compactions + post-compaction-RED fold correctly (back-to-back compactions collapse to one pending state, not double-counted)"

# ── 9) compaction 없는 원장(모든 기존 픽스처)은 post_compaction_red=INSUFFICIENT_DATA ─────────
JSON="$(node "$METRICS" --runs-dir "$AB" --json)" || fail "run-metrics on non-compaction fixture must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.overall.post_compaction_red !== "INSUFFICIENT_DATA")
    throw new Error("no compaction events -> post_compaction_red must be INSUFFICIENT_DATA, got " + JSON.stringify(m.overall.post_compaction_red));
  if (m.overall.compactions_total !== 0) throw new Error("no compaction events -> compactions_total must be 0, got " + m.overall.compactions_total);
' "$JSON" || fail "no-compaction fixture must report INSUFFICIENT_DATA, not a fabricated ratio"
echo "PASS: runs with no compaction events report post_compaction_red=INSUFFICIENT_DATA (no fabricated ratio)"

exit 0
