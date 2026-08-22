#!/usr/bin/env bash
# BAC-756 — locks 7 verified-lesson codifications (glucofit-partners, ADR-0034 §9 repo→plugin
# knowledge-ownership routing) into ship-flow's skill/agent prose. Two of the nine lessons the source
# issue listed already carry `challenge.verdict: "reject"` in the source repo's `.loop/lessons/` —
# 8932917806328c0b ("workflow merged===true") and f3f65538bf7d33b6 ("gh pr merge --admin") — and are
# deliberately NOT codified here (CLAUDE.md's own rule: only an accept-passed lesson gets codified).
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

# 0e5154a1/630796f2/92d95548/5b4f4c8b — deep-gate docker isolation, batched into one ship-feature note.
grep -qi 'more than one deep gate in this worktree' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must warn against parallel deep gates in one worktree"
grep -qi 'isolation identifiers' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must warn against dropping isolation identifiers when bypassing a helper"
echo "PASS: 0e5154a1/630796f2/92d95548/5b4f4c8b (deep-gate docker isolation) codified in ship-feature step 2"

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

# 3602ba16 — ADR number collision with a concurrent open PR.
grep -qi 'concurrent work' "$ADR_FORMAT" || fail "ADR-FORMAT.md must document the concurrent-PR ADR-number collision check"
grep -qi 'open PRs' "$ADR_FORMAT" || fail "ADR-FORMAT.md must tell agents to check open PRs before finalizing an ADR number"
echo "PASS: 3602ba16 (ADR number collision across concurrent PRs) codified in ADR-FORMAT.md"

# 38e9a48c/53da49e1 — namespace migration grep-sweep discipline (repo-wide-from-the-start + raw-substring re-grep).
grep -qi 'repo-wide-from-the-start' "$SETUP" || fail "setup SKILL.md must document the repo-wide-from-the-start sweep habit"
grep -qi 'raw renamed substring' "$SETUP" || fail "setup SKILL.md must document the raw-substring re-grep habit for differently-escaped siblings"
echo "PASS: 38e9a48c/53da49e1 (namespace migration grep-sweep discipline) codified in setup SKILL.md"

exit 0
