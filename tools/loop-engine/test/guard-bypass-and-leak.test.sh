#!/usr/bin/env bash
# Three findings from the security audit that share one shape: a value the code treats as inert is
# actually load-bearing, and nothing in the suite disagreed.
#
#   M2  protect-during-loop.mjs — the mutation-verb list omitted `ln`, and the repo-relative path was
#       computed lexically. Either one alone lets a fixer rewrite a protected file: `ln -sf` replaces
#       its content with no listed verb. (The audit also flagged the lexical `relative()` fallback as
#       a symlink bypass; measured, it is not — worktree re-rooting resolves the symlink through git
#       before that line runs. The case is pinned below rather than fixed, since there was no defect.)
#   M4  tcp-reachable.mjs — the two failure paths returned the raw connection string as `label`, and
#       loop-doctor-heartbeat.mjs prints `label` straight into an agent's SessionStart context. That
#       string is `postgres://user:password@host/db`.
#   M6  ledger-append.mjs — `--run-id` becomes a filename with no validation, so it is a path.
#
# Each is written against the property, not the payload: "no mutation verb reaches a protected file",
# "no output field carries credentials", "a run id cannot be a path".
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../hooks/protect-during-loop.mjs"
TCP="$HERE/../lib/tcp-reachable.mjs"
LEDGER="$HERE/../bin/ledger-append.mjs"

fail() { echo "FAIL: $1"; exit 1; }
for f in "$HOOK" "$TCP" "$LEDGER"; do [ -f "$f" ] || fail "missing fixture target: $f"; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$WORK"' EXIT
g() { git -c user.email=t@example.com -c user.name=t -C "$@"; }

FAILURES=()

# ── fixture: a repo on a working branch, so the guard is armed ────────────────────────────────────
REPO="$WORK/repo"
mkdir -p "$REPO/.loop"
git init -q -b feature/x "$REPO" || fail "git init failed"
printf '**/*.test.sh\n' > "$REPO/.loop/protect.globs"
echo x > "$REPO/a.test.sh"
echo decoy > "$REPO/decoy"
g "$REPO" add -A >/dev/null && g "$REPO" commit -qm init || fail "git commit failed"

run() { # run <root> <tool> <arg> [cwd]
  node -e '
    const [tool, arg, cwd] = process.argv.slice(1);
    const p = { tool_name: tool, tool_input: tool === "Bash" ? { command: arg } : { file_path: arg } };
    if (cwd) p.cwd = cwd;
    process.stdout.write(JSON.stringify(p));
  ' "$2" "$3" "${4:-}" | CLAUDE_PROJECT_DIR="$1" node "$HOOK" 2>>"$WORK/stderr"
}
check() { # check <desc> <deny|allow> <root> <tool> <arg> [cwd]
  local desc="$1" want="$2"; shift 2
  local out got=allow
  out="$(run "$@")" || { echo "FAILED: $desc — hook exited non-zero (it must always exit 0)"; FAILURES+=("$desc"); return; }
  printf '%s' "$out" | grep -q '"permissionDecision":"deny"' && got=deny
  if [ "$got" = "$want" ]; then echo "PASS: $desc"
  else echo "FAILED: $desc — wanted $want, got $got"; FAILURES+=("$desc"); fi
}

# ── M2: every way to replace a protected file's content is a mutation ─────────────────────────────
# `ln` was the missing verb. Both forms replace the bytes an agent reads at that path.
check "ln -sf onto a protected file is a mutation" deny "$REPO" Bash "ln -sf /dev/null a.test.sh" "$REPO"
check "ln -f onto a protected file is a mutation"  deny "$REPO" Bash "ln -f decoy a.test.sh"      "$REPO"
# Pin the verbs that already worked, so a future edit to the regex cannot drop one silently.
check "mv onto a protected file is still a mutation" deny "$REPO" Bash "mv decoy a.test.sh" "$REPO"
check "rm of a protected file is still a mutation"   deny "$REPO" Bash "rm a.test.sh"       "$REPO"
# …and that widening the verb list did not start blocking ordinary commands.
check "an unrelated ln is not blocked" allow "$REPO" Bash "ln -s decoy other-link" "$REPO"

# M2b: a symlinked route to the same bytes. This one ALREADY passed before the `ln` fix — the
# worktree re-rooting (BAC-785) asks git where the target lives, and git resolves the symlink. It is
# pinned here anyway because the audit flagged the lexical `relative()` fallback below it, and the
# reason that fallback is not exploitable is precisely that re-rooting gets there first. If re-rooting
# is ever narrowed, this case is what says so.
LINK="$WORK/link-to-repo"
ln -s "$REPO" "$LINK" || fail "fixture: ln -s failed"
check "an Edit reaching a protected file through a symlinked root is blocked" \
  deny "$REPO" Edit "$LINK/a.test.sh" "$REPO"
# A genuinely unrelated path must still be allowed — the fix must not turn "resolve symlinks" into
# "block everything outside the repo I cannot resolve".
echo x > "$WORK/loose.test.sh"
check "a file in no repository at all is still allowed" allow "$REPO" Edit "$WORK/loose.test.sh" "$REPO"

# ── M4: no output field carries credentials ───────────────────────────────────────────────────────
SECRET='hunter2SUPERSECRET'
for url in "postgres://user:${SECRET}@localhost" "postgres://user:${SECRET}@host:not-a-port/db" "not-a-url-at-all://${SECRET}" "localhost:5434?p=${SECRET}"; do
  out="$(node --input-type=module -e "
    import { tcpReachable } from '$TCP';
    const r = await tcpReachable(process.argv[1], 200);
    process.stdout.write(JSON.stringify(r));
  " "$url" 2>&1)"
  if printf '%s' "$out" | grep -qF "$SECRET"; then
    echo "FAILED: tcpReachable leaked the password for <$url> — this value is printed into an agent's SessionStart context"
    FAILURES+=("tcpReachable leak: $url")
  else
    echo "PASS: no credential in tcpReachable's result for a $( [ "${url:0:9}" = "postgres:" ] && echo malformed || echo non- )URL input"
  fi
done
# The diagnostic must not be gutted into uselessness — but only where the parse is trustworthy.
# A URL that yields a numeric port is structurally a connection string, so the SUCCESS path names the
# host. The failure paths deliberately name nothing: `not-a-url-at-all://<secret>` parses fine and
# puts the secret in the host field, so "keep the host" is unsafe exactly where it would be used.
reach="$(node --input-type=module -e "
  import { tcpReachable } from '$TCP';
  const r = await tcpReachable(process.argv[1], 200);
  process.stdout.write(r.label);
" "postgres://user:${SECRET}@127.0.0.1:1/x")"
case "$reach" in
  127.0.0.1:1) echo "PASS: a well-formed URL still yields host:port — the nudge stays diagnostic" ;;
  *) echo "FAILED: a well-formed URL no longer reports host:port (got '$reach') — redaction went too far"; FAILURES+=("redaction too aggressive") ;;
esac

# ── M6: a run id cannot be a path ─────────────────────────────────────────────────────────────────
T="$WORK/ledger"; mkdir -p "$T/repo/a/b"
for bad in '../../../../pwned' '/tmp/abs-pwned' 'a/b/nested' '..' '.'; do
  ( cd "$T/repo/a/b" && echo '{}' | node "$LEDGER" --type test.done --run-id "$bad" ) >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "FAILED: --run-id '$bad' was accepted (exit $rc) — a run id is used as a filename"
    FAILURES+=("run-id accepted: $bad")
  else
    echo "PASS: --run-id '$bad' refused as a usage error"
  fi
done
# Nothing may have been written anywhere but the one legitimate bucket below.
ESCAPED="$(find "$T" -name 'pwned*' -o -name 'nested*' | head -5)"
[ -z "$ESCAPED" ] || { echo "FAILED: files were written outside the runs directory: $ESCAPED"; FAILURES+=("ledger escape"); }
[ -e /tmp/abs-pwned.jsonl ] && { echo "FAILED: an absolute --run-id wrote /tmp/abs-pwned.jsonl"; FAILURES+=("ledger abs escape"); }
# …and an ordinary run id still works, or the fix is just a break.
( cd "$T/repo/a/b" && echo '{}' | node "$LEDGER" --type test.done --run-id 'sess-abc_123.v2' ) >/dev/null 2>&1
if [ -f "$T/repo/a/b/.loop/runs/sess-abc_123.v2.jsonl" ]; then
  echo "PASS: an ordinary run id still appends to its own bucket"
else
  echo "FAILED: a valid run id stopped working — the pattern is over-tight"
  FAILURES+=("run-id over-tight")
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "FAIL: ${#FAILURES[@]} case(s) failed: ${FAILURES[*]}"
  exit 1
fi
echo "PASS: guard bypass + leak — ln and symlinked routes to a protected file are mutations, no tcpReachable output field carries credentials, and a run id cannot be a path"
exit 0
