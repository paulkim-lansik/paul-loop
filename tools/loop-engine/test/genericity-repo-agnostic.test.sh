#!/usr/bin/env bash
# Regression test for the plugin's stated design contract: loop-engine ships NO product-specific
# rules and is parameterized by the consuming repo's own `.claude/ship-flow.config.json`.
#
# Two runtime surfaces had drifted out of that contract by hardcoding the repo this harness first
# grew in. Both are locked here behaviourally — the default path, the configured path, and (for the
# default) the absence of any invented repo-specific command.
#
#   1) `lessons recall` MISS hint. It told every consuming repo to run
#      `pnpm --filter @glucofit-partners/loop-memory recall …` — a command that exists in exactly one
#      repo on earth. A user-facing instruction that is wrong for everyone else is worse than no
#      instruction: it sends them to a shell error instead of to their own semantic store. Now the
#      command comes from `semanticRecallCommand`, and without config the hint names that key rather
#      than inventing an invocation.
#
#   2) `H1_EXCLUDED_SURFACES` send tokens (lib/boundary-surfaces.mjs). This one is not merely
#      cosmetic. That module exists so the "reduce human interventions" metric cannot optimise away
#      the human-approval boundary itself — merge/deploy/send must be excluded from H1. Its `send`
#      regex was one repo's outbound vocabulary, so in ANY other repo no send command ever matched
#      and the exact failure the module was written to prevent stayed wide open, silently. Now a
#      consuming repo declares its own vocabulary via `sendSurfacePattern`, which EXTENDS (never
#      replaces) the built-in rules — over-exclusion is the safe direction for a metrics filter.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
LESSONS="$ROOT/tools/loop-engine/bin/lessons.mjs"
SURFACES="$ROOT/tools/loop-engine/lib/boundary-surfaces.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$LESSONS" ] || fail "lessons.mjs not found at $LESSONS"
[ -f "$SURFACES" ] || fail "boundary-surfaces.mjs not found at $SURFACES"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
NOCFG="$DIR/no-config"; CFG="$DIR/with-config"
mkdir -p "$NOCFG" "$CFG/.claude" "$DIR/store"

# =================================================================================================
# 1) lessons recall miss hint
# =================================================================================================
ERR="$DIR/err.txt"

# 1a) No config: the hint must still route to semantic recall, must name the config key so the reader
#     knows how to fix it, and must NOT name a scoped package / package-manager invocation that only
#     one repo can run.
CLAUDE_PROJECT_DIR="$NOCFG" node "$LESSONS" recall --signature "FAIL: nothing recorded for this" --lessons "$DIR/store" >/dev/null 2>"$ERR"
rc=$?
[ "$rc" = "0" ] || fail "recall miss must still exit 0 (loop-fix ignores the code); got rc=$rc"
grep -q "semantic recall" "$ERR" || fail "unconfigured miss hint must still route to semantic recall: $(cat "$ERR")"
grep -q "semanticRecallCommand" "$ERR" || fail "unconfigured miss hint must name the config key that would fill it in: $(cat "$ERR")"
grep -qE '@[a-z0-9._-]+/[a-z0-9._-]+' "$ERR" \
  && fail "unconfigured miss hint must not name a scoped package from one specific repo: $(cat "$ERR")"
grep -qE '\b(pnpm|npm|yarn|bun)\b' "$ERR" \
  && fail "unconfigured miss hint must not invent a package-manager command the consuming repo may not have: $(cat "$ERR")"

# 1b) Configured: the repo's own command is quoted verbatim.
printf '{"semanticRecallCommand":"just recall --query \\"<text>\\" --json"}' > "$CFG/.claude/ship-flow.config.json"
CLAUDE_PROJECT_DIR="$CFG" node "$LESSONS" recall --signature "FAIL: nothing recorded for this" --lessons "$DIR/store" >/dev/null 2>"$ERR"
grep -q 'just recall --query "<text>" --json' "$ERR" \
  || fail "configured miss hint must name the consuming repo's own command verbatim: $(cat "$ERR")"

# 1c) A malformed config degrades to the generic hint — never to a crash, and never to a stale
#     hardcoded command.
printf 'not json' > "$CFG/.claude/ship-flow.config.json"
CLAUDE_PROJECT_DIR="$CFG" node "$LESSONS" recall --signature "FAIL: nothing recorded for this" --lessons "$DIR/store" >/dev/null 2>"$ERR"
rc=$?
[ "$rc" = "0" ] || fail "a malformed config must not break recall; got rc=$rc: $(cat "$ERR")"
grep -q "semanticRecallCommand" "$ERR" || fail "a malformed config must fall back to the generic hint: $(cat "$ERR")"

# =================================================================================================
# 2) boundary-surfaces send vocabulary
# =================================================================================================
probe() { # $1 = CLAUDE_PROJECT_DIR, $2 = command string -> prints the surface or "null"
  CLAUDE_PROJECT_DIR="$1" node --input-type=module -e "
    const m = await import('file://$SURFACES')
    const v = m.boundarySurface('Bash', process.env.PROBE_CMD)
    process.stdout.write(String(v))
  "
}

# 2a) Built-in rules keep working with no config at all (merge/deploy still excluded).
PROBE_CMD='gh pr merge 12 --squash' probe "$NOCFG" | grep -qx merge || fail "built-in merge rule regressed with no config"
PROBE_CMD='pnpm run redeploy'       probe "$NOCFG" | grep -qx deploy || fail "built-in deploy rule regressed with no config"
PROBE_CMD='ls -la'                  probe "$NOCFG" | grep -qx null   || fail "a plain command must not be excluded"

# 2b) A consuming repo's own outbound vocabulary is unknown WITHOUT config (this is the gap) …
rm -f "$CFG/.claude/ship-flow.config.json"
PROBE_CMD='curl -X POST https://api.example.com/v1/broadcast/blast' probe "$NOCFG" | grep -qx null \
  || fail "fixture problem: this command should not match any built-in rule"

# 2c) … and IS excluded once the repo declares it.
printf '{"sendSurfacePattern":"broadcast|sms-blast"}' > "$CFG/.claude/ship-flow.config.json"
PROBE_CMD='curl -X POST https://api.example.com/v1/broadcast/blast' probe "$CFG" | grep -qx send \
  || fail "a configured sendSurfacePattern must exclude that repo's send commands from H1"

# 2d) Config EXTENDS, never replaces — the built-in rules must survive alongside it.
PROBE_CMD='gh pr merge 12 --squash' probe "$CFG" | grep -qx merge \
  || fail "sendSurfacePattern must extend the built-in rules, not replace them"

# 2e) An invalid regex in config must not take the module (and every importer of it) down.
printf '{"sendSurfacePattern":"unclosed(["}' > "$CFG/.claude/ship-flow.config.json"
PROBE_CMD='gh pr merge 12 --squash' probe "$CFG" | grep -qx merge \
  || fail "an invalid sendSurfacePattern must degrade to the built-in rules, not throw"

echo "PASS: genericity — lessons recall hint is config-derived (generic + key-naming without config, verbatim with it, no invented package-manager command), boundary send vocabulary is config-extensible while built-in merge/deploy rules and fail-open behaviour hold"
exit 0
