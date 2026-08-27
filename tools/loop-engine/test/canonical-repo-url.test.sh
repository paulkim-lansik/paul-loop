#!/usr/bin/env bash
# Every place this repository names ITSELF must name where it actually lives.
#
# It did not. The clone URL in `setup-loop-engine.action.yml.template` — the one a CONSUMING repo's
# CI runs to fetch and then execute this plugin — pointed at the namespace this repo was transferred
# away from. That resolves today only because GitHub keeps a redirect, and a redirect stops the
# instant anyone creates a repository at the old path. From that moment every consuming repo's CI
# clones and runs whatever is there, and nothing in their diffs changes. The plugin manifests and the
# install instructions in both READMEs had the same stale path.
#
# A gate rather than a one-time correction, because the failure mode is silence: the stale URL worked
# in every test, in CI, and by hand. Nothing would have complained until the day it mattered.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

fail() { echo "FAIL: $1"; exit 1; }

# Derived, not hardcoded: the canonical path is whatever `origin` says, so a future transfer updates
# this gate's expectation by moving the remote — the same act that makes the old path stale.
ORIGIN="$(git -C "$ROOT" remote get-url origin 2>/dev/null)" || ORIGIN=""
[ -n "$ORIGIN" ] || fail "no git origin — this check cannot know the canonical path, and passing anyway would prove nothing"
CANON="$(printf '%s' "$ORIGIN" | sed -e 's#^git@github.com:#https://github.com/#' -e 's#\.git$##' -e 's#^https://github.com/##')"
case "$CANON" in */*) ;; *) fail "could not derive owner/repo from origin '$ORIGIN'" ;; esac
REPO_NAME="${CANON#*/}"

# Any `<owner>/paul-loop` (or github.com/<owner>/paul-loop) that is not the canonical owner.
HITS="$(grep -rnE "(github\.com[:/]|marketplace add )[A-Za-z0-9_-]+/${REPO_NAME}\b" "$ROOT" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null \
  | grep -vF "$CANON" || true)"

if [ -n "$HITS" ]; then
  echo "  A reference names a different owner for this repository than origin does ($CANON):"
  printf '%s\n' "$HITS" | sed "s#^$ROOT/#    #"
  fail "$(printf '%s\n' "$HITS" | wc -l | tr -d ' ') stale self-reference(s) — a clone URL or install instruction that survives only on a GitHub redirect hands the path to whoever claims the old namespace"
fi

# The check must not pass by finding nothing at all — the pattern has to actually match this repo.
FOUND="$(grep -rlE "(github\.com[:/]|marketplace add )[A-Za-z0-9_-]+/${REPO_NAME}\b" "$ROOT" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null | wc -l | tr -d ' ')"
[ "$FOUND" -gt 0 ] || fail "the self-reference pattern matched nothing anywhere — this check verified nothing"

echo "PASS: every self-reference names the canonical repository ($CANON; $FOUND file(s) scanned)"
exit 0
