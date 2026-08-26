#!/usr/bin/env bash
# A sibling plugin's declared dependency range must admit the loop-engine version this repo
# actually ships. Bumping loop-engine's minor while dependents still pin `^0.10.0` does not fail
# anywhere — `claude plugin update` reports success and quietly keeps the old version, because the
# caret range on a 0.x line excludes the next minor. The new loop-engine is then published,
# downloaded into the plugin cache, and unreachable to every consumer, with nothing reporting it.
#
# Observed 2026-08-26: loop-engine 0.11.0 (the check-skill-refs gate) shipped in PR #70 while
# ship-flow 0.6.0 and loop-memory 0.4.1 both declared `^0.10.0`. `claude plugin update` printed
# "already at the latest version satisfying ^0.10.0, ^0.10.0 (0.10.3, required by ship-flow,
# loop-memory)" and the consuming repo kept resolving 0.10.3.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

fail() { echo "FAIL: $1"; exit 1; }

ENGINE_MANIFEST="$ROOT/tools/loop-engine/.claude-plugin/plugin.json"
[ -f "$ENGINE_MANIFEST" ] || fail "loop-engine manifest not found at $ENGINE_MANIFEST"

# Ranges are checked in node: this repo has no semver dependency and must not grow one for a gate.
# Only the forms this repo actually uses are understood; anything else is a hard error rather than a
# silent pass, since an unrecognised range is exactly how this check would stop checking.
check() { # $1=range $2=version -> prints "yes"/"no", or exits non-zero on an unknown form
  node --input-type=module -e '
    const [range, version] = process.argv.slice(1);
    const parse = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
      if (!m) { console.error(`unparseable version: ${v}`); process.exit(2); }
      return m.slice(1, 4).map(Number);
    };
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const ver = parse(version);
    let lo, hi; // hi is exclusive; null means unbounded
    if (range.startsWith("^")) {
      lo = parse(range.slice(1));
      // caret on a 0.x line pins the minor — ^0.10.0 admits 0.10.z but never 0.11.0
      hi = lo[0] === 0 ? [0, lo[1] + 1, 0] : [lo[0] + 1, 0, 0];
    } else if (range.startsWith(">=")) {
      lo = parse(range.slice(2)); hi = null;
    } else if (/^\d/.test(range)) {
      lo = parse(range); hi = [lo[0], lo[1], lo[2] + 1];
    } else {
      console.error(`unrecognised range form: ${range}`); process.exit(2);
    }
    const ok = cmp(ver, lo) >= 0 && (hi === null || cmp(ver, hi) < 0);
    console.log(ok ? "yes" : "no");
  ' "$1" "$2"
}

ENGINE_VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$ENGINE_MANIFEST")" \
  || fail "could not read loop-engine version"
[ -n "$ENGINE_VERSION" ] || fail "loop-engine version is empty"

# Discover dependents rather than listing them — a plugin added later must be covered automatically.
DEPENDENTS=0
VIOLATIONS=0
for manifest in "$ROOT"/tools/*/.claude-plugin/plugin.json; do
  [ -f "$manifest" ] || continue
  [ "$manifest" = "$ENGINE_MANIFEST" ] && continue
  name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"")' "$manifest")"
  range="$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const dep = (d.dependencies||[]).find((x) => x && x.name === "loop-engine");
    console.log(dep ? dep.version : "");
  ' "$manifest")"
  [ -n "$range" ] || continue
  DEPENDENTS=$((DEPENDENTS + 1))
  verdict="$(check "$range" "$ENGINE_VERSION")" || fail "$name declares a dependency range this check cannot interpret ($range) — teach the check the form rather than leaving it unchecked"
  if [ "$verdict" = "yes" ]; then
    echo "PASS: $name's range $range admits loop-engine $ENGINE_VERSION"
  else
    echo "  VIOLATION: $name declares loop-engine $range, which excludes the shipped $ENGINE_VERSION"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# Fail closed: finding no dependents at all means the discovery broke, not that everything is fine.
[ "$DEPENDENTS" -gt 0 ] || fail "no sibling plugin declares a loop-engine dependency — discovery is broken, so this check verified nothing"

[ "$VIOLATIONS" -eq 0 ] || fail "$VIOLATIONS dependent(s) pin a range that excludes loop-engine $ENGINE_VERSION — a consumer would silently keep the old version"
echo "PASS: every dependent's range admits the shipped loop-engine $ENGINE_VERSION ($DEPENDENTS checked)"
