#!/usr/bin/env bash
# ac-verify.sh — AC-level success contract gate (ADR-0104, issue #23).
#
# Parses a plan file for one-line AC contracts, runs each contracted AC's `verify:` command
# through verdict-run.sh (the same Verdict Contract producer everything else in this repo
# composes with), checks any `artifacts:`/`expect:` fields, and emits its own top-level VERDICT
# block — so it plugs into whatever already consumes verdict-run.sh's shape (Stop-hook,
# loop-fix.sh) unmodified. This includes ${LOOP_DIR:-.loop}/verdict-state.json — coupled to OUR
# --log-dir via an explicit `export LOOP_DIR="$LOG_DIR"` (see below) so a non-default --log-dir
# isn't silently ignored: each per-AC verdict-run.sh sub-call writes that shared file with ITS OWN
# pass/fail (existing, unmodified last-writer-wins contract). An EXIT trap (armed at the very top
# of the script, before argument parsing even begins, see below) makes one corrective sync call on
# EVERY exit path this script can take — normal completion AND any early exit (usage errors
# including ones during argument parsing itself, a verdict-run.sh exit-2 hit mid-run, or any exit
# path added later) — so it is always the last writer: the true aggregate on
# normal completion, a fail-closed default on any early exit. A Stop-hook-style freshness gate
# reading that file always sees ac-verify.sh's true result for THIS run, never a stale leftover
# from an earlier AC or an earlier unrelated run.
#
# Usage:
#   ac-verify.sh <plan-file> [--log-dir <dir>]
#
# <plan-file> is a markdown (or plain text) file. It is scanned line-by-line for AC lines of the
# form (an optional leading markdown list marker is tolerated):
#
#   AC: <description> | verify: <command> | artifacts: <paths> | expect: <substring>
#   - AC: <description> | verify: <command>
#
# Only `AC: <description>` is required. `verify:`, `artifacts:`, and `expect:` are each optional,
# may appear in any combination, and in any order after the description — each field is
# separated from its neighbours by ` | ` (space-pipe-space). An AC line with none of the three
# optional fields is a legitimate, human-readable-only acceptance criterion: it counts as
# `skipped` in the aggregate, not as a failure in itself.
#
# artifacts: delimiter convention — COMMA-separated (`artifacts: path/one, path/two`). Chosen
# over whitespace because paths may themselves contain spaces, and the field is already bounded
# by ` | ` on both sides. Use this convention consistently anywhere plans are authored (see the
# ship-feature SKILL.md step 1 guidance, which quotes this same syntax).
#
# Per contracted AC:
#   - verify:    run via `verdict-run.sh --log <per-AC log> -- sh -c "<command>"` (same
#                `-- sh -c` invocation loop-fix.sh uses). verdict-run.sh's own exit code decides
#                this check: 0 = pass, nonzero = fail. A verdict-run.sh exit of 2 (its own
#                usage-error / fail-closed refusal) is NOT a normal AC failure — it aborts
#                ac-verify.sh itself with exit 2, same as loop-fix.sh's handling of the same case.
#   - artifacts: each comma-separated path must exist (`-e`), resolved relative to the CWD
#                ac-verify.sh itself runs from (NOT the plan file's directory — verify commands
#                and artifacts are expected relative to the repo/worktree root, same as verify
#                commands already are).
#   - expect:    the per-AC log (verdict-run.sh's untruncated LOG output for that AC; empty if
#                the AC has no verify: field) must contain this LITERAL substring (`grep -F`, not
#                a regex).
# An AC is fully PASSED only if every field it declares independently passes. A field that isn't
# present on that AC line is simply not checked (neither pass nor fail).
#
# Fail-closed (modeled directly on require-tests.sh's "0 tests = RED"): if the plan has zero AC
# lines at all, OR has AC lines but zero of them carry any contract field, the overall VERDICT is
# FAIL — a gate that can PASS over zero contracts is exactly the dogfood trap ADR-0104 documents
# (optional fields go unfilled unless something makes zero unacceptable). This does not require
# every AC to have a contract — only that the plan as a whole has at least one.
#
# Exit code: 0 when VERDICT is PASS, 1 when FAIL, 2 on a genuine usage error (missing/unreadable
# plan file, bad flag, or a verdict-run.sh exit-2 encountered mid-run — see above).
#
# bash 3.2 compatible (macOS default). No associative arrays, no ${var,,}, no mapfile/readarray.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERDICT_RUN="$HERE/verdict-run.sh"

# ---- fail-closed corrective verdict-state.json sync via an EXIT trap — armed FIRST, before ANY
# possible exit path (round-3 adversarial finding: the trap used to be registered AFTER the
# argument-parsing while-loop below, so a usage error DURING parsing itself — an unknown flag,
# `--log-dir` given with no value, a stray extra positional argument — called `exit 2` before the
# trap was ever armed, leaving a stale earlier verdict-state.json completely untouched). Nothing
# below this point may run any command that can exit before `trap ... EXIT` on the next line has
# executed — so this block only ever does plain variable assignments and function *definitions*
# (which cannot themselves fail/exit), never a command invocation.
#
# LOG_DIR gets its safe default here (matches verdict-run.sh's own ${LOOP_DIR:-.loop} convention)
# so the trap has a real target even if a usage error strikes before the argument-parsing loop
# below ever runs. That loop still overrides LOG_DIR via --log-dir when given (unchanged), and
# re-derives LOGSUBDIR from the finalized value right after — since the trap's handler reads
# SYNC_LOG (and SYNC_VERDICT_EXIT) at the moment it actually FIRES, not at registration time (bash
# closures over the current value of a global variable), it continues to target wherever LOG_DIR
# ends up being by the time of any given exit, exactly as it already did for the exit paths that
# were already covered.
#
# ac-verify.sh has multiple exit paths — normal completion, usage errors (now including ones
# during argument parsing itself), and a per-AC verdict-run.sh sub-call's own exit-2 refusal
# encountered mid-run (see the header comment, and any exit path added later). A sync call placed
# only at normal completion leaves every early-exit path with whatever an earlier AC's OWN
# sub-call happened to leave in verdict-state.json (last-writer-wins) — a stale, unrelated
# pass/fail for a run that never actually finished. Fixing this per call-site doesn't scale (the
# next new early-exit path reopens the same gap) — so instead ONE trap fires on every exit, no
# matter which code path reaches it, and makes one corrective verdict-run.sh sync call
# (stdout+stderr discarded) whose only purpose is to be the last writer.
#
# SYNC_VERDICT_EXIT starts fail-closed (1 = FAIL) BEFORE the trap is registered — "treat this run
# as failed/incomplete unless proven otherwise". Only the normal-completion path far below (once
# the true aggregate $code has actually been computed) updates SYNC_VERDICT_EXIT to that real
# value, right before the script's final `exit "$code"` — which is what fires the trap. Every
# other exit reaches the trap with the untouched fail-closed default. The handler never calls
# `exit` itself (that would clobber the real exit code this script is trying to return) — it only
# runs its side effect and lets the original exit code propagate.
LOG_DIR="${LOOP_DIR:-.loop}"   # matches verdict-run.sh's own ${LOOP_DIR:-.loop} default convention
LOGSUBDIR="$LOG_DIR/ac-verify"
SYNC_VERDICT_EXIT=1
SYNC_LOG="$LOGSUBDIR/aggregate-sync.log"

# Single-quote-escape $1 for safe embedding inside a single-quoted `sh -c` argument (used by the
# verdict-state.json aggregate-sync call below — the plan path may contain spaces/quotes). Classic
# close-quote/escaped-quote/reopen-quote trick. Note: BSD/macOS sed drops a lone backslash before a
# non-special replacement char, so this needs FOUR backslashes in the double-quoted sed argument
# (bash's own double-quote parsing folds 4 -> 2, then sed's `\\` -> one literal backslash escape
# folds 2 -> 1) to land a single literal backslash in the output — verified empirically on macOS.
# Defined here (not further below with the other small helpers) because sync_verdict_state_on_exit
# calls it directly — a plain assignment/def block like this one can't itself exit, so defining it
# ahead of the trap registration below is safe (PLAN is still unset at trap-registration time; the
# handler reads its CURRENT value, empty string, when it actually fires).
shquote() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

sync_verdict_state_on_exit() {
  sync_desc="ac-verify.sh aggregate result for '$(shquote "${PLAN:-}")'"
  "$VERDICT_RUN" --log "$SYNC_LOG" -- sh -c ": $sync_desc; exit $SYNC_VERDICT_EXIT" >/dev/null 2>&1
}
trap sync_verdict_state_on_exit EXIT

SEP=$'\x1e'   # rare separator used only to split on literal " | " without touching pipes elsewhere in a token

need2() { [ "$1" -ge 2 ] || { echo "ac-verify.sh: $2 requires a value" >&2; exit 2; }; }

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null || echo $(( $(date +%s) * 1000 ))
}

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

join_semicolon() {
  out=""
  for a in "$@"; do
    if [ -z "$out" ]; then out="$a"; else out="$out; $a"; fi
  done
  printf '%s' "$out"
}

# ---- parse args ----
PLAN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log-dir) need2 $# "$1"; LOG_DIR="$2"; shift 2 ;;
    --*)       echo "ac-verify.sh: unknown flag $1" >&2; exit 2 ;;
    *)
      if [ -z "$PLAN" ]; then PLAN="$1"; shift
      else echo "ac-verify.sh: unexpected extra argument '$1'" >&2; exit 2; fi
      ;;
  esac
done

# ---- LOG_DIR is now finalized (flag parsed, default applied). Re-derive its dependents (the
# trap above already covered every exit up to this point using the pre-parse default) ----
LOGSUBDIR="$LOG_DIR/ac-verify"
SYNC_LOG="$LOGSUBDIR/aggregate-sync.log"

# Couple verdict-run.sh's own ${LOOP_DIR:-.loop} default to OUR --log-dir (issue #23 round-2
# finding: they were previously decoupled — verdict-run.sh's write_state() derives
# verdict-state.json's path purely from ITS OWN process's LOOP_DIR env var, which ac-verify.sh
# never set, so a non-default --log-dir silently got its state file written to the unrelated
# default ./.loop/ instead, and two parallel --log-dir runs with no manually-exported LOOP_DIR
# would clobber the same shared default file). Exporting here makes every verdict-run.sh sub-call
# below (per-AC calls and the corrective sync call) inherit a LOOP_DIR guaranteed to match
# --log-dir. Both default to the literal ".loop", so this is a no-op for every caller that doesn't
# pass --log-dir.
export LOOP_DIR="$LOG_DIR"

if [ -z "$PLAN" ]; then
  echo "ac-verify.sh: a plan file is required. Usage: ac-verify.sh <plan-file> [--log-dir <dir>]" >&2
  exit 2
fi
if [ ! -f "$PLAN" ] || [ ! -r "$PLAN" ]; then
  echo "ac-verify.sh: cannot read plan file '$PLAN'" >&2
  exit 2
fi
if [ ! -x "$VERDICT_RUN" ]; then
  echo "ac-verify.sh: cannot find verdict-run.sh next to me ($VERDICT_RUN)" >&2
  exit 2
fi

mkdir -p "$LOGSUBDIR" 2>/dev/null || { echo "ac-verify.sh: cannot create log directory '$LOGSUBDIR'" >&2; exit 2; }
AGG_LOG="$LOG_DIR/ac-verify.log"
: > "$AGG_LOG" 2>/dev/null || { echo "ac-verify.sh: cannot write aggregate log file '$AGG_LOG'" >&2; exit 2; }
case "$AGG_LOG" in
  /*) AGG_LOG_ABS="$AGG_LOG" ;;
  *)  AGG_LOG_ABS="$(pwd)/$AGG_LOG" ;;
esac
printf 'ac-verify.sh aggregate log for plan: %s\n\n' "$PLAN" >> "$AGG_LOG"

start_ms="$(now_ms)"

total=0; contracted=0; passed=0; failed=0
FAILS=()
idx=0

# ---- scan the plan file for AC lines ----
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^[[:space:]]*(-[[:space:]]+)?AC:[[:space:]]*(.*)$ ]]; then
    content="${BASH_REMATCH[2]}"
    idx=$((idx + 1))
    total=$((total + 1))

    # ---- split content on literal " | " (space-pipe-space), tolerating pipes embedded inside a
    # field's own value — e.g. a verify: command with a shell pipe — by re-merging any segment
    # that doesn't start with a known field prefix back onto the current field. ----
    content_sub="${content// | /$SEP}"
    IFS="$SEP" read -ra toks <<< "$content_sub"

    desc=""; verify_cmd=""; artifacts_field=""; expect_field=""
    cur_field="desc"; first=1
    # bash 3.2 + `set -u`: expanding "${toks[@]}" on a zero-element array is an unbound-variable
    # error, so guard with the count first (an AC line with nothing after "AC:" produces one).
    if [ "${#toks[@]}" -gt 0 ]; then
      for tok in "${toks[@]}"; do
        if [ "$first" -eq 1 ]; then
          desc="$(trim "$tok")"; first=0; continue
        fi

        # ---- normalize a COPY of the token for field-prefix matching only — lowercase (bash 3.2:
        # tr, no ${var,,}) + strip up to one layer of leading markdown emphasis (**/__/*/_)
        # immediately before the field name. Without this, an authoring variant like `Verify:` or
        # `**verify:**` (both plausible things an LLM or human plan author writes) silently and
        # invisibly folds into the description — a typo that quietly turns a real intended
        # contract into "no contract", indistinguishable from a deliberately-uncontracted AC. The
        # ORIGINAL (case-preserved, marker-preserved) text is used for the extracted VALUE below —
        # only the prefix-match step itself needs to tolerate this.
        tok_stripped="$tok"
        case "$tok_stripped" in
          '**'*) tok_stripped="${tok_stripped:2}" ;;
          '__'*) tok_stripped="${tok_stripped:2}" ;;
          '*'*)  tok_stripped="${tok_stripped:1}" ;;
          '_'*)  tok_stripped="${tok_stripped:1}" ;;
        esac
        tok_norm="$(printf '%s' "$tok_stripped" | tr 'A-Z' 'a-z')"

        field=""; label_len=0
        case "$tok_norm" in
          verify:*)    field="verify";    label_len=7  ;;
          artifacts:*) field="artifacts"; label_len=10 ;;
          expect:*)    field="expect";    label_len=7  ;;
        esac

        if [ -n "$field" ]; then
          value="${tok_stripped:$label_len}"
          # trailing emphasis markers immediately after the colon — the closing `**` of
          # `**verify:**` lands here (same one-layer tolerance, other side of the label).
          case "$value" in
            '**'*) value="${value:2}" ;;
            '__'*) value="${value:2}" ;;
            '*'*)  value="${value:1}" ;;
            '_'*)  value="${value:1}" ;;
          esac
          value="$(trim "$value")"
          cur_field="$field"
          case "$field" in
            verify)    verify_cmd="$value" ;;
            artifacts) artifacts_field="$value" ;;
            expect)    expect_field="$value" ;;
          esac
          continue
        fi

        case "$cur_field" in
          verify)    verify_cmd="$verify_cmd | $tok" ;;
          artifacts) artifacts_field="$artifacts_field | $tok" ;;
          expect)    expect_field="$expect_field | $tok" ;;
          *)
            # This segment matched none of the three known fields (even after the normalization
            # above) and is about to silently vanish into the description — exactly the
            # invisible-typo failure mode. Warn on stderr (not a hard error — an ordinary colon or
            # leading word in free-text description content is legitimate and common; failing the
            # build over it would be worse than the bug) when either heuristic fires:
            #   1. it LOOKS like a mistyped field (a `:` within roughly its first 20 chars), or
            #   2. its first whitespace-delimited word — after the SAME leading-emphasis-marker
            #      stripping + lower-casing as the field-prefix matcher above, and with any single
            #      trailing `:` stripped — case-insensitively equals one of the three reserved
            #      field names. This catches a colon-OMITTED typo (e.g. "verify exit 9" instead of
            #      "verify: exit 9") that heuristic 1 alone can't see (no colon anywhere), without
            #      false-positiving on ordinary free text (which essentially never starts with
            #      exactly one of these three words by coincidence). Additive to heuristic 1, which
            #      still independently catches colon-typos further into a segment (e.g. the field
            #      name itself misspelled, as in "verfy: exit 7").
            seg="$(trim "$tok")"
            head20="$(printf '%s' "$seg" | cut -c1-20)"
            warn=0
            case "$head20" in
              *:*) warn=1 ;;
            esac
            word="$(printf '%s' "$seg" | awk '{print $1}')"
            case "$word" in
              '**'*) word="${word:2}" ;;
              '__'*) word="${word:2}" ;;
              '*'*)  word="${word:1}" ;;
              '_'*)  word="${word:1}" ;;
            esac
            word="${word%:}"
            word_norm="$(printf '%s' "$word" | tr 'A-Z' 'a-z')"
            case "$word_norm" in
              verify|artifacts|expect) warn=1 ;;
            esac
            [ "$warn" -eq 1 ] && echo "ac-verify.sh: warning — AC #$idx (\"$desc\"): unrecognized field-like segment (folded into description, not treated as a contract): \"$seg\"" >&2
            desc="$desc | $tok"
            ;;
        esac
      done
    fi

    has_contract=0
    [ -n "$verify_cmd" ] && has_contract=1
    [ -n "$artifacts_field" ] && has_contract=1
    [ -n "$expect_field" ] && has_contract=1
    if [ "$has_contract" -eq 0 ]; then
      continue   # description-only AC: legitimate, counted under skipped= below (not a failure)
    fi
    contracted=$((contracted + 1))

    ac_log="$LOGSUBDIR/ac-$idx.log"
    reasons=()

    if [ -n "$verify_cmd" ]; then
      # Capture verdict-run's own compact block via command substitution (NOT a `>` file
      # redirect) — a file redirect that fails to open (e.g. an unwritable log dir) would exit 1
      # itself WITHOUT verdict-run.sh ever running, masking what should be verdict-run's own
      # exit-2 usage error as an ordinary AC FAIL. verdict-run.sh creates/truncates $ac_log itself
      # (its own --log target), so we don't pre-touch it here — only in the else-branch below.
      vr_out="$("$VERDICT_RUN" --log "$ac_log" -- sh -c "$verify_cmd" 2>&1)"
      vcode=$?
      if [ "$vcode" -eq 2 ]; then
        # Mirrors loop-fix.sh's own handling: verdict-run's exit 2 is ITS usage error/fail-closed
        # refusal, not a normal verify FAIL — don't silently swallow it into an AC failure.
        echo "ac-verify.sh: verdict-run.sh refused to run for AC #$idx (\"$desc\") — usage error (exit 2):" >&2
        printf '%s\n' "$vr_out" | sed 's/^/    /' >&2
        exit 2
      fi
      if [ "$vcode" -ne 0 ]; then
        # verdict-run.sh's own exit code just mirrors PASS/FAIL (0/1) — pull the underlying
        # command's real exit code out of verdict-run's emitted block for a more useful reason.
        real_exit="$(printf '%s\n' "$vr_out" | grep -m1 '^EXIT: ' | sed 's/^EXIT: //')"
        if [ -n "$real_exit" ]; then
          reasons+=("verify exited $real_exit")
        else
          reasons+=("verify failed (verdict-run.sh exit $vcode)")
        fi
      fi
    else
      # No verify: field — nothing else will create $ac_log, but expect: (if present) still needs
      # a defined (empty) target to grep. A write failure here means the environment itself is
      # broken (unwritable log dir) — fail closed with exit 2 rather than silently mis-reporting
      # it as an ordinary AC FAIL.
      if ! : > "$ac_log" 2>/dev/null; then
        echo "ac-verify.sh: cannot write per-AC log '$ac_log' for AC #$idx (\"$desc\")" >&2
        exit 2
      fi
    fi

    if [ -n "$artifacts_field" ]; then
      missing=""
      IFS=',' read -ra apaths <<< "$artifacts_field"
      if [ "${#apaths[@]}" -gt 0 ]; then
        for p in "${apaths[@]}"; do
          pt="$(trim "$p")"
          [ -z "$pt" ] && continue
          if [ ! -e "$pt" ]; then
            if [ -z "$missing" ]; then missing="$pt"; else missing="$missing, $pt"; fi
          fi
        done
      fi
      [ -n "$missing" ] && reasons+=("missing artifact(s): $missing")
    fi

    if [ -n "$expect_field" ]; then
      if ! grep -qF -- "$expect_field" "$ac_log" 2>/dev/null; then
        reasons+=("expect substring not found: \"$expect_field\"")
      fi
    fi

    ac_ok=1
    [ "${#reasons[@]}" -gt 0 ] && ac_ok=0

    {
      printf '===== AC #%s: %s =====\n' "$idx" "$desc"
      [ -n "$verify_cmd" ]      && printf 'verify: %s\n' "$verify_cmd"
      [ -n "$artifacts_field" ] && printf 'artifacts: %s\n' "$artifacts_field"
      [ -n "$expect_field" ]    && printf 'expect: %s\n' "$expect_field"
      if [ "$ac_ok" -eq 1 ]; then
        printf 'result: PASS\n'
      else
        printf 'result: FAIL (%s)\n' "$(join_semicolon "${reasons[@]}")"
      fi
      printf -- '--- output log: %s ---\n' "$ac_log"
      cat "$ac_log" 2>/dev/null
      printf '\n'
    } >> "$AGG_LOG"

    if [ "$ac_ok" -eq 1 ]; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
      FAILS+=("AC \"$desc\": $(join_semicolon "${reasons[@]}")")
    fi
  fi
done < "$PLAN"

skipped=$((total - contracted))
end_ms="$(now_ms)"
dur=$(( end_ms - start_ms ))
[ "$dur" -lt 0 ] && dur=0

# ---- fail-closed: zero AC lines, or AC lines with zero contracts (require-tests.sh precedent) ----
if [ "$total" -eq 0 ]; then
  verdict="FAIL"
  FAILS=("plan file '$PLAN' has ZERO AC lines ('AC: <description>') — a runtime-surface track requires at least one AC contract (verify:/artifacts:/expect:); same fail-closed shape as require-tests.sh's 0-tests=RED (refusing to certify PASS over nothing).")
  printf 'ac-verify.sh: no "AC:" lines found in %s\n' "$PLAN" >> "$AGG_LOG"
elif [ "$contracted" -eq 0 ]; then
  verdict="FAIL"
  FAILS=("plan file '$PLAN' has $total AC line(s) but ZERO carry a machine-checkable contract (verify:/artifacts:/expect:) — a runtime-surface track requires at least one AC contract; same fail-closed shape as require-tests.sh's 0-tests=RED (refusing to certify PASS over nothing).")
  printf 'ac-verify.sh: %s AC line(s) found in %s but none carry a verify:/artifacts:/expect: contract\n' "$total" "$PLAN" >> "$AGG_LOG"
elif [ "$failed" -gt 0 ]; then
  verdict="FAIL"
else
  verdict="PASS"
fi

code=0; [ "$verdict" = "FAIL" ] && code=1

# ---- the true aggregate is now known: arm the EXIT trap (registered earlier, right after
# LOG_DIR was finalized) with the REAL result instead of its fail-closed default. This is the only
# place SYNC_VERDICT_EXIT moves off of "1" — every other exit path in this script (including ones
# added later) reaches the trap with the safe fail-closed default untouched, and the trap's own
# corrective verdict-run.sh sync call (its stdout+stderr discarded — ac-verify.sh's own richer,
# AC-specific block below, with the real passed=/failed=/skipped= SUMMARY, remains the only
# VERDICT block that reaches the caller's stdout) fires automatically once this script exits.
SYNC_VERDICT_EXIT="$code"

printf '=== VERDICT ===\n'
printf 'VERDICT: %s\n' "$verdict"
printf 'EXIT: %s\n' "$code"
printf 'SUMMARY: passed=%s failed=%s skipped=%s duration_ms=%s\n' "$passed" "$failed" "$skipped" "$dur"
# bash 3.2 + `set -u`: guard the same zero-element-array expansion pitfall as above.
if [ "${#FAILS[@]}" -gt 0 ]; then
  for f in "${FAILS[@]}"; do
    printf 'FAIL: %s\n' "$f"
  done
fi
printf 'LOG: %s\n' "$AGG_LOG_ABS"
printf '=== END VERDICT ===\n'

exit "$code"
