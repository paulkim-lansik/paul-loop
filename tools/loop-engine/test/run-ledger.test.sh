#!/usr/bin/env bash
# Regression test for run-ledger.mjs + ledger-append.mjs + verdict-run.sh 원장 배선 (BAC-570).
#
# .loop/runs/<run-id>.jsonl은 append-only 런 이벤트 원장이다: 스키마 v1
# {id,type,ts,aggregate_id,payload,version} + 기록 시점 BAC-628 sanitize(시크릿 키 낙하·장문 캡).
# verdict.* 이벤트는 보호 파일 verdict-run.sh(write_state)만 산출한다(BAC-564 "에이전트가 못 쓰는
# 경로" 원칙) — 원장 append는 best-effort라 실패해도 verdict·exit code가 불변이어야 한다.
# hermetic: mktemp + 임시 git repo, docker 0.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LIB="$ROOT/tools/loop-engine/lib/run-ledger.mjs"
APPEND="$ROOT/tools/loop-engine/bin/ledger-append.mjs"
VRUN="$ROOT/tools/loop-engine/bin/verdict-run.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LIB" ] || fail "run-ledger.mjs not found at $LIB"
[ -f "$APPEND" ] || fail "ledger-append.mjs not found at $APPEND"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'chmod -R u+w "$DIR" 2>/dev/null; rm -rf "$DIR"' EXIT

append_evt() { # $1=root $2=args-json
  node -e '
    const { pathToFileURL } = require("node:url");
    const [lib, root, args] = process.argv.slice(1);
    import(pathToFileURL(lib).href)
      .then((m) => { m.appendRunEvent(root, JSON.parse(args)); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  ' "$LIB" "$1" "$2"
}

# ── 1) append 1회 → 1줄 + 스키마 v1 필드 전부 + run-id sanitize ──────────────────────────────
R1="$DIR/r1"
mkdir -p "$R1"
append_evt "$R1" '{"type":"run.started","sessionId":"sess one!","payload":{"cwd":"/x"}}' \
  || fail "append #1 failed"
F="$R1/.loop/runs/sessone.jsonl"
[ -f "$F" ] || fail "expected ledger at $F (run-id must strip non [a-zA-Z0-9_-] chars)"
[ "$(wc -l < "$F" | tr -d ' ')" = "1" ] || fail "append #1 must write exactly 1 line"
node -e '
  const fs = require("node:fs");
  const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8").trim());
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(e.id)) throw new Error("id must be a uuid: " + e.id);
  if (e.type !== "run.started") throw new Error("bad type: " + e.type);
  if (Number.isNaN(Date.parse(e.ts))) throw new Error("ts must be ISO: " + e.ts);
  if (e.aggregate_id !== "sessone") throw new Error("bad aggregate_id: " + e.aggregate_id);
  if (typeof e.payload !== "object" || e.payload === null) throw new Error("payload must be object");
  if (e.version !== 1) throw new Error("version must be 1, got " + e.version);
' "$F" || fail "event schema v1 fields wrong"
echo "PASS: run-ledger append writes schema-v1 single line with sanitized run-id"

# ── 2) append 2회 → 2줄, 기존 줄 불변 (append-only) ─────────────────────────────────────────
LINE1="$(head -n1 "$F")"
append_evt "$R1" '{"type":"run.ended","runId":"sessone","payload":{}}' || fail "append #2 failed"
[ "$(wc -l < "$F" | tr -d ' ')" = "2" ] || fail "append #2 must yield 2 lines (append-only)"
[ "$(head -n1 "$F")" = "$LINE1" ] || fail "append must never rewrite existing lines"
echo "PASS: ledger is append-only (2 appends = 2 lines, first line untouched)"

# ── 3) 기록 시점 sanitize — 시크릿 키 낙하 + 장문 트렁케이션 (BAC-628 계약) ──────────────────
LONG="$(node -e 'process.stdout.write("y".repeat(600))')"
append_evt "$R1" "{\"type\":\"permission.requested\",\"runId\":\"san\",\"payload\":{\"api_key\":\"supersecret-value\",\"note\":\"$LONG\"}}" \
  || fail "append #3 failed"
node -e '
  const fs = require("node:fs");
  const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8").trim());
  if (!/^\[REDACTED len=\d+ sha256=[0-9a-f]{16}\]$/.test(e.payload.api_key))
    throw new Error("blocklist key value must drop to marker, got: " + e.payload.api_key);
  if (!/<truncated len=600 sha256=[0-9a-f]{16}>$/.test(e.payload.note))
    throw new Error("long value must be capped with truncation marker, got tail: " + String(e.payload.note).slice(-60));
' "$R1/.loop/runs/san.jsonl" || fail "payload must pass BAC-628 sanitize at write time"
echo "PASS: payload passes write-time redaction (blocklist drop + truncation cap)"

# ── 4) ledger-append CLI — payload는 stdin(대형 payload E2BIG 예방) ─────────────────────────
# 픽스처는 단어 경계가 섞인 내용("x "×512Ki=1MB) — 균일 워드런은 sanitize 정규식의 그리디 스타
# 백트래킹을 O(n²)로 몰아 테스트가 헹한다(실측). E2BIG 증명엔 총 바이트만 중요하다.
R2="$DIR/r2"
mkdir -p "$R2"
( cd "$R2" && node -e 'process.stdout.write(JSON.stringify({note:"x ".repeat(512*1024)}))' \
  | node "$APPEND" --type verdict.passed --run-id big ) || fail "1MB stdin payload must append without E2BIG"
[ -f "$R2/.loop/runs/big.jsonl" ] || fail "stdin append must land in cwd ledger"
grep -q '"type":"verdict.passed"' "$R2/.loop/runs/big.jsonl" || fail "appended event must carry the given --type"
echo "PASS: ledger-append takes payload via stdin (1MB safe)"

# ── 5) --auto-run-id — current 포인터 있으면 그 run-id, 없으면 unknown ──────────────────────
mkdir -p "$R2/.loop/runs"
printf 'runx\n' > "$R2/.loop/runs/current"
( cd "$R2" && printf '{}' | node "$APPEND" --type verdict.failed --auto-run-id ) \
  || fail "--auto-run-id append failed"
[ -f "$R2/.loop/runs/runx.jsonl" ] || fail "--auto-run-id must resolve run-id from .loop/runs/current"
R3="$DIR/r3"
mkdir -p "$R3"
( cd "$R3" && printf '{}' | node "$APPEND" --type verdict.failed --auto-run-id ) \
  || fail "--auto-run-id without current failed"
[ -f "$R3/.loop/runs/unknown.jsonl" ] || fail "--auto-run-id without current must fall back to unknown bucket"
# 파손 포인터(경로 문자 포함)는 'unknown'으로 강등 — 무살균 통과 시 ENOENT 무음 유실(sub/ 형태)
# 또는 .loop/runs 밖 경로 탈출(../ 형태)이 된다(리뷰 실측 2건).
printf 'sub/dir-escape\n' > "$R2/.loop/runs/current"
( cd "$R2" && printf '{}' | node "$APPEND" --type verdict.failed --auto-run-id ) \
  || fail "corrupt current pointer must not fail the append"
[ -f "$R2/.loop/runs/unknown.jsonl" ] || fail "corrupt current pointer must demote to the unknown bucket"
printf '../../escaped\n' > "$R2/.loop/runs/current"
( cd "$R2" && printf '{}' | node "$APPEND" --type verdict.failed --auto-run-id ) \
  || fail "path-escape current pointer must not fail the append"
[ ! -f "$DIR/escaped.jsonl" ] && [ ! -f "$R2/escaped.jsonl" ] \
  || fail "corrupt current pointer must never steer writes outside .loop/runs"
echo "PASS: --auto-run-id resolves current pointer, falls back to unknown (corrupt values demoted)"

# ── 6) verdict-run.sh 배선 — PASS/FAIL이 verdict.passed/failed로 원장에 남는다 ──────────────
REPO="$DIR/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
printf '.loop/\n' > "$REPO/.gitignore"
echo x > "$REPO/f.txt"
git -C "$REPO" add .
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init
# VERDICT_RUN_LEDGER_NESTED= 프리픽스: 이 테스트 스위트 자체가 pnpm verdict(=이 래퍼) 아래에서
# 돌면 중첩 표식이 상속돼 append가 생략된다 — 최상위 래퍼 관점을 강제해 hermetic하게 만든다.
( cd "$REPO" && VERDICT_RUN_LEDGER_NESTED= "$VRUN" -- true >/dev/null 2>&1 ); rc=$?
[ "$rc" = "0" ] || fail "verdict-run -- true must exit 0, got $rc"
grep -q '"type":"verdict.passed"' "$REPO/.loop/runs/unknown.jsonl" 2>/dev/null \
  || fail "verdict-run PASS must append verdict.passed to the ledger (unknown bucket without current)"
( cd "$REPO" && VERDICT_RUN_LEDGER_NESTED= "$VRUN" -- false >/dev/null 2>&1 ); rc=$?
[ "$rc" = "1" ] || fail "verdict-run -- false must exit 1, got $rc"
grep -q '"type":"verdict.failed"' "$REPO/.loop/runs/unknown.jsonl" 2>/dev/null \
  || fail "verdict-run FAIL must append verdict.failed to the ledger"
echo "PASS: verdict-run.sh is the producer of verdict.* ledger events"

# ── 6b) 중첩 래퍼(passthrough) — 같은 검증은 원장에 정확히 1건만 남는다 ─────────────────────
# 래퍼는 명시적으로 composable: 내부가 이미 VERDICT 블록을 내면 외부는 passthrough로 재기록하는데,
# 양쪽 다 append하면 Q2가 중첩 깊이만큼 부푼다(리뷰 실측). 최상위 래퍼만 append해야 한다.
NREPO="$DIR/nested"
mkdir -p "$NREPO"
git -C "$NREPO" init -q
printf '.loop/\n' > "$NREPO/.gitignore"
echo x > "$NREPO/f.txt"
git -C "$NREPO" add .
git -C "$NREPO" -c user.email=t@t -c user.name=t commit -qm init
( cd "$NREPO" && VERDICT_RUN_LEDGER_NESTED= "$VRUN" -- "$VRUN" -- true >/dev/null 2>&1 ); rc=$?
[ "$rc" = "0" ] || fail "nested verdict-run must still exit 0, got $rc"
n="$(grep -c '"type":"verdict.passed"' "$NREPO/.loop/runs/unknown.jsonl" 2>/dev/null || echo 0)"
[ "$n" = "1" ] || fail "nested verdict-run must append exactly 1 verdict event, got $n"
echo "PASS: nested verdict-run records exactly one ledger event (no Q2 double-count)"

# ── 7) 원장 쓰기 불가여도 verdict exit 불변 (best-effort 계약) ──────────────────────────────
REPO2="$DIR/repo2"
mkdir -p "$REPO2"
git -C "$REPO2" init -q
printf '.loop/\n' > "$REPO2/.gitignore"
echo x > "$REPO2/f.txt"
git -C "$REPO2" add .
git -C "$REPO2" -c user.email=t@t -c user.name=t commit -qm init
mkdir -p "$REPO2/.loop/runs"
chmod 555 "$REPO2/.loop/runs"
( cd "$REPO2" && VERDICT_RUN_LEDGER_NESTED= "$VRUN" -- true >/dev/null 2>&1 ); rc=$?
chmod 755 "$REPO2/.loop/runs"
[ "$rc" = "0" ] || fail "ledger write failure must not change the verdict exit code (got $rc)"
echo "PASS: ledger append is best-effort — write failure leaves verdict exit untouched"

# ── 7b) current 포인터 수명주기 — run.ended가 자기 포인터를 정리한다 ────────────────────────
# 잔존 포인터는 세션 종료 후의 터미널 verdict를 죽은 런에 계속 귀속시킨다(리뷰). 자기 run-id일
# 때만 제거 — 동시 세션이 새로 쓴 포인터는 보존(last-writer-wins 계약 유지).
R4="$DIR/r4"
mkdir -p "$R4"
append_evt "$R4" '{"type":"run.started","runId":"lifeA","payload":{},"writeCurrentPointer":true}' \
  || fail "lifecycle run.started append failed"
[ "$(head -n1 "$R4/.loop/runs/current")" = "lifeA" ] || fail "run.started must write current pointer"
append_evt "$R4" '{"type":"run.ended","runId":"lifeA","payload":{},"clearCurrentPointer":true}' \
  || fail "lifecycle run.ended append failed"
[ ! -f "$R4/.loop/runs/current" ] || fail "run.ended must clear its own current pointer"
append_evt "$R4" '{"type":"run.started","runId":"lifeB","payload":{},"writeCurrentPointer":true}' \
  || fail "lifecycle second run.started failed"
append_evt "$R4" '{"type":"run.ended","runId":"lifeA","payload":{},"clearCurrentPointer":true}' \
  || fail "lifecycle mismatched run.ended failed"
[ "$(head -n1 "$R4/.loop/runs/current" 2>/dev/null)" = "lifeB" ] \
  || fail "run.ended of another session must NOT clear a newer current pointer"
echo "PASS: run.ended clears only its own current pointer (stale attribution closed)"

# ── 8) .loop/runs는 커밋되지 않는다 (AC — gitignore) ────────────────────────────────────────
git -C "$ROOT" check-ignore -q .loop/runs/x.jsonl \
  || fail ".loop/runs/*.jsonl must be gitignored in this repo"
echo "PASS: .loop/runs is gitignored"

exit 0
