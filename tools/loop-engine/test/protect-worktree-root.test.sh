#!/usr/bin/env bash
# Behavioral test for protect-during-loop.mjs's *rooting* (BAC-785).
#
# The guard decides "am I armed?" and "does this path match .loop/protect.globs?" against a root.
# That root used to be CLAUDE_PROJECT_DIR, which in a worktree-isolated session is the MAIN worktree
# (HEAD = an unprotected branch). Two independent breaks followed:
#   B1 arming  — guardState(root) saw `develop` and exit(0)'d BEFORE stdin was even parsed, so the
#                verdict was reached before the target path was known.
#   B2 matching — relative(root, filePath) produced `../<sibling-worktree>/…`, which the hook then
#                explicitly let through.
# Net effect: on the very workflow the consuming repo mandates (one worktree per task), the
# reward-hack guard was never armed and never matched. This file pins the fix: the effective root is
# derived from what is being touched — target's worktree, else the session cwd's worktree, else root.
#
# The cases do NOT stop at the first failure. Several AC contracts share this one command, so their
# exit codes DO flip together (fail-closed) — what accumulating buys is diagnosis, not independence:
# each contract greps for its own `PASS:` line, and a fail-fast `exit 1` on case 1 would erase every
# later line and leave the log unable to say which invariant actually broke.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hooks/protect-during-loop.mjs"
# A real file inside the plugin's own install path — the hook protects that path by absolute prefix
# (code, not a glob), since .loop/protect.globs is repo-relative and can never cover outside the repo.
PLUGIN_FILE="$HERE/../lib/protect-globs.mjs"

fail() { echo "FAIL: $1"; exit 1; }   # fixture failures only — those make every case meaningless
[ -f "$HOOK" ] || fail "protect-during-loop.mjs not found at $HOOK"
[ -f "$PLUGIN_FILE" ] || fail "plugin file not found at $PLUGIN_FILE"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT

g() { git -c user.email=t@example.com -c user.name=t -C "$@"; }

# ── fixture ───────────────────────────────────────────────────────────────────────────────────────
# repo = the session root, parked on an unprotected branch (what CLAUDE_PROJECT_DIR points at).
REPO="$WORK/repo"
mkdir -p "$REPO/.loop"
git init -q -b develop "$REPO" || fail "git init failed"
printf '**/*.test.sh\n.claude/settings.json\n' > "$REPO/.loop/protect.globs"
echo x > "$REPO/a.test.sh"
echo x > "$REPO/README.md"
# Root-anchored glob targets. Without these every case matches via `**/*.test.sh`, which is prefix
# agnostic — so a re-root that computes the repo-relative path wrongly (an empty or `undefined`
# prefix) still matches and every case stays green. These two pin `--show-prefix + suffix` itself.
mkdir -p "$REPO/.claude" "$REPO/pkg/.claude"
echo '{}' > "$REPO/.claude/settings.json"
echo '{}' > "$REPO/pkg/.claude/settings.json"
# protect.globs must be COMMITTED: `git worktree add` only checks out tracked files, so an untracked
# glob file would leave the linked worktree with no protection at all and fake-green every case.
g "$REPO" add -A || fail "git add failed"
g "$REPO" commit -qm init || fail "git commit failed"

# wt = the task worktree on a working branch (where the agent actually edits).
WT="$WORK/wt"
g "$REPO" worktree add -q -b feature/x "$WT" || fail "git worktree add failed"
[ -f "$WT/.loop/protect.globs" ] || fail "fixture: protect.globs missing in the linked worktree"

# A worktree nested INSIDE the root. The consuming repo's convention allows this layout ("an
# untracked .worktrees/"), and "the target is under root" must not be taken to mean "no re-rooting
# needed" — it is a different branch with its own .loop.
NESTED="$REPO/.worktrees/feat"
g "$REPO" worktree add -q -b feature/nested "$NESTED" || fail "git worktree add (nested) failed"

# A second, unrelated repository — re-rooting must not reach into it.
OTHER="$WORK/other"
mkdir -p "$OTHER/.loop"
git init -q -b feature/y "$OTHER" || fail "git init (other) failed"
printf '**/*.test.sh\n' > "$OTHER/.loop/protect.globs"
echo x > "$OTHER/b.test.sh"
g "$OTHER" add -A && g "$OTHER" commit -qm init || fail "git commit (other) failed"

# A path belonging to no repository at all.
echo x > "$WORK/loose.test.sh"

# ── runner ────────────────────────────────────────────────────────────────────────────────────────
FAILURES=()

# run <root> <cwd|""> <tool> <arg>
run() {
  node -e '
    const [tool, arg, cwd] = process.argv.slice(1);
    const p = {
      tool_name: tool,
      tool_input: tool === "Bash" ? { command: arg } : { file_path: arg },
    };
    if (cwd) p.cwd = cwd;
    process.stdout.write(JSON.stringify(p));
  ' "$3" "$4" "$2" | CLAUDE_PROJECT_DIR="$1" node "$HOOK" 2>>"$WORK/stderr"
}

# run_from <hook-process-cwd> <root> <tool> <arg> — no `cwd` field in the payload at all, so the
# hook has to fall back to its own process cwd.
run_from() {
  node -e '
    const [tool, arg] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ tool_name: tool, tool_input: { file_path: arg } }));
  ' "$3" "$4" | (cd "$1" && CLAUDE_PROJECT_DIR="$2" node "$HOOK" 2>>"$WORK/stderr")
}

# check <desc> <deny|allow> <root> <cwd|""> <tool> <arg>
check() {
  local desc="$1" want="$2"
  shift 2
  local out got
  out="$(run "$@")" || { echo "FAILED: $desc — hook exited non-zero (must always exit 0)"; FAILURES+=("$desc"); return; }
  got=allow
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"' && got=deny
  if [ "$got" = "$want" ]; then
    echo "PASS: $desc"
  else
    echo "FAILED: $desc — expected $want, got $got${out:+ | output: $out}"
    FAILURES+=("$desc")
  fi
}

# verdict <desc> <deny|allow> <hook-stdout>
verdict() {
  local got=allow
  printf '%s' "$3" | grep -q '"permissionDecision":"deny"' && got=deny
  if [ "$got" = "$2" ]; then
    echo "PASS: $1"
  else
    echo "FAILED: $1 — expected $2, got $got"
    FAILURES+=("$1")
  fi
}

# ── 1) the bug: a protected file in a sibling worktree, judged from the session root ──────────────
check "a protected file in a sibling worktree is denied" deny \
  "$REPO" "$WT" Edit "$WT/a.test.sh"

# ── 2) the main worktree stays a human QA space — no re-rooting for paths inside the root ─────────
check "a protected file in the session root stays allowed on develop" allow \
  "$REPO" "$REPO" Edit "$REPO/a.test.sh"

# ── 3) the escape hatch works, rooted at the worktree being edited ────────────────────────────────
echo 'BAC-785: legitimate edit' > "$WT/.loop/guard-off"
check "a guard-off inside the target worktree opens the window" allow \
  "$REPO" "$WT" Edit "$WT/a.test.sh"
rm -f "$WT/.loop/guard-off"

# ── 4) …and cannot be borrowed from another worktree ──────────────────────────────────────────────
echo 'BAC-785: unrelated window' > "$REPO/.loop/guard-off"
check "a guard-off in the session root does not open a window in the target worktree" deny \
  "$REPO" "$WT" Edit "$WT/a.test.sh"
rm -f "$REPO/.loop/guard-off"

# ── 5) a different repository is out of scope — re-rooting is same-repo only ──────────────────────
check "a protected file in a different repository is not re-rooted" allow \
  "$REPO" "$WT" Edit "$OTHER/b.test.sh"

# ── 6) the Bash channel is rooted the same way ────────────────────────────────────────────────────
check "Bash mutation of a protected file with cwd in a sibling worktree is denied" deny \
  "$REPO" "$WT" Bash "rm -f a.test.sh"

# ── 7) …but only for protected paths ──────────────────────────────────────────────────────────────
check "a non-protected file in a sibling worktree stays allowed" allow \
  "$REPO" "$WT" Edit "$WT/README.md"

# ── 8) fail-open preserved for paths in no worktree of this repo ──────────────────────────────────
check "a path outside every worktree stays allowed" allow \
  "$REPO" "$WT" Edit "$WORK/loose.test.sh"

# ── 9) a new file under a directory that does not exist yet — the reward-hack vector ──────────────
# `**/*.test.sh` is protected, so "write a new fake-green test into a fresh directory" must not be
# the one path that stays open. Resolving the worktree needs an ancestor walk: `git -C <missing dir>`
# exits 128.
check "a new file under a not-yet-created directory in a sibling worktree is denied" deny \
  "$REPO" "$WT" Write "$WT/newdir/n.test.sh"

# ── 10) verifier=ceiling: the plugin's own install path belongs to no worktree, so arming has to
#        fall back to the session cwd or this self-protection stays off exactly as B1 left it ──────
check "a plugin-install-path file is denied when the session cwd is a working worktree" deny \
  "$REPO" "$WT" Edit "$PLUGIN_FILE"

# ── 11) …while a human on the unprotected branch is still not wedged ──────────────────────────────
check "a plugin-install-path file stays allowed when the session cwd is the unprotected session root" allow \
  "$REPO" "$REPO" Edit "$PLUGIN_FILE"

# ── control: with the root already pointing at the worktree the guard has always worked. If this
#    one fails the fixture is broken (globs, branch, payload shape) and the REDs above prove nothing.
check "(control) a protected file is denied when the session root IS the worktree" deny \
  "$WT" "$WT" Edit "$WT/a.test.sh"

# ── 13) a worktree nested inside the root is still a separate worktree ────────────────────────────
check "a protected file in a worktree nested inside the session root is denied" deny \
  "$REPO" "$NESTED" Edit "$NESTED/a.test.sh"

# ── 14/15) the repo-relative path itself has to be right, not just glob-shaped ────────────────────
# `.claude/settings.json` is root-anchored: it must match at the worktree top and NOT one level down.
# An empty prefix would deny 15; an `undefined` prefix would allow 14.
check "a root-anchored protected path is denied at the worktree top" deny \
  "$REPO" "$WT" Edit "$WT/.claude/settings.json"
check "a root-anchored protected path does not match one directory down" allow \
  "$REPO" "$WT" Edit "$WT/pkg/.claude/settings.json"

# ── 16) positive control for the OTHER repo fixture ───────────────────────────────────────────────
# Case 5 is the only one that fails when the same-repository restriction is dropped, so its evidence
# is only worth anything while $OTHER is genuinely armed and genuinely protected. Without this, a
# silently broken fixture (unprotected branch, missing globs) leaves case 5 green and blind.
check "(control) the other repository's own guard is armed and protecting" deny \
  "$OTHER" "$OTHER" Edit "$OTHER/b.test.sh"

# ── 17/18) the process.cwd() fallback, for payloads carrying no cwd field ─────────────────────────
verdict "a payload with no cwd falls back to the hook's own cwd and denies the plugin path" deny \
  "$(run_from "$WT" "$REPO" Edit "$PLUGIN_FILE")"
verdict "a payload with no cwd stays allowed when the hook runs in the unprotected session root" allow \
  "$(run_from "$REPO" "$REPO" Edit "$PLUGIN_FILE")"

# ── 19) re-rooting must never DISARM ──────────────────────────────────────────────────────────────
# Session on an armed worktree, cwd pointing back at the unprotected main worktree. Re-rooting there
# would hand back exactly the escape this whole change removes.
check "re-rooting to an unprotected branch cannot disarm a session rooted on a working branch" deny \
  "$WT" "$REPO" Bash "rm -f a.test.sh"

# The hook writes to stderr only on a fail-open path it could not otherwise report. Any output here
# means one of the allow verdicts above was an internal error wearing a pass's clothes.
if [ -s "$WORK/stderr" ]; then
  echo "FAILED: the hook wrote to stderr — a fail-open path was taken: $(head -c 300 "$WORK/stderr")"
  FAILURES+=("hook stderr non-empty")
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "FAIL: ${#FAILURES[@]} case(s) failed: ${FAILURES[*]}"
  exit 1
fi
echo "PASS: guard arming and glob matching are rooted at the target's own worktree (19 cases)"
exit 0
