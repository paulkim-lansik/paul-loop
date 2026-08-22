#!/usr/bin/env bash
# BAC-754 (ported from glucofit-partners' docs-hygiene.test.sh cases 1-13b — bin/check-docs-hygiene.mjs
# is a synthetic-fixture-testable plugin bin, not consumer-repo state; case 14 (asserting THIS repo's
# own docs/adr + CLAUDE.md are clean) stayed local — a real-repo-state assertion isn't portable).
#
# 계약: docs/adr/ 번호 유일성 + README.md 인덱스 완전성(양방향) + CLAUDE.md·docs/adr/**의 dangling
# 링크/(CLAUDE.md만) dangling 백틱 경로는 FAIL(exit 1). SKILL.md 단어수 상한은 WARN만 — exit code에
# 반영 안 됨(예방 가드로 시작).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../bin/check-docs-hygiene.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "check-docs-hygiene.mjs not found at $CHECK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

mk_readme() {
  # $1 = target root, $2... = "NNNN|제목|상태" 행
  local root="$1"; shift
  {
    echo "# ADR"
    echo ""
    echo "| # | 결정 | 상태 |"
    echo "|---|---|---|"
    for row in "$@"; do
      IFS='|' read -r num title status <<<"$row"
      echo "| [$num](./$num-x.md) | $title | $status |"
    done
  } > "$root/docs/adr/README.md"
}

# ── 1) 정상 코퍼스(연속 번호·중복 없음·README 완전) → exit 0, FAIL 0 ────────────────────────────
OK="$DIR/ok"
mkdir -p "$OK/docs/adr"
printf '# ADR-0001\n' > "$OK/docs/adr/0001-x.md"
printf '# ADR-0002\n' > "$OK/docs/adr/0002-x.md"
printf '# ADR-0000 template\n' > "$OK/docs/adr/0000-template.md"
mk_readme "$OK" "0001|a|승인됨" "0002|b|승인됨"
OUT_OK="$(node "$CHECK" --root "$OK" --json)"; rc=$?
[ "$rc" = "0" ] || fail "clean corpus must exit 0, got $rc: $OUT_OK"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.failures.length !== 0) throw new Error("clean corpus must have 0 failures, got " + JSON.stringify(m.failures));
' "$OUT_OK" || fail "clean corpus JSON wrong"
echo "PASS: sequential, duplicate-free ADR corpus with a complete README index exits 0"

# ── 2) 0000-template.md은 번호 유일성/README 완전성 검사에서 제외된다 ───────────────────────────
# (위 OK 픽스처가 이미 0000을 갖고도 통과했다는 사실 자체가 증거 — 별도 assert 불필요)

# ── 3) ADR 번호 중복 → FAIL ──────────────────────────────────────────────────────────────────
DUP="$DIR/dup"
mkdir -p "$DUP/docs/adr"
printf '# a\n' > "$DUP/docs/adr/0001-a.md"
printf '# b\n' > "$DUP/docs/adr/0001-x.md"
mk_readme "$DUP" "0001|a|승인됨"
OUT_DUP="$(node "$CHECK" --root "$DUP" --json)"; rc=$?
[ "$rc" = "1" ] || fail "duplicate ADR number must exit 1, got $rc"
printf '%s' "$OUT_DUP" | grep -q 'adr-number-uniqueness' || fail "duplicate must be tagged adr-number-uniqueness"
echo "PASS: duplicate ADR numbers are flagged with exit 1"

# ── 4) ADR 번호 결번(중간에 구멍) → FAIL ─────────────────────────────────────────────────────
GAP="$DIR/gap"
mkdir -p "$GAP/docs/adr"
printf '# a\n' > "$GAP/docs/adr/0001-x.md"
printf '# c\n' > "$GAP/docs/adr/0003-x.md"
mk_readme "$GAP" "0001|a|승인됨" "0003|c|승인됨"
OUT_GAP="$(node "$CHECK" --root "$GAP" --json)"; rc=$?
[ "$rc" = "1" ] || fail "gap in ADR numbering must exit 1, got $rc"
printf '%s' "$OUT_GAP" | grep -q 'adr-number-gaps' || fail "gap must be tagged adr-number-gaps"
printf '%s' "$OUT_GAP" | grep -q '0002' || fail "gap detail must name the missing number 0002"
echo "PASS: a gap in ADR numbering (0001, 0003 — no 0002) is flagged with exit 1"

# ── 5) README 인덱스 누락(파일은 있는데 표에 없음) → FAIL (BAC-551 48시간 재발의 실제 형태) ────
MISS="$DIR/missing-from-readme"
mkdir -p "$MISS/docs/adr"
printf '# a\n' > "$MISS/docs/adr/0001-x.md"
printf '# b\n' > "$MISS/docs/adr/0002-b.md"
mk_readme "$MISS" "0001|a|승인됨"
OUT_MISS="$(node "$CHECK" --root "$MISS" --json)"; rc=$?
[ "$rc" = "1" ] || fail "ADR missing from README index must exit 1, got $rc"
printf '%s' "$OUT_MISS" | grep -q 'adr-readme-index-completeness' || fail "must be tagged adr-readme-index-completeness"
printf '%s' "$OUT_MISS" | grep -q '0002' || fail "detail must name the missing number 0002"
echo "PASS: an ADR file present but missing from README.md's index is flagged with exit 1"

# ── 6) README이 존재하지 않는 파일을 가리킴(반대 방향) → FAIL ──────────────────────────────────
STALE="$DIR/stale-readme"
mkdir -p "$STALE/docs/adr"
printf '# a\n' > "$STALE/docs/adr/0001-x.md"
mk_readme "$STALE" "0001|a|승인됨" "0002|ghost|승인됨"
OUT_STALE="$(node "$CHECK" --root "$STALE" --json)"; rc=$?
[ "$rc" = "1" ] || fail "README pointing at a nonexistent ADR must exit 1, got $rc"
printf '%s' "$OUT_STALE" | grep -q '존재하지 않는 파일을 가리킴' || fail "must report the reverse-direction stale-index case"
echo "PASS: README.md indexing a number with no matching file is flagged with exit 1"

# ── 7) CLAUDE.md의 dangling 마크다운 링크 → FAIL ────────────────────────────────────────────
DLINK="$DIR/dangling-link"
mkdir -p "$DLINK/docs/adr"
printf -- '# CLAUDE\n\nSee [ghost](./docs/does-not-exist.md) for details.\n' > "$DLINK/CLAUDE.md"
OUT_DLINK="$(node "$CHECK" --root "$DLINK" --json)"; rc=$?
[ "$rc" = "1" ] || fail "dangling markdown link in CLAUDE.md must exit 1, got $rc"
printf '%s' "$OUT_DLINK" | grep -q 'dangling-reference' || fail "must be tagged dangling-reference"
echo "PASS: a markdown link in CLAUDE.md pointing nowhere is flagged with exit 1"

# ── 8) 유효한 상대 링크는 통과한다 ───────────────────────────────────────────────────────────
VLINK="$DIR/valid-link"
mkdir -p "$VLINK/docs/adr"
printf '# target\n' > "$VLINK/docs/adr/0001-x.md"
printf -- '# CLAUDE\n\nSee [target](./docs/adr/0001-x.md).\n' > "$VLINK/CLAUDE.md"
mk_readme "$VLINK" "0001|target|승인됨"
node "$CHECK" --root "$VLINK" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "a link to a file that actually exists must not fail, got $rc"
echo "PASS: a markdown link that resolves to a real file does not fail the gate"

# ── 9) CLAUDE.md의 dangling 백틱 경로(알려진 레포 prefix로 시작) → FAIL ─────────────────────────
DTICK="$DIR/dangling-tick"
mkdir -p "$DTICK/docs/adr"
printf -- '# CLAUDE\n\nSee `apps/api/src/does-not-exist.ts` for the pattern.\n' > "$DTICK/CLAUDE.md"
OUT_DTICK="$(node "$CHECK" --root "$DTICK" --json)"; rc=$?
[ "$rc" = "1" ] || fail "dangling backtick repo-path in CLAUDE.md must exit 1, got $rc"
printf '%s' "$OUT_DTICK" | grep -q 'apps/api/src/does-not-exist.ts' || fail "detail must name the missing path"
echo "PASS: a backtick-quoted repo path in CLAUDE.md pointing nowhere is flagged with exit 1"

# ── 10) 같은 줄에 부정 단서("더 이상 없다" 등)가 있으면 억제된다 — 의도적 부재 서술 ─────────────
NEG="$DIR/negation"
mkdir -p "$NEG/docs/adr"
printf -- '# CLAUDE\n\n로컬 `apps/api/src/does-not-exist.ts`는 더 이상 없다.\n' > "$NEG/CLAUDE.md"
node "$CHECK" --root "$NEG" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "a same-line negation cue must suppress the dangling backtick finding, got $rc"
echo "PASS: '...는 더 이상 없다' on the same line suppresses a deliberate non-existence note"

# ── 10b) 같은 경로가 부정 단서 있는 줄과 없는 줄에 둘 다 등장하면, 순서와 무관하게 진짜 stale
#         언급은 여전히 잡혀야 한다 — 먼저 스캔된 억제 언급이 dedup으로 뒤의 진짜 실패를 삼키면 안
#         된다(test-hunter 발견: negation-cue 체크 전에 dedup Set에 추가하던 버그) ─────────────
DUPNEG="$DIR/dup-negation-order"
mkdir -p "$DUPNEG/docs/adr"
printf -- '# CLAUDE\n\n로컬 `apps/api/src/does-not-exist.ts`는 더 이상 없다.\n나중에 다시 쓴다: `apps/api/src/does-not-exist.ts`를 참고할 것.\n' > "$DUPNEG/CLAUDE.md"
OUT_DUPNEG="$(node "$CHECK" --root "$DUPNEG" --json)"; rc=$?
[ "$rc" = "1" ] || fail "a real (non-negated) mention of a path must still fail even if an earlier negated mention of the SAME path exists, got $rc"
printf '%s' "$OUT_DUPNEG" | grep -q 'apps/api/src/does-not-exist.ts' || fail "detail must name the missing path"
echo "PASS: a genuine dangling mention is caught even when a negated mention of the same path appears earlier in the file"

# ── 11) glob 백틱 스팬(**)은 경로로 취급되지 않는다 ──────────────────────────────────────────
GLOB="$DIR/glob"
mkdir -p "$GLOB/docs/adr"
printf -- '# CLAUDE\n\n`apps/web/**` import는 금지.\n' > "$GLOB/CLAUDE.md"
node "$CHECK" --root "$GLOB" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "a glob-style backtick span (apps/web/**) must not be treated as a literal path, got $rc"
echo "PASS: glob-style backtick spans (containing *) are not checked as literal paths"

# ── 12) docs/adr/**의 dangling 백틱 경로는 검사 대상이 아니다 — ADR은 역사 기록(스냅샷)이라 ─────
#       구현 파일이 나중에 삭제/이동돼도 정상. 링크는 여전히 검사한다(같은 파일에서 확인).
ADRHIST="$DIR/adr-history"
mkdir -p "$ADRHIST/docs/adr"
printf '# a\n' > "$ADRHIST/docs/adr/0001-x.md"
printf -- '# ADR-0002\n\n참고 코드는 `apps/api/src/long-deleted-file.ts`였다.\n' > "$ADRHIST/docs/adr/0002-x.md"
mk_readme "$ADRHIST" "0001|a|승인됨" "0002|b|승인됨"
node "$CHECK" --root "$ADRHIST" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "a dangling backtick path inside docs/adr/**/*.md (historical record) must not fail, got $rc"
echo "PASS: docs/adr/**/*.md backtick paths are exempt from the dangling check (ADRs are historical snapshots)"

ADRHISTLINK="$DIR/adr-history-link"
mkdir -p "$ADRHISTLINK/docs/adr"
printf '# a\n' > "$ADRHISTLINK/docs/adr/0001-x.md"
printf -- '# ADR-0002\n\nSee [ghost](./0999-ghost.md).\n' > "$ADRHISTLINK/docs/adr/0002-x.md"
mk_readme "$ADRHISTLINK" "0001|a|승인됨" "0002|b|승인됨"
OUT_ADRHISTLINK="$(node "$CHECK" --root "$ADRHISTLINK" --json)"; rc=$?
[ "$rc" = "1" ] || fail "a dangling markdown LINK inside an ADR file must still fail (links are always checked), got $rc"
echo "PASS: markdown links inside docs/adr/**/*.md are still checked (only backtick paths are exempt there)"

# ── 12c) reference-style 링크 정의(`[label]: path`)도 검사한다 ───────────────────────────────
REFDEF="$DIR/ref-def"
mkdir -p "$REFDEF/docs/adr"
printf -- '# CLAUDE\n\nSee [ghost][1].\n\n[1]: ./docs/does-not-exist.md\n' > "$REFDEF/CLAUDE.md"
OUT_REFDEF="$(node "$CHECK" --root "$REFDEF" --json)"; rc=$?
[ "$rc" = "1" ] || fail "a dangling reference-style link definition must exit 1, got $rc"
printf '%s' "$OUT_REFDEF" | grep -q 'dangling-reference' || fail "must be tagged dangling-reference"
echo "PASS: a dangling reference-style link definition ([label]: path) is flagged with exit 1"

# ── 12d) 경로 해석 경계 케이스 — 절대경로 스타일 링크, title 텍스트, 앵커전용/앵커접미 링크 ─────
EDGE="$DIR/path-edges"
mkdir -p "$EDGE/docs/adr"
printf '# target\n' > "$EDGE/docs/adr/0001-x.md"
mk_readme "$EDGE" "0001|target|승인됨"
printf -- '%s\n' \
  '# CLAUDE' '' \
  'absolute-style: [a](/docs/adr/0001-x.md)' \
  'title text: [b](./docs/adr/0001-x.md "Some Title")' \
  'anchor-only: [c](#자체-섹션)' \
  'anchor-suffixed, existing file: [d](./docs/adr/0001-x.md#heading)' \
  > "$EDGE/CLAUDE.md"
node "$CHECK" --root "$EDGE" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "absolute-style links, titled links, anchor-only links, and anchor-suffixed links to real files must all pass, got $rc"
echo "PASS: absolute-style links, link titles, anchor-only links, and anchor-suffixed real-file links all resolve correctly"

EDGEBAD="$DIR/path-edges-bad"
mkdir -p "$EDGEBAD/docs/adr"
printf -- '# CLAUDE\n\nanchor-suffixed, missing file: [d](./docs/adr/0999-ghost.md#heading)\n' > "$EDGEBAD/CLAUDE.md"
node "$CHECK" --root "$EDGEBAD" --json >/dev/null; rc=$?
[ "$rc" = "1" ] || fail "an anchor-suffixed link to a MISSING file must still fail, got $rc"
echo "PASS: an anchor-suffixed link to a missing file still fails (the anchor doesn't hide a bad path)"

# ── 12e) scheme-prefixed 링크(http/https/mailto)는 경로로 취급되지 않는다 ───────────────────────
SCHEME="$DIR/scheme"
mkdir -p "$SCHEME/docs/adr"
printf -- '# CLAUDE\n\n[a](https://example.com/apps/ghost.ts) [b](mailto:x@example.com)\n' > "$SCHEME/CLAUDE.md"
node "$CHECK" --root "$SCHEME" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "http(s):// and mailto: links must be excluded from path resolution, got $rc"
echo "PASS: scheme-prefixed links (http/https/mailto) are excluded from filesystem resolution"

# ── 12f) 줄번호 접미 백틱 경로(file.ts:12-34)는 접미를 떼고 실제 파일 존재로 판정한다 ────────────
LNSUFFIX="$DIR/line-number-suffix"
mkdir -p "$LNSUFFIX/docs/adr" "$LNSUFFIX/apps/api/src"
printf 'export {}\n' > "$LNSUFFIX/apps/api/src/real.ts"
printf -- '# CLAUDE\n\nSee `apps/api/src/real.ts:12-34` for the pattern.\n' > "$LNSUFFIX/CLAUDE.md"
node "$CHECK" --root "$LNSUFFIX" --json >/dev/null; rc=$?
[ "$rc" = "0" ] || fail "a line-number-suffixed backtick path to a real file must not fail, got $rc"
echo "PASS: a line-number suffix (file.ts:12-34) on a backtick path is stripped before existence is checked"

LNSUFFIXBAD="$DIR/line-number-suffix-bad"
mkdir -p "$LNSUFFIXBAD/docs/adr"
printf -- '# CLAUDE\n\nSee `apps/api/src/ghost.ts:12-34` for the pattern.\n' > "$LNSUFFIXBAD/CLAUDE.md"
node "$CHECK" --root "$LNSUFFIXBAD" --json >/dev/null; rc=$?
[ "$rc" = "1" ] || fail "a line-number-suffixed backtick path to a MISSING file must still fail, got $rc"
echo "PASS: a line-number suffix on a backtick path to a missing file still fails"

# ── 13) SKILL.md 단어수 상한은 WARN만 — target/max 초과해도 exit code는 0 ──────────────────────
SKILLWARN="$DIR/skill-warn"
mkdir -p "$SKILLWARN/.claude/skills/big/"
node -e 'process.stdout.write(Array(2100).fill("word").join(" "))' > "$SKILLWARN/.claude/skills/big/SKILL.md"
OUT_SKILLWARN="$(node "$CHECK" --root "$SKILLWARN" --json)"; rc=$?
[ "$rc" = "0" ] || fail "SKILL.md over the word target must still exit 0 (WARN tier only), got $rc"
printf '%s' "$OUT_SKILLWARN" | grep -q 'skill-word-cap' || fail "must report a skill-word-cap warning"
echo "PASS: a SKILL.md over the 2,000-word target is reported as a warning but does not fail the gate"

SKILLOVERMAX="$DIR/skill-over-max"
mkdir -p "$SKILLOVERMAX/.claude/skills/huge/"
node -e 'process.stdout.write(Array(5100).fill("word").join(" "))' > "$SKILLOVERMAX/.claude/skills/huge/SKILL.md"
OUT_SKILLOVERMAX="$(node "$CHECK" --root "$SKILLOVERMAX" --json)"; rc=$?
[ "$rc" = "0" ] || fail "SKILL.md over the 5,000-word max must still exit 0 (WARN-only preventive guard, BAC-574), got $rc"
printf '%s' "$OUT_SKILLOVERMAX" | grep -q '공식 상한' || fail "over-max warning must use the distinct '공식 상한' wording, not the target wording"
echo "PASS: a SKILL.md over the 5,000-word official max is still WARN-only (not yet promoted to a gate)"

# ── 13b) 경계값(정확히 2,000/5,000 단어) — >= 판정 회귀 잠금 + target/max 두 티어 메시지가
#         실제로 구분됨을 확인 ─────────────────────────────────────────────────────────────────
SKILLBELOW="$DIR/skill-below-target"
mkdir -p "$SKILLBELOW/.claude/skills/s/"
node -e 'process.stdout.write(Array(1999).fill("word").join(" "))' > "$SKILLBELOW/.claude/skills/s/SKILL.md"
OUT_SKILLBELOW="$(node "$CHECK" --root "$SKILLBELOW" --json)"; rc=$?
[ "$rc" = "0" ] || fail "1999 words (just under target) must not warn, got exit $rc"
node -e '
  const m = JSON.parse(process.argv[1]);
  if (m.warnings.length !== 0) throw new Error("1999 words must not warn, got " + JSON.stringify(m.warnings));
' "$OUT_SKILLBELOW" || fail "1999-word SKILL.md must produce zero warnings"
echo "PASS: a SKILL.md at 1,999 words (just under target) produces no warning"

SKILLATTARGET="$DIR/skill-at-target"
mkdir -p "$SKILLATTARGET/.claude/skills/s/"
node -e 'process.stdout.write(Array(2000).fill("word").join(" "))' > "$SKILLATTARGET/.claude/skills/s/SKILL.md"
OUT_SKILLATTARGET="$(node "$CHECK" --root "$SKILLATTARGET" --json)"
printf '%s' "$OUT_SKILLATTARGET" | grep -q '공식 target' || fail "exactly 2000 words must warn at the target tier (>= boundary)"
printf '%s' "$OUT_SKILLATTARGET" | grep -q '공식 상한' && fail "exactly 2000 words must NOT warn at the max tier"
echo "PASS: a SKILL.md at exactly 2,000 words warns at the target tier (>= boundary), not the max tier"

SKILLATMAX="$DIR/skill-at-max"
mkdir -p "$SKILLATMAX/.claude/skills/s/"
node -e 'process.stdout.write(Array(5000).fill("word").join(" "))' > "$SKILLATMAX/.claude/skills/s/SKILL.md"
OUT_SKILLATMAX="$(node "$CHECK" --root "$SKILLATMAX" --json)"
printf '%s' "$OUT_SKILLATMAX" | grep -q '공식 상한' || fail "exactly 5000 words must warn at the max tier (>= boundary)"
echo "PASS: a SKILL.md at exactly 5,000 words warns at the max tier (>= boundary)"

# ── 14) paul-loop 자신의 docs/adr/도 이 게이트의 실사용자다 — 이 레포에 대해 항상 통과해야 한다
#       (BAC-754 AC: "업스트림 자체 docs/adr/에 대해 docs-hygiene이 통과") ───────────────────────
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
OUT_REAL="$(node "$CHECK" --root "$REPO_ROOT" --json)"; rc=$?
[ "$rc" = "0" ] || fail "paul-loop's own docs/adr/ must have zero dangling-reference/index failures, got exit $rc: $OUT_REAL"
echo "PASS: paul-loop's own docs/adr/ numbering and references are clean (real gate, not just fixtures)"

exit 0
