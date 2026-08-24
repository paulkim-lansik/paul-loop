#!/usr/bin/env bash
# Regression test for bin/mattpocock-skills-sync-check.mjs — the cheap upstream-drift probe the
# `/mattpocock-skills-sync` skill consults before deciding whether a heavy multi-agent comparison is
# worth running.
#
# Why it earns a test despite being 76 lines: its whole value is a four-state verdict
# (FIRST_RUN / UNCHANGED / CHANGED / UNKNOWN) that a skill branches on, and two of its failure modes
# are silent rather than loud. If the state file is written to or read from the wrong directory, every
# run reports FIRST_RUN forever: no error, no drift ever detected, and the skill quietly stops
# nudging — a wrong-but-plausible answer, not a crash. Likewise a corrupt state file must degrade to
# "no baseline" and never to a fabricated UNCHANGED. Exit codes matter too: only the UNKNOWN branch
# is non-zero, so a caller can distinguish "could not tell" from "nothing changed".
#
# Hermetic: no network and no real `gh` — a fake `gh` on PATH (mode switched by FAKE_GH_MODE) stands
# in for the API, and CLAUDE_PROJECT_DIR points at a temp sandbox so the state file never touches a
# real repo.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
CHECK="$ROOT/tools/loop-engine/bin/mattpocock-skills-sync-check.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CHECK" ] || fail "mattpocock-skills-sync-check.mjs not found at $CHECK"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT
PROJ="$DIR/project"
FAKEBIN="$DIR/fakebin"
mkdir -p "$PROJ" "$FAKEBIN"
STATE="$PROJ/.loop/mattpocock-skills-sync.json"

# fail:   every `gh` call fails (unauthenticated / offline / rate-limited).
# ok:     commits/HEAD resolves to $FAKE_HEAD; compare resolves to $FAKE_COUNT.
# nocount: HEAD resolves but the compare call fails — CHANGED must still be reported, count unknown.
cat > "$FAKEBIN/gh" <<'EOF'
#!/usr/bin/env bash
case "${FAKE_GH_MODE:-fail}" in
  fail) exit 1 ;;
  ok|nocount)
    case "$2" in
      *commits/HEAD) echo "${FAKE_HEAD:?}" ; exit 0 ;;
      *compare/*) [ "${FAKE_GH_MODE}" = "nocount" ] && exit 1; echo "${FAKE_COUNT:-7}"; exit 0 ;;
    esac
    exit 1 ;;
esac
exit 1
EOF
chmod +x "$FAKEBIN/gh"
export PATH="$FAKEBIN:$PATH"

run() { CLAUDE_PROJECT_DIR="$PROJ" node "$CHECK" "$@" 2>&1; }
rc_of() { CLAUDE_PROJECT_DIR="$PROJ" node "$CHECK" "$@" >/dev/null 2>&1; echo $?; }

SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

# 1) No state yet, upstream reachable -> FIRST_RUN naming the current sha, exit 0.
export FAKE_GH_MODE=ok FAKE_HEAD="$SHA_A"
OUT="$(run)"; RC="$(rc_of)"
[ "$RC" = "0" ] || fail "FIRST_RUN must exit 0, got rc=$RC ($OUT)"
[ "$OUT" = "FIRST_RUN $SHA_A" ] || fail "expected 'FIRST_RUN $SHA_A', got: $OUT"
[ -f "$STATE" ] && fail "a plain check must NOT write state — only --stamp does (otherwise the very first probe silently declares itself up to date): $(cat "$STATE")"

# 2) --stamp writes the baseline UNDER CLAUDE_PROJECT_DIR. A state file written anywhere else would
#    make every subsequent run report FIRST_RUN forever, silently: no error, no drift ever detected.
OUT="$(run --stamp "$SHA_A")"; RC="$(rc_of --stamp "$SHA_A")"
[ "$RC" = "0" ] || fail "--stamp must exit 0, got rc=$RC ($OUT)"
[ "$OUT" = "STAMPED $SHA_A" ] || fail "expected 'STAMPED $SHA_A', got: $OUT"
[ -f "$STATE" ] || fail "--stamp must write the state file under CLAUDE_PROJECT_DIR/.loop, expected $STATE"
grep -q "$SHA_A" "$STATE" || fail "state must record the stamped sha: $(cat "$STATE")"

# 3) --stamp with no sha is a loud error, not a stamp of `undefined` (which would poison the
#    baseline into a sha that never matches, making every later run report CHANGED forever).
BEFORE="$(cat "$STATE")"
RC="$(rc_of --stamp)"
[ "$RC" = "1" ] || fail "--stamp with no sha must exit 1, got rc=$RC"
[ "$(cat "$STATE")" = "$BEFORE" ] || fail "--stamp with no sha must leave the existing baseline untouched: $(cat "$STATE")"

# 4) Baseline == upstream HEAD -> UNCHANGED, exit 0.
OUT="$(run)"; RC="$(rc_of)"
[ "$RC" = "0" ] || fail "UNCHANGED must exit 0, got rc=$RC ($OUT)"
[ "$OUT" = "UNCHANGED $SHA_A" ] || fail "expected 'UNCHANGED $SHA_A', got: $OUT"

# 5) Upstream moved -> CHANGED old new count, exit 0.
export FAKE_HEAD="$SHA_B" FAKE_COUNT=4
OUT="$(run)"; RC="$(rc_of)"
[ "$RC" = "0" ] || fail "CHANGED must exit 0, got rc=$RC ($OUT)"
[ "$OUT" = "CHANGED $SHA_A $SHA_B 4" ] || fail "expected 'CHANGED $SHA_A $SHA_B 4', got: $OUT"

# 6) Compare call fails but HEAD resolved -> still CHANGED (best-effort count only). Degrading the
#    whole verdict to UNKNOWN here would drop a real drift signal on a cosmetic failure.
export FAKE_GH_MODE=nocount
OUT="$(run)"
[ "$OUT" = "CHANGED $SHA_A $SHA_B ?" ] || fail "a failed compare must still report CHANGED with an unknown count, got: $OUT"

# 7) gh unreachable -> UNKNOWN with a NON-ZERO exit, so a caller can tell "could not tell" apart from
#    "nothing changed". Never a silent UNCHANGED.
export FAKE_GH_MODE=fail
OUT="$(run)"; RC="$(rc_of)"
[ "$RC" = "2" ] || fail "an unreachable upstream must exit 2 (judgement withheld), got rc=$RC ($OUT)"
printf '%s' "$OUT" | grep -q "^UNKNOWN" || fail "an unreachable upstream must report UNKNOWN, got: $OUT"
printf '%s' "$OUT" | grep -q "UNCHANGED" && fail "an unreachable upstream must never report UNCHANGED: $OUT"

# 8) Corrupt state file -> degrade to "no baseline" (FIRST_RUN), never to a fabricated UNCHANGED.
printf 'not json at all' > "$STATE"
export FAKE_GH_MODE=ok FAKE_HEAD="$SHA_B"
OUT="$(run)"
[ "$OUT" = "FIRST_RUN $SHA_B" ] || fail "a corrupt state file must degrade to FIRST_RUN (no baseline), got: $OUT"

echo "PASS: mattpocock-skills-sync-check — four-state verdict + exit codes (FIRST_RUN/UNCHANGED/CHANGED/UNKNOWN=2), state file lands under CLAUDE_PROJECT_DIR, --stamp validates its sha, failed compare still reports CHANGED, corrupt state degrades to FIRST_RUN"
exit 0
