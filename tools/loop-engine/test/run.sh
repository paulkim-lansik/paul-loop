#!/usr/bin/env bash
# loop-engine self-test runner — runs every *.test.sh here; non-zero if any fails.
# The verifier machine finally gets a verifier (maturity gap #12). Pure bash + node, no docker:
# wired as the `verify:loop` gate (root package.json) and a CI job.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
total=0

# TOCTOU guard (issue #14 adversarial review): the glob below is evaluated once up front, but
# each file's content is only read at execution time via `bash "$t"`. A test file that is new
# (not present at the PR base, so never force-restored by verifier-pinned-review.sh's
# pinned-baseline check) can run early in this loop and overwrite a not-yet-executed sibling
# *.test.sh file on disk with always-passing content before this loop gets around to running it.
# Hash every discovered file up front, then re-hash immediately before executing each one — a
# mismatch means the file's content changed on disk after the initial scan (tamper), so we fail
# it instead of silently running whatever it now contains. Files stay in place (no copying to a
# scratch dir) because several test files locate sibling paths via `dirname "$0"`.
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

files=()
hashes=()
for t in "$HERE"/*.test.sh; do
  [ -e "$t" ] || continue
  files+=("$t")
  hashes+=("$(hash_file "$t")")
done

i=0
for t in "${files[@]}"; do
  total=$((total + 1))
  recorded="${hashes[$i]}"
  i=$((i + 1))
  current="$(hash_file "$t")"
  if [ "$current" != "$recorded" ]; then
    echo "run.sh: TAMPER DETECTED — $t changed on disk after the initial scan (TOCTOU: an earlier test in this run likely overwrote it); not executing it" >&2
    fails=$((fails + 1))
    continue
  fi
  if ! bash "$t"; then fails=$((fails + 1)); fi
done
echo "loop-engine selftest: $((total - fails))/$total passed"
[ "$fails" -eq 0 ]
