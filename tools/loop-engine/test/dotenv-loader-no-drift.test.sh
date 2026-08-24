#!/usr/bin/env bash
# `lib/load-dotenv.mjs` exists twice in this marketplace, and the two copies MUST stay identical.
#
# Why duplicated at all: loop-memory's hooks need it, and so does loop-engine's
# `hooks/loop-doctor-heartbeat.mjs` — but a plugin is installed into its own cache directory, so
# loop-memory cannot import from loop-engine's tree at runtime even though it declares loop-engine as
# a dependency. There is no shared import path. Vendoring is forced by the packaging model.
#
# Why this gate: the two copies answer the same question — "does this repo have an embedding key?" —
# and the whole point of the heartbeat's copy is that its answer must match what the hooks actually
# do. Let them drift and the heartbeat goes back to reporting "no embedding key" while recall is
# live (a false CRIT every session), or the reverse (silence while recall is dead). That exact
# split — one component loading the dotenv file and another not — is the bug this copy exists to fix,
# so the duplication is checked rather than trusted.
#
# If you intend to change the loader: change it in loop-memory, copy it over verbatim, and bump both
# plugins. Do not "fix" a failure here by editing only one side.
set -uo pipefail
# `$0`, not `$BASH_SOURCE`: run.sh executes each test as `bash -c "$content" "$t"`, which sets $0 to
# the file path but leaves $BASH_SOURCE unusable for locating this directory.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

A="$ROOT/tools/loop-memory/hooks/lib/load-dotenv.mjs"
B="$ROOT/tools/loop-engine/lib/load-dotenv.mjs"

fail() { echo "FAIL: $1"; exit 1; }

[ -f "$A" ] || fail "loop-memory's loader is missing at $A — the heartbeat's copy has no source of truth"
[ -f "$B" ] || fail "loop-engine's vendored copy is missing at $B — loop-doctor-heartbeat.mjs imports it"

if ! cmp -s "$A" "$B"; then
  echo "FAIL: the two load-dotenv.mjs copies have drifted:"
  diff -u "$A" "$B" | head -40
  exit 1
fi

# The vendored copy is only load-bearing because the heartbeat imports it. If that import is dropped,
# this gate would keep passing while guarding a file nobody reads — so assert the consumer too.
HEARTBEAT="$ROOT/tools/loop-engine/hooks/loop-doctor-heartbeat.mjs"
grep -q "from '../lib/load-dotenv.mjs'" "$HEARTBEAT" \
  || fail "loop-doctor-heartbeat.mjs no longer imports the vendored loader — its key check is back to reading a different env than the hooks do"
grep -q 'loadDotenv(root' "$HEARTBEAT" \
  || fail "loop-doctor-heartbeat.mjs imports loadDotenv but never calls it — the key check below would still be wrong"

echo "PASS: load-dotenv.mjs is byte-identical across loop-memory and loop-engine, and the heartbeat still calls it"

# --- Behavioural guard: the false CRIT this whole change exists to remove. ---------------------
# Hermetic: a throwaway project dir holding only a dotenv file. No network, no DB, no real repo.
# The heartbeat must (a) find a key that lives ONLY in a non-default dotenv path reached through the
# plugin-option bridge, and (b) still fire when there genuinely is no key anywhere.
SANDBOX="$(mktemp -d)" || fail "mktemp -d failed — cannot build the hermetic sandbox"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/withkey/config" "$SANDBOX/nokey"
printf 'GEMINI_API_KEY=fake-key-for-test\n' > "$SANDBOX/withkey/config/env"

run_heartbeat() { # $1=project dir, $2=dotenv path option (may be empty)
  env -u OPENAI_API_KEY -u GEMINI_API_KEY -u LOOP_DOTENV_PATH -u LOOP_RECALL_OFF \
    CLAUDE_PROJECT_DIR="$1" \
    CLAUDE_PLUGIN_OPTION_LOOP_DOTENV_PATH="${2:-}" \
    node "$ROOT/tools/loop-engine/hooks/loop-doctor-heartbeat.mjs" 2>&1
}

if run_heartbeat "$SANDBOX/withkey" "config/env" | grep -q 'no embedding key'; then
  fail "heartbeat reported 'no embedding key' even though the key is in the dotenv file it was pointed at — the false CRIT is back (check the CLAUDE_PLUGIN_OPTION_LOOP_DOTENV_PATH bridge and the loadDotenv call)"
fi

# The inverse matters just as much: silencing the nudge by loading a file is only correct when a key
# is actually there. A repo with no key must still be told.
if ! run_heartbeat "$SANDBOX/nokey" "" | grep -q 'no embedding key'; then
  fail "heartbeat stayed silent for a project with no embedding key anywhere — the real signal was suppressed, which is worse than the false alarm it replaced"
fi

echo "PASS: heartbeat finds a key via the dotenv-path plugin option, and still nudges when no key exists"
