#!/usr/bin/env bash
# ac-verify.sh — AC-level success contract gate (ADR-0104, issue #23).
#
# Parses a plan file for one-line AC contracts, runs each contracted AC's `verify:` command
# through verdict-run.sh (the same Verdict Contract producer everything else in this repo
# composes with), checks any `artifacts:`/`expect:` fields, and emits its own top-level VERDICT
# block — so it plugs into whatever already consumes verdict-run.sh's shape (Stop-hook,
# loop-fix.sh) unmodified.
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
LOG_DIR="${LOOP_DIR:-.loop}"   # matches verdict-run.sh's own ${LOOP_DIR:-.loop} default convention
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

LOGSUBDIR="$LOG_DIR/ac-verify"
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
        case "$tok" in
          verify:*)
            cur_field="verify"; verify_cmd="$(trim "${tok#verify:}")" ;;
          artifacts:*)
            cur_field="artifacts"; artifacts_field="$(trim "${tok#artifacts:}")" ;;
          expect:*)
            cur_field="expect"; expect_field="$(trim "${tok#expect:}")" ;;
          *)
            case "$cur_field" in
              verify)    verify_cmd="$verify_cmd | $tok" ;;
              artifacts) artifacts_field="$artifacts_field | $tok" ;;
              expect)    expect_field="$expect_field | $tok" ;;
              *)         desc="$desc | $tok" ;;
            esac
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
