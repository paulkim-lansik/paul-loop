import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
// Codex apply_patch wire adapter. Extract every source AND move destination before
// any write is considered. This parses the envelope, not file contents or hunks.
export function patchPaths(command) {
  if (typeof command !== 'string' || command.length > 4 * 1024 * 1024) {
    throw new Error('apply_patch requires a bounded patch string');
  }
  const lines = command.trim().split(/\r?\n/);
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new Error('unsupported apply_patch envelope');
  }
  const paths = [];
  let operation = null;
  let body = false;
  let moved = false;
  const add = (path) => {
    if (!path || path !== path.trim() || /[\x00-\x1f\x7f]/.test(path)) {
      throw new Error('ambiguous apply_patch path');
    }
    paths.push(path);
  };
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.*)$/.exec(line);
    if (header) {
      operation = header[1];
      body = false;
      moved = false;
      add(header[2]);
    } else if (line.startsWith('*** Move to: ')) {
      if (operation !== 'Update' || body || moved) throw new Error('misplaced move destination');
      add(line.slice('*** Move to: '.length));
      moved = true;
    } else if (operation === 'Add' && line.startsWith('+')) {
      body = true;
    } else if (operation === 'Update' &&
      (/^[ +\-]/.test(line) || line === '' || line === '@@' || line.startsWith('@@ ') ||
       line === '*** End of File')) {
      body = true;
    } else {
      throw new Error('unrecognized apply_patch operation');
    }
  }
  if (!paths.length) throw new Error('apply_patch contains no file operations');
  return [...new Set(paths)];
}

// Check both lexical and physical targets: apply_patch can follow existing file/parent symlinks.
// Missing descendants are appended to the nearest existing ancestor. Dangling links/errors deny.
export function patchTargetPaths(cwd, path) {
  const lexical = resolve(cwd, path);
  let ancestor = lexical;
  const suffix = [];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  return [...new Set([lexical, resolve(realpathSync(ancestor), ...suffix)])];
}
