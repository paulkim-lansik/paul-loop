#!/usr/bin/env bash
# verdict-run.sh — Phase 0 of loop-engine.
#
# Run ANY verify command and emit a machine-readable VERDICT block (see
# docs/verdict-contract.md). The block is the integration point between a
# verifier (tests/build/lint) and the closed verify->fix loop (Phase 1).
#
# Usage:
#   verdict-run.sh [--log <path>] [--tail <n>] [--max-fails <n>] [--guard-mutation] -- <command> [args...]
#   verdict-run.sh <command> [args...]            # everything is the command if no '--'
#
# --guard-mutation (BAC-626 ④, opt-in): verify 실행 전후 git-가시 상태(digest = HEAD sha +
# status + diff + untracked 내용) 비교 — 검증이 자기 통과 조건을 만드는 변조가 감지되면 verdict를
# FAIL로 뒤집는다(exit code보다 verdict가 우선하는 유일한 명시 예외 — docs/verdict-contract.md
# Rule 1에 명기). gitignored 산출물(.loop/turbo 캐시 등)은 digest 밖이라 오탐 없음. 비-git
# 디렉토리·digest 계산 불능(unborn HEAD 등)에선 exit 2로 거부한다(fail-closed — 가드를 조용히
# 끄지 않는다). 한계: 종단 상태 비교라 실행 중 변조 후 종료 전 원상복구는 잡지 못한다.
#
# Exit code: this wrapper exits 0 if the verdict is PASS, 1 if FAIL, 2 on its own usage error.
# (So verdict-run.sh is itself composable as a verifier.)
#
# Design notes:
#  - VERDICT is the underlying command's exit code, full stop. Counts are best-effort.
#  - stdout is the compact block only; the full output goes to the LOG file (untruncated, but
#    redacted at rest before consumption — BAC-628 기록 시점 redaction below).
#  - FAIL lines are single-line and greppable (^FAIL:) so an LLM reader steers, not drowns.
#  - bash 3.2 compatible (macOS default). No associative arrays, no ${var,,}.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# 중첩 조합(이 래퍼가 이 래퍼를 감싸는 passthrough — loop-fix가 pnpm verdict를 감싸는 실전 경로)
# 에서 같은 검증이 원장에 두 번 남으면 Q2(재작업 지표)가 중첩 깊이만큼 부푼다(리뷰 실측 2건).
# 최상위 래퍼만 원장에 append한다 — 진입 시 표식을 읽고, 하위 호출 전파용으로 세운다.
# verdict-state.json 기록은 기존대로 모든 층이 쓴다(last-writer-wins, 기존 계약 불변).
_LEDGER_NESTED="${VERDICT_RUN_LEDGER_NESTED:-}"
export VERDICT_RUN_LEDGER_NESTED=1

LOG=""
TAIL=200
MAX_FAILS=20
GUARD_MUT=0   # BAC-626 ④ — 기본 off: 켜지 않으면 기존 계약 완전 불변
MUTATED=0

# Guard a two-argument flag: bash 3.2 `shift 2` with <2 args is a no-op (rc=1), which would
# spin `while [ $# -gt 0 ]` forever on a trailing value-less flag. So require the value first.
need2() { [ "$1" -ge 2 ] || { echo "verdict-run.sh: $2 requires a value" >&2; exit 2; }; }

# ---- parse our own flags up to '--' (or first non-flag = start of command) ----
while [ $# -gt 0 ]; do
  case "$1" in
    --log)       need2 $# "$1"; LOG="$2"; shift 2 ;;
    --tail)      need2 $# "$1"; TAIL="$2"; shift 2 ;;
    --max-fails) need2 $# "$1"; MAX_FAILS="$2"; shift 2 ;;
    --guard-mutation) GUARD_MUT=1; shift ;;
    --)          shift; break ;;
    --*)         echo "verdict-run.sh: unknown flag $1" >&2; exit 2 ;;
    *)           break ;;   # first bare word starts the command
  esac
done

if [ $# -eq 0 ]; then
  echo "verdict-run.sh: no command given. Usage: verdict-run.sh -- <command...>" >&2
  exit 2
fi

# ---- default log path ----
if [ -z "$LOG" ]; then
  LOG="${LOOP_DIR:-.loop}/last-run.log"
fi
# Ensure the log's parent dir exists for EVERY log path (not just the default), and that we can
# actually write it. Otherwise the redirection below fails before the command runs and we'd
# fabricate a bogus FAIL from the redirection's exit code instead of the command's.
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
if ! : > "$LOG" 2>/dev/null; then
  echo "verdict-run.sh: cannot write log file '$LOG'" >&2
  exit 2
fi
# absolutise the log path for the LOG: line
case "$LOG" in
  /*) LOG_ABS="$LOG" ;;
  *)  LOG_ABS="$(pwd)/$LOG" ;;
esac

# ---- verdict freshness state (BAC-564 AC5) ----
# Record WHAT this verdict verified — HEAD sha, worktree dirtiness, timestamp, command — so a
# consumer-repo Stop-hook gate (e.g. .claude/hooks/gate-stop-verdict.mjs, if this repo provides
# one — this plugin does not ship a Stop hook itself) can refuse FAIL / stale / dirty PASS
# replays at turn-end (stale-green guard, BAC-581 lineage). Best-effort: a state-write failure
# never changes the verdict or this wrapper's exit code.
STATE_FILE="${LOOP_DIR:-.loop}/verdict-state.json"
CMD_STR="$*"
# \n·\t 치환 후 남은 제어문자(\r 등)는 전부 삭제 — 한 글자라도 남으면 JSON.parse가 깨져 훅이
# stop-state-unreadable로 fail-closed 차단하는데, 재실행이 같은 파손을 재생산해 탈출 전까지
# 벗어날 수 없는 오차단 루프가 된다(리뷰 M5).
json_esc() { printf '%s' "$1" | tr '\n\t' '  ' | tr -d '[:cntrl:]' | cut -c1-500 | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
write_state() {
  _v="$1"; _c="$2"
  _sha="$(git rev-parse HEAD 2>/dev/null)" || _sha=""
  if [ -z "$_sha" ]; then _sha="unknown"; _dirty=true    # 비-git = 신선도 판단 불가 → fail-closed
  elif _st="$(git status --porcelain 2>/dev/null)"; then
    if [ -n "$_st" ]; then _dirty=true; else _dirty=false; fi
  else
    _dirty=true   # status 실패(index.lock 경합 등) = 신선도 불명 → rev-parse와 대칭으로 fail-closed (리뷰 M3)
  fi
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  if ! printf '{"verdict":"%s","exit":%s,"sha":"%s","dirty":%s,"finished_at":"%s","cmd":"%s","log":"%s"}\n' \
    "$_v" "$_c" "$_sha" "$_dirty" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$(json_esc "$CMD_STR")" "$(json_esc "$LOG_ABS")" > "$STATE_FILE" 2>/dev/null; then
    # 쓰기 실패를 완전 무음으로 두면 직전 fresh PASS가 잔존해 최신 FAIL을 덮는 stale-green이 된다
    # (리뷰 M4). 이전 상태 제거를 시도(fail-closed — 게이트가 미기록으로 차단)하고 경고만 남긴다 —
    # verdict 판정·exit code는 불변(best-effort 계약 유지).
    rm -f "$STATE_FILE" 2>/dev/null || true
    echo "verdict-run: warning — verdict 상태 기록 실패($STATE_FILE); 이전 상태를 제거해 fail-closed로 둔다" >&2
  fi
  # 런 이벤트 원장 append(BAC-570) — verdict.passed/failed의 *정본* 산출기. 이 파일은
  # protect.globs 등재라 무장 중 편집이 deny되지만, 원장 파일 자체는 미보호·gitignore라
  # 리다이렉트 위조가 물리적으로 가능하다(텔레메트리 한정 신뢰 — lib/run-ledger.mjs 헤더의
  # 신뢰 경계 참조; 머지 게이트 진실은 verdict-state.json + Stop 훅). best-effort: 원장 실패는
  # verdict·exit code 불변(위 state 계약과 동일). payload는 stdin으로 — 초대형 CMD_STR의 argv
  # 전달은 E2BIG로 죽는다. 중첩 시 최상위 래퍼만 append(상단 _LEDGER_NESTED — Q2 이중 기록 방지).
  # cwd를 payload에 싣는 이유(BAC-778): --auto-run-id는 세션 원장이 있는 루트로 이벤트를 보낼 수
  # 있다(워크트리에서 돈 검증 → 메인 워크트리 세션 원장). 그러면 이벤트만 보고는 "어느 워크트리의
  # 검증이었나"를 알 수 없어진다 — 귀속을 고치면서 출처를 잃지 않도록 실행 위치를 함께 남긴다.
  if [ -z "$_LEDGER_NESTED" ]; then
    printf '{"verdict":"%s","exit":%s,"cmd":"%s","log":"%s","cwd":"%s"}' \
      "$_v" "$_c" "$(json_esc "$CMD_STR")" "$(json_esc "$LOG_ABS")" "$(json_esc "$(pwd)")" \
      | node "$HERE/ledger-append.mjs" \
          --type "$([ "$_v" = "PASS" ] && echo verdict.passed || echo verdict.failed)" \
          --auto-run-id >/dev/null 2>&1 || true
  fi
}

# ---- millisecond clock (perl if present, else coarse seconds) ----
now_ms() {
  perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null || echo $(( $(date +%s) * 1000 ))
}

# ---- workspace mutation guard (BAC-626 ④, opt-in) ----
# digest 범위 = HEAD sha + git 추적 파일 내용(diff HEAD) + git-가시 파일 목록/상태(status
# --porcelain) + untracked 파일 *내용* 해시. 각 요소가 막는 우회(3축 리뷰 ④):
#   - HEAD sha: 변조 후 `git commit`으로 status/diff를 clean으로 되돌리는 커밋 우회
#   - untracked 내용 해시: 기존 untracked 파일 재작성·untracked 디렉토리 안의 신규 파일
#     (status는 이름/`?? dir/` 접힘만 보여 안 잡힌다)
# gitignored(.loop/** · turbo 캐시 · node_modules)는 구조적으로 제외 — 이 래퍼 자신의 로그/상태
# 기록이 오탐을 내지 않는다. LOOP_DIR와 LOG 경로는 gitignore가 없는 레포에서도 명시 제외한다
# (래퍼 산출물이 verify 중 자란다).
# 보증 한계(명시): digest는 실행 전/후 종단 상태 비교다 — 실행 중 변조했다가 종료 전 원상복구
# (mutate-then-restore)하는 게이밍은 잡지 못한다(--protect 'Guard scope'와 같은 좁은 보증).
# git 명령이 하나라도 실패하면(unborn HEAD·index.lock 경합 등) rc!=0 — 호출부가 fail-closed
# 처리한다(무음 강등 금지: status-only로 조용히 좁아지는 fail-open 차단).
workspace_digest() {
  _t="$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || return 1
  {
    git rev-parse HEAD \
      && git status --porcelain=v1 -z \
      && git diff HEAD
  } >> "$_t" 2>/dev/null || { rm -f "$_t"; return 1; }
  _loopdir="${LOOP_DIR:-.loop}"
  git ls-files -o --exclude-standard -z 2>/dev/null \
    | while IFS= read -r -d '' _f; do
        case "$_f" in "$_loopdir"/*) continue ;; esac
        [ "$(pwd)/$_f" = "$LOG_ABS" ] && continue
        printf '== %s ==\n' "$_f" >> "$_t"
        cat "$_f" >> "$_t" 2>/dev/null
      done
  _dig="$( { shasum -a 256 "$_t" 2>/dev/null || sha256sum "$_t" 2>/dev/null; } | awk '{print $1}')"
  rm -f "$_t"
  [ -n "$_dig" ] || return 1
  printf '%s' "$_dig"
}
if [ "$GUARD_MUT" -eq 1 ]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # --protect 0매치와 같은 fail-closed 철학: 가드를 켜 달라 했는데 잴 수 없으면 거부한다.
    echo "verdict-run.sh: --guard-mutation needs a git worktree (digest = git-visible state) — refusing to run with the guard silently OFF." >&2
    exit 2
  fi
  if ! dig_before="$(workspace_digest)"; then
    echo "verdict-run.sh: --guard-mutation could not compute the workspace digest (unborn HEAD or git error) — refusing to run with the guard silently OFF." >&2
    exit 2
  fi
fi

start_ms="$(now_ms)"
# Run the command; capture combined output to the log, preserve real exit code.
"$@" >"$LOG" 2>&1
code=$?
end_ms="$(now_ms)"
dur=$(( end_ms - start_ms ))
[ "$dur" -lt 0 ] && dur=0

if [ "$GUARD_MUT" -eq 1 ]; then
  if ! dig_after="$(workspace_digest)"; then
    # 실행 후 digest 실패 = 무변조를 증명할 수 없음 → 변조와 동일하게 FAIL(fail-closed).
    # 여기서 exit 2를 내면 방금 돈 명령의 실 결과·로그가 통째로 증발한다 — verdict로 남긴다.
    MUTATED=1
    code=1
  elif [ "$dig_after" != "$dig_before" ]; then
    MUTATED=1
    code=1   # opt-in 명시 계약: verdict가 exit code보다 먼저 뒤집히는 유일한 예외 (헤더 참조)
  fi
fi

# ---- 기록 시점 redaction (BAC-628, ouroboros O5) ----
# LOG를 소비 전에 원천 살균 — passthrough cat·FAIL 추출·loop-fix 프롬프트·lessons 서명이 전부 이
# 파일에서 파생되므로 이 한 지점이 하류를 커버한다. 커밋 시점 gitleaks(ADR-0078 M0)와 상보.
# best-effort: 실패해도 verdict·exit 불변(write_state와 같은 계약), 원문 유지+경고만(fail-open —
# 로그를 지우면 loop-fix 진단이 죽는다. 프라이버시 fail-closed는 스위치 값 해석에만 적용: 미지값=ON).
if [ "${LOOP_SANITIZE_OFF:-}" != "1" ]; then
  if ! _rerr="$(node "$HERE/../lib/sanitize.mjs" --in-place "$LOG" 2>&1)"; then
    # 실패 원인(node 부재·SyntaxError 등)을 삼키지 않는다 — 경고에 첫 줄을 포함(리뷰: 무음 영구화 방지).
    _rerr="$(printf '%s' "$_rerr" | head -n1 | cut -c1-200)"
    echo "verdict-run: warning — log redaction failed (${_rerr:-unknown error}); raw log kept at $LOG" >&2
  fi
fi

# Passthrough: if the command ALREADY emitted a Verdict Contract block (e.g. eval-gate.mjs),
# don't re-wrap it — that would bury its richer VERDICT/SUMMARY/FAIL lines in the log and emit a
# generic block. Echo its block verbatim and mirror its exit code.
if [ "$(head -n1 "$LOG" 2>/dev/null)" = "=== VERDICT ===" ]; then
  if [ "$MUTATED" -eq 1 ]; then
    # 변조 시 내부 블록을 재방출하지 않는다 — 블록 2개 방출은 계약 위반(delimiter 추출 모호성).
    # 자체 FAIL 블록으로 대체하고 내부 블록은 LOG에 남긴다.
    write_state FAIL 1
    printf '=== VERDICT ===\nVERDICT: FAIL\nEXIT: 1\n'
    printf 'SUMMARY: passed= failed= skipped= duration_ms=%s\n' "$dur"
    printf 'FAIL: workspace mutated during verify (--guard-mutation) — verify must not change git-visible state\n'
    printf 'LOG: %s\n=== END VERDICT ===\n' "$LOG_ABS"
    exit 1
  fi
  if [ "$code" -eq 0 ]; then write_state PASS "$code"; else write_state FAIL "$code"; fi
  cat "$LOG"
  exit "$code"
fi

# ---- best-effort count extraction (advisory only; never affects VERDICT) ----
# Look at the tail of the log for common framework summary lines.
passed=""; failed=""; skipped=""
_scan="$(tail -n 60 "$LOG" 2>/dev/null)"

# jest / vitest:  "Tests: 1 failed, 4 passed, 1 skipped, 6 total"
_line="$(printf '%s\n' "$_scan" | grep -iE 'Tests?:' | tail -n 1)"
if [ -n "$_line" ]; then
  _f="$(printf '%s' "$_line" | grep -oiE '[0-9]+ failed'  | grep -oE '[0-9]+' | tail -n1)"
  _p="$(printf '%s' "$_line" | grep -oiE '[0-9]+ passed'  | grep -oE '[0-9]+' | tail -n1)"
  _s="$(printf '%s' "$_line" | grep -oiE '[0-9]+ skipped' | grep -oE '[0-9]+' | tail -n1)"
  [ -n "$_f" ] && failed="$_f"; [ -n "$_p" ] && passed="$_p"; [ -n "$_s" ] && skipped="$_s"
fi

# node --test / TAP:  "# pass 4" / "# fail 1" / "# skipped 0"
if [ -z "$passed$failed" ]; then
  _p="$(printf '%s\n' "$_scan" | grep -oiE '# pass(ed)? +[0-9]+'    | grep -oE '[0-9]+' | tail -n1)"
  _f="$(printf '%s\n' "$_scan" | grep -oiE '# fail(ed)? +[0-9]+'    | grep -oE '[0-9]+' | tail -n1)"
  _s="$(printf '%s\n' "$_scan" | grep -oiE '# skipped +[0-9]+'      | grep -oE '[0-9]+' | tail -n1)"
  [ -n "$_p" ] && passed="$_p"; [ -n "$_f" ] && failed="$_f"; [ -n "$_s" ] && skipped="$_s"
fi

# pytest:  "1 failed, 4 passed in 0.12s"
if [ -z "$passed$failed" ]; then
  _line="$(printf '%s\n' "$_scan" | grep -oiE '[0-9]+ (failed|passed|skipped)([, ]|$)' | tr '\n' ' ')"
  if [ -n "$_line" ]; then
    _f="$(printf '%s' "$_line" | grep -oiE '[0-9]+ failed'  | grep -oE '[0-9]+' | tail -n1)"
    _p="$(printf '%s' "$_line" | grep -oiE '[0-9]+ passed'  | grep -oE '[0-9]+' | tail -n1)"
    _s="$(printf '%s' "$_line" | grep -oiE '[0-9]+ skipped' | grep -oE '[0-9]+' | tail -n1)"
    [ -n "$_f" ] && failed="$_f"; [ -n "$_p" ] && passed="$_p"; [ -n "$_s" ] && skipped="$_s"
  fi
fi

# ---- verdict from exit code (ground truth) ----
if [ "$code" -eq 0 ]; then verdict="PASS"; else verdict="FAIL"; fi
write_state "$verdict" "$code"

# ---- extract greppable failure lines (only when failing) ----
# Curated, framework-native per-failure markers — kept narrow so FAIL lines stay a clean
# steering signal (not stack-trace noise). Adjacent duplicates are collapsed. Generic 'Error:'
# is deliberately excluded because it mostly matches stack frames.
fails=""
if [ "$verdict" = "FAIL" ]; then
  fails="$(grep -nE '(✕|✗|✖|✘|×|not ok|--- FAIL|FAILED|AssertionError|panic:)' "$LOG" 2>/dev/null \
    | sed -e 's/[[:space:]]\{2,\}/ /g' \
    | cut -c1-200 \
    | awk '!seen[$0]++' \
    | head -n "$MAX_FAILS")"
fi

# ---- emit the contract block ----
printf '=== VERDICT ===\n'
printf 'VERDICT: %s\n' "$verdict"
printf 'EXIT: %s\n' "$code"
printf 'SUMMARY: passed=%s failed=%s skipped=%s duration_ms=%s\n' "$passed" "$failed" "$skipped" "$dur"
if [ "$verdict" = "FAIL" ]; then
  # BAC-626 ④: 변조 FAIL 줄을 맨 앞에 — 마커 부재 시의 generic 줄은 이 줄이 대신한다
  # (명령 자체는 0으로 끝났을 수 있어 "command exited 1"은 오독을 낳는다).
  [ "$MUTATED" -eq 1 ] && printf 'FAIL: workspace mutated during verify (--guard-mutation) — verify must not change git-visible state\n'
  if [ -n "$fails" ]; then
    printf '%s\n' "$fails" | while IFS= read -r ln; do
      [ -n "$ln" ] && printf 'FAIL: %s\n' "$ln"
    done
  elif [ "$MUTATED" -eq 0 ]; then
    printf 'FAIL: command exited %s with no recognised failure markers (see LOG)\n' "$code"
  fi
fi
printf 'LOG: %s\n' "$LOG_ABS"
printf '=== END VERDICT ===\n'

# mirror the verdict in our own exit code so verdict-run.sh composes
[ "$verdict" = "PASS" ] && exit 0 || exit 1
