#!/usr/bin/env bash
# loop-engine self-test runner — runs every *.test.sh here; non-zero if any fails.
# The verifier machine finally gets a verifier (maturity gap #12). Pure bash + node, no docker:
# wired as the `verify:loop` gate (root package.json) and a CI job.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
total=0

# TOCTOU guard, round 2 (issue #14 adversarial review): round 1 defended against an early-running
# sibling *.test.sh overwriting a not-yet-executed sibling on disk by hashing every file up front,
# then re-hashing immediately before executing each one and comparing. That re-check itself was a
# TOCTOU: "re-hash" and "execute" were two separate opens of the same path, with a real gap between
# them for a background process to win — reproduced empirically, a background toggler alternating a
# victim file's content between clean and malicious won roughly half the time.
#
# The fix removes the check-then-use gap instead of narrowing it. Every *.test.sh file's full
# content is read into memory with one `cat`, in a pass that completes for every file before any
# test starts executing — so an early-running test's write to a not-yet-processed sibling's file on
# disk can never affect what that sibling actually runs against, because there is no second open of
# that path afterward: execution runs the already-captured in-memory string directly via
# `bash -c "$content" "$t"`, not a re-read of "$t". This closes the *inter-test* race this guard
# exists for (one *.test.sh sabotaging another later in the same run — the actual bypass this
# defends against, since no earlier step in this script's real callers gives attacker-controlled
# code an execution window before or during this read-all loop). It does not claim the single
# `cat -- "$t"` read of any one file is itself atomic against a hypothetical concurrent external
# writer already running against that exact path from outside this script — no such writer exists
# on this loop's actual entry points, but if one somehow did, a torn read is a separate, narrower
# question this comment used to overstate as fully closed. There is nothing left to hash-compare
# against a prior scan, so that logic is gone entirely rather than narrowed.
#
# `bash -c "$content" "$t"` sets $0 to the literal path string "$t" (the standard
# `bash -c script name` idiom — the argument right after the script text becomes $0, with no
# further positional args here), matching what plain `bash "$t"` used to set $0 to. This matters
# because most test files in this directory locate sibling fixtures via `dirname "$0"`. `bash -c`
# reports $BASH_SOURCE differently than direct file execution would (checked first: no current
# test file in this directory relies on $BASH_SOURCE, only $0).
files=()
contents=()
for t in "$HERE"/*.test.sh; do
  [ -e "$t" ] || continue
  files+=("$t")
  content="$(cat -- "$t")" || exit 2
  contents+=("$content")
done

# TOCTOU_NODE_ENTRY_SNAPSHOT_V1 — kept stable for the HEAD-bound regression under pinned review.
# Thin shell wrappers delegate to top-level .mjs test entries. Capture those bytes before ANY
# sibling runs too. An inline, parent-supplied loader serves them under their original file URLs:
# import.meta.url, argv and relative imports keep their identities. There is no mutable snapshot
# file and no hash-then-reopen gap. Each sibling receives a fresh copy from this Bash parent's
# memory; changing/unsetting its own NODE_OPTIONS cannot affect a later sibling's snapshot.
# Node canonicalizes a main-file symlink before calling the loader. Bind the main entry from
# its original argv path in the preload, then serve that captured entry even if Node presents
# a different, attacker-selected realpath. Imports still use the original captured file URL.
#
# The loader is embedded here so copying run.sh alone into the original shell-only regression
# fixture still works. Only test entries are frozen: imported helper/runtime dependencies and
# explicit fs reads retain the same known limit as helpers sourced by the frozen shell tests.
# An external writer active DURING the initial capture, modifying Node itself, or a test that
# deliberately disables its OWN loader is outside the inter-sibling guarantee.
NODE_TEST_SNAPSHOT_IMPORT="$(node --input-type=module - "$HERE" <<'JS'
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
const sources = {};
for (const entry of readdirSync(process.argv[2], { withFileTypes: true })) {
  if (!entry.name.endsWith('.mjs') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
  const path = join(process.argv[2], entry.name), url = pathToFileURL(realpathSync(path)).href;
  const saved = { url, source: readFileSync(path, 'utf8') };
  sources[pathToFileURL(path).href] = sources[url] = saved;
}
if (Object.keys(sources).length) {
  const loader = `
    import { pathToFileURL } from 'node:url';
    let sources, main;
    export function initialize(data) { sources = data.sources; main = data.main; }
    export function resolve(specifier, context, next) {
      if (!context.parentURL && main) return { url: main.url, shortCircuit: true };
      let url;
      if (specifier.startsWith('/')) url = pathToFileURL(specifier).href;
      else if (/^(file:|\\.\\.?\\/)/.test(specifier)) url = new URL(specifier, context.parentURL).href;
      return sources[url] ? { url: sources[url].url, shortCircuit: true } : next(specifier, context);
    }
    export function load(url, context, next) {
      return sources[url] ? { format: 'module', source: sources[url].source, shortCircuit: true } : next(url, context);
    }
  `;
  const dataURL = (code) => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  const payload = gzipSync(JSON.stringify(sources)).toString('base64');
  const preload = dataURL(`import { register } from 'node:module'; import { gunzipSync } from 'node:zlib';
    import { pathToFileURL } from 'node:url'; import { resolve } from 'node:path';
    const sources = JSON.parse(gunzipSync(Buffer.from(${JSON.stringify(payload)}, 'base64')));
    const main = process.argv[1] ? sources[pathToFileURL(resolve(process.argv[1])).href] : undefined;
    register(${JSON.stringify(dataURL(loader))}, { data: { sources, main } });`);
  // Stay below conservative per-environment-string limits. Oversize snapshots fail before tests,
  // never silently fall back to mutable source. Compression keeps current entries comfortably small.
  if (Buffer.byteLength(preload) + Buffer.byteLength(process.env.NODE_OPTIONS || '') > 60000) throw new Error('test-entry snapshot exceeds inline loader limit');
  process.stdout.write(preload);
}
JS
)" || exit 2

i=0
for t in "${files[@]}"; do
  total=$((total + 1))
  content="${contents[$i]}"
  i=$((i + 1))
  if [ -n "$NODE_TEST_SNAPSHOT_IMPORT" ]; then
    if ! NODE_OPTIONS="${NODE_OPTIONS:-} --import=$NODE_TEST_SNAPSHOT_IMPORT" bash -c "$content" "$t"; then fails=$((fails + 1)); fi
  elif ! bash -c "$content" "$t"; then fails=$((fails + 1)); fi
done
echo "loop-engine selftest: $((total - fails))/$total passed"
[ "$fails" -eq 0 ]
