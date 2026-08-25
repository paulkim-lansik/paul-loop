#!/usr/bin/env bash
# Locks `.github/workflows/tag-on-publish.yml`: it must tag EVERY plugin the marketplace lists, by
# deriving the list at run time rather than carrying its own copy of it.
#
# Why: the workflow exists because a manual step stopped happening silently. A hardcoded plugin list
# inside it reintroduces the same failure one level down — add a fourth plugin, forget to edit this
# workflow, and that plugin's releases go untagged with everything still green. So the property under
# test is not "the workflow mentions three names", it is "the workflow finds whatever is in the
# manifest".
#
# This runs the workflow's actual shell body against a sandbox repo rather than grepping it. Grep
# would pass on a workflow that reads the manifest and then ignores it.
set -uo pipefail
# `$0`, not `$BASH_SOURCE`: run.sh executes each test as `bash -c "$content" "$t"`.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WF="$ROOT/.github/workflows/tag-on-publish.yml"

fail() { echo "FAIL: $1"; exit 1; }

[ -f "$WF" ] || fail "tag-on-publish.yml is missing — published versions go untagged again"

grep -q 'permissions:' "$WF" || fail "workflow declares no permissions block — it would inherit the default token scope while pushing tags"
grep -q 'contents: write' "$WF" || fail "workflow cannot push tags without contents: write"

# Extract the tagging step's shell body: everything indented under its `run: |`, dedented.
SCRIPT="$(awk '
  /^      - name: create missing version tags$/ { step = 1 }
  step && /^        run: \|$/ { body = 1; next }
  body {
    if ($0 !~ /^          / && $0 !~ /^[[:space:]]*$/) exit
    sub(/^          /, "")
    print
  }
' "$WF")"

# A silently-empty extraction would make every assertion below vacuous — the exact failure mode this
# suite exists to prevent. Require it to have found real content.
case "$SCRIPT" in
  *'git tag'*) : ;;
  *) fail "could not extract the tagging step's shell body from $WF (the step name or its indentation changed) — the assertions below would have passed vacuously" ;;
esac

# Comment-stripped, so a comment *explaining* why force is avoided doesn't read as force being used.
if printf '%s\n' "$SCRIPT" | sed 's/[[:space:]]*#.*$//' | grep -qE 'push[^|]*--force|git tag[[:space:]]+-[a-zA-Z]*f'; then
  fail "the tagging step force-updates tags — a published version could be silently repointed at a different commit"
fi

SANDBOX="$(mktemp -d)" || fail "mktemp -d failed — cannot build the hermetic sandbox"
trap 'rm -rf "$SANDBOX"' EXIT

# A fake marketplace with FOUR plugins, deliberately none of them named like the real ones. A
# workflow carrying a hardcoded list of the real names tags nothing here and fails the count below.
mkdir -p "$SANDBOX/repo" && cd "$SANDBOX/repo"
mkdir -p .claude-plugin
cat > .claude-plugin/marketplace.json <<'JSON'
{ "name": "sandbox", "owner": { "name": "t" }, "plugins": [
  { "name": "alpha", "source": "./tools/alpha", "description": "d", "version": "1.0.0" },
  { "name": "beta",  "source": "./tools/beta",  "description": "d", "version": "2.3.4" },
  { "name": "gamma", "source": "./tools/gamma", "description": "d", "version": "0.1.0" },
  { "name": "delta", "source": "./tools/delta", "description": "d", "version": "9.9.9" }
] }
JSON
for p in alpha:1.0.0 beta:2.3.4 gamma:0.1.0 delta:9.9.9; do
  n="${p%%:*}"; v="${p##*:}"
  mkdir -p "tools/$n/.claude-plugin"
  printf '{ "name": "%s", "version": "%s" }\n' "$n" "$v" > "tools/$n/.claude-plugin/plugin.json"
done

git init -q . && git add -A
git -c user.email=t@t -c user.name=t commit -q -m init
# A bare remote so the workflow's `git push origin --tags` has somewhere real to go.
git init -q --bare "$SANDBOX/remote.git"
git remote add origin "$SANDBOX/remote.git"
git push -q origin HEAD:refs/heads/main

# One version is already published — the workflow must leave it alone, not re-tag or fail.
git tag 'beta--v2.3.4'
git push -q origin 'beta--v2.3.4'

SHA="$(git rev-parse HEAD)"
OUT="$(SHA="$SHA" bash -c "$SCRIPT" 2>&1)" || fail "the workflow's tagging step exited non-zero in the sandbox:
$OUT"

for expect in 'alpha--v1.0.0' 'gamma--v0.1.0' 'delta--v9.9.9'; do
  git -C "$SANDBOX/remote.git" rev-parse -q --verify "refs/tags/$expect" >/dev/null \
    || fail "workflow did not publish $expect — it is not deriving the plugin list from marketplace.json (a hardcoded list would miss exactly these). Output:
$OUT"
done

# The pre-existing tag must still point where it did: skipped, never rewritten.
[ "$(git -C "$SANDBOX/remote.git" rev-parse 'beta--v2.3.4')" = "$SHA" ] \
  || fail "workflow moved an already-published tag"

# Idempotence: a second run on the same commit must be a clean no-op, not a push failure. `main`
# gets many pushes between releases, and a workflow that errors on "nothing to do" is a workflow
# people switch off.
OUT2="$(SHA="$SHA" bash -c "$SCRIPT" 2>&1)" || fail "re-running on an already-tagged commit failed:
$OUT2"
case "$OUT2" in
  *'nothing to tag'*) : ;;
  *) fail "second run did not report a no-op — got: $OUT2" ;;
esac

# A manifest listing a plugin whose directory is gone must be a loud error, not a silent skip.
python3 - <<'PY'
import json
p = '.claude-plugin/marketplace.json'
d = json.load(open(p))
d['plugins'].append({"name": "ghost", "source": "./tools/ghost", "description": "d", "version": "1.0.0"})
json.dump(d, open(p, 'w'))
PY
if SHA="$SHA" bash -c "$SCRIPT" >/dev/null 2>&1; then
  fail "a marketplace entry pointing at a missing plugin directory was skipped silently — that is how a plugin stops being tagged without anyone noticing"
fi

echo "PASS: tag-on-publish derives its plugin list from the manifest, skips published versions without rewriting them, no-ops cleanly, and fails loudly on a missing plugin dir"
