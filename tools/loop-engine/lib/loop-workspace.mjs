// Worktree identity is separate from a session's telemetry root.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
export function workspaceRoot(cwd) {
  try { return realpathSync(git(cwd, ['rev-parse', '--show-toplevel'])); }
  catch { return realpathSync(cwd); }
}
export function stopWorkspaceRoot(projectRoot, cwd) {
  if (typeof cwd !== 'string' || !cwd) return projectRoot;
  try {
    const common = (dir) => realpathSync(resolve(dir, git(dir, ['rev-parse', '--git-common-dir'])));
    return common(cwd) === common(projectRoot) ? workspaceRoot(cwd) : projectRoot;
  } catch { return projectRoot; }
}
