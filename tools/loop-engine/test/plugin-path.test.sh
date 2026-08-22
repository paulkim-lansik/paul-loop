#!/usr/bin/env bash
# BAC-753 — bin/plugin-path.mjs is the resolver a consuming repo (or another of this repo's own
# skills) uses to find an installed paul-loop plugin's on-disk root when bare PATH resolution
# doesn't apply (CI, or resolving a *different* plugin's path). Ported from glucofit-partners'
# repo-local tools/plugin-path.mjs + its harness-test/plugin-path.test.sh (BAC-699/706/766), which
# this plugin now makes redundant for a repo with no copy of its own. Its own doc comment documents
# a real bug class observed on that machine during BAC-699 (two different install versions
# resolvable across worktrees on the same machine) — this test locks the disambiguation logic that
# fixes it, plus the malformed/missing-file and CLI dispatch paths.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MOD="$HERE/../bin/plugin-path.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$MOD" ] || fail "plugin-path.mjs not found at $MOD"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

# helper: call resolvePluginPath({pluginsFile, root}) programmatically and print the result (or "null").
# LOOP_ENGINE_PATH= (empty, not unset) explicitly clears any value the parent shell exported — the
# resolver checks this env var FIRST and highest-priority, so a global override (e.g. CI's
# setup-loop-engine action exporting it job-wide via $GITHUB_ENV) would otherwise leak into every one
# of these pluginsFile-targeted assertions and make them pass for the wrong reason. Reproduced locally
# by running this suite with LOOP_ENGINE_PATH set, matching what a real CI job does (BAC-699 review).
resolve() { # $1=pluginsFile $2=root
  LOOP_ENGINE_PATH= node --input-type=module -e '
    const { resolvePluginPath } = await import(process.argv[1]);
    const pluginsFile = process.argv[2] || undefined;
    const root = process.argv[3] || undefined;
    const r = resolvePluginPath({ pluginsFile, root });
    process.stdout.write(String(r));
  ' "$(node -e "console.log(require('url').pathToFileURL(process.argv[1]).href)" "$MOD")" "$1" "${2:-}"
}

write_plugins() { # $1=file $2=json-body(the array under plugins["loop-engine@paul-loop"])
  node -e '
    const fs = require("fs");
    const [, file, body] = process.argv;
    fs.writeFileSync(file, JSON.stringify({ plugins: { "loop-engine@paul-loop": JSON.parse(body) } }));
  ' "$1" "$2"
}

# ── missing installed_plugins.json file → null, not a throw ────────────────────────────────────
OUT="$(resolve "$WORK/does-not-exist.json" "$WORK/proj")"
[ "$OUT" = "null" ] || fail "missing plugins file must resolve to null, got: $OUT"

# ── malformed JSON → null (fail-closed-to-caller, not a crash) ─────────────────────────────────
printf 'not-json{{{' > "$WORK/malformed.json"
OUT="$(resolve "$WORK/malformed.json" "$WORK/proj")"
[ "$OUT" = "null" ] || fail "malformed plugins file must resolve to null, got: $OUT"

# ── plugin key absent / empty entries array → null ──────────────────────────────────────────────
printf '{"plugins":{}}' > "$WORK/no-key.json"
OUT="$(resolve "$WORK/no-key.json" "$WORK/proj")"
[ "$OUT" = "null" ] || fail "plugins file with no loop-engine@paul-loop key must resolve to null, got: $OUT"
write_plugins "$WORK/empty.json" '[]'
OUT="$(resolve "$WORK/empty.json" "$WORK/proj")"
[ "$OUT" = "null" ] || fail "empty entries array must resolve to null, got: $OUT"

# ── single entry, exact projectPath match → that entry's installPath ───────────────────────────
write_plugins "$WORK/single.json" "$(node -e '
  console.log(JSON.stringify([{ scope: "project", projectPath: process.argv[1], installPath: "/cache/v1" }]));
' "$WORK/proj")"
OUT="$(resolve "$WORK/single.json" "$WORK/proj")"
[ "$OUT" = "/cache/v1" ] || fail "exact projectPath match must win, got: $OUT"

# ── multi-entry disambiguation (the documented bug class — two worktrees, two versions on the
# same machine): entries[0] is a DIFFERENT project at v1, entries[1] is THIS project at v2 — the
# match must be by projectPath, never by array position. ──────────────────────────────────────
write_plugins "$WORK/multi.json" "$(node -e '
  const [, other, mine] = process.argv;
  console.log(JSON.stringify([
    { scope: "project", projectPath: other, installPath: "/cache/wrong-project-v1" },
    { scope: "project", projectPath: mine, installPath: "/cache/right-project-v2" },
  ]));
' "$WORK/other-worktree" "$WORK/proj")"
OUT="$(resolve "$WORK/multi.json" "$WORK/proj")"
[ "$OUT" = "/cache/right-project-v2" ] || fail "multi-entry resolution must match by projectPath, not array position (entries[0] would give the wrong project's install) — got: $OUT"

# ── no exact projectPath match, but a scope:user entry exists → user-scope fallback wins ───────
write_plugins "$WORK/user-fallback.json" "$(node -e '
  const [, other] = process.argv;
  console.log(JSON.stringify([
    { scope: "project", projectPath: other, installPath: "/cache/other-project" },
    { scope: "user", installPath: "/cache/user-scope" },
  ]));
' "$WORK/some-other-project")"
OUT="$(resolve "$WORK/user-fallback.json" "$WORK/proj")"
[ "$OUT" = "/cache/user-scope" ] || fail "no projectPath match must fall back to the scope:user entry, got: $OUT"

# ── no exact match, no user-scope entry either → null (no blind entries[0] fallback) ───────────
write_plugins "$WORK/no-fallback.json" "$(node -e '
  const [, other] = process.argv;
  console.log(JSON.stringify([{ scope: "project", projectPath: other, installPath: "/cache/other" }]));
' "$WORK/some-other-project")"
OUT="$(resolve "$WORK/no-fallback.json" "$WORK/proj")"
[ "$OUT" = "null" ] || fail "no projectPath match and no user-scope entry must resolve to null (not silently grab entries[0]), got: $OUT"

echo "PASS: resolvePluginPath — missing/malformed file, empty/no-key entries, exact-match, multi-entry disambiguation (not array position), user-scope fallback, no-fallback-to-entries[0] all correct"

# ── LOOP_ENGINE_PATH env var wins over everything (highest priority, per module's own doc) ─────
write_plugins "$WORK/ignored.json" "$(node -e '
  const [, mine] = process.argv;
  console.log(JSON.stringify([{ scope: "project", projectPath: mine, installPath: "/cache/should-be-ignored" }]));
' "$WORK/proj")"
OUT="$(LOOP_ENGINE_PATH=/env/override node --input-type=module -e '
  const { resolvePluginPath } = await import(process.argv[1]);
  process.stdout.write(String(resolvePluginPath({ pluginsFile: process.argv[2], root: process.argv[3] })));
' "$(node -e "console.log(require('url').pathToFileURL(process.argv[1]).href)" "$MOD")" "$WORK/ignored.json" "$WORK/proj")"
[ "$OUT" = "/env/override" ] || fail "LOOP_ENGINE_PATH must win over installed_plugins.json entirely, got: $OUT"

echo "PASS: LOOP_ENGINE_PATH env override takes precedence over installed_plugins.json"

# ── CLI: exec subcommand dispatch by extension (.mjs → node, .sh → bash, else → direct exec) ───
FAKE_PLUGIN="$WORK/fake-plugin"
mkdir -p "$FAKE_PLUGIN/bin"
printf '#!/usr/bin/env node\nconsole.log("mjs:" + process.argv.slice(2).join(","));\n' > "$FAKE_PLUGIN/bin/hello.mjs"
printf '#!/usr/bin/env bash\necho "sh:$*"\n' > "$FAKE_PLUGIN/bin/hello.sh"
printf '#!/bin/sh\necho "bin:$*"\n' > "$FAKE_PLUGIN/bin/hello.bin"
chmod +x "$FAKE_PLUGIN/bin/hello.sh" "$FAKE_PLUGIN/bin/hello.bin"

OUT="$(LOOP_ENGINE_PATH="$FAKE_PLUGIN" node "$MOD" exec bin/hello.mjs a b)"
[ "$OUT" = "mjs:a,b" ] || fail ".mjs target must dispatch via node, got: $OUT"
OUT="$(LOOP_ENGINE_PATH="$FAKE_PLUGIN" node "$MOD" exec bin/hello.sh a b)"
[ "$OUT" = "sh:a b" ] || fail ".sh target must dispatch via bash, got: $OUT"
OUT="$(LOOP_ENGINE_PATH="$FAKE_PLUGIN" node "$MOD" exec bin/hello.bin a b)"
[ "$OUT" = "bin:a b" ] || fail "extensionless (executable) target must dispatch via direct exec, got: $OUT"

echo "PASS: exec subcommand dispatches by extension — .mjs via node, .sh via bash, else direct exec"

# ── CLI: resolve/exec with no plugin resolvable → exit 1 with a clear stderr message ────────────
RC="$(LOOP_ENGINE_PATH= HOME="$WORK/no-home" node "$MOD" resolve >/dev/null 2>"$WORK/err"; echo $?)"
[ "$RC" = "1" ] || fail "resolve with nothing resolvable must exit 1, got rc=$RC"
grep -q 'loop-engine@paul-loop' "$WORK/err" || fail "unresolvable failure must name the plugin in stderr: $(cat "$WORK/err")"

# ── CLI: exec with no relative bin path → usage error (exit 2) ─────────────────────────────────
RC="$(LOOP_ENGINE_PATH="$FAKE_PLUGIN" node "$MOD" exec >/dev/null 2>/dev/null; echo $?)"
[ "$RC" = "2" ] || fail "exec with no relative-bin argument must be a usage error (exit 2), got rc=$RC"

echo "PASS: CLI dispatch — unresolvable plugin exits 1 with a named error, exec with no bin path exits 2 (usage)"

# ── ship-flow@paul-loop resolves independently of loop-engine@paul-loop — same disambiguation
# logic, a different plugins-file key and a different env var (SHIP_FLOW_PATH, not LOOP_ENGINE_PATH). ──
write_ship_flow_plugins() { # $1=file $2=json-body(entries array under plugins["ship-flow@paul-loop"])
  node -e '
    const fs = require("fs");
    const [, file, body] = process.argv;
    fs.writeFileSync(file, JSON.stringify({ plugins: { "ship-flow@paul-loop": JSON.parse(body) } }));
  ' "$1" "$2"
}
resolve_ship_flow() { # $1=pluginsFile $2=root
  LOOP_ENGINE_PATH= SHIP_FLOW_PATH= node --input-type=module -e '
    const { resolvePluginPath } = await import(process.argv[1]);
    const pluginsFile = process.argv[2] || undefined;
    const root = process.argv[3] || undefined;
    const r = resolvePluginPath({ pluginsFile, root, plugin: "ship-flow" });
    process.stdout.write(String(r));
  ' "$(node -e "console.log(require('url').pathToFileURL(process.argv[1]).href)" "$MOD")" "$1" "${2:-}"
}

write_ship_flow_plugins "$WORK/ship-flow.json" "$(node -e '
  console.log(JSON.stringify([{ scope: "project", projectPath: process.argv[1], installPath: "/cache/ship-flow-v1" }]));
' "$WORK/proj")"
OUT="$(resolve_ship_flow "$WORK/ship-flow.json" "$WORK/proj")"
[ "$OUT" = "/cache/ship-flow-v1" ] || fail "plugin:ship-flow must resolve from the ship-flow@paul-loop key, got: $OUT"

# a loop-engine-only plugins file must NOT satisfy a ship-flow lookup (distinct keys, no cross-talk)
OUT="$(resolve_ship_flow "$WORK/single.json" "$WORK/proj")"
[ "$OUT" = "null" ] || fail "plugin:ship-flow must not resolve from a loop-engine@paul-loop-only plugins file, got: $OUT"

echo "PASS: ship-flow@paul-loop resolves independently by its own key, no cross-talk with loop-engine@paul-loop"

# SHIP_FLOW_PATH env override wins for ship-flow; LOOP_ENGINE_PATH must NOT leak into a ship-flow lookup
OUT="$(SHIP_FLOW_PATH=/env/ship-flow-override LOOP_ENGINE_PATH= node --input-type=module -e '
  const { resolvePluginPath } = await import(process.argv[1]);
  process.stdout.write(String(resolvePluginPath({ pluginsFile: process.argv[2], root: process.argv[3], plugin: "ship-flow" })));
' "$(node -e "console.log(require('url').pathToFileURL(process.argv[1]).href)" "$MOD")" "$WORK/ship-flow.json" "$WORK/proj")"
[ "$OUT" = "/env/ship-flow-override" ] || fail "SHIP_FLOW_PATH must win over installed_plugins.json for plugin:ship-flow, got: $OUT"

OUT="$(LOOP_ENGINE_PATH=/env/wrong-plugin SHIP_FLOW_PATH= node --input-type=module -e '
  const { resolvePluginPath } = await import(process.argv[1]);
  process.stdout.write(String(resolvePluginPath({ pluginsFile: process.argv[2], root: process.argv[3], plugin: "ship-flow" })));
' "$(node -e "console.log(require('url').pathToFileURL(process.argv[1]).href)" "$MOD")" "$WORK/ship-flow.json" "$WORK/proj")"
[ "$OUT" = "/cache/ship-flow-v1" ] || fail "LOOP_ENGINE_PATH must not leak into a plugin:ship-flow lookup, got: $OUT"

echo "PASS: SHIP_FLOW_PATH env override is independent of LOOP_ENGINE_PATH (no cross-plugin env leakage)"

# ── loop-memory@paul-loop resolves independently too (BAC-753) — same key/env-var isolation ────
OUT="$(LOOP_MEMORY_PATH=/env/loop-memory-override node --input-type=module -e '
  const { resolvePluginPath } = await import(process.argv[1]);
  process.stdout.write(String(resolvePluginPath({ pluginsFile: process.argv[2], root: process.argv[3], plugin: "loop-memory" })));
' "$(node -e "console.log(require('url').pathToFileURL(process.argv[1]).href)" "$MOD")" "$WORK/does-not-exist.json" "$WORK/proj")"
[ "$OUT" = "/env/loop-memory-override" ] || fail "LOOP_MEMORY_PATH must resolve plugin:loop-memory, got: $OUT"

echo "PASS: loop-memory@paul-loop resolves via its own LOOP_MEMORY_PATH env var"

# CLI: `resolve` with no argument still defaults to loop-engine (every pre-BAC-706 caller omits it)
OUT="$(LOOP_ENGINE_PATH=/env/default-loop-engine node "$MOD" resolve)"
[ "$OUT" = "/env/default-loop-engine" ] || fail "CLI 'resolve' with no plugin argument must default to loop-engine, got: $OUT"
OUT="$(SHIP_FLOW_PATH=/env/cli-ship-flow node "$MOD" resolve ship-flow)"
[ "$OUT" = "/env/cli-ship-flow" ] || fail "CLI 'resolve ship-flow' must resolve the ship-flow plugin, got: $OUT"

echo "PASS: CLI 'resolve' defaults to loop-engine, 'resolve ship-flow' targets ship-flow explicitly"

# CLI: unknown plugin shorthand is a usage error (exit 2), same class as a missing exec bin path
RC="$(node "$MOD" resolve nonexistent-plugin >/dev/null 2>/dev/null; echo $?)"
[ "$RC" = "2" ] || fail "CLI 'resolve <unknown>' must be a usage error (exit 2), got rc=$RC"

echo "PASS: CLI rejects an unknown plugin shorthand as a usage error"

# ── BAC-699 review regression: import.meta.url (percent-encoded) vs process.argv[1] (raw OS path)
# must not silently mismatch when the checkout path has a space — that mismatch made the whole CLI
# block never run, exiting 0 having done nothing (a caller like `pnpm verdict` reads that as
# success). Copy the module into a space-containing directory and confirm it still dispatches. ────
SPACE_DIR="$WORK/has space"
mkdir -p "$SPACE_DIR"
cp "$MOD" "$SPACE_DIR/plugin-path.mjs"
(
  cd "$SPACE_DIR" &&
  git init -q &&
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
) || fail "could not init the hermetic space-path fixture repo"
SPACE_ERR="$WORK/space-err"
RC="$(cd "$SPACE_DIR" && LOOP_ENGINE_PATH= HOME="$WORK/no-home" node ./plugin-path.mjs resolve >/dev/null 2>"$SPACE_ERR"; echo $?)"
[ "$RC" = "1" ] || fail "resolver in a space-containing path must still reach the unresolvable-plugin exit 1, got rc=$RC (import.meta.url percent-encoding mismatch would silently exit 0 instead)"
grep -q 'loop-engine@paul-loop' "$SPACE_ERR" || fail "space-path resolver must still emit the named error, got: $(cat "$SPACE_ERR")"

echo "PASS: CLI entrypoint check survives a space in the module's own path (import.meta.url vs argv[1] encoding)"

# ── hermetic idiom (BAC-753 issue text): plugin-unresolved simulation = LOOP_ENGINE_PATH= (empty,
# not unset) + HOME=$WORK/no-home, so installed_plugins.json under the real $HOME is never
# consulted even by accident. Confirms this idiom actually produces the documented exit 1 + named
# stderr, so other tests/CI adopting it can trust it. ───────────────────────────────────────────
RC="$(LOOP_ENGINE_PATH= HOME="$WORK/no-home" node "$MOD" resolve loop-memory >/dev/null 2>"$WORK/hermetic-err"; echo $?)"
[ "$RC" = "1" ] || fail "hermetic no-plugin idiom (LOOP_ENGINE_PATH= + HOME=\$WORK/no-home) must exit 1 for loop-memory too, got rc=$RC"
grep -q 'loop-memory@paul-loop' "$WORK/hermetic-err" || fail "hermetic idiom's failure must name the plugin: $(cat "$WORK/hermetic-err")"

echo "PASS: hermetic plugin-unresolved idiom (LOOP_ENGINE_PATH= + HOME=\$WORK/no-home) behaves as documented"
exit 0
