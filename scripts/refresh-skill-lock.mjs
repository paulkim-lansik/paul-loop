#!/usr/bin/env node
// Local content hashes only. Never fetches upstream or changes its identity/fork metadata.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'skills-lock.json');
const lock = JSON.parse(readFileSync(path, 'utf8'));
const changed = [];
if (!['--check', '--write'].includes(process.argv[2]) || process.argv.length !== 3) {
  console.error('usage: node scripts/refresh-skill-lock.mjs --check|--write'); process.exit(2);
}
for (const [name, entry] of Object.entries(lock.skills)) {
  const local = resolve(root, entry.localPath);
  if (!local.startsWith(root + sep)) throw new Error(`skill path escaped source: ${name}`);
  const hash = createHash('sha256').update(readFileSync(local)).digest('hex');
  if (entry.computedHash !== hash) { changed.push(name); entry.computedHash = hash; }
}
if (process.argv[2] === '--write') writeFileSync(path, JSON.stringify(lock, null, 2) + '\n');
console.log(changed.length ? `Skill lock ${process.argv[2] === '--write' ? 'refreshed' : 'drift'}: ${changed.join(', ')}` : 'Skill lock matches source');
process.exitCode = changed.length && process.argv[2] === '--check' ? 1 : 0;
