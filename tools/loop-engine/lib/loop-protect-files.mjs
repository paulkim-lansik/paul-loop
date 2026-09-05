// Canonical expansion for loop-fix snapshots and lifecycle recovery. No shell glob emulation.
import { readdirSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { globToRegExp } from './protect-globs.mjs';

// Check every component BEFORE reading/skipping/restoring a protected file. Matching bytes at
// the leaf do not make an ancestor redirected to another workspace safe to traverse.
export function assertProtectedPath(cwd, file) {
  const root = resolve(cwd), target = resolve(root, file), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('protected path outside execution directory');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    let st;
    try { st = lstatSync(current); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) throw new Error(`symlink in protected path: ${relative(root, current)}`);
    if (current === target ? !st.isFile() : !st.isDirectory()) throw new Error(`unsupported protected path: ${relative(root, current)}`);
  }
  return target;
}

export function protectedFiles(cwd, loopDir, patterns, { requireEach = false } = {}) {
  const root = resolve(cwd);
  const excluded = [resolve(loopDir), join(root, '.loop')];
  const inside = (dir, path) => path === dir || path.startsWith(`${dir}/`);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (excluded.some((d) => inside(d, path))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, path));
    }
  }
  if (!patterns.length) return [];
  walk(root);
  const result = new Set();
  for (let pattern of patterns) {
    if (isAbsolute(pattern)) pattern = relative(root, pattern);
    pattern = pattern.replace(/^\.\//, '');
    if (pattern === '..' || pattern.startsWith('../')) throw new Error('protected paths must be inside the execution directory');
    const re = globToRegExp(pattern);
    const hits = files.filter((file) => re.test(file));
    if (requireEach && !hits.length) throw new Error(`--protect matched 0 files: ${pattern}`);
    for (const file of hits) {
      if (/[\n\r]/.test(file)) throw new Error('newline-containing protected paths are unsupported by the Bash worker');
      if (requireEach && lstatSync(join(root, file)).isSymbolicLink()) throw new Error(`protected baseline must be a regular file: ${file}`);
      result.add(file);
    }
  }
  return [...result].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [dir, raw = '', mode = 'scan'] = process.argv.slice(2);
    const paths = protectedFiles(process.cwd(), resolve(dir), raw.split('\n').filter(Boolean), { requireEach: mode === 'validate' });
    if (paths.length) process.stdout.write(`${paths.join('\n')}\n`);
  } catch (e) { console.error(`loop-protect: ${e.message}`); process.exitCode = 2; }
}
