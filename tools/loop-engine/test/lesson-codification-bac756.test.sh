#!/usr/bin/env bash
# BAC-756 — locks verified-lesson codifications (glucofit-partners, ADR-0034 §9 repo→plugin
# knowledge-ownership routing) into ship-flow's skill/agent prose.
#
# Correction (BAC-756 follow-up, fix/bac756-challenge-correction): the initial PR#50 codification ran
# BEFORE an independent challenge pass instead of after (CLAUDE.md's own rule: only an accept-passed
# lesson gets codified). A skeptical review run afterward rejected 5 of the 9 candidates as too
# repo-specific, too thin (count=1, single review finding), or already-covered by a stricter existing
# policy — 3602ba166619af93 (ADR-number collision, already covered by CLAUDE.md §8's own worktree-scan
# rule), 630796f2f488f993 (deep-gate container race, a near-duplicate of the already-accepted 0e5154a1
# tied to this repo's non-portable container-naming script), 92d95548aad4ebf4 (stale docker volume after
# migration change, restates Postgres's own documented init-script behavior), 5b4f4c8ba005695f (preserve
# isolation env vars when bypassing a helper — too thin/generic at count=1), and 38e9a48c3659de1d
# (grep-whole-repo-before-narrowing — too obvious to be worth a permanent doc entry). Their prose was
# reverted from ship-feature/SKILL.md, setup/SKILL.md, and ADR-FORMAT.md; this test's PASS blocks for
# them were removed and replaced with regression guards below. Two more of the nine —
# 8932917806328c0b ("workflow merged===true") and f3f65538bf7d33b6 ("gh pr merge --admin") — already
# carried `challenge.verdict: "reject"` in the source repo's `.loop/lessons/` before this issue started
# and were never codified. That leaves 4 accept-passed codifications actually locked below: 07bc4859
# (pre-existing accept), 15c8b2ca, 1a5200e3, fb72c699, plus 53da49e1's half of the namespace-migration
# section.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIP_FEATURE="$HERE/../../ship-flow/skills/ship-feature/SKILL.md"
HOTFIX="$HERE/../../ship-flow/skills/hotfix/SKILL.md"
CODE_REVIEWER="$HERE/../../ship-flow/agents/code-reviewer.md"
ADR_FORMAT="$HERE/../../ship-flow/skills/grill-with-docs/ADR-FORMAT.md"
SETUP="$HERE/../../ship-flow/skills/setup/SKILL.md"

fail() { echo "FAIL: $1"; exit 1; }
for f in "$SHIP_FEATURE" "$HOTFIX" "$CODE_REVIEWER" "$ADR_FORMAT" "$SETUP"; do
  [ -f "$f" ] || fail "missing file: $f"
done

# 07bc4859 — stacked PR + squash-merge retarget, in both ship-feature and hotfix's failure-handling text.
grep -qi 'stacked PR' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must document the stacked-PR retarget gotcha"
grep -q 'git show origin/<base>' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must tell agents to verify landing beyond the MERGED badge"
grep -qi 'stacked' "$HOTFIX" || fail "hotfix SKILL.md must document the stacked-PR retarget gotcha"
echo "PASS: 07bc4859 (stacked PR + squash-merge retarget) codified in ship-feature and hotfix"

# 0e5154a1 — deep-gate docker container race (pre-existing accept, already retired against ADR-0054).
grep -qi 'more than one deep gate in this worktree' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must warn against parallel deep gates in one worktree"
echo "PASS: 0e5154a1 (deep-gate docker container race) codified in ship-feature step 2"
# 92d95548/5b4f4c8b — rejected; must not have been re-added.
grep -qi 'isolation identifiers' "$SHIP_FEATURE" && fail "ship-feature SKILL.md must not re-add the rejected isolation-identifiers note (5b4f4c8b)"
grep -qi 'clean that resource before re-verifying' "$SHIP_FEATURE" && fail "ship-feature SKILL.md must not re-add the rejected stale-volume note (92d95548)"
echo "PASS: 92d95548/5b4f4c8b correctly excluded from ship-feature step 2"

# 15c8b2ca — MCP browser fallback in runtime-verify.
grep -qi 'browser-automation MCP is unavailable' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must document the MCP-unavailable browser fallback"
echo "PASS: 15c8b2ca (MCP browser fallback) codified in ship-feature step 3"

# 1a5200e3 — macOS ACL deny-delete blocking git worktree remove.
grep -q 'chmod -R -N' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must cross-reference the macOS ACL worktree-remove fix"
grep -q 'chmod -R -N' "$HOTFIX" || fail "hotfix SKILL.md must document the macOS ACL worktree-remove fix"
echo "PASS: 1a5200e3 (macOS ACL blocks git worktree remove) codified in ship-feature and hotfix"

# fb72c699 — reviewer subagent has no web access, shouldn't BLOCK on spec questions as settled fact.
grep -qi 'no web access' "$CODE_REVIEWER" || fail "code-reviewer.md must caution that it has no web access"
echo "PASS: fb72c699 (reviewer no-web-access caution) codified in agents/code-reviewer.md"

# 3602ba16 — rejected; already covered by CLAUDE.md §8's own worktree-scan rule. Must not be re-added.
grep -qi 'concurrent work' "$ADR_FORMAT" && fail "ADR-FORMAT.md must not re-add the rejected concurrent-PR ADR-number-collision note (3602ba16)"
echo "PASS: 3602ba16 correctly excluded from ADR-FORMAT.md"

# 53da49e1 — namespace migration raw-substring re-grep habit.
grep -qi 'raw renamed substring' "$SETUP" || fail "setup SKILL.md must document the raw-substring re-grep habit for differently-escaped siblings"
echo "PASS: 53da49e1 (raw-substring re-grep habit) codified in setup SKILL.md"
# 38e9a48c — rejected (too obvious); must not have been re-added.
grep -qi 'repo-wide-from-the-start' "$SETUP" && fail "setup SKILL.md must not re-add the rejected repo-wide-from-the-start sweep habit (38e9a48c)"
echo "PASS: 38e9a48c correctly excluded from setup SKILL.md"

exit 0
