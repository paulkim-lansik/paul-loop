#!/usr/bin/env bash
# Link-check: docs (skills/agents/*.md under tools/*) must not point a consuming repo at a
# consumer-repo-owned path (bin/plugin-path.mjs, .claude/hooks/*.mjs, bin/loop-doctor.mjs, ...) as
# if this plugin ships it (BAC-758 B7 — traced to real breakage: retrospect/deps-audit/ship-feature
# examples referenced tools/plugin-path.mjs, docs/verdict-contract.md and docs/otel.md referenced
# .claude/hooks/gate-stop-verdict.mjs and bin/loop-doctor.mjs, none of which exist in this repo).
#
# A reference is fine if EITHER (a) the path actually exists under one of this repo's plugin dirs,
# or (b) the same markdown file carries a hedge disclaiming plugin ownership somewhere in it (the
# convention this repo uses: one disclaimer near the top of a skill/doc, not repeated at every
# call site). This is a regression guard, not an install-time integration test — it can't prove a
# hedge is *correctly worded*, only that a bare, unqualified dangling reference doesn't silently
# come back.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."

fail() { echo "FAIL: $1"; exit 1; }

node -e '
  const fs = require("fs");
  const path = require("path");

  const root = process.argv[1];
  const pluginDirs = ["tools/loop-engine", "tools/ship-flow", "tools/loop-memory"];

  const SCAN_ROOTS = [
    "tools/loop-engine/docs",
    "tools/ship-flow/skills",
    "tools/ship-flow/agents",
    "tools/ship-flow/workflows",
  ];

  const HEDGE_RE = /if this repo|consumer-repo|consumer repo|however this repo|does not ship|convention|otherwise invoke|if present|if provided|was retired|retired \(|was removed/i;

  // bin/<name>.(mjs|sh) and test/<name>.test.sh — real if present under any plugin dir.
  const RELATIVE_PATTERNS = [/\bbin\/[\w.-]+\.(?:mjs|sh)\b/g, /\btest\/[\w.-]+\.test\.sh\b/g];
  // .claude/hooks/* is never something a plugin ships (it names the CONSUMING repo'\''s own
  // .claude/ namespace) — always requires a hedge, no existence bypass.
  const ALWAYS_HEDGE_PATTERNS = [/\.claude\/hooks\/[\w.-]+\.mjs\b/g, /\btools\/plugin-path\.mjs\b/g];

  function existsUnderAnyPluginDir(rel) {
    return pluginDirs.some((d) => fs.existsSync(path.join(root, d, rel)));
  }

  function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
    return out;
  }

  const files = SCAN_ROOTS.flatMap((r) => walk(path.join(root, r), []));
  const violations = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const hedged = HEDGE_RE.test(text);
    const rel = path.relative(root, file);

    for (const re of RELATIVE_PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (existsUnderAnyPluginDir(m[0])) continue;
        if (hedged) continue;
        violations.push(`${rel}: "${m[0]}" does not exist under any plugin dir and file has no hedge`);
      }
    }
    for (const re of ALWAYS_HEDGE_PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (hedged) continue;
        violations.push(`${rel}: "${m[0]}" is never plugin-shipped and file has no hedge`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log(`PASS: ${files.length} doc(s) scanned, no unhedged dangling references`);
' "$ROOT" || fail "dangling consumer-repo references found in docs (see above)"
