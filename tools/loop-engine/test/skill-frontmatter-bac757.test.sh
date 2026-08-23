#!/usr/bin/env bash
# BAC-757 — locks ship-flow's skill frontmatter modernization: `context: fork` on skills confirmed
# self-contained (verified by reading each SKILL.md end-to-end — no live AskUserQuestion call or
# "confirm/ask the user"-style mid-flow checkpoint whose answer the rest of that same run depends on),
# and its ABSENCE on skills that genuinely interview the user mid-flow (a forked subagent's questions
# never reach the user — see the Agent tool's own fork semantics). Also locks that `setup` points a
# repo at the new risk-rules.example.json template.
#
# Fork-safe (produce a report/result and hand it back; any "ask a human" moment is async — surface a
# candidate list for a LATER, separate review, not a live blocking question this same run needs
# answered to continue): deps-audit, retrospect, resolving-merge-conflicts.
# NOT fork-safe (a literal AskUserQuestion call, or a "confirm with the user"/"ask the user" step this
# same run blocks on before continuing): setup, grill-with-docs, to-issues (the three the issue itself
# names), hotfix (3x AskUserQuestion approval gates), ship-feature (config-fallback question — also the
# plugin's own top-level entrypoint, so forking it doesn't make architectural sense either way),
# harness-maturity-audit ("ask what they want next" branches the rest of the run), improve-codebase-
# architecture ("ask the user: which of these would you like to explore?"), tdd ("confirm with user"
# interface/behavior checkpoint gates writing any code), to-prd ("check with the user" seam-confirmation
# step gates publishing).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HERE/../../ship-flow/skills"
SETUP="$SKILLS/setup/SKILL.md"

fail() { echo "FAIL: $1"; exit 1; }

FORK_SAFE="deps-audit retrospect resolving-merge-conflicts"
NOT_FORK_SAFE="setup grill-with-docs to-issues hotfix ship-feature harness-maturity-audit improve-codebase-architecture tdd to-prd"

for name in $FORK_SAFE; do
  f="$SKILLS/$name/SKILL.md"
  [ -f "$f" ] || fail "missing skill file: $f"
  grep -q '^context: fork$' "$f" || fail "$name/SKILL.md must declare context: fork (confirmed self-contained, no mid-flow user question)"
done
echo "PASS: fork-safe skills ($FORK_SAFE) all declare context: fork"

for name in $NOT_FORK_SAFE; do
  f="$SKILLS/$name/SKILL.md"
  [ -f "$f" ] || fail "missing skill file: $f"
  grep -q '^context: fork$' "$f" && fail "$name/SKILL.md must NOT declare context: fork — it asks the user something mid-flow, which a fork can never surface"
done
echo "PASS: interactive skills ($NOT_FORK_SAFE) correctly do NOT declare context: fork"

# risk-rules.example.json guidance wired into setup
[ -f "$SETUP" ] || fail "missing file: $SETUP"
grep -qi 'risk-rules.example.json' "$SETUP" || fail "setup SKILL.md must offer templates/risk-rules.example.json"
grep -qi 'self-covering' "$SETUP" || fail "setup SKILL.md must call out the example template's self-coverage property (so a repo copy doesn't silently drop it)"
echo "PASS: setup SKILL.md offers risk-rules.example.json and calls out its self-coverage property"

exit 0
