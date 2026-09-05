#!/usr/bin/env bash
# Read existing protection and print a reviewable plan by default. Applying requires the exact
# saved plan and its reviewed hash; unspecified existing restrictions are preserved.
# Usage: branch-protect.sh owner/repo branch --require-pr --required-check selftest --output plan.json
# After approval: branch-protect.sh --apply-plan plan.json --approve-plan <plan_hash>
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/branch-protect.mjs" "$@"
