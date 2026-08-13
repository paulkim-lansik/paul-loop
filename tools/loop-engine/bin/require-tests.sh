#!/usr/bin/env bash
# require-tests.sh — fail (loudly) when a verifier would run ZERO tests.
#
# A verifier that certifies PASS while executing no tests is a "false green": the ceiling of the
# loop silently drops to zero exactly where you most need it (docs/verdict-contract.md — the verifier
# is the ceiling). vitest/jest `--passWithNoTests` is the usual culprit. Put this guard BEFORE such a
# runner on any verify step whose whole purpose is to PROVE something (e.g. RLS isolation): if the
# tests that prove it were deleted or never written, the step must go RED, not vacuously green.
#
# Usage: require-tests.sh "<glob>" ["<what this gate proves>"]
#   "<glob>" is matched by basename via find from the current dir (recurses; skips node_modules/.git),
#   which mirrors how vitest's `include: ['**/*.integration.test.ts']` resolves per package.
#   Exits 1 with a curated `FAILED:` line (greppable by the Verdict Contract) when nothing matches;
#   exits 0 otherwise.
set -uo pipefail

glob="${1:?require-tests.sh: a test glob is required (e.g. '**/*.integration.test.ts')}"
label="${2:-this gate}"

base="${glob##*/}"   # '**/*.integration.test.ts' -> '*.integration.test.ts'
count="$(find . -type f -name "$base" 2>/dev/null | grep -vcE '/(node_modules|\.git)/')"

if [ "${count:-0}" -eq 0 ]; then
  echo "FAILED: ${label} matched ZERO tests ('${glob}') — refusing to certify PASS over nothing."
  echo "  A verifier that runs no tests is a false green (verifier=ceiling). Add a real test;"
  echo "  do NOT silence this by re-adding --passWithNoTests."
  exit 1
fi
exit 0
