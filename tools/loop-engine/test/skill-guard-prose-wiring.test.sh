#!/usr/bin/env bash
# BAC-755 (ported from glucofit-partners' skill-sentinel-wiring.test.sh §③/④ — the ship-flow-specific
# portions only). Checks that ship-flow's own SKILL.md prose stays consistent with loop-engine's
# reward-hack guard: tdd names the .loop/guard-off escape hatch, ship-feature names the guard concept
# generically (it's repo-agnostic post-BAC-706, so it can't hardcode the literal path), and neither
# ever reintroduces the BAC-583 failure mode (agent-owned prose "arming" via `touch .loop/looping` —
# the guard's actual armed/unarmed state must come from lib/protect-globs.mjs's guardState(), never
# from a skill telling an agent to touch a sentinel file itself).
#
# The consuming repo's local-only loop-fix/SKILL.md (never ported to any plugin) keeps its own
# equivalent checks — that file doesn't exist here to check.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TDD="$HERE/../../ship-flow/skills/tdd/SKILL.md"
SHIP="$HERE/../../ship-flow/skills/ship-feature/SKILL.md"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$TDD" ] || fail "ship-flow tdd SKILL.md not found at $TDD"
[ -f "$SHIP" ] || fail "ship-flow ship-feature SKILL.md not found at $SHIP"

grep -q '\.loop/guard-off' "$TDD" || fail "tdd SKILL.md must mention .loop/guard-off"
echo "PASS: tdd SKILL.md mentions .loop/guard-off"

grep -qi 'reward-hack guard' "$SHIP" || fail "ship-feature SKILL.md must mention the reward-hack guard concept"
grep -qi 'window' "$SHIP" || fail "ship-feature SKILL.md must mention the guard-off window concept"
echo "PASS: ship-feature SKILL.md mentions the reward-hack guard and its window concept"

for f in "$TDD" "$SHIP"; do
  if grep -q 'touch \.loop/looping' "$f"; then
    fail "$f must not reintroduce prose-arming via 'touch .loop/looping' (BAC-583 failure mode)"
  fi
done
echo "PASS: neither SKILL.md reintroduces touch .loop/looping prose-arming"

exit 0
