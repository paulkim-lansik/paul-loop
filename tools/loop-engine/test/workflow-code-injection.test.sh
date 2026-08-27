#!/usr/bin/env bash
# A shell variable interpolated into an interpreter's SOURCE TEXT is code injection, not substitution.
#
# `tag-on-publish.yml` did exactly that:
#     name=$(python3 -c "import json;print(json.load(open('$manifest'))['name'])")
# where `$manifest` derives from `plugins[].source` in `.claude-plugin/marketplace.json` — a data field
# any pull request can edit. A single quote in a directory name ends the Python string literal and the
# rest runs as Python, inside a job holding `contents: write` on a public plugin marketplace.
#
# Two things made it invisible rather than obvious, and both argue for a machine check over review
# attention: the payload lives in a *directory name* and a *JSON value*, not in a workflow file, so the
# diff reads as "one more plugin registered"; and `marketplace.json` is not in CODEOWNERS' sensitive
# paths, so `verifier-pinned-review` does not flag it either.
#
# This gate is written against the CLASS. Checking that one line stays fixed would pass the moment the
# same mistake is made in a different workflow, with `node -e`, or with a different variable. The rule
# it enforces has no exceptions worth carving: pass data as ARGV (`python3 -c '...' "$path"`,
# `node -e '...' "$path"`) or on stdin, never by building the program text around it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WF_DIR="$ROOT/.github/workflows"

fail() { echo "FAIL: $1"; exit 1; }
[ -d "$WF_DIR" ] || fail "no .github/workflows directory at $WF_DIR — this check verified nothing"

FILES="$(find "$WF_DIR" -maxdepth 1 -name '*.yml' -o -maxdepth 1 -name '*.yaml' | sort)"
[ -n "$FILES" ] || fail "no workflow files found — this check verified nothing"

VIOLATIONS=0
COUNT=0

# A double-quoted `-c`/`-e` argument is expanded by the shell before the interpreter ever sees it, so a
# `$` inside one is the whole bug. A single-quoted argument is passed through literally — that is the
# safe form, and it is what the fix uses.
while IFS= read -r f; do
  COUNT=$((COUNT + 1))
  while IFS= read -r line; do
    case "$line" in
      *'$'*) ;;                       # has an expansion — keep looking
      *) continue ;;                  # no expansion, nothing to inject
    esac
    echo "  VIOLATION: $(basename "$f"): a shell expansion is built into interpreter source text:"
    echo "             ${line#"${line%%[![:space:]]*}"}"
    echo "             Pass the value as an argument instead: python3 -c '<program>' \"\$var\"  (or node -e '<program>' \"\$var\")"
    VIOLATIONS=$((VIOLATIONS + 1))
  done < <(grep -nE '(python3?|node|ruby|perl|php)[[:space:]]+-(c|e)[[:space:]]*"' "$f" 2>/dev/null || true)
done <<< "$FILES"

[ "$COUNT" -gt 0 ] || fail "scanned zero workflow files — this check verified nothing"
[ "$VIOLATIONS" -eq 0 ] || fail "$VIOLATIONS interpreter-source injection site(s) in .github/workflows — a data field editable by a pull request would become code in CI"
echo "PASS: no workflow builds interpreter source text out of shell expansions ($COUNT file(s) scanned)"
exit 0
