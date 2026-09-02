#!/usr/bin/env bash
# Gate: a plugin's tree must not differ from its own last-published tag while its version stays put.
#
# `tag-on-publish.yml` closed "a released version has no tag". This closes the level below it: a
# plugin file EDITED without bumping that plugin's version. The edit merges, CI is green, the
# marketplace serves the same version number as before — and the change never reaches a single
# consumer, because a manifest only travels on a NEW version.
#
# Measured 2026-09-02 (PR #90 → #91): loop-engine went to 0.14.0 and every dependent's range was
# widened to `^0.14.0`, loop-memory's manifest included — but loop-memory stayed at 0.6.2. The
# marketplace kept serving 0.6.2, which still declared `^0.13.0`, so loop-engine 0.14.0 became
# unresolvable for everyone:
#   claude plugin update loop-engine@paul-loop
#   ✔ Skipped — conflicting version requirements (no version satisfies all of: ^0.13.0, ^0.14.0)
# A checkmark on a no-op. `plugin-dep-range.test.sh` passed throughout and was right to: it checks
# that the ranges in THIS TREE admit the loop-engine THIS TREE ships, and after the edit they did.
# It has no reach into "an edit that never ships". Nothing else looked either.
#
# The check: for each plugin the marketplace lists, if tag `<name>--v<version>` already exists then
# that exact version is already published — so the plugin's subtree must be byte-identical to what
# that tag holds. Any difference means the working tree is shipping under a version number that
# already means something else. Bump the version (which has no tag yet, so this check goes quiet
# until it is published).
#
# Fail-closed on a missing tag universe: with no `*--v*` tags visible at all (shallow clone, tags
# not fetched) this gate would pass on everything while checking nothing — the exact silence it
# exists to end. It errors instead and says how to fix it.
set -uo pipefail
# `$0`, not `$BASH_SOURCE`: run.sh executes each test as `bash -c "$content" "$t"`.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

fail() { echo "FAIL: $1"; exit 1; }

command -v git >/dev/null 2>&1 || fail "git not available — this gate cannot run"
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || fail "$ROOT is not a git repo — this gate cannot run"

MARKET="$ROOT/.claude-plugin/marketplace.json"
[ -f "$MARKET" ] || fail "marketplace.json missing at $MARKET"

# The plugin list is DERIVED, never hardcoded — same reasoning as tag-on-publish.yml's own comment:
# a hardcoded list reintroduces the identical failure one level down (add a fourth plugin, forget
# this file, and its unbumped edits go unnoticed just as silently).
sources="$(python3 -c '
import json, sys
for p in json.load(open(sys.argv[1]))["plugins"]:
    print(p["source"])
' "$MARKET")" || fail "could not read plugins[].source from marketplace.json"
[ -n "$sources" ] || fail "no plugins found in marketplace.json"

# Fail-closed: no version tags visible at all means this gate is decorative.
if [ -z "$(git -C "$ROOT" tag --list '*--v*' | head -n1)" ]; then
  fail "no '<plugin>--v<semver>' tags are visible — this gate would pass without checking anything. Run 'git fetch origin --tags' (CI: checkout with fetch-depth: 0 or fetch-tags: true)."
fi

stale=0
checked=0
unpublished=0
while IFS= read -r src; do
  [ -n "$src" ] || continue
  dir="${src#./}"
  manifest="$ROOT/$dir/.claude-plugin/plugin.json"
  [ -f "$manifest" ] || fail "marketplace.json lists $src but $manifest does not exist"
  # Path as ARGV, never interpolated into the Python source — `plugins[].source` is a data field any
  # PR can edit (same hardening tag-on-publish.yml carries, and for the same reason).
  read_field() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
  name="$(read_field "$manifest" name)" || fail "could not read name from $manifest"
  version="$(read_field "$manifest" version)" || fail "could not read version from $manifest"
  tag="${name}--v${version}"

  if ! git -C "$ROOT" rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    # This version has never been published — nothing to be stale against. tag-on-publish.yml will
    # create the tag on merge, and from then on this check has a baseline for it.
    echo "  · ${name} ${version}: not yet published (no ${tag}) — nothing to compare"
    unpublished=$((unpublished + 1))
    continue
  fi

  checked=$((checked + 1))
  # Tag vs WORKING TREE (not HEAD): an uncommitted edit needs the bump just as much as a committed
  # one, and saying so before the commit is the whole point of a local gate.
  #
  # TWO probes, because `git diff` alone silently misses the most common plugin change there is.
  # `git diff <tag> -- <dir>` only ever considers TRACKED paths, so a brand-new, not-yet-added file
  # (a new skill, hook, bin tool, or test) reads as "no difference" — measured while building this
  # gate: it passed on the very commit that adds this file. A plugin gaining a file must ship, and
  # therefore must bump, exactly like a plugin whose file changed.
  untracked="$(git -C "$ROOT" ls-files --others --exclude-standard -- "$dir")"
  if ! git -C "$ROOT" diff --quiet "$tag" -- "$dir" || [ -n "$untracked" ]; then
    echo "  ✗ ${name}: tree differs from its own published tag ${tag}, but the version is still ${version}"
    git -C "$ROOT" diff --stat "$tag" -- "$dir" | sed 's/^/      /'
    [ -n "$untracked" ] && printf '%s\n' "$untracked" | sed 's/^/      (new, untracked) /'
    stale=$((stale + 1))
  else
    echo "  · ${name} ${version}: matches ${tag}"
  fi
done <<< "$sources"

if [ "$stale" -gt 0 ]; then
  fail "${stale} plugin(s) edited without a version bump — the marketplace would keep serving the old version and these changes would reach nobody. Bump each plugin.json version (and its marketplace.json entry), and add a CHANGELOG entry."
fi

[ "$((checked + unpublished))" -gt 0 ] || fail "no plugins were examined — the derive step produced nothing"
echo "PASS: every published plugin version still matches its tag (${checked} checked, ${unpublished} awaiting first publish)"
exit 0
