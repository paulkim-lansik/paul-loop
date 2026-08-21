#!/usr/bin/env bash
# Regression test for hooks/hooks.json (BAC-765/BAC-752 — loop-engine bundles its own hooks so a
# consuming repo gets them via plugin-version bump instead of a hand-maintained local copy).
#
# Verifies the bundle actually wires up, not just that each file parses: every command in
# hooks.json resolves to a real file under hooks/, every hook is valid JS, plugin.json points at
# hooks.json, and each PreToolUse/Stop/SessionStart hook actually runs end-to-end against a benign
# non-matching input (allow path) plus one deny-path behavioral check for gate-before-merge.mjs
# (the one hook whose logic changed during the port — protected branches now come from a consuming
# repo's ship-flow.config.json instead of being hardcoded).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
ENGINE="$ROOT/tools/loop-engine"
HOOKS="$ENGINE/hooks"

fail() { echo "FAIL: $1"; exit 1; }

[ -f "$ENGINE/.claude-plugin/plugin.json" ] || fail "plugin.json not found"
[ -f "$HOOKS/hooks.json" ] || fail "hooks/hooks.json not found"

node -e '
  const fs = require("fs");
  const path = require("path");
  const engine = process.argv[1];

  const plugin = JSON.parse(fs.readFileSync(path.join(engine, ".claude-plugin/plugin.json"), "utf8"));
  // hooks/hooks.json is auto-discovered by convention — declaring it explicitly in manifest.hooks
  // causes a "duplicate hooks file" load error (Claude Code loads it twice: once by convention,
  // once via the manifest). Regression for a real bug hit installing loop-engine 0.4.0.
  if ("hooks" in plugin) {
    console.error(`FAIL: plugin.json must NOT declare a "hooks" field (hooks/hooks.json is auto-discovered; declaring it causes a duplicate-load error) — got ${JSON.stringify(plugin.hooks)}`);
    process.exit(1);
  }

  const hooksJson = JSON.parse(fs.readFileSync(path.join(engine, "hooks/hooks.json"), "utf8"));
  const seen = new Set();
  let count = 0;
  for (const [event, entries] of Object.entries(hooksJson.hooks ?? {})) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        count += 1;
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w.-]+\.mjs)/.exec(h.command ?? "");
        if (!m) {
          console.error(`FAIL: ${event} hook command does not reference \${CLAUDE_PLUGIN_ROOT}/hooks/*.mjs: ${h.command}`);
          process.exit(1);
        }
        const rel = m[1];
        seen.add(rel);
        if (!fs.existsSync(path.join(engine, rel))) {
          console.error(`FAIL: ${event} hook references missing file: ${rel}`);
          process.exit(1);
        }
      }
    }
  }
  if (count < 8) {
    console.error(`FAIL: expected at least 8 wired hook commands, found ${count}`);
    process.exit(1);
  }

  // Every .mjs directly under hooks/ must be reachable from hooks.json, either as a top-level
  // command or as a shared dependency (command-tokenizer.mjs / red-events-log.mjs are imported by
  // other hooks, not registered directly) — this is a drift guard against an orphaned file.
  const SHARED_DEPS = new Set(["hooks/command-tokenizer.mjs", "hooks/red-events-log.mjs"]);
  for (const f of fs.readdirSync(path.join(engine, "hooks"))) {
    if (!f.endsWith(".mjs")) continue;
    const rel = `hooks/${f}`;
    if (!seen.has(rel) && !SHARED_DEPS.has(rel)) {
      console.error(`FAIL: hooks/${f} exists but is neither registered in hooks.json nor a known shared dependency`);
      process.exit(1);
    }
  }
  console.log(`hooks.json wiring OK — ${count} hook command(s), ${seen.size} distinct file(s)`);
' "$ENGINE" || fail "hooks.json structural check failed"

# Every hook file must be valid JS.
for f in "$HOOKS"/*.mjs; do
  node --check "$f" || fail "syntax error in $f"
done

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# -- Allow-path smoke test: every PreToolUse/Stop hook must run end-to-end (real relative imports
# resolving, not just parsing) against a benign, non-matching input and exit 0 with no stdout. This
# is the actual regression this port could break — a wrong `../lib/...` import path parses fine
# under `node --check` but throws at runtime the first time the module is touched.
run_allow() {
  local name="$1" stdin="$2"
  local out rc
  out="$(printf '%s' "$stdin" | node "$HOOKS/$name" 2>"$DIR/stderr.$name")"
  rc=$?
  [ "$rc" -eq 0 ] || fail "$name: expected exit 0 on a benign input, got $rc (stderr: $(cat "$DIR/stderr.$name"))"
  [ -z "$out" ] || fail "$name: expected no stdout on a benign (allow) input, got: $out"
}
run_allow "gate-before-merge.mjs" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
run_allow "gate-risky-commands.mjs" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
run_allow "gate-worktree-create.mjs" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
run_allow "warn-partial-checkout.mjs" '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
run_allow "protect-during-loop.mjs" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/not-protected.txt"}}'
run_allow "gate-stop-verdict.mjs" '{"session_id":"hooks-json-wiring-test"}'

# record-run-event.mjs and loop-doctor-heartbeat.mjs are always-exit-0/no-deny by design (pure
# instrumentation / advisory nudges) — just confirm they run without throwing.
printf '{"session_id":"hooks-json-wiring-test","hook_event_name":"SessionStart"}' \
  | node "$HOOKS/record-run-event.mjs" >/dev/null 2>"$DIR/stderr.record" \
  || fail "record-run-event.mjs threw on a valid SessionStart input (stderr: $(cat "$DIR/stderr.record"))"
LOOP_DOCTOR_HEARTBEAT_OFF=1 node "$HOOKS/loop-doctor-heartbeat.mjs" </dev/null >/dev/null 2>"$DIR/stderr.doctor" \
  || fail "loop-doctor-heartbeat.mjs threw with the kill switch on (stderr: $(cat "$DIR/stderr.doctor"))"
rm -f "$DIR/.loop/runs" 2>/dev/null

# -- Deny-path behavioral check: gate-before-merge.mjs on a protected branch, no ship-flow.config.json
# present (the fallback-default path — protected = {main, master}) must deny a merge into main.
REPO="$DIR/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name test
git -C "$REPO" commit -q --allow-empty -m init

OUT="$(printf '{"tool_name":"Bash","tool_input":{"command":"git merge origin/develop"},"cwd":"%s"}' "$REPO" \
  | CLAUDE_PROJECT_DIR="$REPO" node "$HOOKS/gate-before-merge.mjs")"
printf '%s' "$OUT" | grep -q '"permissionDecision":"deny"' \
  || fail "gate-before-merge.mjs: expected a deny decision merging into main with no ship-flow.config.json, got: $OUT"
printf '%s' "$OUT" | grep -q "Can't land directly on main" \
  || fail "gate-before-merge.mjs: deny reason must name the protected branch, got: $OUT"

# -- Config-driven path: an explicit ship-flow.config.json narrows the protected set to what it says.
mkdir -p "$REPO/.claude"
printf '{"releaseBranch":"release","integrationBranch":"trunk"}' > "$REPO/.claude/ship-flow.config.json"
OUT="$(printf '{"tool_name":"Bash","tool_input":{"command":"git merge origin/develop"},"cwd":"%s"}' "$REPO" \
  | CLAUDE_PROJECT_DIR="$REPO" node "$HOOKS/gate-before-merge.mjs")"
[ -z "$OUT" ] || fail "gate-before-merge.mjs: with ship-flow.config.json declaring release/trunk, a merge on 'main' must be allowed (main is no longer in the protected set), got: $OUT"

echo "PASS: hooks/hooks.json — plugin.json wiring, file resolution, allow-path smoke test (8 hooks), gate-before-merge deny + config-driven protected-branch behavior"
