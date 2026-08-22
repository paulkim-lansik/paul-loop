#!/usr/bin/env bash
# BAC-755 — generic unit coverage for lib/protect-globs.mjs's globToRegExp/loadPatterns, which had
# zero direct test coverage anywhere (only exercised indirectly, and only against one consuming
# repo's real file list, via that repo's protect-globs-coverage.test.sh — which is itself entirely
# repo-policy and not portable, see BAC-755's investigation). This locks the matcher's own contract
# with synthetic patterns, independent of any consumer's protect.globs content.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../lib/protect-globs.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LIB" ] || fail "protect-globs.mjs not found at $LIB"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

OUT="$(node --input-type=module -e '
  import { globToRegExp, loadPatterns } from "'"$LIB"'";
  import { writeFileSync, mkdirSync } from "node:fs";
  import { join } from "node:path";

  const cases = [];
  const check = (label, cond) => cases.push({ label, cond });

  // globToRegExp: * (single segment), ** (any depth incl. zero), **/ (0+ leading segments), ?
  check("* matches within one segment", globToRegExp("*.test.ts").test("foo.test.ts"));
  check("* does not cross a slash", !globToRegExp("*.test.ts").test("a/foo.test.ts"));
  check("** matches across slashes", globToRegExp("apps/**").test("apps/api/src/x.ts"));
  check("** matches zero segments too", globToRegExp("apps/**").test("apps/"));
  check("**/ matches zero leading segments", globToRegExp("**/*.test.ts").test("foo.test.ts"));
  check("**/ matches nested leading segments", globToRegExp("**/*.test.ts").test("a/b/foo.test.ts"));
  check("? matches exactly one char", globToRegExp("a?c").test("abc"));
  check("? does not match zero chars", !globToRegExp("a?c").test("ac"));
  check("? does not match a slash", !globToRegExp("a?c").test("a/c"));
  check("literal dot is escaped, not a wildcard", !globToRegExp("a.ts").test("aXts"));
  check("non-matching path is rejected", !globToRegExp("apps/web/**").test("apps/api/x.ts"));
  check("full match required, not substring", !globToRegExp("foo.ts").test("foo.ts.bak"));

  // loadPatterns: comments/blank lines filtered, missing file -> []
  const dir = join(process.argv[1], "patterns");
  mkdirSync(dir, { recursive: true });
  const globFile = join(dir, "protect.globs");
  writeFileSync(globFile, "# comment\n\n  \napps/web/**\n*.test.ts\n  # indented comment\napps/api/**\n");
  const patterns = loadPatterns(globFile);
  check("loadPatterns drops comments/blank lines", JSON.stringify(patterns) === JSON.stringify(["apps/web/**", "*.test.ts", "apps/api/**"]));
  check("loadPatterns on missing file returns []", JSON.stringify(loadPatterns(join(dir, "nope.globs"))) === "[]");

  const failed = cases.filter(c => !c.cond);
  if (failed.length) {
    for (const f of failed) console.error("FAIL: " + f.label);
    process.exit(1);
  }
  console.log("PASS: all " + cases.length + " globToRegExp/loadPatterns cases");
' "$WORK" 2>&1)"
rc=$?
echo "$OUT"
[ "$rc" = "0" ] || fail "protect-globs.mjs matcher unit cases failed"

exit 0
