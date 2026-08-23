#!/usr/bin/env bash
# Regression test for classify-risk.mjs's externalized rule table (BAC-698 / BAC-563 C5).
#
# Locks: (1) with no rules file anywhere (no --rules, no CLASSIFY_RISK_RULES, no cwd risk-rules.json),
#     an ordinary small changeset resolves to the app-code-low-risk baseline, not fail-closed REQUIRE —
#     shipping zero product-specific rules must not make the plugin unusable out of the box,
# (2) --rules <path> loads pathRules/commandRules and a matching path raises dimensions + deep gates
#     exactly as the old hardcoded table did,
# (3) CLASSIFY_RISK_RULES env var is an equivalent injection channel to --rules,
# (4) a risk-rules.json sitting at the CWD is picked up with no flag at all (the "drop a file, get
#     rules" ergonomics BAC-698 asked for),
# (5) a malformed rules file is a loud usage error (exit 2, stderr names the file), never a silent
#     empty-rules fallback — a rules file the tool couldn't read must not under-report risk,
# (6) a --rules path that does not exist is also a loud usage error, not a silent fallback,
# (7) excludeStartsWith carves an exception out of a broader startsWith match.
# (8) templates/risk-rules.example.json (BAC-757, shape-only starter for a consuming repo) is itself
#     valid, self-covering (its own harness rule matches "risk-rules.json" — the same self-coverage
#     idea as a consuming repo's own verify-loop-wiring "harness-covers-risk-rules-json" case), and
#     its per-rule deep-gate lists are locked so a future edit can't silently drop one.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
CR="$ROOT/tools/loop-engine/bin/classify-risk.mjs"
EXAMPLE_RULES="$ROOT/tools/loop-engine/templates/risk-rules.example.json"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$CR" ] || fail "classify-risk.mjs not found at $CR"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX")" || fail "mktemp -d failed"
trap 'rm -rf "$DIR"' EXIT

# ── 1) no rules anywhere → ordinary small changeset is the app-code-low-risk baseline (AUTO) ────
cd "$DIR"
OUT="$(node "$CR" --path "src/foo.ts" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || fail "no-rules classify must exit 0 (--no-gate), got $rc: $OUT"
echo "$OUT" | grep -q "TRACK: standard" || fail "no-rules ordinary path must resolve to TRACK: standard, got: $OUT"
echo "$OUT" | grep -q "app-code-low-risk-baseline" || fail "no-rules ordinary path must hit the low-risk baseline, got: $OUT"
echo "PASS: with zero rules files present, an ordinary changeset is the low-risk baseline, not fail-closed"

# ── 2) --rules loads a custom path rule and raises dimensions + deep gates ───────────────────────
cat > "$DIR/rules.json" <<'EOF'
{
  "pathRules": [
    { "id": "custom-migration", "startsWith": ["db/migrations/"], "dims": { "revers": "none" },
      "deep": ["custom-gate"], "why": "test fixture: irreversible once applied" }
  ],
  "commandRules": [
    { "id": "custom-deploy", "patterns": ["\\bcustom-deploy\\b"], "dims": { "revers": "none" },
      "why": "test fixture: deploy command" }
  ]
}
EOF
OUT="$(node "$CR" --path "db/migrations/0001.sql" --rules "$DIR/rules.json" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || fail "--rules classify must exit 0 (--no-gate), got $rc: $OUT"
echo "$OUT" | grep -q "custom-migration" || fail "--rules must match the injected path rule, got: $OUT"
echo "$OUT" | grep -q "reversibility=none" || fail "--rules dims must raise reversibility to none, got: $OUT"
echo "$OUT" | grep -q "DEEP_GATES: custom-gate" || fail "--rules deep gates must surface, got: $OUT"
echo "$OUT" | grep -q "TRACK: risky" || fail "a real rule match must set TRACK: risky, got: $OUT"
echo "PASS: --rules injects a path rule that raises dimensions and deep gates"

OUT="$(node "$CR" --command "custom-deploy now" --rules "$DIR/rules.json" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || fail "command-rule classify must exit 0, got $rc: $OUT"
echo "$OUT" | grep -q "custom-deploy" || fail "--rules must match the injected command rule, got: $OUT"
echo "PASS: --rules injects a command rule too"

# ── 3) CLASSIFY_RISK_RULES env var is equivalent to --rules ──────────────────────────────────────
OUT="$(CLASSIFY_RISK_RULES="$DIR/rules.json" node "$CR" --path "db/migrations/0002.sql" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || fail "env-var rules classify must exit 0, got $rc: $OUT"
echo "$OUT" | grep -q "custom-migration" || fail "CLASSIFY_RISK_RULES env var must load the same rules as --rules, got: $OUT"
echo "PASS: CLASSIFY_RISK_RULES env var is an equivalent injection channel"

# ── 4) a risk-rules.json at the CWD is picked up with no flag ────────────────────────────────────
W="$DIR/cwd-project"
mkdir -p "$W"
cp "$DIR/rules.json" "$W/risk-rules.json"
OUT="$(cd "$W" && node "$CR" --path "db/migrations/0003.sql" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || fail "cwd risk-rules.json classify must exit 0, got $rc: $OUT"
echo "$OUT" | grep -q "custom-migration" || fail "a risk-rules.json sitting at the CWD must be picked up with no flag, got: $OUT"
echo "PASS: risk-rules.json at the CWD is auto-discovered with no --rules flag"

# ── 5) malformed rules file → loud usage error (exit 2), not silent empty-rules fallback ─────────
printf '{not json' > "$DIR/bad.json"
OUT="$(node "$CR" --path "src/foo.ts" --rules "$DIR/bad.json" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 2 ] || fail "malformed rules file must exit 2 (usage error), got $rc: $OUT"
echo "$OUT" | grep -q "not valid JSON" || fail "malformed rules file error must name the problem, got: $OUT"
echo "$OUT" | grep -q "bad.json" || fail "malformed rules file error must name the path, got: $OUT"
echo "PASS: a malformed rules file is a loud usage error, never a silent fallback"

# ── 6) a --rules path that does not exist is also a loud usage error ─────────────────────────────
OUT="$(node "$CR" --path "src/foo.ts" --rules "$DIR/does-not-exist.json" --no-gate 2>&1)"; rc=$?
[ "$rc" -eq 2 ] || fail "missing --rules file must exit 2 (usage error), got $rc: $OUT"
echo "$OUT" | grep -q "not found" || fail "missing --rules file error must say so, got: $OUT"
echo "PASS: a --rules path that does not exist is a loud usage error"

# ── 7) excludeStartsWith carves an exception out of a broader startsWith match ───────────────────
cat > "$DIR/exclude-rules.json" <<'EOF'
{
  "pathRules": [
    { "id": "harness-like", "startsWith": [".loop/"], "excludeStartsWith": [".loop/lessons/"],
      "dims": { "blast": "high" }, "why": "test fixture: harness surface excluding lessons data" }
  ],
  "commandRules": []
}
EOF
OUT_IN="$(node "$CR" --path ".loop/protect.globs" --rules "$DIR/exclude-rules.json" --no-gate 2>&1)"
echo "$OUT_IN" | grep -q "harness-like" || fail "excludeStartsWith must not block the non-excluded prefix, got: $OUT_IN"
OUT_EX="$(node "$CR" --path ".loop/lessons/foo.json" --rules "$DIR/exclude-rules.json" --no-gate 2>&1)"
echo "$OUT_EX" | grep -q "harness-like" && fail "excludeStartsWith must carve out the excluded prefix, got: $OUT_EX"
echo "$OUT_EX" | grep -q "app-code-low-risk-baseline" || fail "the excluded path must fall through to the low-risk baseline, got: $OUT_EX"
echo "PASS: excludeStartsWith carves an exception out of a broader startsWith match"

# ── 8) templates/risk-rules.example.json — self-coverage, deep-gates locked, structurally sound ─
[ -f "$EXAMPLE_RULES" ] || fail "templates/risk-rules.example.json not found at $EXAMPLE_RULES"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$EXAMPLE_RULES" \
  || fail "templates/risk-rules.example.json is not valid JSON"

OUT_SELF="$(node "$CR" --path "risk-rules.json" --rules "$EXAMPLE_RULES" --no-gate 2>&1)"
echo "$OUT_SELF" | grep -q "MATCHED: harness" || fail "the example template's own harness rule must match a change to risk-rules.json itself, got: $OUT_SELF"
echo "$OUT_SELF" | grep -q "blast_radius=high" || fail "a self-covering harness match must raise blast=high, got: $OUT_SELF"
echo "PASS: templates/risk-rules.example.json's harness rule covers risk-rules.json itself (self-coverage)"

OUT_CLAUDE="$(node "$CR" --path "CLAUDE.md" --rules "$EXAMPLE_RULES" --no-gate 2>&1)"
echo "$OUT_CLAUDE" | grep -q "MATCHED: harness" || fail "the example template's harness rule must also cover CLAUDE.md, got: $OUT_CLAUDE"
echo "PASS: templates/risk-rules.example.json's harness rule also covers CLAUDE.md"

node -e '
  const rules = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const byId = Object.fromEntries(rules.pathRules.map((r) => [r.id, r.deep ?? []]));
  const expected = {
    "example-irreversible-migration": ["<your-deep-verify-command, e.g. verify:db>"],
    "example-security-surface": ["<your-deep-verify-command, e.g. verify:auth>"],
    "example-outbound-side-effect": [],
    harness: [],
    "ci-deploy-infra": [],
    "workspace-root": [],
  };
  for (const [id, want] of Object.entries(expected)) {
    const got = byId[id];
    if (got === undefined) throw new Error(`rule id missing from example template: ${id}`);
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(`rule ${id} deep gates changed — want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const r of rules.pathRules) {
    for (const g of r.deep ?? []) {
      if (typeof g !== "string" || !g.trim()) throw new Error(`rule ${r.id} has an empty/non-string deep-gate entry`);
    }
  }
' "$EXAMPLE_RULES" || fail "templates/risk-rules.example.json per-rule deep-gate lists changed unexpectedly or are malformed"
echo "PASS: templates/risk-rules.example.json's per-rule deep-gate lists are locked and structurally sound"

exit 0
