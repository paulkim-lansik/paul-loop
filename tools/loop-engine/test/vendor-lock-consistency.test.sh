#!/usr/bin/env bash
# skills-lock.json records which of this repo's skills are vendored from an upstream project, so an
# upstream-drift round knows what to compare. The failure it exists to prevent is the quiet one: a
# vendored skill moves, is renamed, or is added, the lock is not updated, and the skill simply stops
# being compared. Nothing errors — the drift round just has one fewer entry to walk.
#
# Two directions, both checked:
#   ghost entry  — the lock names a file that isn't there (a move/rename left the lock behind)
#   unregistered — a vendored skill exists but no lock entry covers it (an import skipped the lock)
#
# `computedHash` is the content of the local copy as last reconciled with upstream. It is enforced
# here rather than merely recorded: a mismatch means the local copy was edited since, which is
# exactly the "has local modifications, do not bulk-apply upstream over it" signal the drift
# procedure needs. Recorded-and-unread is how a field like this rots — observed in the consuming
# repo, where 9 of 12 hashes were stale and nothing noticed, because nothing read them.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LOCK="$ROOT/skills-lock.json"

fail() { echo "FAIL: $1"; exit 1; }

[ -f "$LOCK" ] || fail "skills-lock.json not found at $LOCK — vendored skills would be tracked by nothing"

COUNT="$(node -e '
  const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(Object.keys(l.skills || {}).length);
' "$LOCK")" || fail "skills-lock.json is not readable JSON"

# Fail closed: an empty lock is not "nothing vendored, all fine" — it is a check that verified nothing.
[ "${COUNT:-0}" -gt 0 ] || fail "skills-lock.json registers zero skills — either the lock was emptied or it is not being maintained; this check verified nothing"

VIOLATIONS=0

# Direction 1 — every lock entry points at a file that exists, with the content the lock claims.
while IFS=$'\t' read -r name localpath hash; do
  [ -n "$name" ] || continue
  f="$ROOT/$localpath"
  if [ ! -f "$f" ]; then
    echo "  VIOLATION: lock entry '$name' points at $localpath, which does not exist (ghost entry — a move or rename left the lock behind)"
    VIOLATIONS=$((VIOLATIONS + 1)); continue
  fi
  actual="$(shasum -a 256 "$f" | cut -d' ' -f1)"
  if [ "$actual" != "$hash" ]; then
    echo "  VIOLATION: '$name' has been edited since it was last reconciled with upstream ($localpath)"
    echo "             lock: $hash"
    echo "             file: $actual"
    echo "             If the edit is intended, record it by updating computedHash in skills-lock.json."
    VIOLATIONS=$((VIOLATIONS + 1)); continue
  fi
  echo "PASS: $name is registered and matches its recorded content"
done < <(node -e '
  const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const [name, e] of Object.entries(l.skills || {})) {
    const localPath = e.localPath || `.claude/skills/${name}/SKILL.md`;
    process.stdout.write(`${name}\t${localPath}\t${e.computedHash || ""}\n`);
  }
' "$LOCK")

# Direction 2 — a vendored skill with no lock entry. `disable-model-invocation: true` is the marker
# this plugin puts on the skills it took from upstream as user-invoked, so it is the discoverable
# signal; a plugin-native skill never carries it.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -q '^disable-model-invocation: true' "$f" || continue
  rel="${f#$ROOT/}"
  name="$(basename "$(dirname "$f")")"
  node -e '
    const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = (l.skills || {})[process.argv[2]];
    process.exit(e && (e.localPath || `.claude/skills/${process.argv[2]}/SKILL.md`) === process.argv[3] ? 0 : 1);
  ' "$LOCK" "$name" "$rel" && continue
  echo "  VIOLATION: '$name' ($rel) is marked user-invoked like a vendored skill but no lock entry covers it — an upstream-drift round would skip it silently"
  VIOLATIONS=$((VIOLATIONS + 1))
done < <(find "$ROOT/tools" -path '*/skills/*/SKILL.md' -type f 2>/dev/null | sort)

[ "$VIOLATIONS" -eq 0 ] || fail "$VIOLATIONS vendor-lock inconsistency/inconsistencies — a vendored skill would drop out of upstream comparison without anything reporting it"
echo "PASS: every vendored skill is registered and every lock entry resolves ($COUNT checked)"
