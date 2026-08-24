// Loads a dotenv-shaped file into a hook's child-env object.
//
// Why this exists: Claude Code hands a hook the *session process env* — it does not load `.env` files.
// A repo that keeps its embedding key in a gitignored `.env` (the normal way to hold a secret that
// must not be committed) and never `export`s it to the shell therefore hits both hooks' own
// no-key gate, and recall/graduate no-op **silently**. That failure mode already burned this
// plugin's origin repo once for six weeks, so the loader ships *with the plugin* rather than being
// something each consuming repo has to re-implement as a local hook.
//
// Contract (all three properties are load-bearing — see test/hooks-dotenv.test.ts):
//   1. Never overwrite a key already present in `target` — an explicit shell/session export, and the
//      `CLAUDE_PLUGIN_OPTION_*` userConfig bridge the hooks run first, both outrank the file.
//   2. Worktree fallback: a gitignored `.env` does not exist in a freshly-created feature worktree,
//      which is exactly where an isolated agent loop runs. If the primary path is missing, resolve the
//      *main* worktree via `git rev-parse --git-common-dir` and read its copy instead. Without this,
//      every worktree fails closed. No file is copied — the key stays untracked, in one place.
//   3. Best-effort: any failure (missing file, unreadable, non-git, no git binary) leaves `target`
//      untouched and returns null. A hook must never break a session over its own optional config.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

/** Repo-relative default. `.loop/` is loop-engine's own convention directory (it already holds
 * `.loop/lessons`) and is conventionally gitignored, so `.loop/.env` is the one path that is a
 * sensible guess for *any* consuming repo. Repos that keep the file elsewhere point the
 * `loop_dotenv_path` plugin option (env `LOOP_DOTENV_PATH`) at it. */
export const DEFAULT_DOTENV_PATH = '.loop/.env';

/** Absolute path of the main worktree, via `git rev-parse --git-common-dir`. null if not a git repo,
 * git is missing/slow, or the common dir isn't a `.git` directory (i.e. nothing to fall back to). */
function mainWorktreeRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const commonDir = resolve(cwd, out);
    // The main worktree's `.git` is a directory (= commonDir itself) — its parent is that worktree's root.
    return basename(commonDir) === '.git' ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/** Resolves the dotenv file to read, applying the worktree fallback (property 2 above).
 * Returns null when nothing readable exists. An absolute `configured` path is used as-is (a path
 * outside the project has no "main worktree" counterpart to fall back to). */
export function resolveDotenvPath(projectDir, configured) {
  const rel = configured || DEFAULT_DOTENV_PATH;
  if (isAbsolute(rel)) return existsSync(rel) ? rel : null;
  const local = resolve(projectDir, rel);
  if (existsSync(local)) return local;
  const mainRoot = mainWorktreeRoot(projectDir);
  if (!mainRoot) return null;
  const fallback = resolve(mainRoot, rel);
  return existsSync(fallback) ? fallback : null;
}

/** Fills `target` with the `KEY=VALUE` lines of the resolved dotenv file, skipping keys already set.
 * Returns the path actually read, or null if nothing was loaded (so callers can log which it was —
 * "silently loaded nothing" and "silently found nothing" must be distinguishable in the debug log). */
export function loadDotenv(projectDir, configured, target = process.env) {
  try {
    const file = resolveDotenvPath(projectDir, configured);
    if (!file) return null;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim(); // also drops CRLF's \r
      if (!line || line.startsWith('#')) continue; // blank / comment line
      const eq = line.indexOf('='); // split on the FIRST '=' only — values may contain '='
      if (eq < 1) continue;
      const key = line
        .slice(0, eq)
        .replace(/^export\s+/, '')
        .trim(); // tolerate `export KEY=...`
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in target) continue; // already set: file loses
      let val = line.slice(eq + 1).trim();
      const q = val[0];
      if (q === '"' || q === "'") {
        const end = val.indexOf(q, 1); // value ends at the closing quote (trailing inline comment ignored)
        val = end === -1 ? val.slice(1) : val.slice(1, end);
      } else {
        const c = val.search(/\s#/); // unquoted `val # comment` — strip the comment
        if (c !== -1) val = val.slice(0, c).trim();
      }
      target[key] = val;
    }
    return file;
  } catch {
    return null; // best-effort: the caller's own key gate handles "still no key"
  }
}
