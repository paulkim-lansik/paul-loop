#!/usr/bin/env bash
# BAC-749 — locks two runtime-verify (ship-feature step 3) evidence-gathering guidelines: prefer an
# accessibility-tree snapshot over a screenshot as observation evidence, and never attach a
# browser-automation MCP that drives the user's own logged-in browser to an autonomous run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIP_FEATURE="$HERE/../../ship-flow/skills/ship-feature/SKILL.md"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$SHIP_FEATURE" ] || fail "missing file: $SHIP_FEATURE"

grep -qi 'accessibility-tree snapshot' "$SHIP_FEATURE" || fail "ship-feature SKILL.md must prefer accessibility-tree snapshots over screenshots as runtime-verify evidence"
grep -qi "user's own" "$SHIP_FEATURE" || fail "ship-feature SKILL.md must warn against attaching a browser-automation MCP bound to the user's own logged-in browser"
echo "PASS: BAC-749 (a11y-snapshot-first evidence + no user-logged-in-browser MCP in autonomous runs) codified in ship-feature step 3"

exit 0
