// Authoritative local state is protected independently of optional consumer globs.
// Observation telemetry (.loop/runs, logs, metrics) deliberately remains outside this set.
import { join, resolve } from 'node:path';
import { patchTargetPaths } from '../lib/patch-paths.mjs';
export function authoritativeState(root, cwd, loopDir, lessonsDir) {
  const dirs = [...new Set([join(root, '.loop'), resolve(cwd, loopDir || '.loop')].flatMap(path => patchTargetPaths(cwd, path)))];
  // LESSONS_DIR is the actual CLI override; there is no separate LOOP_LESSONS registry.
  // Keep default roots protected even when the caller configures an additional lesson directory.
  const trees = [...dirs.flatMap((dir) => ['evidence', 'lifecycle', '.execution-lease', 'lessons'].map((name) => join(dir, name))),
    ...(lessonsDir ? [resolve(cwd, lessonsDir)] : [])].flatMap(path => patchTargetPaths(cwd, path));
  const files = dirs.flatMap((dir) => ['verdict-state.json', 'looping', 'protect.globs', 'plugins.json', 'protect-compromised'].map((name) => join(dir, name)));
  return (path) => {
    const abs = resolve(cwd, path);
    return dirs.includes(abs) || trees.some((tree) => abs === tree || abs.startsWith(tree + '/')) ||
      files.some((file) => abs === file || abs.startsWith(file + '.')) ||
      dirs.some((dir) => abs.startsWith(join(dir, 'stop-gate.')));
  };
}
