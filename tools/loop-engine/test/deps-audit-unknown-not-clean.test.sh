#!/usr/bin/env bash
# Regression test for bin/deps-audit.mjs — the "fail-open, but NEVER collapse unknown into
# 0/clean/latest" invariant its own header states as the design.
#
# Why this tool and not a louder one: deps-audit's entire job is REPORTING DIVERGENCE. Every failure
# mode here is silent and plausible-looking — a `~/.claude.json` that failed to parse would, if
# collapsed to `{}`, make every plugin and skill read `usageCount: 0` and get printed as a
# 🗑️ removal candidate; a `gh` that isn't authenticated would, if collapsed to `stale: false`, print
# "최신" for skills that are months behind; a `git` lookup that failed would print "0커밋" for a
# skill with real history. None of those raise an error — they produce a confidently wrong report
# that a human then acts on by deleting things. That is exactly the failure class this harness
# exists to catch, so it gets a test even though the tool never throws.
#
# Hermetic: no network, no real `gh`, no real GitHub. A sandbox HOME holds every manifest the tool
# reads, and a fake `gh` on PATH (mode switched by FAKE_GH_MODE) stands in for the API. `--deep` and
# `--refresh-provenance` are deliberately NOT exercised — those clone from github.com, so covering
# them hermetically would mean faking `git` too, and the divergence-collapse invariants they add are
# a separate question from the fast-path ones locked here.
#
# Locks:
#   A) unreadable ~/.claude.json  -> usageAvailable:false, the suppression notice is printed, and NO
#      removal candidate is emitted for any channel.
#   B) readable ~/.claude.json    -> removal candidates DO appear (proves A's silence is suppression,
#      not an unrelated reason nothing matched).
#   C) gh unavailable             -> stale:null and the staleness column reads "?" — never "최신".
#   D) gh up but repo lookup fails-> upstreamStatus:"gone" + the 조회 실패 warning names it, while a
#      repo that DOES resolve is judged normally (stale:true) in the same run.
#   E) upstream sha unknown       -> gstack.behind stays null ("?"), never "최신", even though the
#      local HEAD resolved fine.
#   F) git lookup fails           -> project skill commits:null, printed as "미상", never "0커밋".
#   G) every run stamps .loop/deps-audit.last under CLAUDE_PROJECT_DIR (heartbeat throttle).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
AUDIT="$ROOT/tools/loop-engine/bin/deps-audit.mjs"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$AUDIT" ] || fail "deps-audit.mjs not found at $AUDIT"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

SBHOME="$DIR/home"
PROJ="$DIR/project"
FAKEBIN="$DIR/fakebin"
mkdir -p "$SBHOME/.claude/plugins" "$SBHOME/.agents" "$PROJ/.claude/skills/mine" "$FAKEBIN"

# ---- fake gh (no network) -----------------------------------------------------------------------
# off:  `gh auth status` fails -> the tool must treat upstream freshness as unmeasurable.
# on:   auth ok; `repos/owner/live/commits?per_page=1` resolves, everything else fails (deleted /
#       private / rate-limited repo — the case that must surface as "gone", not as a blank).
cat > "$FAKEBIN/gh" <<'EOF'
#!/usr/bin/env bash
[ "${FAKE_GH_MODE:-off}" = "on" ] || exit 1
case "$1" in
  auth) exit 0 ;;
  api)
    case "$2" in
      repos/owner/live/commits*) echo "1111111111111111111111111111111111111111 2026-08-01T00:00:00Z"; exit 0 ;;
      *) exit 1 ;;
    esac ;;
esac
exit 1
EOF
chmod +x "$FAKEBIN/gh"
export PATH="$FAKEBIN:$PATH"

# ---- sandbox manifests --------------------------------------------------------------------------
# One plugin: disabled + never used -> a removal candidate the moment usage telemetry is readable.
cat > "$SBHOME/.claude/plugins/installed_plugins.json" <<'EOF'
{"plugins":{"alpha@mkt":[{"version":"1.0.0","gitCommitSha":"aaaaaaa","lastUpdated":"2026-01-01T00:00:00Z"}]}}
EOF
cat > "$SBHOME/.claude/plugins/known_marketplaces.json" <<'EOF'
{"mkt":{"autoUpdate":false,"source":{"repo":"owner/live"}}}
EOF
cat > "$SBHOME/.claude/settings.json" <<'EOF'
{"enabledPlugins":{"alpha@mkt":false}}
EOF
# Two skills.sh skills: one whose upstream resolves, one whose upstream 404s.
cat > "$SBHOME/.agents/.skill-lock.json" <<'EOF'
{"skills":{
  "widget":{"source":"gh","sourceUrl":"https://github.com/owner/live","skillPath":"skills/widget/SKILL.md","installedAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
  "ghostly":{"source":"gh","sourceUrl":"https://github.com/owner/deleted","skillPath":"skills/ghostly/SKILL.md","installedAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
}}
EOF
# A base commit that is NOT the fake upstream HEAD -> "노후" once upstream is knowable, "?" before.
cat > "$SBHOME/.agents/.skill-provenance.json" <<'EOF'
{"skills":{"widget":{"installBaseCommit":"9999999999999999999999999999999999999999"},
           "ghostly":{"installBaseCommit":"9999999999999999999999999999999999999999"}}}
EOF
# gstack: a REAL local git repo (so HEAD resolves) whose origin is the repo the fake gh rejects —
# isolating "local side fine, upstream side unknown" from "everything broken".
GSTACK="$SBHOME/.claude/skills/gstack"
mkdir -p "$GSTACK"
git -C "$GSTACK" init -q || fail "could not init fake gstack repo"
git -C "$GSTACK" remote add origin https://github.com/owner/deleted
echo "9.9.9" > "$GSTACK/VERSION"
git -C "$GSTACK" add -A >/dev/null 2>&1
git -C "$GSTACK" -c user.email=t@t.com -c user.name=t commit -q -m init || fail "could not commit fake gstack repo"

run() { HOME="$SBHOME" CLAUDE_PROJECT_DIR="$PROJ" node "$AUDIT" "$@" 2>&1; }
jq_node() { node -e '
  const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const f=new Function("d","return ("+process.argv[2]+")");
  const v=f(d); console.log(v===undefined?"<undefined>":JSON.stringify(v));
' "$1" "$2"; }

# =================================================================================================
# A) usage telemetry unreadable -> unknown, and every destructive recommendation is silenced.
# =================================================================================================
printf '{"skillUsage": THIS IS NOT JSON' > "$SBHOME/.claude.json"

export FAKE_GH_MODE=off
JSON_A="$DIR/a.json"
run --json > "$JSON_A" || fail "deps-audit --json (A) exited non-zero: $(cat "$JSON_A")"
[ "$(jq_node "$JSON_A" 'd.usageAvailable')" = "false" ] \
  || fail "A: a corrupt ~/.claude.json must report usageAvailable:false, got $(jq_node "$JSON_A" 'd.usageAvailable')"

TXT_A="$(run)"
printf '%s' "$TXT_A" | grep -q "판독 불가" \
  || fail "A: unreadable usage telemetry must be stated in the report, got: $TXT_A"
printf '%s' "$TXT_A" | grep -q "제거후보" \
  && fail "A: unreadable usage telemetry must SUPPRESS removal candidates (a false 🗑️ leads to deletion), got: $TXT_A"

# =================================================================================================
# C) gh unavailable -> staleness is unknown, never "최신". (Still on the FAKE_GH_MODE=off run.)
# =================================================================================================
[ "$(jq_node "$JSON_A" 'd.skillsSh.find(s=>s.name==="widget").stale')" = "null" ] \
  || fail "C: with gh unavailable, stale must be null (unknown), got $(jq_node "$JSON_A" 'd.skillsSh.find(s=>s.name==="widget").stale')"
[ "$(jq_node "$JSON_A" 'd.skillsSh.find(s=>s.name==="widget").upstreamStatus')" = '"no-gh"' ] \
  || fail "C: with gh unavailable, upstreamStatus must be no-gh, got $(jq_node "$JSON_A" 'd.skillsSh.find(s=>s.name==="widget").upstreamStatus')"
printf '%s' "$TXT_A" | grep -q "gh 없음/미인증" \
  || fail "C: with gh unavailable the report must say upstream freshness was not measured, got: $TXT_A"
printf '%s' "$TXT_A" | grep -qE '^\s+widget\b.*최신' \
  && fail "C: with gh unavailable, widget must NOT be printed as 최신, got: $TXT_A"

# =================================================================================================
# F) git lookup fails (PROJECT_DIR is not a git repo) -> commits:null printed as 미상, never 0커밋.
# =================================================================================================
[ "$(jq_node "$JSON_A" 'd.projectSkills.find(s=>s.name==="mine").commits')" = "null" ] \
  || fail "F: a failed git lookup must yield commits:null, got $(jq_node "$JSON_A" 'd.projectSkills.find(s=>s.name==="mine").commits')"
printf '%s' "$TXT_A" | grep -q "git 조회 실패 — 미상" \
  || fail "F: a failed git lookup must print 미상, got: $TXT_A"
printf '%s' "$TXT_A" | grep -q "0커밋" \
  && fail "F: a failed git lookup must NOT be rendered as 0커밋 (unknown history is not empty history), got: $TXT_A"

# =================================================================================================
# G) heartbeat stamp is written under CLAUDE_PROJECT_DIR.
# =================================================================================================
[ -f "$PROJ/.loop/deps-audit.last" ] || fail "G: every run must stamp .loop/deps-audit.last under CLAUDE_PROJECT_DIR"

# =================================================================================================
# B) usage telemetry readable -> the same disabled+unused plugin DOES surface as a removal
#    candidate. Without this, A's assertion would also pass if nothing ever matched at all.
# =================================================================================================
cat > "$SBHOME/.claude.json" <<'EOF'
{"pluginUsage":{"alpha@mkt":{"usageCount":0}},
 "skillUsage":{"widget":{"usageCount":3,"lastUsedAt":1750000000000},"ghostly":{"usageCount":0}}}
EOF
JSON_B="$DIR/b.json"
run --json > "$JSON_B" || fail "deps-audit --json (B) exited non-zero"
[ "$(jq_node "$JSON_B" 'd.usageAvailable')" = "true" ] \
  || fail "B: a readable ~/.claude.json must report usageAvailable:true"
TXT_B="$(run)"
printf '%s' "$TXT_B" | grep -q "제거후보 플러그인" \
  || fail "B: with readable telemetry a disabled+unused plugin must surface as a removal candidate (otherwise A proves nothing), got: $TXT_B"
printf '%s' "$TXT_B" | grep -q "판독 불가" \
  && fail "B: with readable telemetry the suppression notice must NOT be printed, got: $TXT_B"

# =================================================================================================
# D) gh up: a resolvable repo is judged, an unresolvable one is surfaced as 'gone' — not blank.
# E) upstream sha unknown -> gstack.behind stays null, rendered "?" and never "최신".
# =================================================================================================
export FAKE_GH_MODE=on
JSON_D="$DIR/d.json"
run --json > "$JSON_D" || fail "deps-audit --json (D) exited non-zero"

[ "$(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="widget").upstreamStatus')" = '"ok"' ] \
  || fail "D: a resolvable upstream must be ok, got $(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="widget").upstreamStatus')"
[ "$(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="widget").stale')" = "true" ] \
  || fail "D: base commit != upstream HEAD must be judged stale:true, got $(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="widget").stale')"
[ "$(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="ghostly").upstreamStatus')" = '"gone"' ] \
  || fail "D: a repo-specific gh failure must be surfaced as gone (distinct from no-gh), got $(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="ghostly").upstreamStatus')"
[ "$(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="ghostly").stale')" = "null" ] \
  || fail "D: an unresolvable upstream must leave stale unknown (null), never false/최신, got $(jq_node "$JSON_D" 'd.skillsSh.find(s=>s.name==="ghostly").stale')"

TXT_D="$(run)"
printf '%s' "$TXT_D" | grep -q "upstream 조회 실패" \
  || fail "D: an unresolvable upstream must be named in the recommendations, got: $TXT_D"

# E) local gstack HEAD resolved (real repo) but upstream is the rejected repo -> behind must be null.
[ "$(jq_node "$JSON_D" 'd.gstack.head !== null')" = "true" ] \
  || fail "E: the fake gstack repo's local HEAD should resolve — fixture problem, got $(jq_node "$JSON_D" 'd.gstack')"
BEHIND="$(jq_node "$JSON_D" 'd.gstack.behind')"
{ [ "$BEHIND" = "null" ] || [ "$BEHIND" = "<undefined>" ]; } \
  || fail "E: with the upstream sha unknown, gstack.behind must stay unknown, never false/최신, got $BEHIND"
printf '%s' "$TXT_D" | grep -qE '^  v9\.9\.9.*최신' \
  && fail "E: gstack must not be printed as 최신 when the upstream sha is unknown, got: $TXT_D"

echo "PASS: deps-audit — unknown never collapses into 0/clean/최신 (usage unreadable suppresses removal advice, gh-off keeps staleness unknown, repo-404 surfaces as gone, failed git lookup stays 미상), and the readable-telemetry control still emits candidates"
exit 0
