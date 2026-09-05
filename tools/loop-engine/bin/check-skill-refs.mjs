#!/usr/bin/env node
// check-skill-refs: every skill/agent a doc hands off to must actually exist here.
//
// This plugin deliberately keeps skill-to-skill handoffs. Upstream mattpocock/skills dropped them
// repo-wide (commit 1dab982, "Stop skills from calling other user-invoked skills") because a generic
// library can't know which siblings a consumer installed; a single curated plugin ships its own
// siblings, so the handoff is valid here (see CHANGELOG ship-flow 0.5.0). That choice buys real
// composition and costs one failure mode: a handoff whose target does not exist reads as a normal
// instruction and fails silently at runtime — the agent is told to call something that isn't there.
//
// Measured, in a consuming repo (2026-08-26): four personal-layer skills delegated to `/grilling`,
// `/domain-modeling`, `/codebase-design` — none installed. `grill-me` and `grill-with-docs` were
// one-line stubs whose entire body was a call to a skill that did not exist, and they shadowed
// working copies, so the breakage was invisible. `dangling-doc-refs.test.sh` did not catch it: that
// gate checks *file paths*, not skill/agent handoffs.
//
// Usage: check-skill-refs.mjs [--root <dir>] [--json]
//   exit 0 = every reference resolves · 1 = unresolved reference(s) · 2 = fail-closed (see below)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MD = /\.md$/;

const dirs = (p) => (existsSync(p) ? readdirSync(p).filter((n) => statSync(path.join(p, n)).isDirectory()) : []);
const mdFiles = (p) => (existsSync(p) ? readdirSync(p).filter((n) => MD.test(n)) : []);

function walkMd(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const f = path.join(dir, n);
    if (statSync(f).isDirectory()) walkMd(f, out);
    else if (MD.test(n)) out.push(f);
  }
  return out;
}

/** Plugin dirs are discovered, never hardcoded — this repo's own genericity gate requires that. */
export function findProviders(root) {
  const providers = [];
  const seen = new Set();
  const scan = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
      let name = path.basename(dir);
      try {
        name = JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name || name;
      } catch {
        /* an unreadable manifest still marks a provider; the dir name is a good enough namespace */
      }
      if (!seen.has(dir)) { seen.add(dir); providers.push({ dir, name }); }
      return;
    }
    for (const n of readdirSync(dir)) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const f = path.join(dir, n);
      if (statSync(f).isDirectory()) scan(f, depth + 1);
    }
  };
  scan(root, 0);
  const consumer = path.join(root, '.claude');
  if (existsSync(path.join(consumer, 'skills')) || existsSync(path.join(consumer, 'agents'))) {
    providers.push({ dir: consumer, name: null });
  }
  return providers;
}

export function collect(root) {
  const providers = findProviders(root);
  const known = new Set();
  const namespaces = new Set();
  const files = [];
  for (const { dir, name } of providers) {
    if (name) namespaces.add(name);
    for (const s of dirs(path.join(dir, 'skills'))) known.add(s);
    for (const a of mdFiles(path.join(dir, 'agents'))) known.add(a.replace(MD, ''));
    for (const sub of ['skills', 'agents', 'workflows']) files.push(...walkMd(path.join(dir, sub)));
  }
  return { known, namespaces, files: [...new Set(files)] };
}

/**
 * Only unambiguous handoff forms are checked. A bare `/name` in backticks is also a URL path
 * (`/login`, `/healthz`), so it counts only on a line that says "skill" — stated here rather than
 * hidden, because that is the one form this gate can miss.
 */
export function refsIn(text, namespaces) {
  const out = [];
  for (const m of text.matchAll(/Skill tool with "([^"]+)"/g)) out.push({ raw: m[0], name: m[1].split(':').pop() });
  for (const m of text.matchAll(/`([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)`/g)) {
    if (namespaces.has(m[1])) out.push({ raw: m[0], name: m[2] });
  }
  for (const line of text.split('\n')) {
    if (!/skill/i.test(line)) continue;
    for (const m of line.matchAll(/`\/([a-z0-9][a-z0-9-]{2,40})`/g)) out.push({ raw: m[0], name: m[1] });
  }
  return out;
}

export function check({ known, namespaces, files }, read = (f) => readFileSync(f, 'utf8')) {
  const fatal = [];
  if (known.size === 0) fatal.push('no skills or agents found — the scanner resolved nothing, so every reference would look valid');
  if (files.length === 0) fatal.push('no markdown scanned — the scanner found no docs, so every reference would go unchecked');
  if (fatal.length) return { violations: [], scanned: 0, docs: files.length, fatal };

  const violations = [];
  let scanned = 0;
  for (const file of files) {
    for (const ref of refsIn(read(file), namespaces)) {
      scanned++;
      if (!known.has(ref.name)) violations.push({ file, ref: ref.raw, name: ref.name });
    }
  }
  if (scanned === 0) fatal.push('zero references extracted from a non-empty doc set — the extractor is broken, not the docs');
  return { violations, scanned, docs: files.length, fatal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const root = path.resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : '.');
  const json = argv.includes('--json');
  let r;
  try {
    r = check(collect(root));
  } catch (e) {
    console.error(`check-skill-refs: ${String(e?.message ?? e).split('\n')[0]}`);
    process.exit(2);
  }
  if (json) console.log(JSON.stringify({ ...r, violations: r.violations.map((v) => ({ ...v, file: path.relative(root, v.file) })) }));
  if (r.fatal.length) {
    if (!json) for (const f of r.fatal) console.error(`FATAL: ${f}`);
    process.exit(2);
  }
  if (r.violations.length) {
    if (!json) for (const v of r.violations) console.error(`${path.relative(root, v.file)}: ${v.ref} — no such skill or agent in this repo`);
    process.exit(1);
  }
  if (!json) console.log(`PASS: skill-refs — ${r.scanned} handoff reference(s) across ${r.docs} doc(s), all resolve`);
  process.exit(0);
}

