#!/usr/bin/env bash
# loop-engine self-test runner — runs every *.test.sh here; non-zero if any fails.
# The verifier machine finally gets a verifier (maturity gap #12). Pure bash + node, no docker:
# wired as the `verify:loop` gate (root package.json) and a CI job.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
total=0

# TOCTOU guard, round 2 (issue #14 adversarial review): round 1 defended against an early-running
# sibling *.test.sh overwriting a not-yet-executed sibling on disk by hashing every file up front,
# then re-hashing immediately before executing each one and comparing. That re-check itself was a
# TOCTOU: "re-hash" and "execute" were two separate opens of the same path, with a real gap between
# them for a background process to win — reproduced empirically, a background toggler alternating a
# victim file's content between clean and malicious won roughly half the time.
#
# The fix removes the gap instead of narrowing it. Every *.test.sh file's full content is read into
# memory with exactly one read, in a pass that completes for every file before any test starts
# executing — so an early-running test's write to a not-yet-processed sibling's file on disk can
# never affect what that sibling actually runs; its content was already captured before any test
# (sabotaging or not) got a chance to run. Execution then runs that captured in-memory string
# directly via `bash -c "$content" "$t"` — there is no second open of the path at all, so "the
# content checked" and "the content executed" are the same in-memory string by construction, not
# two reads that could observe different bytes. There is nothing left to hash-compare, so that
# logic is gone entirely rather than narrowed.
#
# `bash -c "$content" "$t"` sets $0 to the literal path string "$t" (the standard
# `bash -c script name` idiom — the argument right after the script text becomes $0, with no
# further positional args here), matching what plain `bash "$t"` used to set $0 to. This matters
# because most test files in this directory locate sibling fixtures via `dirname "$0"`. `bash -c`
# reports $BASH_SOURCE differently than direct file execution would (checked first: no current
# test file in this directory relies on $BASH_SOURCE, only $0).
files=()
contents=()
for t in "$HERE"/*.test.sh; do
  [ -e "$t" ] || continue
  files+=("$t")
  contents+=("$(cat -- "$t")")
done

i=0
for t in "${files[@]}"; do
  total=$((total + 1))
  content="${contents[$i]}"
  i=$((i + 1))
  if ! bash -c "$content" "$t"; then fails=$((fails + 1)); fi
done
echo "loop-engine selftest: $((total - fails))/$total passed"
[ "$fails" -eq 0 ]
