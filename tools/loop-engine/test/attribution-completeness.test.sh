#!/usr/bin/env bash
# This repo is public and redistributes skills derived from other projects. Those projects' licenses
# (MIT, in every current case) require their copyright and permission notice to travel with any
# substantial portion of the work. NOTICE carries them.
#
# The failure this prevents is drift, not malice: a skill gets vendored, `skills-lock.json` records
# where it came from, NOTICE is not touched, and the repo quietly redistributes one more file without
# attribution. Nothing errors — the lock and NOTICE just stop agreeing. That is how the gap this test
# was written for opened in the first place: 24 lock entries, zero mentions of the upstream author
# anywhere outside prose.
#
# Checked against the lock rather than a hand-kept list, so a new vendored skill is covered the moment
# it is registered.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LOCK="$ROOT/skills-lock.json"
NOTICE="$ROOT/NOTICE"

fail() { echo "FAIL: $1"; exit 1; }

[ -f "$NOTICE" ] || fail "NOTICE not found at $NOTICE — this repo redistributes derived work and must carry its upstreams' notices"
[ -f "$LOCK" ] || fail "skills-lock.json not found — cannot tell what is derived, so attribution cannot be checked"

VIOLATIONS=0

# 1. Every distinct upstream named in the lock has a section in NOTICE.
SOURCES="$(node -e '
  const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const s = new Set(Object.values(l.skills || {}).map((e) => e.source).filter(Boolean));
  process.stdout.write([...s].sort().join("\n") + (s.size ? "\n" : ""));
' "$LOCK")" || fail "skills-lock.json is not readable JSON"

[ -n "$SOURCES" ] || fail "no upstream source recorded in the lock — this check verified nothing"

while IFS= read -r src; do
  [ -n "$src" ] || continue
  if grep -qF "$src" "$NOTICE"; then
    echo "PASS: NOTICE credits $src"
  else
    echo "  VIOLATION: the lock records skills derived from '$src' but NOTICE never names it"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done <<< "$SOURCES"

# 2. Every derived skill is listed by name, so a reader can tell which files the notice covers.
while IFS= read -r name; do
  [ -n "$name" ] || continue
  grep -qF "\`$name\`" "$NOTICE" && continue
  echo "  VIOLATION: '$name' is a derived skill in the lock but NOTICE does not list it"
  VIOLATIONS=$((VIOLATIONS + 1))
done < <(node -e '
  const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(Object.keys(l.skills || {}).sort().join("\n") + "\n");
' "$LOCK")

# 3. The upstream copyright line itself must be present — naming the project is not the same as
#    carrying its notice, and the notice is what the license actually requires.
grep -qE '^Copyright \(c\) .+' "$NOTICE" || {
  echo "  VIOLATION: NOTICE names upstreams but reproduces no upstream copyright line"
  VIOLATIONS=$((VIOLATIONS + 1))
}

[ "$VIOLATIONS" -eq 0 ] || fail "$VIOLATIONS attribution gap(s) — derived work would ship without the notice its license requires"
echo "PASS: every upstream in the lock is credited in NOTICE, with its copyright reproduced"
