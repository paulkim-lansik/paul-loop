#!/usr/bin/env bash
# BAC-754 (ported from glucofit-partners' module-size.test.sh, originally BAC-629 — ouroboros O8
# 채택). bin/check-module-size.mjs is entirely synthetic-fixture-testable — every case here builds its
# own throwaway root, no consumer-repo state involved.
#
# 계약:
#   1) threshold를 넘는 파일의 현재 줄수가 baseline 한도(없으면 0)보다 크면 growth 위반 → exit 1.
#   2) 이 PR이 제안하는 baseline(작업트리)이 base-ref 시점 baseline보다 완화(threshold 상향/모듈
#      한도 상향/신규 모듈 한도 추가)되어 있으면 self-modification 위반 → exit 1.
#   3) base-ref에 baseline이 아예 없으면(최초 도입) self-mod 비교는 스킵(부트스트랩).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../bin/check-module-size.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "check-module-size.mjs not found at $CHECK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

mk_lines() {
  # $1 = target file, $2 = line count
  local f="$1" n="$2"
  mkdir -p "$(dirname "$f")"
  : > "$f"
  for ((i = 1; i <= n; i++)); do echo "// line $i" >> "$f"; done
}

mk_baseline() {
  # $1 = target path, $2 = threshold, $3... = "path:limit" pairs
  local f="$1" threshold="$2"; shift 2
  mkdir -p "$(dirname "$f")"
  local entries="" first=1
  for pair in "$@"; do
    local p="${pair%%:*}" lim="${pair#*:}"
    [ "$first" = "1" ] || entries="$entries,"
    entries="$entries\"$p\":$lim"
    first=0
  done
  printf '{"threshold":%s,"modules":{%s}}\n' "$threshold" "$entries" > "$f"
}

# ── 1) baseline과 정확히 일치하는 오버사이즈 모듈 → exit 0 ──────────────────────────────────────
OK="$DIR/ok"
mkdir -p "$OK/src"
mk_lines "$OK/src/big.ts" 2500
mk_baseline "$OK/tools/module-size-baseline.json" 2000 "src/big.ts:2500"
OUT_OK="$(node "$CHECK" --root "$OK" --json)"; rc=$?
[ "$rc" = "0" ] || fail "baseline-matching oversized module must exit 0, got $rc: $OUT_OK"
echo "PASS: module at exactly its baseline limit exits 0"

# ── 2) threshold 이하 모듈은 baseline에 없어도 통과 ─────────────────────────────────────────
mk_lines "$OK/src/small.ts" 100
OUT_OK2="$(node "$CHECK" --root "$OK" --json)"; rc=$?
[ "$rc" = "0" ] || fail "under-threshold file with no baseline entry must exit 0, got $rc: $OUT_OK2"
echo "PASS: file under threshold with no baseline entry exits 0"

# ── 3) growth 위반: baseline 한도를 넘겨 자란 모듈 → exit 1, kind=growth ────────────────────────
GROW="$DIR/grow"
mkdir -p "$GROW/src"
mk_lines "$GROW/src/big.ts" 2600
mk_baseline "$GROW/tools/module-size-baseline.json" 2000 "src/big.ts:2500"
OUT_GROW="$(node "$CHECK" --root "$GROW" --json)"; rc=$?
[ "$rc" = "1" ] || fail "module grown past its baseline limit must exit 1, got $rc"
node -e '
  const r = JSON.parse(process.argv[1]);
  const v = r.violations.find(v => v.kind === "growth" && v.path === "src/big.ts");
  if (!v) throw new Error("expected growth violation for src/big.ts, got " + JSON.stringify(r));
  if (v.lines !== 2600 || v.limit !== 2500) throw new Error("wrong lines/limit: " + JSON.stringify(v));
' "$OUT_GROW" || fail "growth violation JSON shape wrong"
echo "PASS: module grown past its baseline limit is flagged growth and exits 1"

# ── 4) growth 위반: baseline에 아예 없던 신규 모듈이 threshold를 넘김(한도 0 초과) → exit 1 ──────
NEWBIG="$DIR/newbig"
mkdir -p "$NEWBIG/src"
mk_lines "$NEWBIG/src/surprise.ts" 2100
mk_baseline "$NEWBIG/tools/module-size-baseline.json" 2000
OUT_NEWBIG="$(node "$CHECK" --root "$NEWBIG" --json)"; rc=$?
[ "$rc" = "1" ] || fail "new module crossing threshold must exit 1, got $rc"
node -e '
  const r = JSON.parse(process.argv[1]);
  const v = r.violations.find(v => v.kind === "growth" && v.path === "src/surprise.ts");
  if (!v || v.limit !== 0) throw new Error("expected growth violation with limit 0, got " + JSON.stringify(r));
' "$OUT_NEWBIG" || fail "new-module growth violation JSON shape wrong"
echo "PASS: a module newly crossing threshold (unregistered) exits 1"

# ── 5) 정당한 shrink: 모듈이 줄어들면 통과(줄어든 만큼 baseline이 더 낮아도 무방) ────────────────
SHRINK="$DIR/shrink"
mkdir -p "$SHRINK/src"
mk_lines "$SHRINK/src/big.ts" 2400
mk_baseline "$SHRINK/tools/module-size-baseline.json" 2000 "src/big.ts:2500"
OUT_SHRINK="$(node "$CHECK" --root "$SHRINK" --json)"; rc=$?
[ "$rc" = "0" ] || fail "module shrunk below its baseline limit must exit 0, got $rc: $OUT_SHRINK"
echo "PASS: module shrunk below its baseline limit exits 0"

# ── 6) 자가변조: 같은 PR에서 개별 모듈 한도를 상향 → exit 1, kind=module-limit-relaxed ──────────
RELAX="$DIR/relax"
mkdir -p "$RELAX/src"
mk_lines "$RELAX/src/big.ts" 2500
mk_baseline "$RELAX/tools/module-size-baseline.json" 2000 "src/big.ts:3000"   # working: relaxed to 3000
mk_baseline "$RELAX/base-baseline.json" 2000 "src/big.ts:2500"               # base-ref: was 2500
OUT_RELAX="$(node "$CHECK" --root "$RELAX" --base-baseline "$RELAX/base-baseline.json" --json)"; rc=$?
[ "$rc" = "1" ] || fail "raising a module's baseline limit in the same PR must exit 1, got $rc"
node -e '
  const r = JSON.parse(process.argv[1]);
  const v = r.violations.find(v => v.kind === "module-limit-relaxed" && v.path === "src/big.ts");
  if (!v) throw new Error("expected module-limit-relaxed violation, got " + JSON.stringify(r));
' "$OUT_RELAX" || fail "module-limit-relaxed JSON shape wrong"
echo "PASS: raising a module baseline limit vs. base-ref in the same PR is blocked (self-modification)"

# ── 7) 자가변조: 같은 PR에서 threshold 자체를 상향 → exit 1, kind=threshold-relaxed ─────────────
RELAXT="$DIR/relaxt"
mkdir -p "$RELAXT/src"
mk_lines "$RELAXT/src/big.ts" 2500
mk_baseline "$RELAXT/tools/module-size-baseline.json" 3000 "src/big.ts:2500"  # working: threshold 3000
mk_baseline "$RELAXT/base-baseline.json" 2000 "src/big.ts:2500"              # base-ref: threshold 2000
OUT_RELAXT="$(node "$CHECK" --root "$RELAXT" --base-baseline "$RELAXT/base-baseline.json" --json)"; rc=$?
[ "$rc" = "1" ] || fail "raising the global threshold in the same PR must exit 1, got $rc"
node -e '
  const r = JSON.parse(process.argv[1]);
  const v = r.violations.find(v => v.kind === "threshold-relaxed");
  if (!v) throw new Error("expected threshold-relaxed violation, got " + JSON.stringify(r));
' "$OUT_RELAXT" || fail "threshold-relaxed JSON shape wrong"
echo "PASS: raising the global threshold vs. base-ref in the same PR is blocked (self-modification)"

# ── 8) 자가변조: base-ref에 없던 모듈 한도를 이 PR에서 신설 → exit 1, kind=new-module-entry ─────
NEWENTRY="$DIR/newentry"
mkdir -p "$NEWENTRY/src"
mk_lines "$NEWENTRY/src/big.ts" 2100
mk_baseline "$NEWENTRY/tools/module-size-baseline.json" 2000 "src/big.ts:2100"
mk_baseline "$NEWENTRY/base-baseline.json" 2000   # base-ref: no entries at all
OUT_NEWENTRY="$(node "$CHECK" --root "$NEWENTRY" --base-baseline "$NEWENTRY/base-baseline.json" --json)"; rc=$?
[ "$rc" = "1" ] || fail "adding a brand-new baseline entry in the same PR must exit 1, got $rc"
node -e '
  const r = JSON.parse(process.argv[1]);
  const v = r.violations.find(v => v.kind === "new-module-entry" && v.path === "src/big.ts");
  if (!v) throw new Error("expected new-module-entry violation, got " + JSON.stringify(r));
' "$OUT_NEWENTRY" || fail "new-module-entry JSON shape wrong"
echo "PASS: registering a brand-new baseline entry in the same PR is blocked (self-modification)"

# ── 9) 부트스트랩: base-ref에 baseline 파일이 없으면(최초 도입) self-mod 비교 스킵 ────────────────
BOOT="$DIR/boot"
mkdir -p "$BOOT/src"
mk_lines "$BOOT/src/big.ts" 2500
mk_baseline "$BOOT/tools/module-size-baseline.json" 2000 "src/big.ts:2500"
# base-baseline.json 파일 자체를 만들지 않음 — "base-ref에 없었다"를 모사
OUT_BOOT="$(node "$CHECK" --root "$BOOT" --base-baseline "$BOOT/base-baseline.json" --json)"; rc=$?
[ "$rc" = "0" ] || fail "missing base-ref baseline (bootstrap) must skip self-mod check and exit 0, got $rc: $OUT_BOOT"
echo "PASS: missing base-ref baseline (first adoption) skips self-modification check"

# ── 10) --base-ref 미지정 시(로컬 실행) self-mod 비교 자체를 안 함 ─────────────────────────────
OUT_NOBASEREF="$(node "$CHECK" --root "$RELAX" --json)"; rc=$?
[ "$rc" = "0" ] || fail "without --base-ref/--base-baseline, self-mod check must be skipped, got $rc: $OUT_NOBASEREF"
echo "PASS: omitting --base-ref/--base-baseline skips self-modification check entirely"

# ── 11) 실제 git --base-ref 경로(CI가 실제로 쓰는 경로) — 부트스트랩 + 완화 감지 둘 다 ────────────
# --base-baseline은 테스트 전용 훅이고, CI(.github/workflows/ci.yml)는 --base-ref로 실제
# `git show <ref>:path`를 태운다. 그 경로 자체가 안 새는지(리뷰에서 지적된 갭) 실제 git repo로 검증.
GITREPO="$DIR/gitrepo"
mkdir -p "$GITREPO/src"
git init -q "$GITREPO"
git -C "$GITREPO" config user.email test@test.local
git -C "$GITREPO" config user.name test
git -C "$GITREPO" config commit.gpgsign false
mk_lines "$GITREPO/src/big.ts" 2500
git -C "$GITREPO" add -A
git -C "$GITREPO" commit -q -m "before baseline"
BASE_SHA="$(git -C "$GITREPO" rev-parse HEAD)"
# base-ref 시점엔 baseline 파일이 없었다 — 진짜 부트스트랩. 워킹트리에서 이제 baseline을 신설.
mk_baseline "$GITREPO/tools/module-size-baseline.json" 2000 "src/big.ts:2500"
OUT_BOOT_GIT="$(node "$CHECK" --root "$GITREPO" --base-ref "$BASE_SHA" --json)"; rc=$?
[ "$rc" = "0" ] || fail "real git bootstrap (--base-ref, no baseline at that ref) must exit 0, got $rc: $OUT_BOOT_GIT"
echo "PASS: real --base-ref bootstrap (no baseline at that commit) skips self-mod check and exits 0"

# 이제 base-ref에도 baseline이 있는 커밋을 만들고, 워킹트리에서 완화를 시도 → --base-ref로 잡혀야 함.
git -C "$GITREPO" add -A
git -C "$GITREPO" commit -q -m "add baseline (limit 2500)"
BASE_SHA2="$(git -C "$GITREPO" rev-parse HEAD)"
mk_baseline "$GITREPO/tools/module-size-baseline.json" 2000 "src/big.ts:9000"  # 워킹트리: 완화 시도
OUT_RELAX_GIT="$(node "$CHECK" --root "$GITREPO" --base-ref "$BASE_SHA2" --json)"; rc=$?
[ "$rc" = "1" ] || fail "real git relaxation (--base-ref) must exit 1, got $rc: $OUT_RELAX_GIT"
node -e '
  const r = JSON.parse(process.argv[1]);
  const v = r.violations.find(v => v.kind === "module-limit-relaxed" && v.path === "src/big.ts");
  if (!v) throw new Error("expected module-limit-relaxed via real --base-ref, got " + JSON.stringify(r));
' "$OUT_RELAX_GIT" || fail "real --base-ref relaxation JSON shape wrong"
echo "PASS: real --base-ref path (git show) catches baseline relaxation vs. an actual commit"

# ── 12) 잘못된/resolve 안 되는 --base-ref → 부트스트랩으로 조용히 넘어가지 않고 에러로 중단(exit 1) ──
mk_baseline "$GITREPO/tools/module-size-baseline.json" 2000 "src/big.ts:2500"
set +e
OUT_BADREF="$(node "$CHECK" --root "$GITREPO" --base-ref not-a-real-ref-at-all --json 2>&1)"; rc=$?
set -e
[ "$rc" = "1" ] || fail "invalid --base-ref must exit 1 (loud failure, not silent bootstrap), got $rc"
printf '%s' "$OUT_BADREF" | grep -qi "resolve" || fail "invalid --base-ref must surface a wiring error, got: $OUT_BADREF"
echo "PASS: an unresolvable --base-ref fails loudly instead of silently skipping self-mod check"
