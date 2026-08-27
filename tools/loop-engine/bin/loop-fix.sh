#!/usr/bin/env bash
# loop-fix.sh — Phase 1 of loop-engine: the closed verify -> fix loop.
#
# "Ralph is a Bash loop." This is that loop, made disciplined:
#   verify (ground truth) -> PASS? done : hand structured failures to a fixer -> repeat
#   until PASS, or a hard stopping criterion fires.
#
# It encodes the loop-engineering findings:
#   - The VERIFIER is the ceiling. The verdict comes from verify-cmd's exit code, period.
#   - GENERATOR != EVALUATOR. The fixer never decides success; only the verifier does.
#   - HARD STOPPING CRITERIA. --max-iter (always), optional --budget-sec, stall detection.
#   - NO REWARD HACKING. --protect snapshots verifier/test files; if a fix mutates them, restore
#     them to their pre-run bytes and abort.
#   - FILE-BASED HANDOFF. Each iteration writes the verdict, log, and a fix prompt to .loop/.
#
# Usage:
#   loop-fix.sh --verify "<cmd>" --fix "<cmd>" [options]
#
# Required:
#   --verify "<cmd>"    Command whose exit code is ground truth. Run via `sh -c`, so normal
#                       shell quoting works (e.g. --verify 'node --test "a b.mjs"').
#   --fix    "<cmd>"    Command that attempts a fix. Run once per failing iteration with the
#                       workspace as cwd, via `sh -c`. Reads $LOOP_PROMPT_FILE / $LOOP_VERDICT_FILE
#                       / $LOOP_LOG_FILE. For real use, wrap an agent (e.g. claude -p). For tests,
#                       a deterministic script. If omitted, runs verify-only (stops at first FAIL).
# Options:
#   --max-iter <n>      Hard iteration cap (default 10). The primary safety net.
#   --budget-sec <s>    Wall-clock budget; 0 = unlimited (default 0).
#   --stall <n>         Abort once the failure signature has been identical n iterations running
#                       (default 3). Heuristic — see "Stall caveat" below. Dual-signal (BAC-626 ①):
#                       a stall only counts when the failure fingerprint (EXIT+FAIL lines) is
#                       identical AND the summed pass/fail counts from the log did not move; moving
#                       counts reset the counter ("same message, moving counts" is progress). If no
#                       counts are extractable, fingerprint-only (previous behaviour).
#   --infra-retries <n|off>  Transient infra failures do NOT consume --max-iter: the iteration is
#                       exempt and verify is retried, up to n exemptions (default 2); one more infra
#                       failure past the cap aborts (exit 1). Classified as infra ONLY when a docker
#                       daemon/port signature is in the log AND no runner failure marker (FAILED,
#                       not ok, AssertionError, …) is present — tests that actually ran and failed
#                       are never exempted. 'off' disables the classifier entirely (pre-BAC-626
#                       behaviour: every FAIL goes to the fixer). n=0 aborts on the first infra
#                       failure. Exempt iterations spawn no fixer, never seed the lessons
#                       signature, and still honour --budget-sec.
#   --guard-mutation    Passed through to verdict-run.sh: verify must not change git-visible state,
#                       otherwise the verdict is forced FAIL (see verdict-run.sh, BAC-626 ④).
#   --idle-timeout-sec <n>      Material-progress watchdog (BAC-626 ③; opt-in, default 0=off).
#                       Kills the loop's whole descendant process tree and aborts (exit 1) when
#                       NEITHER the run-event ledger (.loop/runs/<current>.jsonl, BAC-570) NOR the
#                       verify log grows for n seconds ("activity = any log", so a long healthy
#                       verify that keeps writing output is never killed). LOOP_RUN_LEDGER
#                       overrides the ledger path (test seam).
#   --progress-timeout-sec <n>  Second clock of the same watchdog: aborts when no MATERIAL progress
#                       event (a new verdict.* entry in the ledger) lands for n seconds while mere
#                       activity may continue. Recommended ops values: idle 600 / no-progress 1800.
#                       Caveat: when loop-fix itself runs under an outer verdict-run wrapper, the
#                       inherited VERDICT_RUN_LEDGER_NESTED marker suppresses nested ledger appends
#                       — the progress clock can then fire on a healthy loop (a warning is logged
#                       at watchdog start; prefer the idle clock in that composition).
#   --protect <glob>    File(s) the fixer must NOT modify (repeatable). Reward-hacking guard.
#                       A pattern containing '**' recurses (resolved via `find`, skipping
#                       node_modules/.git, and $LOOP_DIR itself so the guard's own backup copies
#                       never self-match a broad glob like '**/*.test.*'); otherwise it is a
#                       single-level glob or a literal path. If a --protect pattern matches ZERO
#                       files, the loop refuses to run (exit 2) rather than silently leaving the
#                       guard off. Every check_protected() call that comes back clean is followed by
#                       a bounded grace-period recheck (PROTECT_GRACE_SEC, default 1.5s, override via
#                       env var LOOP_PROTECT_GRACE_SEC — mainly a test-speed knob) before being
#                       trusted — see round-5 in Guard scope below for why, and what this does and
#                       does NOT guarantee.
#   --loop-dir <dir>    State/handoff dir (default .loop).
#   --lessons <dir>     Verified-lessons memory (Phase 3): recall past fixes for this same failure
#                       into the fix prompt, and record a VERIFIED lesson on success. See bin/lessons.mjs.
#
# Exit: 0 = reached PASS. 1 = budget/iter/stall/infra/timeout exhausted. 2 = usage error / protect
#       matched nothing / verdict-run itself refused (exit 2 — e.g. --guard-mutation outside git).
#       3 = protected file mutated (restore attempted — see Guard scope below for what "restore"
#       actually guarantees). 4 = refused to start: a PRIOR run's restore could not verify its own
#       integrity and left $LOOP_DIR/protect-compromised behind — a human must inspect and clear it
#       before retrying (see Guard scope below).
#
# Guard scope (read this — the guarantee is narrow): --protect aborts (exit 3) when a file that
# existed at start AND was matched by --protect is edited or deleted. It does NOT cover files not
# listed, or other inputs the verifier reads (fixtures, snapshots, config like
# vitest.config/conftest.py). It detects the mutation AFTER the fact and, before aborting: (a)
# restores every protected file from a backup taken when THIS run's snapshot was taken
# (byte-for-byte, NOT `git checkout` — a protected file may already have had a legitimate
# uncommitted edit before this run even started); (b) deletes any NEW file that now matches a
# --protect glob but did not exist at snapshot time, so a fixer cannot dodge the guard by dropping a
# fresh trivially-passing file next to the real protected one; and (c) recomputes each restored
# file's hash and compares it against the ORIGINAL hash recorded before iteration 1 ever ran. The
# per-file sha256 used for BOTH (c) and the live detection in check_protected() is held ONLY in
# loop-fix.sh's own bash process memory (never written to a file) — a --fix subprocess runs as a
# separate CHILD process and structurally cannot write into its parent's shell variables, only into
# files/IPC the parent later reads (issue #34 round-3). Earlier revisions kept this hash in a plain
# file under $LOOP_DIR instead, which the fixer subprocess could reach the same as any other file it
# writes: overwriting it with the hash of its own sabotaged content made detection agree with itself
# ("unchanged"), and simply deleting it was treated as "nothing to protect" — both were a SINGLE-run,
# silent, complete bypass with no PROTECTED-VIOLATION log line at all. That specific file is gone
# now; there is nothing on disk left for a fixer to rewrite to fake a match. The byte-CONTENT backup
# under $PROTECT_BACKUP is different and DOES still live on disk (file content — as opposed to its
# hash — is not something that belongs crammed into a shell variable), so it remains reachable by
# the fixer the same as before: a sufficiently motivated fixer CAN poison the backup copy in the
# same move it poisons the live file — (c) exists to catch exactly that. It is not a tamper-proof
# store; it is a check that notices when the store was tampered with. Whenever a protected file's
# restore cannot be independently verified — the
# restored bytes do NOT match the original hash, the backup copy is missing entirely (e.g. the
# fixer `rm`s it instead of overwriting it with matching content), or the `cp` from backup itself
# fails — loop-fix.sh does NOT claim success: it logs a loud, distinct failure, writes
# $LOOP_DIR/protect-compromised (which file(s), why), and still exits 3. A SUBSEQUENT run then
# refuses to start at all (exit 4) until a human inspects and clears that marker — so the actual
# guarantee is "detect, attempt an exact restore, and if restoration integrity cannot itself be
# verified, refuse future runs until a human clears it," not "always perfectly undoes any sabotage
# no matter how the fixer attacks the backup." Known narrow gap: restore uses `cp -p`, which
# follows a symlink rather than replacing it — if the fixer replaces a protected file with a
# symlink to an external path, the restored bytes land at the symlink's target and the file is
# left as a symlink (content is correct, file type/identity is not) — this does not defeat
# detection or let a rerun report false success, it is a restoration-fidelity gap, not a bypass.
# Round-4 fix: check_protected() now also runs on the PASS path (right before declaring success),
# not just the FAIL path — closing a bypass where a fixer backgrounded a detached mutation timed to
# land after the FAIL-path check but before the next verify call.
#
# Round-5 fix (this revision) — two parts closing the SAME underlying limitation from two angles:
# the fixer runs as `sh -c "$FIX"`, and if $FIX ends with something like "(sleep D;
# corrupt-the-file) & true", that backgrounded subshell is NOT waited on — `sh -c "$FIX"` exits once
# "true" returns, the background job gets reparented away from anything loop-fix.sh can see or wait
# for, and ANY delay D longer than roughly "however long this process takes to finish its own check
# and exit" lands the corruption strictly AFTER that check already ran and reported clean. This is
# NOT a logic bug in check_protected() itself (confirmed correct in isolation) — it is a structural
# property of any short-lived supervisor process: you cannot detect, at the moment you check,
# something that has not happened yet. Adding another check_protected() call at some OTHER point
# does not close this either — the same argument applies to whatever the new "last point" becomes;
# an attacker just increases D further.
#
#   Part 1 — bounded grace-period recheck (check_protected_with_grace(), used on BOTH the PASS path
#   and the FAIL path, replacing the bare check_protected() calls round 4 added): once a
#   check_protected() call comes back clean, sleep a short, bounded grace period (PROTECT_GRACE_SEC,
#   default 1.5s, override via env var LOOP_PROTECT_GRACE_SEC — a test-speed knob) and check ONE
#   more time; a failing recheck is handled exactly like any other violation. This converts "any D
#   beats it" into "D must be under PROTECT_GRACE_SEC to be undetected" — a meaningfully higher bar
#   against realistic reward-hacking, NOT a claim that the gap is closed (see "Honest limit" below).
#
#   Part 2 — the STALLED / BUDGET / watchdog-during-fixer / infra-cap-exhausted abort paths check
#   their OWN abort condition and exit BEFORE that iteration's fixer invocation or the FAIL-path
#   check_protected() call ever runs. A corruption from an EARLIER iteration's still-pending delayed
#   background job can therefore land after every check_protected() call in the run has already
#   completed, and the run exits non-zero — its own real failure code (STALLED stays STALLED, BUDGET
#   stays BUDGET; this is NOT the false-SUCCESS class of bug) — with the protected file left
#   corrupted, unrestored, and unflagged. Each of these paths now also calls
#   check_protected_with_grace() (via check_protected_on_abort()) right before it exits: on a
#   violation it logs a warning, restores from backup, and cleans up any rogue new protect-matching
#   file — the same recovery as a normal violation — but keeps its OWN exit code. This is workspace
#   hygiene on exit, not a re-diagnosis of why the run failed.
#
# Honest limit (read this, it is the actual guarantee): the grace period raises the bar, it does not
# close the gap. A background job whose delay exceeds PROTECT_GRACE_SEC lands strictly after this
# process has finished checking and exited — a structural limit of any short-lived supervisor
# process, not a bug in this specific check, and NOT something a larger grace period alone can ever
# fully close (an attacker can always pick a D larger than whatever finite grace period is set). If
# a caller needs a stronger guarantee against a fixer that deliberately backgrounds long-delayed
# mutations, the fixer's execution environment itself would need to be sandboxed (e.g. no ability to
# survive past the fixer subprocess's own lifetime, via a process-group kill or similar OS-level
# containment) — that is a materially different, larger architectural change and is explicitly out
# of scope for this fix.
# Stall caveat: stall detection is reliable when the verifier emits recognizable failure markers
# or changing pass/fail counts; the hard guarantee against runaway is --max-iter.
#
# bash 3.2 compatible.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERDICT_RUN="$HERE/verdict-run.sh"

VERIFY=""; FIX=""; MAX_ITER=10; BUDGET=0; STALL=3; LOOP_DIR=".loop"
PROTECT_LIST=""   # newline-separated globs
LESSONS=""        # optional verified-lessons memory dir (Phase 3)
INFRA_RETRIES=2   # BAC-626 ②: transient 인프라 실패 면제 상한(초과 시 INFRA 중단)
IDLE_T=0; PROG_T=0  # BAC-626 ③: material-progress 워치독(0=off, 완전 opt-in)
GUARD_MUT=""      # BAC-626 ④: verdict-run passthrough 플래그(빈 값=off)
# issue #34 round-5: bounded grace period a check_protected() pass is held to before being trusted —
# raises the bar against a fixer that backgrounds a delayed mutation (see check_protected_with_grace()
# and the round-5 Guard-scope block above) but does NOT guarantee catching every delay, only ones
# shorter than this. Override via LOOP_PROTECT_GRACE_SEC (test-speed knob).
PROTECT_GRACE_SEC="${LOOP_PROTECT_GRACE_SEC:-1.5}"

need2() { [ "$1" -ge 2 ] || { echo "loop-fix.sh: $2 requires a value" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --verify)     need2 $# "$1"; VERIFY="$2"; shift 2 ;;
    --fix)        need2 $# "$1"; FIX="$2"; shift 2 ;;
    --max-iter)   need2 $# "$1"; MAX_ITER="$2"; shift 2 ;;
    --budget-sec) need2 $# "$1"; BUDGET="$2"; shift 2 ;;
    --stall)      need2 $# "$1"; STALL="$2"; shift 2 ;;
    --protect)    need2 $# "$1"; PROTECT_LIST="$PROTECT_LIST
$2"; shift 2 ;;
    --loop-dir)   need2 $# "$1"; LOOP_DIR="$2"; shift 2 ;;
    --lessons)    need2 $# "$1"; LESSONS="$2"; shift 2 ;;
    --infra-retries)        need2 $# "$1"; INFRA_RETRIES="$2"; shift 2 ;;
    --idle-timeout-sec)     need2 $# "$1"; IDLE_T="$2"; shift 2 ;;
    --progress-timeout-sec) need2 $# "$1"; PROG_T="$2"; shift 2 ;;
    --guard-mutation)       GUARD_MUT="--guard-mutation"; shift ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            echo "loop-fix.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done

[ -z "$VERIFY" ] && { echo "loop-fix.sh: --verify is required" >&2; exit 2; }
[ -x "$VERDICT_RUN" ] || { echo "loop-fix.sh: cannot find verdict-run.sh next to me ($VERDICT_RUN)" >&2; exit 2; }

mkdir -p "$LOOP_DIR"
COMPROMISED_MARKER="$LOOP_DIR/protect-compromised"

# Fail-closed startup check (issue #34 round-2 finding 1 / step 3): if a PRIOR run's protected-file
# restore could not verify its own integrity (the backup store itself looked tampered with — see
# restore_protected() below), it leaves this marker instead of silently reporting success. This is
# what actually closes the "rerun reports false SUCCESS" case even under full double-poisoning: a
# later run does not try to re-detect or re-trust a possibly-still-sabotaged workspace, it just
# refuses to run at all until a human clears the marker. Placed before any real work — before the
# sentinel arm, before snapshot_protected() — so a compromised workspace is never silently reused.
if [ -s "$COMPROMISED_MARKER" ]; then
  {
    echo "loop-fix.sh: refusing to run — $COMPROMISED_MARKER exists from a prior run."
    echo
    echo "A previous run detected a protected-file violation, attempted to restore it from backup,"
    echo "and could NOT verify that the restore actually worked (the backup itself appeared"
    echo "tampered with — see the file above for which protected file(s) and why). This workspace"
    echo "is left in an UNVERIFIED state on purpose rather than risking a false report of success."
    echo
    echo "A human must inspect the file(s) named in $COMPROMISED_MARKER, confirm they are"
    echo "genuinely trustworthy (e.g. restore them from git or another trusted source), and then"
    echo "remove that marker before retrying loop-fix.sh."
  } >&2
  exit 4
fi

HISTORY="$LOOP_DIR/history.log"
VERDICT_FILE="$LOOP_DIR/last-verdict.txt"
LOG_FILE="$LOOP_DIR/last-run.log"
PROMPT_FILE="$LOOP_DIR/fix-prompt.txt"
PROTECT_BACKUP="$LOOP_DIR/protected-backup"     # byte-for-byte copies, mirroring relative paths — the
                                                 # ONLY protect bookkeeping that still lives on disk
                                                 # (issue #34 round-3: large/binary content does not
                                                 # belong crammed into a bash variable; content backups
                                                 # were already documented as "not tamper-proof,
                                                 # integrity-checked instead" — see restore_protected()).
# PROTECT_FILES_DATA / PROTECT_SNAP_DATA / PROTECT_MODES_DATA (round-3 fix, issue #34 finding — a
# SINGLE-run false SUCCESS): the hash/list/mode ground truth used to live in plain files under
# $LOOP_DIR (protected.sha / protected.files / protected.modes) — a path the --fix subprocess has
# the same filesystem write access to as loop-fix.sh itself. A fixer could overwrite protected.sha
# with the hash of its OWN sabotaged content (check_protected()'s diff then agrees with itself and
# reports "unchanged"), or simply `rm -f` it (an empty/missing snapshot was treated as "nothing to
# protect"). No amount of chmod/backup/re-checking-against-another-file closes this while the
# ground truth itself lives in a file the fixer can also reach — that is an infinite regress
# (protect the snapshot -> now protect the backup-of-the-snapshot -> …). The actual fix: loop-fix.sh
# runs as ONE continuous bash process for the whole loop; --fix runs as a SEPARATE CHILD subprocess
# via `sh -c`, and a child process cannot write into its parent's in-memory shell variables — only
# into files/IPC the parent later reads. So the ground truth now lives ONLY in these three bash
# variables, held in loop-fix.sh's own process memory, which the fixer subprocess structurally
# cannot touch no matter what it does to the filesystem (same idiom already used for PROTECT_LIST
# itself — a newline-accumulated string built once from CLI args, never re-read from disk). All
# three are newline-separated strings, one entry per line, walked in lockstep (same order, one line
# per protected file) — set once by snapshot_protected() before the iteration loop and read-only
# after that.
PROTECT_FILES_DATA=""   # relative paths captured at snapshot time
PROTECT_SNAP_DATA=""    # `sha_of` output per file, same order as PROTECT_FILES_DATA
PROTECT_MODES_DATA=""   # original perm bits per file, same order (undoes the backup's read-only
                         # chmod on restore, step 5)
LESSONS_BIN="$HERE/lessons.sh"
FIRST_VERDICT="$LOOP_DIR/first-verdict.txt"
rm -f "$FIRST_VERDICT" 2>/dev/null   # reset per run: never inherit a prior run's first failure (sharing --loop-dir)
WATCHDOG_FIRED="$LOOP_DIR/watchdog-fired"
rm -f "$WATCHDOG_FIRED" 2>/dev/null  # reset per run: a stale fired flag must not abort a fresh loop
WATCHDOG_PID=""

sha_of() { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1" 2>/dev/null; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }   # BSD vs GNU stat

# Normalized form of $LOOP_DIR used to exclude the guard's own backup tree from '**' protect scans
# (issue #34 round-2 finding 2): snapshot_protected() writes byte-backups under
# $LOOP_DIR/protected-backup/<path>, which itself matches a broad glob like '**/*.test.*' — without
# this exclusion, check_protected()'s rescan sees the backup as an extra unmatched file and
# false-positives a violation even with a completely inert fixer. `find .`'s output is relative to
# cwd with the leading './' stripped (see protect_files() below), so this must land in that same
# relative form regardless of whether --loop-dir was left at the default relative ".loop", set to
# another relative path, or given as an absolute path.
case "$LOOP_DIR" in
  /*)
    case "$LOOP_DIR" in
      "$PWD"/*) LOOP_DIR_EXCL="${LOOP_DIR#"$PWD"/}" ;;
      "$PWD")   LOOP_DIR_EXCL="." ;;
      *)        LOOP_DIR_EXCL="" ;;   # outside cwd's tree — `find .` can never see it anyway
    esac
    ;;
  ./*) LOOP_DIR_EXCL="${LOOP_DIR#./}" ;;
  *)   LOOP_DIR_EXCL="$LOOP_DIR" ;;
esac

# Expand the protect globs into a concrete file list.
#  - a pattern with '**' recurses via find (skipping node_modules/.git, and $LOOP_DIR itself)
#  - otherwise it is a single-level shell glob or a literal path
#
# The recursive branch used to reduce the pattern to its BASENAME (`packages/db/test/**/*.test.ts` ->
# `*.test.ts`) and hand that to `find . -name`, discarding the directory part entirely. Every
# `*.test.ts` in the repository then counted as protected — and `cleanup_rogue_protected()` `rm -f`s
# any protect-matching file that did not exist at run start, so an unrelated test file created
# anywhere during a run was deleted. Over-protection is not the safe direction when the protection
# includes a delete.
#
# So the basename is now only a fast PRE-FILTER for find; each candidate is then matched against the
# WHOLE pattern. Shell `case` is the matcher: its `*` crosses `/`, which is exactly `**` semantics, so
# `**` -> `*` is a faithful translation. `/**/` additionally has to match zero directories
# (`a/**/x` matches `a/x`), which one `case` pattern cannot express — hence the second pattern with
# `/**` elided, and a match against either.
glob_to_case() { printf '%s' "$1" | sed 's/\*\*/*/g'; }

protect_files() {
  printf '%s\n' "$PROTECT_LIST" | while IFS= read -r g; do
    [ -z "$g" ] && continue
    case "$g" in
      *'**'*)
        base="${g##*/}"                                   # fast pre-filter only, NOT the match
        pat_deep="$(glob_to_case "$g")"                   # '**' -> '*' (one or more dirs)
        pat_flat="$(glob_to_case "$(printf '%s' "$g" | sed 's#/\*\*##g')")"   # zero dirs
        find . -type f -name "$base" 2>/dev/null \
          | grep -vE '/(node_modules|\.git)/' \
          | sed 's#^\./##' \
          | while IFS= read -r p; do
              if [ -n "$LOOP_DIR_EXCL" ]; then
                case "$p" in
                  "$LOOP_DIR_EXCL"/*) continue ;;
                esac
              fi
              case "$p" in
                $pat_deep|$pat_flat) printf '%s\n' "$p" ;;
              esac
            done ;;
      *)
        for f in $g; do [ -f "$f" ] && printf '%s\n' "$f"; done ;;
    esac
  done
}

# Snapshots both the sha256 (detection, held in-memory — round-3 fix, see PROTECT_SNAP_DATA above)
# AND a byte-for-byte backup copy of each protected file's current content under $PROTECT_BACKUP
# (issue #34: without the backup, a detected violation had nothing to restore FROM). Runs once per
# loop-fix.sh run, before the iteration loop — it must reflect state at run start, not be re-taken
# every iteration.
#
# Builds PROTECT_FILES_DATA/PROTECT_SNAP_DATA/PROTECT_MODES_DATA via a `while` loop fed by PROCESS
# SUBSTITUTION (`< <(...)`), not a pipe (`... | while`) — a bash pipe runs its last stage in a
# subshell, so variable assignments inside a piped `while` body are invisible once the pipe exits.
# Process substitution attaches the producer as an input redirection instead, so the `while` body
# itself still runs in THIS shell and the accumulated variables survive the loop.
snapshot_protected() {
  PROTECT_FILES_DATA=""
  PROTECT_SNAP_DATA=""
  PROTECT_MODES_DATA=""
  rm -rf "$PROTECT_BACKUP"
  mkdir -p "$PROTECT_BACKUP"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    PROTECT_FILES_DATA="$PROTECT_FILES_DATA$f
"
    PROTECT_SNAP_DATA="$PROTECT_SNAP_DATA$(sha_of "$f")
"
    PROTECT_MODES_DATA="$PROTECT_MODES_DATA$(mode_of "$f")
"
    _dir="$(dirname "$f")"
    [ "$_dir" = "." ] || mkdir -p "$PROTECT_BACKUP/$_dir"
    cp -p "$f" "$PROTECT_BACKUP/$f" 2>/dev/null
    # Best-effort friction (issue #34 round-2, step 5): NOT the guarantee — a same-UID fixer can
    # chmod its own file back to writable given enough determination. The actual guarantee against
    # backup-poisoning is the post-restore integrity check in restore_protected() below, plus the
    # fail-closed marker it leaves for a future run to see. Note this chmod means `cp -p` back OUT
    # of the backup during restore would otherwise propagate 0444 onto the live file too — restore
    # explicitly re-chmods to the mode captured in PROTECT_MODES_DATA above to undo that side effect.
    chmod 0444 "$PROTECT_BACKUP/$f" 2>/dev/null
  done < <(protect_files | sort -u)
}

# Returns 0 if unchanged, 1 if any protected file's hash changed (or a file vanished). Recomputes
# the current state FRESH every call (protect_files() + sha_of() per file) and compares it directly
# against PROTECT_SNAP_DATA via a plain string comparison — no temp file, no `diff -q` against a
# file, nothing on disk a fixer could rewrite to fake a match (round-3 fix). Also stashes the fresh
# scan in PROTECT_NOW_DATA (a global, not a return value) purely so the caller can render a
# human-readable "changed vs snapshot" diff on a violation — that var is diagnostic output, not
# ground truth, and nothing re-reads it for the actual pass/fail decision.
check_protected() {
  [ -n "$PROTECT_SNAP_DATA" ] || return 0
  _now=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    _now="$_now$(sha_of "$f")
"
  done < <(protect_files | sort -u)
  PROTECT_NOW_DATA="$_now"
  [ "$_now" = "$PROTECT_SNAP_DATA" ]
}

# check_protected_with_grace() (issue #34 round-5, Part 1): runs check_protected() first (zero added
# latency when nothing is protected) and, ONLY if something is actually protected, ALSO sleeps
# PROTECT_GRACE_SEC and checks a SECOND time — regardless of whether the first check was clean or
# violated (a violation already returns 1 without paying the sleep; every CLEAN check, which is the
# common case, does pay it — do not read this as "the common case is free"). Exists because
# `sh -c "$FIX"` does not wait on a job the fixer detaches with `&`: a fixer can return immediately
# while a backgrounded subshell mutates a protected file after loop-fix.sh has already moved on to
# its own check. A single check_protected() call, no matter WHERE it runs, can only ever prove
# "clean as of the instant it ran" — it cannot see a mutation that has not happened yet. This
# recheck converts "any delay beats detection" into "the delay must be under PROTECT_GRACE_SEC to be
# undetected" — see the round-5 Guard-scope block above for what this does and does NOT guarantee.
#
# Round-6 adversarial finding: a plain single `sleep "$PROTECT_GRACE_SEC"` is itself a child process
# of loop-fix.sh, and start_watchdog()'s descendant-killer (BAC-626 ③) sends SIGTERM/SIGKILL to
# EVERY child process when an idle/progress timeout fires — including this sleep, if the configured
# watchdog timeout happens to be shorter than PROTECT_GRACE_SEC (an unusual combination, but a real,
# demonstrated one: --idle-timeout-sec below the default recommended 600s). That would silently
# truncate the grace period without ever completing the recheck below. Fix: background the sleep,
# `wait` on it, and check ITS OWN exit status — a `sleep` killed by a signal exits at 128+signum (143
# for SIGTERM, 137 for SIGKILL), a normal uninterrupted sleep exits 0 — and retry the SAME full
# PROTECT_GRACE_SEC duration (not a computed remainder, which would need sub-second wall-clock
# arithmetic `date +%s` cannot provide portably — BSD date has no %N) if it was killed. Bounded to 3
# attempts; the watchdog fires at most once per run and its subshell exits right after its one kill
# sweep (see start_watchdog()), so at most one retry is ever needed in practice.
check_protected_with_grace() {
  check_protected || return 1
  [ -n "$PROTECT_SNAP_DATA" ] || return 0
  case "$PROTECT_GRACE_SEC" in
    0|0.0|0.00|.0|.00) return 0 ;;   # explicit "no grace" test-speed override — skip the sleep entirely
  esac
  _grace_tries=0
  while [ "$_grace_tries" -lt 3 ]; do
    sleep "$PROTECT_GRACE_SEC" 2>/dev/null &
    _grace_pid=$!
    wait "$_grace_pid" 2>/dev/null
    [ $? -lt 128 ] && break
    _grace_tries=$(( _grace_tries + 1 ))
  done
  check_protected
}

# Restores every protected file to the bytes captured by snapshot_protected() at run start —
# called right before the PROTECTED-VIOLATION abort so "detect" becomes "detect and undo" (issue
# #34). Deliberately restores from $PROTECT_BACKUP, NOT `git checkout`: a protected file may
# already have had a legitimate uncommitted edit before this loop-fix run even started, and the
# guarantee is "back to exactly what this run started with," not "back to git HEAD". Handles both
# a modified file (overwrite from backup) and a deleted file (recreate from backup). Always logs
# what happened; a per-file restore failure is logged loudly rather than swallowed, but never
# suppresses the PROTECTED-VIOLATION abort itself (caller still exits 3 regardless).
#
# Round-2 addition (issue #34 adversarial finding 1 — backup poisoning): after copying bytes back,
# recomputes each restored file's sha256 and compares it against the ORIGINAL hash recorded in
# $PROTECT_SNAP_DATA at run start (before iteration 1, so it predates any fixer action including
# poisoning the backup). A mismatch proves $PROTECT_BACKUP was ALSO tampered with — cp'ing from a
# poisoned backup "succeeds" as a copy but does not actually restore anything trustworthy. In that
# case this does NOT log the normal success line; it logs a distinct, loud failure and appends to
# $COMPROMISED_MARKER (consumed by the fail-closed startup check near the top of this script) so a
# later run refuses to proceed rather than trusting a possibly-still-sabotaged workspace.
restore_protected() {
  if [ -z "$PROTECT_FILES_DATA" ]; then
    log "  restore: no protected-file list captured — nothing to restore from."
    return 1
  fi
  _restored=0
  _restore_failed=0
  _integrity_failed=0
  # Three parallel in-memory lists (PROTECT_FILES_DATA / PROTECT_SNAP_DATA / PROTECT_MODES_DATA),
  # walked together via three process-substitution fds — same shape as the old three-file-descriptor
  # read (fd 3/4/5 against real files), just sourced from bash variables instead of disk (round-3
  # fix). Not a pipe, so this `while` body still runs in THIS shell — _restored/_restore_failed/
  # _integrity_failed set below correctly persist past the loop.
  while IFS= read -r f <&3 && IFS= read -r _origline <&4 && IFS= read -r _origmode <&5; do
    [ -n "$f" ] || continue
    _orig_hash="${_origline%% *}"
    _b="$PROTECT_BACKUP/$f"
    if [ ! -f "$_b" ]; then
      log "  RESTORE FAILED for $f: no backup copy at $_b — manual intervention needed."
      _restore_failed=1
      # A missing backup is just as untrustworthy a post-state as a hash-mismatched one — the
      # live file is left in whatever (possibly cheated) state the fixer put it in, with no way
      # to verify it. Without this, a fixer that simply `rm`s its own backup (instead of
      # overwriting it with matching content) skips the hash-mismatch branch entirely and no
      # marker gets written, leaving a rerun free to take the cheated content as a fresh, trusted
      # baseline — reopening the exact false-SUCCESS-on-rerun bug this guard exists to close.
      printf 'file=%s reason=no backup copy found at %s — cannot verify or restore original pre-run bytes (the fixer may have deleted its own backup)\n' \
        "$f" "$_b" >> "$COMPROMISED_MARKER"
      continue
    fi
    _dir="$(dirname "$f")"
    [ "$_dir" = "." ] || [ -d "$_dir" ] || mkdir -p "$_dir" 2>/dev/null
    if cp -p "$_b" "$f" 2>/dev/null; then
      # cp -p just carried the backup's mode (0444, from snapshot_protected()'s step-5 chmod) onto
      # $f — restore it to the mode the live file actually had at snapshot time instead.
      [ -n "$_origmode" ] && chmod "$_origmode" "$f" 2>/dev/null
      _restored=$(( _restored + 1 ))
      _now_hash="$(sha_of "$f" 2>/dev/null | awk '{print $1}')"
      if [ "$_now_hash" != "$_orig_hash" ]; then
        _integrity_failed=1
        log "  INTEGRITY CHECK FAILED for $f: restored bytes do NOT match the original pre-run hash — the backup itself was tampered with, this file may still be compromised."
        printf 'file=%s restored-hash=%s expected-original-hash=%s backup=%s reason=backup did not contain trustworthy pre-run bytes (likely poisoned by the same fixer that modified the live file)\n' \
          "$f" "$_now_hash" "$_orig_hash" "$_b" >> "$COMPROMISED_MARKER"
      fi
    else
      log "  RESTORE FAILED for $f: cp from backup did not succeed — manual intervention needed."
      _restore_failed=1
      # Same reasoning as the missing-backup branch above: an unverifiable live file must block
      # future runs, not just log a warning this invocation will forget.
      printf 'file=%s reason=cp from backup %s did not succeed — cannot verify or restore original pre-run bytes\n' \
        "$f" "$_b" >> "$COMPROMISED_MARKER"
    fi
  done 3< <(printf '%s' "$PROTECT_FILES_DATA") 4< <(printf '%s' "$PROTECT_SNAP_DATA") 5< <(printf '%s' "$PROTECT_MODES_DATA")
  if [ "$_integrity_failed" -eq 1 ] || [ "$_restore_failed" -eq 1 ]; then
    log "  RESTORE COULD NOT BE VERIFIED — the workspace may still be compromised. Do NOT trust it; a human must inspect it. Marker written: $COMPROMISED_MARKER (future runs will refuse to start until it is cleared)."
  else
    log "  restored $_restored protected file(s) to their pre-run state."
  fi
  [ "$_restore_failed" -eq 0 ] && [ "$_integrity_failed" -eq 0 ]
}

# Deletes any file that currently matches a --protect glob but did NOT exist at snapshot time
# (issue #34 adversarial finding 3): check_protected() only compares hashes for files it already
# knew about, so a fixer that creates a brand-new file matching a broad glob (e.g. dropping a
# second, trivially-passing test file next to the real protected one) still trips the violation,
# but restore_protected() alone never removes it — it only walks PROTECT_FILES_DATA (snapshot-time
# names, held in-memory — round-3 fix). Scope is deliberately narrow: only files protect_files()
# matches RIGHT NOW are candidates; anything the fixer created that does not match a --protect
# pattern is left untouched.
cleanup_rogue_protected() {
  [ -n "$PROTECT_FILES_DATA" ] || return 0
  protect_files | sort -u | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s' "$PROTECT_FILES_DATA" | grep -qFx "$f" && continue   # existed at snapshot time — restore_protected()'s job
    if rm -f "$f" 2>/dev/null; then
      log "  removed rogue new file matching --protect (not present at run start): $f"
    else
      log "  RM FAILED for rogue new protect-matching file $f — manual cleanup needed."
    fi
  done
}

# Shared PROTECTED-VIOLATION response — invoked from BOTH call sites: the FAIL-path check (after the
# fixer runs, before looping back to the next verify) and the PASS-path check (round-4, right before
# declaring success). Same reaction either way: log loudly, show the diff, restore + clean up, and
# exit 3. Factored out so the PASS-path addition below cannot drift from the FAIL-path behaviour it
# is mirroring. Never returns.
handle_protect_violation() {
  log "iter $iter: PROTECTED FILE MODIFIED by the fixer. This is reward hacking — aborting."
  log "Changed vs snapshot:"
  diff <(printf '%s' "$PROTECT_SNAP_DATA") <(printf '%s' "$PROTECT_NOW_DATA") 2>/dev/null | sed 's/^/    /' | tee -a "$HISTORY"
  restore_protected
  cleanup_rogue_protected
  log "=== loop-fix done: PROTECTED-VIOLATION ==="
  exit 3
}

# check_protected_on_abort() (issue #34 round-5, Part 2): STALLED / BUDGET / watchdog-during-fixer /
# infra-cap-exhausted aborts check their OWN abort condition and exit BEFORE that iteration's fixer
# invocation or the FAIL-path check_protected() call ever runs — so a corruption from an EARLIER
# iteration's still-pending delayed background job (see check_protected_with_grace() above) can land
# after every check_protected() call in the run has already completed, leaving the protected file
# corrupted, unrestored, and unflagged even though the run correctly exits non-zero. Called right
# before each of those paths' own exit: on a violation it logs a warning, restores from backup, and
# cleans up any rogue new protect-matching file — same recovery as handle_protect_violation() — but
# deliberately does NOT exit 3 and does NOT change the caller's verdict. Callers ignore this
# function's return value and keep their own exit code and their own "done: X" reason; this is
# workspace hygiene on exit, not a re-diagnosis of why the run failed.
check_protected_on_abort() {
  check_protected_with_grace && return 0
  log "iter $iter: PROTECTED FILE MODIFIED by the fixer, discovered while aborting for an unrelated reason. This is reward hacking — restoring before this run exits (the exit code below is this abort's OWN reason, not a protect violation)."
  log "Changed vs snapshot:"
  diff <(printf '%s' "$PROTECT_SNAP_DATA") <(printf '%s' "$PROTECT_NOW_DATA") 2>/dev/null | sed 's/^/    /' | tee -a "$HISTORY"
  restore_protected
  cleanup_rogue_protected
}

# ── BAC-626 ①: 전체 LOG의 러너 요약줄 합산 카운트 ──────────────────────────────────────────
# verdict-run SUMMARY는 tail-60의 마지막 매치라 turbo 병렬 출력에선 "어느 한 패키지의 숫자"로
# 회차마다 흔들린다(비결정 순서). 전체 LOG의 'Tests' 요약줄(vitest3 "Tests  3 failed | 245 passed"
# — 콜론 없음 / jest "Tests: 1 failed, 4 passed" — 둘 다 복수형 'Tests'로 잡히고, "Test Files"
# 줄은 단수라 제외)을 합산하면 순서-불변이다.
# 2차 소스 = VERDICT_FILE의 SUMMARY 줄: 'Tests' 요약줄이 없는 러너군(TAP `# pass N`·pytest
# `N passed`)과 passthrough(내부 VERDICT 블록만 남는 실전 `pnpm verdict` 경로)에서는 verdict-run이
# 이미 추출해 둔 counts가 유일한 전진 신호다 — 교체 전 sig는 SUMMARY 줄을 포함해 이 전진을 잡았
# 으므로, 폴백 없이는 그 러너군에서 조기-STALL 회귀가 된다(3축 리뷰 ①). duration_ms는 매회 변해
# 제외하고 숫자가 실존하는 passed=/failed=만 읽는다. 둘 다 없으면 빈 문자열 = 추출 불가(fp-only).
extract_counts() {
  _lines="$(grep -E '(^|[[:space:]])Tests([:[:space:]])' "$LOG_FILE" 2>/dev/null)" || true
  if [ -n "$_lines" ]; then
    _f="$(printf '%s\n' "$_lines" | grep -oE '[0-9]+ failed' | awk '{s+=$1} END{print s+0}')"
    _p="$(printf '%s\n' "$_lines" | grep -oE '[0-9]+ passed' | awk '{s+=$1} END{print s+0}')"
    printf 'f=%s p=%s' "$_f" "$_p"
    return 0
  fi
  _sum="$(grep -E '^SUMMARY: ' "$VERDICT_FILE" 2>/dev/null | head -n1)"
  _f="$(printf '%s' "$_sum" | grep -oE 'failed=[0-9]+' | head -n1)"
  _p="$(printf '%s' "$_sum" | grep -oE 'passed=[0-9]+' | head -n1)"
  [ -z "$_f$_p" ] && { printf ''; return 0; }
  printf 's:%s %s' "$_f" "$_p"
}

# ── BAC-626 ②: transient 인프라 실패 서명(이 레포 딥게이트 docker compose 실패 모드 전부) ──
# 좁게 유지한다 — 제품 테스트의 정상 실패(assertion·ECONNREFUSED류 범용 패턴)를 인프라로
# 오면제하는 역방향이 더 위험하다. `address already in use`(Node/OS EADDRINUSE 표준 문구)는
# 서버를 안 닫는 제품 버그의 출력과 정확히 겹쳐 목록에서 제외했다 — docker 고유 문구
# `port is already allocated`만 유지(3축 리뷰 ②). LOG 원문을 검사한다 — verdict의 FAIL: 줄은
# 200자 절단·20개 캡이라 서명이 잘릴 수 있다.
INFRA_RE='Cannot connect to the Docker daemon|Is the docker daemon running|Error response from daemon|port is already allocated|all predefined address pools have been fully subnetted|docker(-compose)?: command not found'
# 인프라 판정의 2차 조건: 러너 실패 마커(verdict-run FAIL 추출과 동일 목록)가 LOG에 하나라도
# 있으면 테스트가 실제로 돌아 실패한 것 — 인프라 서명이 곁가지 노이즈(정리용 docker rm 출력 등)
# 여도 면제하지 않고 fixer에 넘긴다. 인프라 실패는 정의상 테스트가 아예 못 돈 경우가 대부분이다.
RUNNER_FAIL_RE='(✕|✗|✖|✘|×|not ok|--- FAIL|FAILED|AssertionError|panic:)'

# ── BAC-626 ③: material-progress 이원 시계 (opt-in — 기본 0=off) ───────────────────────────
# 이벤트 소스 = BAC-570 런 이벤트 원장(.loop/runs/<run-id>.jsonl, cwd 기준 — ledger-append.mjs가
# root=cwd로 쓴다). run-id는 .loop/runs/current 포인터에서 읽고, 파손 포인터는 원장 계약
# (lib/run-ledger.mjs readCurrentRunId)대로 'unknown'으로 강등한다. LOOP_RUN_LEDGER 환경변수가
# 있으면 그 경로를 그대로 쓴다(테스트 seam).
#
# ⚠️ 신뢰 경계(run-ledger.mjs 헤더): 원장은 미보호·gitignore라 위조 가능하다. 그래서 워치독의
# 방향은 보수적으로만 잡는다 — 원장 이상(부재·정체·파손)은 타임아웃 발화(중단) 쪽으로 떨어지고,
# 위조 append는 발화를 늦출 수 있을 뿐이며 --max-iter/--budget-sec/stall 등 기존 정지 기준은
# 원장을 소비하지 않으므로 원장으로 루프 수명을 연장하는 경로는 없다.
resolve_ledger() {
  if [ -n "${LOOP_RUN_LEDGER:-}" ]; then printf '%s' "$LOOP_RUN_LEDGER"; return 0; fi
  _rid="$(head -n1 .loop/runs/current 2>/dev/null | tr -d '[:space:]')"
  printf '%s' "$_rid" | grep -qE '^[A-Za-z0-9_-]{1,40}$' || _rid="unknown"
  printf '%s/.loop/runs/%s.jsonl' "$(pwd)" "$_rid"
}

# 실질 진전 = 새 verdict 이벤트(passed든 failed든 — 이슈의 명시 목록 "새 verdict"). 수렴 실패는
# stall/max-iter의 몫이고 이 시계는 '멈춤(hang)'만 잡는다. 활동 = 원장 파일 크기 변화(아무 이벤트).
PROGRESS_RE='"type":"verdict\.(passed|failed)"'

# 워치독은 부모(loop-fix)가 아니라 부모의 "후손 트리 전체"를 죽인다 — bash trap은 포그라운드
# 명령이 끝나야 실행되므로 hung verify 중 부모 TERM은 무효다. 실행 트리는
# loop-fix → verdict-run → `sh -c "$VERIFY"` → 실제 러너(pnpm/vitest/docker…)라 직계(pgrep -P)만
# 죽이면 래퍼만 죽고 정작 hung verify 본체가 init에 고아로 재부모화되어 CPU·포트·로그 fd를 계속
# 쥔다(3축 리뷰 ③). macOS엔 setsid가 없어 프로세스 그룹 대신 pgrep -P 재귀 하강으로 트리를
# 수집한다. 부모는 $WATCHDOG_FIRED 플래그 파일로 타임아웃과 일반 실패를 구분한다.
descendants_of() {
  _queue="$1"; _seen=""
  while [ -n "$_queue" ]; do
    _next=""
    for _p in $_queue; do
      for _k in $(pgrep -P "$_p" 2>/dev/null); do
        _seen="$_seen $_k"; _next="$_next $_k"
      done
    done
    _queue="$_next"
    [ -z "$(printf '%s' "$_queue" | tr -d ' ')" ] && _queue=""   # 공백뿐이면 종료(무한 루프 방지)
  done
  printf '%s' "$_seen"
}
start_watchdog() {
  (
    parent=$$                       # ()& 서브셸에서 $$ = 부모(loop-fix) pid (bash 3.2)
    mypid="$(sh -c 'echo $PPID')"   # bash 3.2엔 $BASHPID가 없다 — 자식 셸의 PPID로 자기 pid 획득
    prev_act=""; idle_last="$(date +%s)"
    prev_prog=""; prog_last="$(date +%s)"
    reason=""
    while kill -0 "$parent" 2>/dev/null; do
      sleep 1
      now="$(date +%s)"
      # 활동(idle 시계) = 원장 이벤트 "또는" verify 로그의 어떤 출력이든(AC ③의 "아무 로그").
      # 원장만 보면 verify 실행 구간엔 이벤트가 안 붙어(verdict.*는 종료 시점 append) 정상적으로
      # 오래 걸리는 verify를 hang으로 오인해 죽인다(3축 리뷰 ③) — LOG 성장 = 살아있음의 증거.
      lsize="$(wc -c < "$LEDGER" 2>/dev/null | tr -d ' ')"; [ -z "$lsize" ] && lsize=0
      gsize="$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')"; [ -z "$gsize" ] && gsize=0
      act="$lsize:$gsize"
      [ "$act" != "$prev_act" ] && { prev_act="$act"; idle_last="$now"; }
      prog="$(grep -cE "$PROGRESS_RE" "$LEDGER" 2>/dev/null)"; [ -z "$prog" ] && prog=0
      [ "$prog" != "$prev_prog" ] && { prev_prog="$prog"; prog_last="$now"; }
      if [ "$IDLE_T" -gt 0 ] && [ $(( now - idle_last )) -ge "$IDLE_T" ]; then reason="TIMEOUT-IDLE"
      elif [ "$PROG_T" -gt 0 ] && [ $(( now - prog_last )) -ge "$PROG_T" ]; then reason="TIMEOUT-NO-PROGRESS"
      else continue; fi
      printf '%s\n' "$reason" > "$WATCHDOG_FIRED"
      for pid in $(descendants_of "$parent"); do
        [ "$pid" = "$mypid" ] || kill -TERM "$pid" 2>/dev/null
      done
      sleep 3
      for pid in $(descendants_of "$parent"); do
        [ "$pid" = "$mypid" ] || kill -KILL "$pid" 2>/dev/null
      done
      exit 0
    done
    exit 0
  ) &
  WATCHDOG_PID=$!
}

log() { printf '%s\n' "$*" | tee -a "$HISTORY"; }

# Phase 3 fail-channel (issue #10): record an UNVERIFIED lesson when the loop gives up without
# ever reaching PASS — ground truth never confirmed a fix, so this is a signal, not a verified
# lesson (record()'s existing merge logic upgrades it to verified=true if a later run with the
# same signature DOES converge). No-op if --lessons wasn't given, or FIRST_VERDICT was never
# captured (e.g. the very first verify hung before any verdict landed).
record_fail_lesson() {
  [ -n "$LESSONS" ] && [ -s "$FIRST_VERDICT" ] && [ -x "$LESSONS_BIN" ] || return 0
  "$LESSONS_BIN" record --signature-file "$FIRST_VERDICT" --source loop-fix-fail --iterations "$iter" --lessons "$LESSONS" >/dev/null 2>&1 \
    && log "recorded an unverified fail-channel lesson to memory ($LESSONS)"
}

log "=== loop-fix start $(date '+%Y-%m-%d %H:%M:%S') ==="
log "verify: $VERIFY"
log "fix:    ${FIX:-<none — verify-only mode>}"
log "limits: max-iter=$MAX_ITER budget-sec=$BUDGET stall=$STALL"

# Auto-arm the in-session protect hook for the loop's duration (closes the hand-armed gap): the
# PreToolUse guard (.claude/hooks/protect-during-loop.mjs) only blocks edits to verifier-defining
# files WHILE `.loop/looping` exists. Create it so an in-session loop is guarded by default, and
# disarm on EVERY exit path (fail-safe-off). Only touch what we armed — a pre-existing sentinel
# (an outer loop / a manual arm) is left to its owner.
SENTINEL="$LOOP_DIR/looping"
CLEAN_SENTINEL=0
# EXIT 정리는 누적 함수 하나로 — 센티넬 소유권 로직(내가 무장한 것만 해제)을 유지한 채 워치독
# 정리를 얹는다(trap 덮어쓰기 금지 — auto-arm.test.sh 케이스 4가 소유권을 잠근다).
cleanup() {
  [ "$CLEAN_SENTINEL" -eq 1 ] && rm -f "$SENTINEL" 2>/dev/null
  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null
    rm -f "$WATCHDOG_FIRED" 2>/dev/null
  fi
  return 0
}
trap cleanup EXIT
if [ ! -e "$SENTINEL" ]; then
  : > "$SENTINEL"
  CLEAN_SENTINEL=1
  log "armed in-session protect hook ($SENTINEL)"
fi

# Snapshot protected files, and FAIL CLOSED if a protect pattern was given but matched nothing —
# never run believing the guard is on when it is silently off.
snapshot_protected
has_protect=0
printf '%s\n' "$PROTECT_LIST" | grep -q '[^[:space:]]' && has_protect=1
if [ "$has_protect" -eq 1 ] && [ -z "$PROTECT_SNAP_DATA" ]; then
  echo "loop-fix.sh: --protect matched 0 files — refusing to run with the reward-hacking guard OFF." >&2
  echo "             Check the path/glob (note: only '**' patterns recurse)." >&2
  exit 2
fi
[ -n "$PROTECT_SNAP_DATA" ] && log "protecting $(printf '%s' "$PROTECT_SNAP_DATA" | wc -l | tr -d ' ') file(s) from modification"

# BAC-626 ③: 워치독 기동(opt-in). 원장 경로는 기동 시 1회 해석해 history에 남긴다(강등 가시화).
if [ "$IDLE_T" -gt 0 ] || [ "$PROG_T" -gt 0 ]; then
  LEDGER="$(resolve_ledger)"
  log "watchdog: ledger=$LEDGER idle=${IDLE_T}s progress=${PROG_T}s"
  # 외부 verdict-run 아래서 돌면(중첩 표식 상속) 내부 verdict-run들이 원장 append를 억제해
  # progress 시계가 건강한 루프에 오발화할 수 있다 — 원인이 로그에 남게 경고 1줄(3축 리뷰 ③).
  [ -n "${VERDICT_RUN_LEDGER_NESTED:-}" ] && log "watchdog: warning — VERDICT_RUN_LEDGER_NESTED is set (outer verdict wrapper): nested ledger appends are suppressed, the progress clock may fire on a healthy loop"
  start_watchdog
fi

start_epoch="$(date +%s)"
prev_fp=""; prev_counts=""; stall_count=0; iter=0; infra_count=0

while [ "$iter" -lt "$MAX_ITER" ]; do
  iter=$(( iter + 1 ))

  # ---- VERIFY (ground truth). Run via `sh -c` so quoting in $VERIFY is honoured. ----
  # stderr는 버리지 않고 파일로 보존한다 — --guard-mutation의 fail-closed 거부(exit 2)가 무음으로
  # 사라지면 운영자가 원인을 알 단서가 없다(3축 리뷰).
  # shellcheck disable=SC2086 — $GUARD_MUT는 빈 값(off) 또는 단일 플래그라 무인용 확장이 의도.
  "$VERDICT_RUN" $GUARD_MUT --log "$LOG_FILE" -- sh -c "$VERIFY" > "$VERDICT_FILE" 2>"$LOOP_DIR/verdict-run.err"
  vcode=$?

  # ---- BAC-626 ③: 워치독 발화 확인 — 타임아웃으로 살해된 verify를 일반 FAIL과 구분 ----
  if [ -f "$WATCHDOG_FIRED" ]; then
    wreason="$(head -n1 "$WATCHDOG_FIRED" 2>/dev/null)"
    log "iter $iter: ${wreason:-TIMEOUT} — material-progress watchdog fired. Aborting."
    check_protected_on_abort
    record_fail_lesson
    log "=== loop-fix done: ${wreason:-TIMEOUT} ==="
    exit 1
  fi

  # verdict-run exit 2 = 래퍼 자신의 사용 오류/fail-closed 거부(비-git 가드 등) — verify FAIL이
  # 아니다. FAIL로 오독하면 빈 verdict로 fixer를 헛돌리다 STALLED로 끝나 원인이 안 남는다 —
  # 즉시 exit 2로 중단하고 사유(stderr)를 history에 남긴다.
  if [ "$vcode" -eq 2 ]; then
    log "iter $iter: verdict-run refused to run (exit 2 — usage error / fail-closed guard). Aborting."
    sed 's/^/    /' "$LOOP_DIR/verdict-run.err" 2>/dev/null | tee -a "$HISTORY"
    # Round-6 adversarial finding: this abort path exits without ever rechecking protected files —
    # an earlier iteration's still-pending delayed background mutation (see
    # check_protected_with_grace()) could land after every other check in the run and leave the
    # workspace silently corrupted on this otherwise-unrelated exit. Same treatment as the other six
    # abort points: check_protected_on_abort() restores + warns but never changes this path's own
    # exit code.
    check_protected_on_abort
    log "=== loop-fix done: VERDICT-RUN-ERROR ==="
    exit 2
  fi

  cat "$VERDICT_FILE"

  if [ "$vcode" -eq 0 ]; then
    # ---- reward-hacking guard, PASS path (issue #34 round-4 adversarial finding) ----
    # check_protected() used to run ONLY on the FAIL path below (right before looping back to the
    # next verify) — never here. A fixer could background a detached mutation of a protected file
    # timed to land AFTER that FAIL-path check but BEFORE the next verify call: the poisoned bytes
    # would then be what verify reads, verify reports PASS, and this branch declared SUCCESS with no
    # PROTECTED-VIOLATION log line, no restore, no compromise marker — the same silent-false-SUCCESS
    # signature as every other bug this file exists to close. Must run before ANY success signal
    # (including the "PASS — stopping" log line just below), not just before the exit 0.
    # Round-5: uses check_protected_with_grace() (a bounded sleep-then-recheck), not the bare
    # check_protected() round 4 added — see the round-5 Guard-scope block near the top of this file.
    if ! check_protected_with_grace; then
      handle_protect_violation
    fi
    log "iter $iter: PASS — stopping (success)."
    # mark-clean wiring (issue #9): bump clean_pass_count on every lesson tied to this gate BEFORE
    # record — record's existing-lesson merge path resets clean_pass_count to 0 for the lesson that
    # just recurred THIS run (if FIRST_VERDICT was captured), so that lesson is never miscounted as
    # a clean pass. Runs whenever --lessons is set, independent of FIRST_VERDICT — a fully clean pass
    # (no failure this run) has no FIRST_VERDICT but must still bump every lesson on this gate.
    if [ -n "$LESSONS" ] && [ -x "$LESSONS_BIN" ]; then
      "$LESSONS_BIN" mark-clean --gate "$VERIFY" --lessons "$LESSONS" >/dev/null 2>&1
    fi
    # Phase 3: record a VERIFIED lesson — ground truth (the verifier) confirmed this fix worked.
    if [ -n "$LESSONS" ] && [ -s "$FIRST_VERDICT" ] && [ -x "$LESSONS_BIN" ]; then
      "$LESSONS_BIN" record --signature-file "$FIRST_VERDICT" --source loop-fix \
        --iterations "$iter" --verified --gate "$VERIFY" --lessons "$LESSONS" >/dev/null 2>&1 \
        && log "recorded a verified lesson to memory ($LESSONS)"
    fi
    log "=== loop-fix done: SUCCESS in $iter iteration(s) ==="
    exit 0
  fi

  log "iter $iter: FAIL"

  # ---- BAC-626 ②: transient 인프라 실패는 예산을 소모하지 않는다 ----
  # FIRST_VERDICT 보존보다 앞이어야 한다 — FIRST_VERDICT는 성공 시 verified lesson의 서명이
  # 되므로(아래) 인프라 서명으로 lessons 스토어를 오염시키면 안 된다. 면제 회차는 fixer
  # 미스폰·stall 미갱신(continue). 상한(--infra-retries)은 별도로 유지 — 영구 인프라 다운을
  # 무한 재시도로 가리지 않는다.
  if [ "$INFRA_RETRIES" != "off" ] \
     && grep -qE "$INFRA_RE" "$LOG_FILE" 2>/dev/null \
     && ! grep -qE "$RUNNER_FAIL_RE" "$LOG_FILE" 2>/dev/null; then
    infra_count=$(( infra_count + 1 ))
    if [ "$infra_count" -gt "$INFRA_RETRIES" ]; then
      log "iter $iter: INFRA failure ${infra_count}x — retry cap exhausted. Aborting (infra, not code)."
      check_protected_on_abort
      log "=== loop-fix done: INFRA ==="
      exit 1
    fi
    # 하드 정지 기준은 면제 경로도 우회하지 못한다 — --budget-sec 검사를 continue 앞에 둔다
    # (아래 정규 경로의 budget 블록과 동일 판정, 3축 리뷰 ②).
    if [ "$BUDGET" -gt 0 ] && [ $(( $(date +%s) - start_epoch )) -ge "$BUDGET" ]; then
      log "iter $iter: budget ${BUDGET}s exhausted during an infra-exempt retry. Aborting."
      check_protected_on_abort
      log "=== loop-fix done: BUDGET ==="
      exit 1
    fi
    iter=$(( iter - 1 ))   # 예산 면제: 실제 결과를 수령한 iteration만 max-iter를 소모한다
    log "iter(exempt): transient infra failure (${infra_count}/${INFRA_RETRIES}) — retrying verify without consuming max-iter."
    sleep 2
    continue
  fi

  # Remember the FIRST failure; its signature is what we record as a lesson once the loop converges.
  [ -s "$FIRST_VERDICT" ] || cp "$VERDICT_FILE" "$FIRST_VERDICT" 2>/dev/null

  # ---- stall detection (BAC-626 ①): dual-signal ----
  # fingerprint(EXIT+FAIL 줄)가 동일 "그리고" 합산 카운트가 무전진일 때만 stall로 센다 —
  # FAIL 문구가 같아도 카운트가 움직이면 진행이다. 카운트 추출 불가(빈 값) 시 fingerprint 단독
  # = 기존 동작과 등가(기존 sig의 SUMMARY도 그 경우 빈 카운트 상수였다). duration은 원래
  # EXIT/FAIL 줄에 없으므로 노이즈 제거가 불필요하다.
  fp="$(grep -E '^(EXIT|FAIL):' "$VERDICT_FILE" 2>/dev/null | sha_of /dev/stdin 2>/dev/null | awk '{print $1}')"
  counts="$(extract_counts)"
  if [ -n "$fp" ] && [ "$fp" = "$prev_fp" ] && { [ -z "$counts" ] || [ "$counts" = "$prev_counts" ]; }; then
    stall_count=$(( stall_count + 1 ))
  else
    stall_count=1
  fi
  prev_fp="$fp"; prev_counts="$counts"
  if [ "$stall_count" -ge "$STALL" ]; then
    log "iter $iter: STALLED — identical failure fingerprint and no count progress ${stall_count}x running. Aborting."
    check_protected_on_abort
    record_fail_lesson
    log "=== loop-fix done: STALLED ==="
    exit 1
  fi

  # ---- budget check ----
  if [ "$BUDGET" -gt 0 ]; then
    elapsed=$(( $(date +%s) - start_epoch ))
    if [ "$elapsed" -ge "$BUDGET" ]; then
      log "iter $iter: budget ${BUDGET}s exhausted (${elapsed}s). Aborting."
      check_protected_on_abort
      record_fail_lesson
      log "=== loop-fix done: BUDGET ==="
      exit 1
    fi
  fi

  # ---- verify-only mode: no fixer, just report and stop ----
  if [ -z "$FIX" ]; then
    log "no --fix given; verify-only mode. Stopping at first FAIL."
    record_fail_lesson
    log "=== loop-fix done: FAIL (verify-only) ==="
    exit 1
  fi

  # ---- recall verified lessons for THIS failure from memory (Phase 3) ----
  RECALLED=""
  if [ -n "$LESSONS" ] && [ -x "$LESSONS_BIN" ]; then
    RECALLED="$("$LESSONS_BIN" recall --signature-file "$VERDICT_FILE" --lessons "$LESSONS" 2>/dev/null)"
    [ -n "$RECALLED" ] && log "iter $iter: recalled lesson(s) from memory"
  fi

  # ---- compose the fix prompt (file-based handoff) ----
  {
    echo "You are the FIX step of a closed verify->fix loop. Iteration $iter of $MAX_ITER."
    echo
    echo "The verifier just FAILED. Make the SMALLEST change to the workspace that will make it PASS."
    echo "Then exit; the loop re-runs the verifier — you do NOT decide success, the verifier does."
    echo
    echo "Hard rules:"
    echo "  - Do NOT modify the verifier or any test/spec files. They are the ground truth."
    echo "  - Do NOT weaken assertions to pass. Fix the code under test."
    echo "  - Change one thing at a time; the loop will tell you if it worked."
    if [ -n "$RECALLED" ]; then
      echo
      echo "From memory (a past verified run hit this same failure — a hint, not a guarantee):"
      printf '%s\n' "$RECALLED" | sed 's/^/    /'
    fi
    echo
    echo "Current verdict:"
    sed 's/^/    /' "$VERDICT_FILE"
    echo
    echo "Full log: $LOG_FILE  (read it only if the FAIL lines above are not enough)"
  } > "$PROMPT_FILE"

  log "iter $iter: invoking fixer…"
  # LOOP_STOP_GATE_OFF=1: 수정자 서브프로세스(claude -p 등)에는 Stop verdict 게이트를 끈다 —
  # 수정자는 성공을 결정하지 않고(GENERATOR != EVALUATOR) 종료 직후 이 루프가 검증기를 다시
  # 돌리므로 게이트가 보탤 것이 없는데, 켜두면 수정자 종료 시점의 verdict가 구조적으로 FAIL이라
  # (수정자는 FAIL 뒤에만 호출된다) 매 회차 3연속 차단+탈출을 반복하며 red-events를 오염시킨다
  # (BAC-564 리뷰 I2).
  LOOP_ITER="$iter" \
  LOOP_PROMPT_FILE="$PROMPT_FILE" \
  LOOP_VERDICT_FILE="$VERDICT_FILE" \
  LOOP_LOG_FILE="$LOG_FILE" \
  LOOP_DIR="$LOOP_DIR" \
  LOOP_STOP_GATE_OFF=1 \
    sh -c "$FIX"
  fcode=$?
  log "iter $iter: fixer exited $fcode"

  # ---- BAC-626 ③: 워치독 발화 확인(수정자 구간) — hung fixer도 같은 시계로 끊는다 ----
  if [ -f "$WATCHDOG_FIRED" ]; then
    wreason="$(head -n1 "$WATCHDOG_FIRED" 2>/dev/null)"
    log "iter $iter: ${wreason:-TIMEOUT} — material-progress watchdog fired during the fixer. Aborting."
    check_protected_on_abort
    record_fail_lesson
    log "=== loop-fix done: ${wreason:-TIMEOUT} ==="
    exit 1
  fi

  # ---- reward-hacking guard: protected files must be untouched ----
  # Round-5: check_protected_with_grace() (bounded sleep-then-recheck) — same reasoning as the
  # PASS-path call above, applied here for consistency (a fixer can background a delayed mutation
  # timed to evade an immediate-only check here just as easily as on the PASS path).
  if ! check_protected_with_grace; then
    handle_protect_violation
  fi
done

log "reached max-iter=$MAX_ITER without PASS. Aborting."
record_fail_lesson
log "=== loop-fix done: MAX-ITER ==="
exit 1
