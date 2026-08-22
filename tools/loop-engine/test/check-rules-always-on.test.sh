#!/usr/bin/env bash
# BAC-755 (ported from glucofit-partners' check-rules-always-on.test.sh cases 1-8 — synthetic-fixture
# coverage of check-rules-always-on.mjs's own leak-detection logic, which had been living in a
# consuming repo even though none of it reads that repo's actual state). The consuming repo keeps
# only a real-repo assertion ("this repo's own .claude/rules has zero leakage") — that one stays
# local since it's a wiring/state check, not plugin behavior.
#
# 계약: `.claude/rules/**/*.md` 중 (a) frontmatter/paths: 키 없음, (b) paths: 빈 배열, (c) paths:
# 정확히 ["**"]인 파일을 "always-on 잔류"로 집계해 바이트 합계를 리포트한다. 광역 glob("apps/web/**")은
# 해당 안 됨. 리크가 있으면 기본 exit 1(게이트), --report-only는 항상 exit 0.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../bin/check-rules-always-on.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "check-rules-always-on.mjs not found at $CHECK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# ── 1) .claude/rules 디렉터리 자체가 없음 → 0개, exit 0 ─────────────────────────────────────
EMPTY="$DIR/empty-root"
mkdir -p "$EMPTY"
JSON_NONE="$(node "$CHECK" --root "$EMPTY" --json)"; rc=$?
[ "$rc" = "0" ] || fail "missing .claude/rules dir must exit 0, got $rc"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.total_files !== 0) throw new Error("no rules dir must report 0 files, got " + m.total_files);
' "$JSON_NONE" || fail "missing dir report wrong"
echo "PASS: missing .claude/rules directory reports 0 files, exit 0"

# ── 2) 정상 scoped 규칙(광역 glob "apps/web/**" 포함)은 leak 아님 → exit 0 ──────────────────
R="$DIR/root"
mkdir -p "$R/.claude/rules"
printf -- '---\npaths: ["apps/web/**", "apps/admin-web/**"]\n---\n\n# ok\ncontent\n' > "$R/.claude/rules/ok-flow.md"
printf -- '---\npaths:\n  - "apps/api/**"\n---\n\n# ok block style\n' > "$R/.claude/rules/ok-block.md"
JSON_OK="$(node "$CHECK" --root "$R" --json)"; rc=$?
[ "$rc" = "0" ] || fail "fully-scoped rules must exit 0, got $rc"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.total_files !== 2) throw new Error("expected 2 files, got " + m.total_files);
  if (m.leaking_files !== 0) throw new Error("apps/web/** and block-style paths must not leak, got " + m.leaking_files);
  if (m.scoped_files !== 2) throw new Error("both files must count as scoped, got " + m.scoped_files);
' "$JSON_OK" || fail "flow-style and block-style paths: parsing wrong"
echo "PASS: flow-style and block-style paths: (including a apps/web/** double-star glob) are not flagged"

# ── 3) paths: 없음 / 빈 배열 / ["**"] 는 전부 leak → exit 1, 바이트 합계 정확 ─────────────────
L="$DIR/leaky"
mkdir -p "$L/.claude/rules"
printf 'no frontmatter at all\n' > "$L/.claude/rules/no-frontmatter.md"
printf -- '---\nname: has-frontmatter-no-paths\n---\nbody\n' > "$L/.claude/rules/no-paths-key.md"
printf -- '---\npaths: []\n---\nbody\n' > "$L/.claude/rules/empty-paths.md"
printf -- '---\npaths: ["**"]\n---\nbody\n' > "$L/.claude/rules/match-all.md"
EXPECT_BYTES=$(( $(wc -c < "$L/.claude/rules/no-frontmatter.md") + $(wc -c < "$L/.claude/rules/no-paths-key.md") + $(wc -c < "$L/.claude/rules/empty-paths.md") + $(wc -c < "$L/.claude/rules/match-all.md") ))
JSON_LEAK="$(node "$CHECK" --root "$L" --json)"; rc=$?
[ "$rc" = "1" ] || fail "leaking rules must exit 1 by default, got $rc"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.leaking_files !== 4) throw new Error("expected 4 leaking files, got " + m.leaking_files);
  if (m.leaking_bytes !== Number(process.argv[2])) throw new Error("leaking_bytes mismatch: got " + m.leaking_bytes + " want " + process.argv[2]);
  const reasons = m.leaking.map(f => f.reason).sort();
  const want = ["empty-paths", "match-all", "no-frontmatter", "no-paths-key"].sort();
  if (JSON.stringify(reasons) !== JSON.stringify(want)) throw new Error("reason tags wrong: " + JSON.stringify(reasons));
' "$JSON_LEAK" "$EXPECT_BYTES" || fail "leak detection/byte accounting wrong"
echo "PASS: missing frontmatter, missing paths: key, empty array, and [\"**\"] are all flagged with correct byte sum, exit 1"

# ── 4) --report-only는 리크가 있어도 exit 0 (리포트만) ──────────────────────────────────────
node "$CHECK" --root "$L" --report-only --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "--report-only must force exit 0 even with leaks, got $rc"
echo "PASS: --report-only reports leaks without failing the gate"

# ── 5) 사람용 텍스트 출력에 LEAK 라인과 바이트 합계가 보인다 ────────────────────────────────
OUT_TXT="$(node "$CHECK" --root "$L" --report-only)"
printf '%s' "$OUT_TXT" | grep -q "LEAK: .claude/rules/no-frontmatter.md" || fail "text output must list leaking files by relative path"
printf '%s' "$OUT_TXT" | grep -q "always-on 잔류" || fail "text output must report the always-on-leftover summary line"
echo "PASS: human-readable output lists leaking files and the summary line"

# ── 6) 중첩 서브디렉터리도 재귀적으로 스캔한다 ──────────────────────────────────────────────
N="$DIR/nested"
mkdir -p "$N/.claude/rules/backend"
printf -- '---\npaths: ["apps/api/**"]\n---\nok\n' > "$N/.claude/rules/backend/scoped.md"
printf 'no frontmatter, nested\n' > "$N/.claude/rules/backend/leaky.md"
JSON_NESTED="$(node "$CHECK" --root "$N" --json)"; rc=$?
[ "$rc" = "1" ] || fail "nested leak must still exit 1, got $rc"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.total_files !== 2) throw new Error("nested scan must find 2 files, got " + m.total_files);
  if (m.leaking_files !== 1) throw new Error("nested leak must be found, got " + m.leaking_files);
  if (!m.leaking[0].file.includes("backend/leaky.md")) throw new Error("leak path must include the subdirectory, got " + m.leaking[0].file);
' "$JSON_NESTED" || fail "nested subdirectory scanning wrong"
echo "PASS: .claude/rules subdirectories are scanned recursively"

# ── 7) 한 번의 실행에서 scoped와 leaking이 섞여도 양쪽 합계가 독립적으로 정확하다 ─────────────
M="$DIR/mixed"
mkdir -p "$M/.claude/rules"
printf -- '---\npaths: ["apps/web/**"]\n---\nok one\n' > "$M/.claude/rules/scoped-a.md"
printf -- '---\npaths: ["apps/api/**"]\n---\nok two\n' > "$M/.claude/rules/scoped-b.md"
printf -- '---\npaths: ["**"]\n---\nleak\n' > "$M/.claude/rules/leak-a.md"
EXPECT_SCOPED=$(( $(wc -c < "$M/.claude/rules/scoped-a.md") + $(wc -c < "$M/.claude/rules/scoped-b.md") ))
EXPECT_LEAK=$(wc -c < "$M/.claude/rules/leak-a.md")
JSON_MIXED="$(node "$CHECK" --root "$M" --json)"; rc=$?
[ "$rc" = "1" ] || fail "mixed run with any leak must exit 1, got $rc"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.total_files !== 3) throw new Error("mixed run must see 3 files, got " + m.total_files);
  if (m.scoped_files !== 2) throw new Error("mixed run must count 2 scoped files, got " + m.scoped_files);
  if (m.leaking_files !== 1) throw new Error("mixed run must count 1 leaking file, got " + m.leaking_files);
  if (m.scoped_bytes !== Number(process.argv[2])) throw new Error("scoped_bytes wrong: got " + m.scoped_bytes + " want " + process.argv[2]);
  if (m.leaking_bytes !== Number(process.argv[3])) throw new Error("leaking_bytes wrong: got " + m.leaking_bytes + " want " + process.argv[3]);
' "$JSON_MIXED" "$EXPECT_SCOPED" "$EXPECT_LEAK" || fail "mixed scoped+leaking accounting wrong"
echo "PASS: scoped and leaking files are accounted independently within the same run"

# ── 8) exit code follows leak COUNT, not bytes — a 0-byte leaking file must still fail ───────
Z="$DIR/zero-byte"
mkdir -p "$Z/.claude/rules"
: > "$Z/.claude/rules/empty.md"
node "$CHECK" --root "$Z" --json >/dev/null; rc=$?
[ "$rc" = "1" ] || fail "a 0-byte leaking file must still exit 1 (count-based, not bytes-based), got $rc"
echo "PASS: exit code is driven by leak count, not leak byte total (0-byte leaks still fail)"

exit 0
