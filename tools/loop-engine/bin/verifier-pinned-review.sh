#!/usr/bin/env bash
# verifier-pinned-review.sh — pinned-baseline check that breaks the circular-trust problem of a
# PR grading itself with its own (freshly edited) verifier (issue #14, ADR-0002).
#
# CODEOWNERS is repurposed here (not as a GitHub native approval gate — see ADR-0002 for why not)
# as a machine-readable list of "paths that define the verifier". A PR that touches any of those
# paths gets its NEW tools/loop-engine/bin/ code re-checked against the OLD (base-revision)
# tools/loop-engine/test/*.test.sh suite. A PR that weakens verdict logic while weakening the
# tests that watch it would pass its own new tests trivially — but the base tests are untouched
# by this PR, so they still catch it. Deleting a base test file outright is treated the same way
# (restored from base and re-run) — removing the watcher is also a way to defeat it.
#
# Usage: verifier-pinned-review.sh --base <git-ref> [--repo-root <path>]
# Exit:  0 = PASS (including "nothing sensitive touched" skip)
#        1 = FAIL (an old test broke against the new code)
#        2 = usage / environment error
set -uo pipefail

usage() {
  echo "usage: verifier-pinned-review.sh --base <git-ref> [--repo-root <path>]" >&2
  exit 2
}

BASE=""
REPO_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base)      [ $# -ge 2 ] || usage; BASE="$2"; shift 2 ;;
    --repo-root) [ $# -ge 2 ] || usage; REPO_ROOT="$2"; shift 2 ;;
    *)           usage ;;
  esac
done
[ -n "$BASE" ] || usage

if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)" || { echo "verifier-pinned-review.sh: cannot resolve default --repo-root" >&2; exit 2; }
fi
[ -d "$REPO_ROOT" ] || { echo "verifier-pinned-review.sh: --repo-root '$REPO_ROOT' is not a directory" >&2; exit 2; }
git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "verifier-pinned-review.sh: --repo-root '$REPO_ROOT' is not a git repo" >&2; exit 2; }

# ---- cleanup (worktree + temp files), always ----
WORKTREE_DIR=""
SENSITIVE_FILE=""
CHANGED_FILE=""
TEST_LIST_FILE=""
RUN_LOG=""
cleanup() {
  if [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1
    rm -rf "$WORKTREE_DIR" 2>/dev/null
  fi
  rm -f "$SENSITIVE_FILE" "$CHANGED_FILE" "$TEST_LIST_FILE" "$RUN_LOG" 2>/dev/null
}
trap cleanup EXIT

# ---- 1) parse CODEOWNERS into a sensitive-path-prefix list ----
# No CODEOWNERS at all = nothing declared as verifier-defining = nothing to pin. PASS.
CODEOWNERS_FILE="$REPO_ROOT/CODEOWNERS"
SENSITIVE_FILE="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || { echo "verifier-pinned-review.sh: mktemp failed" >&2; exit 2; }
if [ -f "$CODEOWNERS_FILE" ]; then
  grep -vE '^[[:space:]]*(#|$)' "$CODEOWNERS_FILE" | awk '{print $1}' > "$SENSITIVE_FILE"
fi
if [ ! -s "$SENSITIVE_FILE" ]; then
  echo "verifier-pinned-review: no CODEOWNERS sensitive paths declared — nothing to pin, PASS"
  exit 0
fi

# ---- 2) diff base...HEAD (3-dot: what HEAD introduced since it diverged from base) ----
# --no-renames: without it, a commit that `git mv`s a sensitive-path file to a non-sensitive
# location while also editing its content gets reported by git as a rename, and --name-only then
# prints only the NEW path — the old sensitive path never appears in the diff output, so the
# prefix-matching sensitivity scan below never fires on it. Forcing rename detection off makes
# git report the same change as a plain delete of the old path + add of the new one, so both
# paths show up in --name-only and the old (sensitive) one still trips the scan.
CHANGED_FILE="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || { echo "verifier-pinned-review.sh: mktemp failed" >&2; exit 2; }
if ! git -C "$REPO_ROOT" diff --no-renames --name-only "${BASE}...HEAD" > "$CHANGED_FILE" 2>/dev/null; then
  echo "verifier-pinned-review.sh: 'git diff ${BASE}...HEAD' failed — is '${BASE}' a valid ref reachable from this repo?" >&2
  exit 2
fi

# ---- 3) does the diff touch any sensitive path? ----
touched=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  target="/$f"
  while IFS= read -r prefix; do
    [ -z "$prefix" ] && continue
    case "$prefix" in
      */)
        case "$target" in
          "$prefix"*) touched=1 ;;
        esac
        ;;
      *)
        [ "$target" = "$prefix" ] && touched=1
        ;;
    esac
  done < "$SENSITIVE_FILE"
done < "$CHANGED_FILE"

# ---- 4) nothing verifier-defining touched -> skip ----
if [ "$touched" -eq 0 ]; then
  echo "verifier-pinned-review: no verifier-defining paths touched — skipping pinned-baseline check"
  exit 0
fi

# ---- 5) verifier-defining change present: pin the test/ suite to its base-revision content ----

# 5a) detached worktree of the PR's current (new) code
WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || { echo "verifier-pinned-review.sh: mktemp -d failed" >&2; exit 2; }
# Canonicalize (resolve symlinks, e.g. macOS /var -> /private/var) before it's used anywhere
# else. Some pinned test files re-derive their own script directory via `cd "$(dirname "$0")" &&
# pwd`, then join it with a relative `../../..` to locate lib/ scripts they invoke with `node`.
# If WORKTREE_DIR still carries a symlinked prefix, that literal (non-realpath'd) node invocation
# path can end up disagreeing with Node's own realpath'd `import.meta.url`, breaking the common
# `import.meta.url === pathToFileURL(process.argv[1]).href` "run as main" guard and making the
# script silently no-op — a false FAIL unrelated to anything this mechanism is meant to catch.
WORKTREE_DIR="$(cd -P "$WORKTREE_DIR" && pwd)" || { echo "verifier-pinned-review.sh: cannot canonicalize worktree dir" >&2; exit 2; }
if ! WT_ERR="$(git -C "$REPO_ROOT" worktree add --detach "$WORKTREE_DIR" HEAD 2>&1)"; then
  echo "verifier-pinned-review.sh: git worktree add failed: $WT_ERR" >&2
  exit 2
fi

# 5b) full list of test files that existed at base under tools/loop-engine/test/ — includes
# files the PR deleted (git ls-tree reads the base tree, not the working copy).
TEST_LIST_FILE="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || { echo "verifier-pinned-review.sh: mktemp failed" >&2; exit 2; }
if ! git -C "$REPO_ROOT" ls-tree -r --name-only "$BASE" -- tools/loop-engine/test/ > "$TEST_LIST_FILE" 2>/dev/null; then
  echo "verifier-pinned-review.sh: could not list tools/loop-engine/test/ at '${BASE}'" >&2
  exit 2
fi

# 5c) force each of those paths back to its base-revision content inside the worktree.
# bin/ and lib/ are left untouched (still the PR's new code) — only test/ is pinned. A test file
# that is new in HEAD (not present at base) is simply not in this list, so it's left as-is.
while IFS= read -r tf; do
  [ -z "$tf" ] && continue
  dest="$WORKTREE_DIR/$tf"
  mkdir -p "$(dirname "$dest")" || { echo "verifier-pinned-review.sh: mkdir failed for $tf" >&2; exit 2; }
  if ! git -C "$REPO_ROOT" show "${BASE}:${tf}" > "$dest" 2>/dev/null; then
    echo "verifier-pinned-review.sh: could not read '${tf}' at '${BASE}'" >&2
    exit 2
  fi
done < "$TEST_LIST_FILE"

# 5d) run the pinned suite against the PR's new bin/ code
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || { echo "verifier-pinned-review.sh: mktemp failed" >&2; exit 2; }
( cd "$WORKTREE_DIR" && bash tools/loop-engine/test/run.sh ) > "$RUN_LOG" 2>&1
RUN_RC=$?

if [ "$RUN_RC" -ne 0 ]; then
  echo "verifier-pinned-review: FAIL — the base ('${BASE}') tools/loop-engine/test/ suite broke against this PR's new bin/ code." >&2
  echo "  This PR touches a verifier-defining path (see CODEOWNERS). Old tests must keep passing" >&2
  echo "  against new verifier code, or a self-weakening change (loosening the checker and its" >&2
  echo "  own tests in the same PR) would silently pass. If this failure is an intended behaviour" >&2
  echo "  change, say so explicitly in the PR description — a human must sign off on it." >&2
  echo "  --- pinned test/ run output ---" >&2
  cat "$RUN_LOG" >&2
  exit 1
fi

echo "verifier-pinned-review: PASS — the base ('${BASE}') tools/loop-engine/test/ suite still passes against this PR's new bin/ code."
exit 0
