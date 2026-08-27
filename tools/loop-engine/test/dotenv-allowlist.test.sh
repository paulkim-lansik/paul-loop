#!/usr/bin/env bash
# load-dotenv.mjs reads a file OUT OF THE REPOSITORY BEING WORKED ON, and what it fills is a process
# environment: graduate-lessons.mjs hands it to `spawnSync`, loop-doctor-heartbeat.mjs merges it into
# its own `process.env` before running `git`. Both are wired to SessionStart. So "which keys may this
# file set" is not a config question — it decides whether opening an untrusted repo runs its code.
#
# It did. Both of these were reproduced against the pre-fix loader:
#   NODE_OPTIONS=--require ./payload.cjs                      -> the spawned `node` ran the repo's file
#   GIT_CONFIG_COUNT/KEY_0=core.fsmonitor/VALUE_0=./payload.sh -> the `git` call ran the repo's program
# and they are examples, not the set (BASH_ENV, LD_PRELOAD, PERL5OPT, DYLD_INSERT_LIBRARIES land in the
# same place). Hence an allowlist: a denylist has to be complete forever, an allowlist has to be right
# once.
#
# The last case is the one that matters most. Cases 1-8 test the loader's own filtering, which is
# where the fix lives — but a future refactor could keep the filter and still hand the environment to
# a child by another route. So case 9 skips the unit level entirely and asks the question the CVE
# actually asked: run the real SessionStart hook against a real hostile repo, and see whether the
# payload executed. That one cannot pass for the wrong reason.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LOADER="$ROOT/tools/loop-engine/lib/load-dotenv.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LOADER" ] || fail "load-dotenv.mjs not found at $LOADER"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# load <project-dir> [configured] -> prints the resulting keys, one per line, sorted
load() {
  node --input-type=module -e "
    import { loadDotenv } from '$LOADER';
    const target = {};
    loadDotenv(process.argv[1], process.argv[2] || undefined, target);
    process.stdout.write(Object.keys(target).sort().join('\n'));
  " "$1" "${2:-}"
}

has_key() { printf '%s\n' "$1" | grep -qx "$2"; }

# ==== 1-3) the exploit keys are dropped ====
P="$DIR/hostile"; mkdir -p "$P/.loop"
cat > "$P/.loop/.env" <<'ENV'
OPENAI_API_KEY=sk-fake-passes-the-key-gate
NODE_OPTIONS=--require ./payload.cjs
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.fsmonitor
GIT_CONFIG_VALUE_0=./payload.sh
BASH_ENV=./payload.sh
LD_PRELOAD=/tmp/evil.so
PERL5OPT=-Mevil
DYLD_INSERT_LIBRARIES=/tmp/evil.dylib
ENV
KEYS="$(load "$P")"
for k in NODE_OPTIONS GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 BASH_ENV LD_PRELOAD PERL5OPT DYLD_INSERT_LIBRARIES; do
  has_key "$KEYS" "$k" && fail "(1) '$k' from a repo's dotenv file reached the target env — this is the RCE primitive"
done
echo "PASS: code-execution env vars in a repo's dotenv file are dropped (8 checked)"

# ==== 4) …while the key the loader exists for still loads ====
has_key "$KEYS" OPENAI_API_KEY || fail "(4) the allowlist dropped OPENAI_API_KEY — the loader's whole purpose"
echo "PASS: an allowed credential still loads from the same file"

# ==== 5) gate-disabling switches are not settable by a repo ====
P2="$DIR/gates"; mkdir -p "$P2/.loop"
cat > "$P2/.loop/.env" <<'ENV'
LOOP_STOP_GATE_OFF=1
LOOP_SANITIZE_OFF=1
LOOP_WORKTREE_SESSION_GATE_OFF=1
LOOP_VERIFY_PIPE_GATE_OFF=1
LOOP_RECALL_OFF=1
LOOP_LIVENESS_OFF=1
LOOP_DOTENV_PATH=../../elsewhere/.env
ENV
KEYS2="$(load "$P2")"
for k in LOOP_STOP_GATE_OFF LOOP_SANITIZE_OFF LOOP_WORKTREE_SESSION_GATE_OFF LOOP_VERIFY_PIPE_GATE_OFF LOOP_RECALL_OFF LOOP_LIVENESS_OFF LOOP_DOTENV_PATH; do
  has_key "$KEYS2" "$k" && fail "(5) '$k' was settable from a repo's dotenv file — a repo could disable its own gate or redaction"
done
[ -z "$KEYS2" ] || fail "(5) expected nothing to load from a file of switches, got: $KEYS2"
echo "PASS: a repo cannot turn a gate, the stop verdict, or log redaction off via its dotenv file"

# ==== 6) every remaining allowlist entry loads (the list is not accidentally empty/typo'd) ====
P3="$DIR/allowed"; mkdir -p "$P3/.loop"
cat > "$P3/.loop/.env" <<'ENV'
GEMINI_API_KEY=g
LOOP_MEMORY_SIGNING_KEY=s
LOOP_DATABASE_URL=postgres://localhost/x
LOOP_EMBED_PROVIDER=openai
LOOP_RECALL_MAX_DISTANCE=0.5
LOOP_KNOWLEDGE_MAX_DISTANCE=0.5
ENV
KEYS3="$(load "$P3")"
for k in GEMINI_API_KEY LOOP_MEMORY_SIGNING_KEY LOOP_DATABASE_URL LOOP_EMBED_PROVIDER LOOP_RECALL_MAX_DISTANCE LOOP_KNOWLEDGE_MAX_DISTANCE; do
  has_key "$KEYS3" "$k" || fail "(6) allowlisted key '$k' did not load — the allowlist is over-tight"
done
echo "PASS: all 7 allowlisted keys load (6 here + OPENAI_API_KEY above)"

# ==== 7) a relative configured path cannot walk out of the project ====
# LOOP_DOTENV_PATH is ordinary session env, which a repo-committed .claude/settings.json can set.
mkdir -p "$DIR/outside"
printf 'OPENAI_API_KEY=sk-from-outside\n' > "$DIR/outside/.env"
P4="$DIR/proj4"; mkdir -p "$P4"
ESCAPED="$(load "$P4" '../outside/.env')"
[ -z "$ESCAPED" ] || fail "(7) a relative dotenv path escaped the project directory and loaded: $ESCAPED"
echo "PASS: a relative dotenv path that escapes the project is refused"

# ==== 8) …but an absolute path still works (documented: a repo may keep its key outside the tree) ====
ABS="$(load "$P4" "$DIR/outside/.env")"
has_key "$ABS" OPENAI_API_KEY || fail "(8) an absolute dotenv path stopped working — that is a supported configuration"
echo "PASS: an absolute dotenv path still loads (unchanged, documented behaviour)"

# ==== 9) END TO END: the real SessionStart hook, a real hostile repo, does the payload run? ====
# Deliberately not a unit test of the loader. This is the question the vulnerability asked.
HOOK="$ROOT/tools/loop-memory/hooks/graduate-lessons.mjs"
if [ ! -f "$HOOK" ]; then
  fail "(9) graduate-lessons.mjs not found — this case must not be skipped silently; it is the only one that proves the fix at the level the attack happens"
fi
V="$DIR/victim"; mkdir -p "$V/.loop"
cat > "$V/.loop/.env" <<ENV
OPENAI_API_KEY=sk-fake-passes-the-key-gate
NODE_OPTIONS=--require ./payload.cjs
ENV
cat > "$V/payload.cjs" <<JS
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'EXECUTED'), 'x');
JS
# Cleared explicitly: an inherited LOOP_DOTENV_PATH (or its CLAUDE_PLUGIN_OPTION_* bridge) from the
# developer's own session would point the loader somewhere else and this case would pass without ever
# reading the hostile file — a false green that actually happened while investigating this bug.
env -u LOOP_DOTENV_PATH -u CLAUDE_PLUGIN_OPTION_LOOP_DOTENV_PATH \
    -u NODE_OPTIONS -u OPENAI_API_KEY -u GEMINI_API_KEY \
    -u CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY -u CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY \
    CLAUDE_PROJECT_DIR="$V" CLAUDE_PLUGIN_ROOT="$ROOT/tools/loop-memory" CLAUDE_PLUGIN_DATA="$V" \
    LOOP_GRADUATE_DEBUG=1 \
    node "$HOOK" --event SessionStart >/dev/null 2>&1

[ -f "$V/EXECUTED" ] && fail "(9) RCE: the SessionStart hook executed a payload named only by the repo's own .loop/.env"
# Guard against the case passing because the file was never read at all (see the env note above).
grep -q 'dotenv: loaded' "$V/graduate-debug.log" 2>/dev/null \
  || fail "(9) the hostile dotenv file was never read, so this case proved nothing — check the env isolation above"
echo "PASS: end to end — a hostile repo's .loop/.env is read, and its NODE_OPTIONS payload does not run"

echo "PASS: load-dotenv allowlist — repo-controlled dotenv files cannot set code-execution env vars or disable gates, relative paths stay in the project, and the real SessionStart hook survives the live exploit"
exit 0
