#!/usr/bin/env bash
# loop-engine self-test runner — runs every *.test.sh here; non-zero if any fails.
# The verifier machine finally gets a verifier (maturity gap #12). Pure bash + node, no docker:
# wired as the `verify:loop` gate (root package.json) and a CI job.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
total=0
for t in "$HERE"/*.test.sh; do
  [ -e "$t" ] || continue
  total=$((total + 1))
  if ! bash "$t"; then fails=$((fails + 1)); fi
done
echo "loop-engine selftest: $((total - fails))/$total passed"
[ "$fails" -eq 0 ]
