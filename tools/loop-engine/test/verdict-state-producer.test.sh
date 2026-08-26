#!/usr/bin/env bash
# BAC-755 (ported from glucofit-partners' gate-stop-verdict.test.sh "AC5 producer" section, which
# lived in a consuming repo even though it tests verdict-run.sh's own behavior — a Stop-hook
# consumer running its own gate-stop-verdict.mjs against this repo's verdict-run.sh, but the
# producer half (does verdict-run.sh itself write correct freshness state?) has zero generic
# coverage anywhere upstream). Locks the shape of `.loop/verdict-state.json` — the freshness record
# a consumer-repo Stop-hook gate reads to refuse stale/dirty PASS replays.
#
# AC1-AC4/AC7/AC8 (the Stop-hook's own block/allow/kill-switch/escape-valve behavior) stay in the
# consuming repo — that's testing a Stop hook, a repo-local wiring concern (BAC-752's hook-bundling
# decision governs whether/how that moves upstream, not this issue).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VERDICT_RUN="$HERE/../bin/verdict-run.sh"
LOOP_FIX="$HERE/../bin/loop-fix.sh"

fail() { echo "FAIL: $1"; exit 1; }
[ -x "$VERDICT_RUN" ] || fail "verdict-run.sh not found/executable at $VERDICT_RUN"
[ -x "$LOOP_FIX" ] || fail "loop-fix.sh not found/executable at $LOOP_FIX"

# verdict-run.sh writes its state to ${LOOP_DIR:-.loop}/verdict-state.json (bin/verdict-run.sh:92),
# so these assertions resolve the same way instead of hardcoding `.loop` (issue #58). Hardcoding
# made this suite unrunnable under a non-default LOOP_DIR — which is exactly what ac-verify.sh
# exports when given --log-dir, so any plan whose AC ran this suite failed permanently for a reason
# that had nothing to do with the code under test. A relative LOOP_DIR stays relative to the repo
# under test; an absolute one is used as-is.
LOOPD="${LOOP_DIR:-.loop}"
state_file() {  # $1 = repo root
  case "$LOOPD" in
    /*) printf '%s/verdict-state.json' "$LOOPD" ;;
    *)  printf '%s/%s/verdict-state.json' "$1" "$LOOPD" ;;
  esac
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
cleanup() { chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

REPO2="$WORK/repo2"
mkdir -p "$REPO2"
git -C "$REPO2" init -q
printf '.loop/\n' > "$REPO2/.gitignore"
echo hi > "$REPO2/a.txt"
git -C "$REPO2" add .
git -C "$REPO2" -c user.email=t@t -c user.name=t commit -qm init
HEAD2="$(git -C "$REPO2" rev-parse HEAD)"
state_field() { # $1=field → prints value (validates JSON while at it)
  node -e '
    const st = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(st[process.argv[2]]));
  ' "$(state_file "$REPO2")" "$1"
}
(cd "$REPO2" && "$VERDICT_RUN" -- true >/dev/null 2>&1)
[ "$?" = "0" ] || fail "verdict-run -- true must exit 0"
[ -f "$(state_file "$REPO2")" ] || fail "verdict-run must write \${LOOP_DIR:-.loop}/verdict-state.json (looked at $(state_file "$REPO2"))"
[ "$(state_field verdict)" = "PASS" ] || fail "state verdict must be PASS after a passing run"
[ "$(state_field sha)" = "$HEAD2" ] || fail "state sha must be the verified HEAD ($HEAD2), got $(state_field sha)"
[ "$(state_field dirty)" = "false" ] || fail "state dirty must be false on a clean tree"
case "$(state_field finished_at)" in
  *T*Z) : ;;
  *) fail "state finished_at must be an ISO-8601 UTC timestamp, got $(state_field finished_at)" ;;
esac
echo wip > "$REPO2/untracked.txt"
(cd "$REPO2" && "$VERDICT_RUN" -- true >/dev/null 2>&1)
[ "$(state_field dirty)" = "true" ] || fail "state dirty must be true when the tree has uncommitted changes"
rm -f "$REPO2/untracked.txt"
(cd "$REPO2" && "$VERDICT_RUN" -- false >/dev/null 2>&1)
rc=$?
[ "$rc" = "1" ] || fail "verdict-run -- false must exit 1, got rc=$rc"
[ "$(state_field verdict)" = "FAIL" ] || fail "state verdict must be FAIL after a failing run"
# non-git directory: sha=unknown + dirty=true (freshness can't be judged → fail-closed value a
# consumer gate should treat as stale/untrusted).
NOGIT="$WORK/nogit"
mkdir -p "$NOGIT"
(cd "$NOGIT" && "$VERDICT_RUN" -- true >/dev/null 2>&1)
node -e '
  const st = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (st.sha !== "unknown" || st.dirty !== true) { console.error(st); process.exit(1); }
' "$(state_file "$NOGIT")" || fail "non-git verdict state must record sha=unknown dirty=true (fail-closed input)"
# control chars in cmd must not corrupt the state JSON (review M5).
rm -f "$REPO2/untracked.txt"
(cd "$REPO2" && "$VERDICT_RUN" -- sh -c "$(printf 'true #\rCR')" >/dev/null 2>&1)
[ "$(state_field verdict)" = "PASS" ] || fail "control chars in cmd must not corrupt the state JSON"
# git status failure → dirty=true (fail-closed, symmetric with rev-parse failure — review M3).
REALGIT="$(command -v git)"
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
printf '#!/bin/sh\n[ "$1" = status ] && exit 1\nexec "%s" "$@"\n' "$REALGIT" > "$FAKEBIN/git"
chmod +x "$FAKEBIN/git"
(cd "$REPO2" && PATH="$FAKEBIN:$PATH" "$VERDICT_RUN" -- true >/dev/null 2>&1)
[ "$(state_field dirty)" = "true" ] || fail "git status failure must record dirty=true (fail-closed), got $(state_field dirty)"

echo "PASS: verdict-run.sh freshness state — sha/dirty/timestamp recorded, FAIL/non-git/control-char/status-fail shapes correct"

# ── loop-fix → fixer env: LOOP_STOP_GATE_OFF=1 propagated (a consumer-repo Stop-hook gate, if
# wired, must not fight the fixer on every cycle while a loop is actively converging). ────────────
REPO3="$WORK/repo3"
mkdir -p "$REPO3"
git -C "$REPO3" init -q
printf '.loop/\n' > "$REPO3/.gitignore"
echo x > "$REPO3/f.txt"
git -C "$REPO3" add .
git -C "$REPO3" -c user.email=t@t -c user.name=t commit -qm init
(cd "$REPO3" && "$LOOP_FIX" --verify "false" --max-iter 1 \
  --fix 'printf "%s" "${LOOP_STOP_GATE_OFF:-unset}" > gate-off-env.out' >/dev/null 2>&1) || true
[ "$(cat "$REPO3/gate-off-env.out" 2>/dev/null)" = "1" ] \
  || fail "loop-fix must pass LOOP_STOP_GATE_OFF=1 to the fixer, got '$(cat "$REPO3/gate-off-env.out" 2>/dev/null)'"

echo "PASS: loop-fix propagates LOOP_STOP_GATE_OFF=1 to the fixer"
exit 0
