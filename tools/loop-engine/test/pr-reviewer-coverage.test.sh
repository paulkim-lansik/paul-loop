#!/usr/bin/env bash
# Behavioral test for bin/check-pr-hygiene.mjs's reviewer-coverage check (BAC-778).
#
# Motivation (measured): an audited run summoned only 2 of its 3 mandated review agents and opened
# the PR anyway; no gate caught it. Reviewer *names* are consumer-repo specific, so this plugin
# takes them as `--reviewers` config and ships none of its own — exactly like `--pattern`.
#
# Contract: without --reviewers nothing changes (the tracker-reference behaviour that
# test/check-pr-hygiene.test.sh already pins). With --reviewers, every named reviewer must appear in
# the body with a result token on its line or within the next 2 lines; a bare mention is not a
# result block. Exit 1 if any reviewer is missing, even when the tracker reference is present.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../bin/check-pr-hygiene.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "check-pr-hygiene.mjs not found at $CHECK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

REVIEWERS='code-reviewer,test-hunter,verifier-integrity-hunter'

cat > "$DIR/all-three.md" <<'EOF'
BAC-778 구현.

## 리뷰
### code-reviewer
PASS — 컨벤션 위반 없음.
### test-hunter
블로커 없음 (behavioural 커버리지 확인).
### verifier-integrity-hunter
PASS — 테스트 약화·검증기 우회 흔적 없음.
EOF

cat > "$DIR/only-two.md" <<'EOF'
BAC-778 구현.

## 리뷰
### code-reviewer
PASS — 컨벤션 위반 없음.
### test-hunter
PASS — 커버리지 충분.
EOF

cat > "$DIR/mention-only.md" <<'EOF'
BAC-778 구현.

### code-reviewer
PASS.
### test-hunter
PASS.

verifier-integrity-hunter는 이번에 돌리지 않았고 다음 PR에서 볼 예정이다. 특별한 이유는 없다.
그냥 시간이 없었다. 다음 문단은 관계 없는 내용이다.
EOF

# ── 1) 3종 결과 블록이 다 있으면 exit 0 ──────────────────────────────────────────────────────
OUT="$(node "$CHECK" --body-file "$DIR/all-three.md" --reviewers "$REVIEWERS" --json)"; rc=$?
[ "$rc" = "0" ] || fail "all three reviewer blocks must exit 0, got $rc: $OUT"
node -e '
  const r = JSON.parse(process.argv[1]);
  if (r.reviewers.ok !== true) throw new Error("reviewers.ok must be true, got " + JSON.stringify(r.reviewers));
  if (r.reviewers.missing.length !== 0) throw new Error("missing must be empty, got " + JSON.stringify(r.reviewers.missing));
  if (r.matched !== "BAC-778") throw new Error("the tracker-ref check must still run, got " + JSON.stringify(r.matched));
' "$OUT" || fail "all-three JSON shape wrong"
echo "PASS: a PR body with result blocks for all three reviewers exits 0"

# ── 2) 한 명이 통째로 빠지면 exit 1 + 누가 빠졌는지 이름을 낸다 (감사에서 나온 실제 형태) ────────
OUT="$(node "$CHECK" --body-file "$DIR/only-two.md" --reviewers "$REVIEWERS" --json)"; rc=$?
[ "$rc" = "1" ] || fail "a missing reviewer must exit 1, got $rc: $OUT"
node -e '
  const r = JSON.parse(process.argv[1]);
  if (r.ok !== false) throw new Error("overall ok must be false");
  if (JSON.stringify(r.reviewers.missing) !== JSON.stringify(["verifier-integrity-hunter"]))
    throw new Error("missing must name exactly the absent reviewer, got " + JSON.stringify(r.reviewers.missing));
  if (r.matched !== "BAC-778") throw new Error("a present tracker ref must not mask the reviewer failure");
' "$OUT" || fail "only-two JSON shape wrong"
echo "PASS: 2-of-3 reviewers exits 1 and names the missing one (the audited failure)"

# ── 3) 결과 없는 단순 언급은 결과 블록이 아니다 ──────────────────────────────────────────────
OUT="$(node "$CHECK" --body-file "$DIR/mention-only.md" --reviewers "$REVIEWERS" --json)"; rc=$?
[ "$rc" = "1" ] || fail "a bare mention must not count as a result block, got $rc: $OUT"
printf '%s' "$OUT" | grep -q 'verifier-integrity-hunter' \
  || fail "the bare-mention reviewer must be reported missing, got: $OUT"
echo "PASS: mentioning a reviewer's name in prose with no nearby verdict does not count"

# ── 4) --reviewers 없으면 기존 계약 그대로 (opt-in) ──────────────────────────────────────────
OUT="$(node "$CHECK" --body-file "$DIR/only-two.md" --json)"; rc=$?
[ "$rc" = "0" ] || fail "without --reviewers the check must not run, got $rc: $OUT"
node -e '
  const r = JSON.parse(process.argv[1]);
  if ("reviewers" in r) throw new Error("no --reviewers -> no reviewers key at all, got " + JSON.stringify(r));
' "$OUT" || fail "opt-in contract broken"
echo "PASS: without --reviewers the reviewer check is absent entirely (opt-in)"

# ── 5) 리뷰어 이름은 하드코딩되지 않는다 — 임의의 이름 집합이 그대로 동작 ─────────────────────
printf 'PROJ-1\n\nsecurity-bot\nAPPROVED\n' > "$DIR/custom.md"
OUT="$(node "$CHECK" --body-file "$DIR/custom.md" --reviewers 'security-bot' --json)"; rc=$?
[ "$rc" = "0" ] || fail "an arbitrary reviewer name must work, got $rc: $OUT"
OUT="$(node "$CHECK" --body-file "$DIR/custom.md" --reviewers 'security-bot,perf-bot' --json)"; rc=$?
[ "$rc" = "1" ] || fail "an absent arbitrary reviewer must exit 1, got $rc: $OUT"
# 주석의 예시 언급은 허용 — 금지 대상은 *코드*에 박힌 기본 리뷰어 목록이다.
grep -vE '^[[:space:]]*(//|\*|/\*)' "$CHECK" \
  | grep -q 'code-reviewer\|test-hunter\|verifier-integrity-hunter' \
  && fail "this plugin must not hardcode any consuming repo's reviewer names in code"
echo "PASS: reviewer names come entirely from config — none are hardcoded in the plugin"

# ── 6) --result-pattern으로 판정 어휘를 교체할 수 있다 ────────────────────────────────────────
printf 'PROJ-2\n\nlint-bot\nVERDICT_GREEN\n' > "$DIR/tok.md"
OUT="$(node "$CHECK" --body-file "$DIR/tok.md" --reviewers 'lint-bot' --json)"; rc=$?
[ "$rc" = "1" ] || fail "an unrecognised result token must fail by default, got $rc: $OUT"
OUT="$(node "$CHECK" --body-file "$DIR/tok.md" --reviewers 'lint-bot' --result-pattern 'VERDICT_(GREEN|RED)' --json)"; rc=$?
[ "$rc" = "0" ] || fail "--result-pattern must replace the default token vocabulary, got $rc: $OUT"
echo "PASS: --result-pattern replaces the default result vocabulary"

# ── 7) 이름이 다른 이름의 부분문자열이어도 오탐하지 않는다 ────────────────────────────────────
printf 'PROJ-3\n\nmeta-code-reviewer\nPASS\n' > "$DIR/sub.md"
OUT="$(node "$CHECK" --body-file "$DIR/sub.md" --reviewers 'code-reviewer' --json)"; rc=$?
[ "$rc" = "1" ] || fail "'meta-code-reviewer' must not satisfy 'code-reviewer', got $rc: $OUT"
echo "PASS: a reviewer name embedded in a longer name does not satisfy coverage"

exit 0
