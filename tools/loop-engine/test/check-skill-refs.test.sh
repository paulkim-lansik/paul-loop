#!/usr/bin/env bash
# check-skill-refs.mjs — a skill/agent handoff whose target doesn't exist must be RED, not silent.
#
# Why this gate exists: this plugin deliberately keeps skill-to-skill handoffs (CHANGELOG ship-flow
# 0.5.0 — upstream dropped them as a generic-library concern; a curated plugin ships its own
# siblings). The cost of that choice is one silent failure mode, observed for real in a consuming
# repo on 2026-08-26: four skills delegated to `/grilling`, `/domain-modeling`, `/codebase-design`,
# none installed. Two of them were one-line stubs whose whole body was the dead call, and they
# shadowed working copies — so nothing looked wrong. `dangling-doc-refs.test.sh` misses this: it
# checks file paths, not handoffs.
#
# 계약: skills/agents/workflows의 md에서 위임 참조(`Skill tool with "X"` · `ns:name` · "skill"이
# 있는 줄의 `/name`)를 뽑아 이 레포가 제공하는 스킬·에이전트로 해결되는지 본다. 미해결 exit 1,
# 스캔 자체가 빈 경우(제공자 0 · 문서 0 · 참조 0)는 fail-closed exit 2.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
CHECK="$HERE/../bin/check-skill-refs.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "check-skill-refs.mjs not found at $CHECK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
INJECTED=""
trap 'rm -rf "$DIR"; [ -n "$INJECTED" ] && git -C "$ROOT" checkout -- "$INJECTED" 2>/dev/null; true' EXIT

# 픽스처 하나를 재사용한다 — 케이스는 순차라 host 본문만 갈아끼우면 되고, 케이스마다 트리를
# 새로 만들면 그 I/O가 스위트 전체의 타이밍 예산을 갉아먹는다(같은 러너 안의 타이밍 민감 테스트에
# 실제로 영향이 갔다).
FX=""
mkfixture() {
  local d="$1" body="$2"
  if [ "$d" != "$FX" ]; then
    rm -rf "$d"; mkdir -p "$d/plug/.claude-plugin" "$d/plug/skills/host" "$d/plug/skills/sibling" "$d/plug/agents"
    printf '{"name":"demo"}' > "$d/plug/.claude-plugin/plugin.json"
    printf 'sibling skill body\n' > "$d/plug/skills/sibling/SKILL.md"
    printf 'helper agent body\n' > "$d/plug/agents/helper.md"
    FX="$d"
  fi
  printf '%s\n' "$body" > "$d/plug/skills/host/SKILL.md"
}
run() { node "$CHECK" --root "$1" >"$DIR/out" 2>"$DIR/err"; echo $?; }

# ── 1) 실레포: 전부 해결되고 참조를 실제로 세고 있다 ────────────────────────────────────────
rc="$(run "$ROOT")"
[ "$rc" = "0" ] || fail "this repo's own skill handoffs must resolve, got exit $rc: $(cat "$DIR/err")"
grep -q "PASS: skill-refs" "$DIR/out" || fail "real-repo run printed no PASS line"
node -e '
  const m = require("fs").readFileSync(process.argv[1], "utf8").match(/— (\d+) handoff/);
  if (!m || Number(m[1]) < 5) throw new Error("scanned too few references: " + (m ? m[1] : "none"));
' "$DIR/out" || fail "real-repo run scanned suspiciously few references (a broken extractor also passes)"
echo "PASS: this repo's own skill and agent handoffs all resolve, and the extractor found real references"

# ── 2) 없는 스킬로 위임하면 RED, 그 참조를 이름으로 지목한다 ────────────────────────────────
mkfixture "$DIR/fx" 'Call the Skill tool with "nope".'
[ "$(run "$DIR/fx")" = "1" ] || fail "a handoff to a nonexistent skill must exit 1"
grep -q "nope" "$DIR/err" || fail "the violation must name the unresolved reference"
echo "PASS: a handoff to a skill that does not exist is reported by name"

# ── 3) 존재하는 형제 스킬로의 위임은 통과 ──────────────────────────────────────────────────
mkfixture "$DIR/fx" 'Call the Skill tool with "sibling".'
[ "$(run "$DIR/fx")" = "0" ] || fail "a handoff to an existing sibling skill must pass: $(cat "$DIR/err")"
echo "PASS: a handoff to an existing sibling skill passes"

# ── 4) 에이전트도 해결 대상이다 (스킬만 보면 publisher/planner가 전부 오탐이 된다) ──────────
mkfixture "$DIR/fx" 'Hand off to the `demo:helper` agent.'
[ "$(run "$DIR/fx")" = "0" ] || fail "an agent target must resolve, not be flagged: $(cat "$DIR/err")"
echo "PASS: an agent is a valid handoff target, not a false positive"

# ── 5) 네임스페이스가 붙어도 대상이 없으면 RED ─────────────────────────────────────────────
mkfixture "$DIR/fx" 'See `demo:ghost` for details.'
[ "$(run "$DIR/fx")" = "1" ] || fail "a namespaced reference to a missing target must exit 1"
echo "PASS: a namespaced reference to a missing target is still a violation"

# ── 6) URL 경로는 오탐이 아니다 — "skill"이 없는 줄의 /x 는 세지 않는다 ─────────────────────
mkfixture "$DIR/fx" 'Call the Skill tool with "sibling".
The app serves `/login` and `/healthz` for probes.'
[ "$(run "$DIR/fx")" = "0" ] || fail "a bare URL path must not be treated as a skill reference: $(cat "$DIR/err")"
echo "PASS: a URL path on a line that never says skill is not treated as a handoff"

# ── 7) 같은 문법이라도 "skill"이 있는 줄이면 검사 대상이다 (6번의 대칭) ─────────────────────
mkfixture "$DIR/fx" 'Run the `/ghostly` skill first.'
[ "$(run "$DIR/fx")" = "1" ] || fail "a /name on a line that says skill must be checked"
echo "PASS: …but the same form on a line that says skill is checked"

# ── 8) fail-closed: 제공자가 없으면 통과가 아니라 exit 2 ────────────────────────────────────
mkdir -p "$DIR/f8"
[ "$(run "$DIR/f8")" = "2" ] || fail "a root with no plugin or .claude provider must be fatal, not a silent pass"
echo "PASS: a root where nothing resolves is fatal, not a silent pass"

# ── 9) fail-closed: 스킬은 있는데 문서가 하나도 없으면 exit 2 ──────────────────────────────
rm -rf "$DIR/f9"; mkdir -p "$DIR/f9/plug/.claude-plugin" "$DIR/f9/plug/skills/only"
printf '{"name":"demo"}' > "$DIR/f9/plug/.claude-plugin/plugin.json"
[ "$(run "$DIR/f9")" = "2" ] || fail "providers with zero markdown must be fatal, not a silent pass"
echo "PASS: a provider set with no documents at all is fatal, not a silent pass"

# ── 10) fail-closed: 문서는 있는데 참조가 0건이면 추출기가 깨진 것이다 ──────────────────────
mkfixture "$DIR/fx" 'This skill explains things and hands off to nobody.'
[ "$(run "$DIR/fx")" = "2" ] || fail "zero extracted references must be fatal — a broken extractor also finds zero"
echo "PASS: extracting zero references from real documents is fatal, not a pass"

# ── 11) RED-first on the real tree: 실제 스킬 파일에 죽은 위임을 심으면 이 레포가 RED가 된다 ─
INJECTED="tools/ship-flow/skills/ship-feature/SKILL.md"
printf '\nCall the Skill tool with "__skill_refs_redproof__".\n' >> "$ROOT/$INJECTED"
rc="$(run "$ROOT")"
git -C "$ROOT" checkout -- "$INJECTED" 2>/dev/null; INJECTED=""
[ "$rc" = "1" ] || fail "a dead handoff injected into a real skill must turn this repo RED, got exit $rc"
[ "$(run "$ROOT")" = "0" ] || fail "the repo must be green again once the injected handoff is removed"
echo "PASS: a dead handoff injected into a real skill turns this repo RED, and green again once removed"
