#!/usr/bin/env bash
# Regression test for run-metrics.mjs의 recall 건전성 축 (memory.recall fold).
#
# 왜 이 축이 필요한가: hooks/recall-lessons.mjs는 fail-open 계약(항상 exit 0)이라 "회수할 게
# 없었다"와 "고장났다"가 겉으로 똑같다. 원장(memory.recall)만이 둘을 가르는데 그걸 아무도
# fold하지 않아, 소비 레포에서 cli_failed가 attempted의 89%인 상태로 6일간(2026-08-27~09-01,
# 실측 626건) 무증상으로 지나갔다. 이 테스트가 잠그는 계약 4가지:
#   ① 실패율 분모는 attempted(=fired−skipped) — self-gate(키 부재·짧은 프롬프트)는 고장이 아니다.
#   ② 컷오프 실효성은 hit 단위(candidates/passed)로 잰다 — `above_cutoff` 사유(후보 전부 탈락)만
#      세면 과소보고된다(실측: above_cutoff 1건 vs hit 단위 탈락 55건).
#   ③ 코퍼스(lessons/knowledge)를 합치지 않는다 — 임베딩 분포가 달라 한 숫자로는 둘 다 못 읽는다.
#   ④ 결손은 INSUFFICIENT_DATA 1급 — 훅 미발화를 0%처럼 보이게 하지 않는다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
METRICS="$ROOT/tools/loop-engine/bin/run-metrics.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$METRICS" ] || fail "run-metrics.mjs not found at $METRICS"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# ── T1) 혼합 원장: self-gate 2 + 고장 2 + 주입 2 ──────────────────────────────────────────
A="$DIR/a"; mkdir -p "$A"
cat > "$A/runA.jsonl" <<'EOF'
{"id":"r1","type":"run.started","ts":"2026-09-01T00:00:00.000Z","aggregate_id":"runA","payload":{},"version":1}
{"id":"r2","type":"memory.recall","ts":"2026-09-01T00:01:00.000Z","aggregate_id":"runA","payload":{"outcome":"skipped","reason":"prompt_too_short","lessons":{"candidates":0,"near":0,"nearest":null},"knowledge":{"candidates":0,"near":0,"nearest":null},"injected_chars":0},"version":1}
{"id":"r3","type":"memory.recall","ts":"2026-09-01T00:02:00.000Z","aggregate_id":"runA","payload":{"outcome":"skipped","reason":"no_embedding_key","lessons":{"candidates":0,"near":0,"nearest":null},"knowledge":{"candidates":0,"near":0,"nearest":null},"injected_chars":0},"version":1}
{"id":"r4","type":"memory.recall","ts":"2026-09-01T00:03:00.000Z","aggregate_id":"runA","payload":{"outcome":"error","reason":"cli_failed","cli_status":1,"lessons":{"candidates":0,"near":0,"nearest":null},"knowledge":{"candidates":0,"near":0,"nearest":null},"injected_chars":0},"version":1}
{"id":"r5","type":"memory.recall","ts":"2026-09-01T00:04:00.000Z","aggregate_id":"runA","payload":{"outcome":"error","reason":"cli_failed","cli_status":1,"lessons":{"candidates":0,"near":0,"nearest":null},"knowledge":{"candidates":0,"near":0,"nearest":null},"injected_chars":0},"version":1}
{"id":"r6","type":"memory.recall","ts":"2026-09-01T00:05:00.000Z","aggregate_id":"runA","payload":{"outcome":"injected","reason":"injected","lessons":{"candidates":3,"near":2,"nearest":0.15},"knowledge":{"candidates":3,"near":1,"nearest":0.1},"cutoffs":{"lessons":0.25,"knowledge":0.2},"injected_chars":1000},"version":1}
{"id":"r7","type":"memory.recall","ts":"2026-09-01T00:06:00.000Z","aggregate_id":"runA","payload":{"outcome":"injected","reason":"injected","lessons":{"candidates":3,"near":3,"nearest":0.25},"knowledge":{"candidates":3,"near":3,"nearest":0.2},"cutoffs":{"lessons":0.25,"knowledge":0.2},"injected_chars":2000},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$A" --json)" || fail "T1 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]).overall.recall;
  if (m === "INSUFFICIENT_DATA") throw new Error("T1 recall axis must be present");
  if (m.fired !== 6) throw new Error("T1 fired must be 6, got " + m.fired);
  if (m.skipped !== 2) throw new Error("T1 skipped must be 2, got " + m.skipped);
  // ① 분모는 attempted=4, 실패 2 -> 0.5. fired(6) 기준이면 0.33으로 희석된다.
  if (m.attempted !== 4) throw new Error("T1 attempted must be fired-skipped=4, got " + m.attempted);
  if (m.failed !== 2) throw new Error("T1 failed must be 2, got " + m.failed);
  if (m.failure_ratio !== 0.5) throw new Error("T1 failure_ratio must be failed/attempted=0.5, got " + m.failure_ratio);
  if (m.injected !== 2) throw new Error("T1 injected must be 2, got " + m.injected);
  if (m.injected_chars_total !== 3000) throw new Error("T1 injected_chars_total must be 3000, got " + m.injected_chars_total);
  if (m.injected_chars_mean !== 1500) throw new Error("T1 injected_chars_mean must be 1500, got " + m.injected_chars_mean);
  if (m.by_reason.cli_failed !== 2) throw new Error("T1 by_reason.cli_failed must be 2");
  if (m.by_reason.no_embedding_key !== 1) throw new Error("T1 by_reason must keep distinct skip slugs");
  // ② hit 단위 컷오프 실효성. above_cutoff 사유는 0건인데 실제로는 hit이 탈락했다.
  if (m.by_reason.above_cutoff) throw new Error("T1 fixture has no above_cutoff reason — the hit-level count must not depend on it");
  const L = m.corpus.lessons, K = m.corpus.knowledge;
  if (L.candidates !== 6 || L.passed_cutoff !== 5 || L.dropped_by_cutoff !== 1)
    throw new Error("T1 lessons hit-level wrong: " + JSON.stringify(L));
  // ③ 코퍼스 분리 — knowledge는 lessons와 다른 수치여야 한다(합치면 3/12로 뭉갠다).
  if (K.candidates !== 6 || K.passed_cutoff !== 4 || K.dropped_by_cutoff !== 2)
    throw new Error("T1 knowledge hit-level wrong: " + JSON.stringify(K));
  if (L.dropped_ratio === K.dropped_ratio) throw new Error("T1 corpora must stay separate, not merged");
  if (L.nearest.n !== 2 || L.nearest.min !== 0.15 || L.nearest.max !== 0.25)
    throw new Error("T1 lessons nearest distribution wrong: " + JSON.stringify(L.nearest));
  if (JSON.stringify(L.cutoffs_observed) !== JSON.stringify([0.25]))
    throw new Error("T1 observed cutoff must come from the ledger, got " + JSON.stringify(L.cutoffs_observed));
' "$JSON" || fail "T1 recall fold contract broken"
echo "PASS: T1 failure_ratio uses attempted (not fired), hit-level cutoff efficacy, corpora kept separate"

# ── T2) memory.recall 0건 -> INSUFFICIENT_DATA (0%로 날조 금지) ────────────────────────────
B="$DIR/b"; mkdir -p "$B"
cat > "$B/runB.jsonl" <<'EOF'
{"id":"b1","type":"run.started","ts":"2026-09-01T00:00:00.000Z","aggregate_id":"runB","payload":{},"version":1}
{"id":"b2","type":"verdict.passed","ts":"2026-09-01T00:01:00.000Z","aggregate_id":"runB","payload":{"verdict":"PASS","exit":0},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$B" --json)" || fail "T2 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]).overall.recall;
  if (m !== "INSUFFICIENT_DATA") throw new Error("T2 no memory.recall events must be INSUFFICIENT_DATA, got " + JSON.stringify(m));
' "$JSON" || fail "T2 must not fabricate a recall ratio from zero events"
OUT="$(node "$METRICS" --runs-dir "$B")" || fail "T2 text mode must exit 0"
printf '%s' "$OUT" | grep -q "recall (loop-memory 시맨틱 회수): INSUFFICIENT_DATA" \
  || fail "T2 text mode must say INSUFFICIENT_DATA, got: $OUT"
echo "PASS: T2 zero memory.recall events report INSUFFICIENT_DATA in both json and text"

# ── T3) attempted=0(전부 self-gate) -> failure_ratio는 0이 아니라 INSUFFICIENT ────────────
C="$DIR/c"; mkdir -p "$C"
cat > "$C/runC.jsonl" <<'EOF'
{"id":"c1","type":"run.started","ts":"2026-09-01T00:00:00.000Z","aggregate_id":"runC","payload":{},"version":1}
{"id":"c2","type":"memory.recall","ts":"2026-09-01T00:01:00.000Z","aggregate_id":"runC","payload":{"outcome":"skipped","reason":"no_embedding_key","injected_chars":0},"version":1}
EOF
JSON="$(node "$METRICS" --runs-dir "$C" --json)" || fail "T3 --json must exit 0"
node -e '
  const m = JSON.parse(process.argv[1]).overall.recall;
  if (m.attempted !== 0) throw new Error("T3 attempted must be 0, got " + m.attempted);
  if (m.failure_ratio !== "INSUFFICIENT_DATA")
    throw new Error("T3 attempted=0 must give INSUFFICIENT_DATA, not a 0 that reads as healthy, got " + m.failure_ratio);
  if (m.corpus.lessons.nearest !== "INSUFFICIENT_DATA")
    throw new Error("T3 no distances -> nearest must be INSUFFICIENT_DATA, got " + JSON.stringify(m.corpus.lessons.nearest));
' "$JSON" || fail "T3 an all-self-gated ledger must not read as 0% failure"
echo "PASS: T3 attempted=0 yields INSUFFICIENT_DATA, not a healthy-looking 0"

# ── T4) 컷오프가 후보를 하나도 안 막으면 WARN — 교정 nudge(자동 변경은 안 한다) ──────────
D="$DIR/d"; mkdir -p "$D"
cat > "$D/runD.jsonl" <<'EOF'
{"id":"d1","type":"run.started","ts":"2026-09-01T00:00:00.000Z","aggregate_id":"runD","payload":{},"version":1}
{"id":"d2","type":"memory.recall","ts":"2026-09-01T00:01:00.000Z","aggregate_id":"runD","payload":{"outcome":"injected","reason":"injected","lessons":{"candidates":3,"near":3,"nearest":0.11},"knowledge":{"candidates":3,"near":1,"nearest":0.1},"cutoffs":{"lessons":0.65,"knowledge":0.2},"injected_chars":900},"version":1}
EOF
OUT="$(node "$METRICS" --runs-dir "$D")" || fail "T4 text mode must exit 0"
printf '%s' "$OUT" | grep -q "WARN: lessons 컷오프가 후보 3개 중 하나도 막지 않았다" \
  || fail "T4 a cutoff that never bound must WARN, got: $OUT"
printf '%s' "$OUT" | grep -q "WARN: knowledge" \
  && fail "T4 a cutoff that DID bind must not WARN"
echo "PASS: T4 a never-binding cutoff warns; a binding one stays quiet"

exit 0
