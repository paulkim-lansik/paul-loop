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
//   4. ALLOWLIST. Only the keys in `ALLOWED_KEYS` are ever copied into `target`. Everything else in
//      the file is ignored, silently and by design.
//
// Why 4 exists — the threat model this loader sits in the middle of:
//
//   This file is READ FROM THE REPOSITORY BEING WORKED ON. `.loop/.env` is a path any repo can carry,
//   and a repo you merely *open* is not a repo you trust: reviewing a pull request, trying someone
//   else's project, or cloning to reproduce a bug all mean a hostile file can be sitting there before
//   you type anything. What `target` then becomes is a process environment — `graduate-lessons.mjs`
//   passes it as `spawnSync(..., { env })`, and `loop-doctor-heartbeat.mjs` merges it into its OWN
//   `process.env` before running `git`. So without an allowlist this loader hands a repository the
//   ability to set ANY environment variable for a child process, and both of those hooks are wired to
//   `SessionStart` — i.e. it fires on opening the repo, with no user action at all.
//
//   That is remote code execution, not a theoretical weakness, and it was reproduced both ways before
//   this allowlist was written: `NODE_OPTIONS=--require ./payload.cjs` (the spawned `node` runs the
//   repo's file) and `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=core.fsmonitor` (the `git` call runs the
//   repo's program). Those two are examples, not the set — `BASH_ENV`, `LD_PRELOAD`, `PERL5OPT`,
//   `DYLD_INSERT_LIBRARIES` and others reach the same place, which is exactly why this is an
//   allowlist and not a denylist. A denylist has to be complete forever; an allowlist has to be
//   correct once.
//
//   The allowlist's own rule, so future keys land on the right side of it: **a dotenv file supplies
//   credentials and connection settings. It never changes behaviour and never turns a gate off.**
//   That is why `LOOP_*_OFF` / `LOOP_*_GATE_OFF` / `LOOP_SANITIZE_OFF` are absent — a repo must not be
//   able to disable the stop gate, the worktree gate, or log redaction by shipping a file. `LOOP_DOTENV_PATH`
//   is absent too: a dotenv file redirecting where dotenv files are read from is a loop, and a lever.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/** Repo-relative default. `.loop/` is loop-engine's own convention directory (it already holds
 * `.loop/lessons`) and is conventionally gitignored, so `.loop/.env` is the one path that is a
 * sensible guess for *any* consuming repo. Repos that keep the file elsewhere point the
 * `loop_dotenv_path` plugin option (env `LOOP_DOTENV_PATH`) at it. */
export const DEFAULT_DOTENV_PATH = '.loop/.env';

/** The only keys a dotenv file may set. See the threat model in this file's header for why this is an
 * allowlist. Adding to it means answering one question: *would I let an untrusted repository set this
 * for a process running on my machine?* Credentials and connection/tuning settings pass that; anything
 * that switches behaviour off does not. */
export const ALLOWED_KEYS = Object.freeze([
  // credentials — the reason this loader exists at all
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'LOOP_MEMORY_SIGNING_KEY',
  // connection
  'LOOP_DATABASE_URL',
  'LOOP_EMBED_PROVIDER',
  // recall tuning — numeric thresholds, no behaviour switch
  'LOOP_RECALL_MAX_DISTANCE',
  'LOOP_KNOWLEDGE_MAX_DISTANCE',
]);
const ALLOWED = new Set(ALLOWED_KEYS);

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
  // A RELATIVE path stays inside the directory it is relative to. `LOOP_DOTENV_PATH` is ordinary
  // session env, which a repo-committed `.claude/settings.json` can set — so without this, `../../..`
  // walks the loader out of the project and into whatever it names. An ABSOLUTE path is left alone on
  // purpose (documented in the plugin manifest: a repo may keep its key outside the tree), and the
  // allowlist above is what keeps even that from being interesting to point somewhere hostile.
  const local = contained(projectDir, rel);
  if (local && existsSync(local)) return local;
  const mainRoot = mainWorktreeRoot(projectDir);
  if (!mainRoot) return null;
  const fallback = contained(mainRoot, rel);
  return fallback && existsSync(fallback) ? fallback : null;
}

/** `resolve(root, rel)` if the result is still under `root`, else null. Compares via `relative()`
 * rather than `startsWith` — `/repo-evil` must not count as inside `/repo`. */
function contained(root, rel) {
  const abs = resolve(root, rel);
  const r = relative(resolve(root), abs);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r)) ? abs : null;
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
      // Shape check, then the allowlist (property 4 — see the header's threat model), then
      // precedence. An ignored key is not an error: a repo's `.env` legitimately holds its own
      // application config next to the one key this plugin wants, and refusing to start over that
      // would be worse than ignoring it.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !ALLOWED.has(key) || key in target) continue;
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
