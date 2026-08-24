#!/usr/bin/env bash
# Contract test for the thin `bin/*.sh` wrappers over `bin/*.mjs` (classify-risk, eval-gate, lessons,
# gstack-scan, gate — and anything added later: the list is DISCOVERED, not hardcoded).
#
# Scope, stated honestly: most ways these three-line wrappers can break are LOUD. Drop the `.mjs`
# path and node prints "Cannot find module"; drop the arguments entirely and every one of these tools
# exits 2 on a usage error. Those need no test. Exactly one degradation is silent, and it is the
# reason this file exists: quoting. `node "$X" $@` (or `$*`) still runs, still exits 0, and still
# looks right — it just re-splits every argument on whitespace, so `lessons record --title "two
# words"` records a lesson titled `two` with a stray positional, and `classify-risk --files "a b.ts"`
# classifies two files that do not exist. Wrong, plausible, and silent. The second property worth
# pinning is cwd independence: `$(cd "$(dirname "$0")" && pwd)` is what lets these run from anywhere,
# and a regression to a bare relative path passes every developer test run from inside `bin/`.
#
# Both are checked behaviourally, not by grepping the wrapper source: each discovered wrapper is
# copied into a sandbox next to a STUB `.mjs` that echoes its own argv and exits with a chosen code,
# then invoked from an unrelated directory. What the wrapper actually hands the interpreter is what
# gets asserted.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
BIN="$ROOT/tools/loop-engine/bin"

fail() { echo "FAIL: $1"; exit 1; }
[ -d "$BIN" ] || fail "bin/ not found at $BIN"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
mkdir -p "$DIR/elsewhere"

# argv fixture: whitespace inside one argument, an empty argument, and a glob character — the three
# things unquoted expansion mangles (re-split, dropped, expanded against the cwd).
EXPECTED='["one","two words","","*","--flag=a b"]'

found=0
for w in "$BIN"/*.sh; do
  [ -e "$w" ] || continue
  base="$(basename "$w" .sh)"
  # A thin wrapper = it hands off to the sibling .mjs of the same name. Anything else in bin/ (real
  # bash tools like verdict-run.sh, loop-fix.sh, require-tests.sh) is out of scope for this contract.
  # Deliberately NOT keyed on `exec`: a wrapper that drops `exec` is precisely one of the shapes this
  # test needs to judge (it can then swallow the exit code), so it must stay discoverable.
  grep -qE "node .*${base}\.mjs" "$w" || continue
  found=$((found + 1))

  [ -f "$BIN/$base.mjs" ] || fail "$base.sh delegates to $base.mjs, which does not exist in $BIN"

  # --- sandbox: same wrapper, stub interpreter target ---
  SB="$DIR/sb-$base"
  mkdir -p "$SB"
  cp "$w" "$SB/$base.sh"
  chmod +x "$SB/$base.sh"
  cat > "$SB/$base.mjs" <<'STUB'
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\n')
process.exit(Number(process.env.STUB_EXIT || 0))
STUB

  # 1) argv fidelity, invoked by ABSOLUTE path from an unrelated cwd.
  OUT="$(cd "$DIR/elsewhere" && "$SB/$base.sh" one "two words" "" "*" "--flag=a b")"
  [ "$OUT" = "$EXPECTED" ] \
    || fail "$base.sh must pass arguments through verbatim (quoted \"\$@\"); expected $EXPECTED, got $OUT"

  # 2) same, invoked by a RELATIVE path from a different cwd — locks the
  #    \$(cd "\$(dirname "\$0")" && pwd) resolution, which a bare relative interpreter path breaks.
  OUT="$(cd "$DIR/elsewhere" && "../sb-$base/$base.sh" one "two words" "" "*" "--flag=a b")"
  [ "$OUT" = "$EXPECTED" ] \
    || fail "$base.sh must resolve its .mjs relative to its OWN location, not the caller's cwd; expected $EXPECTED, got $OUT"

  # 3) exit-code propagation — a wrapper that swallows a non-zero status turns every gate built on
  #    it into a permanent PASS.
  rc=0
  ( cd "$DIR/elsewhere" && STUB_EXIT=7 "$SB/$base.sh" ) >/dev/null 2>&1 || rc=$?
  [ "$rc" = "7" ] || fail "$base.sh must propagate the interpreter's exit code; expected 7, got $rc"
done

# The discovery loop must actually have found the known wrappers — otherwise a broken matcher would
# make this whole file a silent no-op that reports PASS.
[ "$found" -ge 5 ] || fail "expected at least 5 thin bin/*.sh wrappers, discovered $found (discovery matcher broken, or wrappers were removed)"
for expected in classify-risk eval-gate lessons gstack-scan gate; do
  [ -d "$DIR/sb-$expected" ] || fail "$expected.sh was not discovered as a thin wrapper — discovery matcher is too narrow"
done

echo "PASS: bin/*.sh thin wrappers ($found discovered) — verbatim argv passthrough (spaces/empty/glob), .mjs resolved from the wrapper's own location under both absolute and relative invocation, exit code propagated"
exit 0
