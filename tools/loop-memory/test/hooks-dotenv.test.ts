import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Regression: both hooks read the embedding key from the process env only, but Claude Code hands a
// hook the *session process env* — it never loads `.env` files. A repo holding its key in a
// gitignored `.env` therefore tripped each hook's own no-key gate and no-op'd **silently**: no
// semantic recall, no lesson graduation, no error anywhere. These tests exercise the real hook
// processes (not the loader in isolation) so what's locked is "the key reaches the gate", which is
// the property that was actually broken.
const GRADUATE = join(__dirname, '..', 'hooks', 'graduate-lessons.mjs');
const RECALL = join(__dirname, '..', 'hooks', 'recall-lessons.mjs');

let base: string;
let pluginRoot: string;
let dataDir: string;
let projectDir: string;

/** Fake `dist/cli.js` — the hooks spawn this; it dumps the env it was given, per subcommand, so a
 * test can assert both *that* the gate let it run and *what* env crossed over. */
function writeFakeCli(root = pluginRoot) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'dist', 'cli.js'),
    [
      "const fs = require('node:fs');",
      "const sub = process.argv[2] || 'none';",
      'fs.writeFileSync(`${process.env.TEST_ENV_DUMP}.${sub}.json`, JSON.stringify(process.env));',
      // recall parses a single-line JSON object off stdout; distance 0.1 is inside the 0.65 default cutoff.
      "if (sub === 'recall')",
      "  process.stdout.write(JSON.stringify({ lessons: [{ id: 'l1', content: 'a recalled lesson', distance: 0.1 }], knowledge: [] }) + '\\n');",
      'process.exit(0);',
    ].join('\n'),
  );
}

function dumpPath(sub: string) {
  return join(dataDir, `cli-env.${sub}.json`);
}

/** The env a spawned CLI actually saw, or null if the hook's gate never spawned it. */
function spawnedEnv(sub: string): Record<string, string> | null {
  try {
    return JSON.parse(readFileSync(dumpPath(sub), 'utf8'));
  } catch {
    return null;
  }
}

function writeDotenv(dir: string, relPath: string, body: string) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function runGraduate(extraEnv: Record<string, string> = {}, cwd = projectDir) {
  return spawnSync('node', [GRADUATE], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PROJECT_DIR: cwd,
      TEST_ENV_DUMP: join(dataDir, 'cli-env'),
      ...extraEnv,
    } as NodeJS.ProcessEnv,
  });
}

function runRecall(extraEnv: Record<string, string> = {}, cwd = projectDir) {
  return spawnSync('node', [RECALL], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ user_input: 'a prompt long enough to pass the length gate' }),
    env: {
      PATH: process.env.PATH,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PROJECT_DIR: cwd,
      TEST_ENV_DUMP: join(dataDir, 'cli-env'),
      ...extraEnv,
    } as NodeJS.ProcessEnv,
  });
}

describe('hooks — .env loading before the embedding-key gate', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'loop-memory-dotenv-'));
    pluginRoot = join(base, 'plugin');
    dataDir = join(base, 'data');
    projectDir = join(base, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(projectDir, '.loop', 'lessons'), { recursive: true });
    writeFakeCli();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a key that exists only in .loop/.env reaches the gate (graduate spawns the CLI with it)', () => {
    writeDotenv(projectDir, '.loop/.env', '# comment\nGEMINI_API_KEY=from-dotenv\n');
    const res = runGraduate();
    expect(res.status).toBe(0);
    const env = spawnedEnv('graduate');
    expect(env, 'CLI was not spawned — the no-key gate still blocked').not.toBeNull();
    expect(env?.GEMINI_API_KEY).toBe('from-dotenv');
  });

  it('the same for recall — the hook injects context instead of no-oping', () => {
    writeDotenv(projectDir, '.loop/.env', 'GEMINI_API_KEY=from-dotenv\n');
    const res = runRecall();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('a recalled lesson');
    expect(spawnedEnv('recall')?.GEMINI_API_KEY).toBe('from-dotenv');
  });

  it('does NOT overwrite a value already set in the session env (shell export wins)', () => {
    writeDotenv(projectDir, '.loop/.env', 'OPENAI_API_KEY=from-dotenv\nLOOP_EMBED_PROVIDER=gemini\n');
    const res = runGraduate({ OPENAI_API_KEY: 'from-shell' });
    expect(res.status).toBe(0);
    const env = spawnedEnv('graduate');
    expect(env?.OPENAI_API_KEY).toBe('from-shell');
    // ...while a key the session env did NOT set still comes through from the file.
    expect(env?.LOOP_EMBED_PROVIDER).toBe('gemini');
  });

  it('does NOT overwrite a userConfig value bridged from CLAUDE_PLUGIN_OPTION_*', () => {
    writeDotenv(projectDir, '.loop/.env', 'OPENAI_API_KEY=from-dotenv\n');
    const res = runGraduate({ CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: 'from-user-config' });
    expect(res.status).toBe(0);
    expect(spawnedEnv('graduate')?.OPENAI_API_KEY).toBe('from-user-config');
  });

  it('missing .env file: no throw, both hooks stay fail-open no-ops (exit 0, empty stdout, no CLI run)', () => {
    const g = runGraduate();
    expect(g.status).toBe(0);
    expect(g.stdout).toBe('');
    expect(spawnedEnv('graduate')).toBeNull();

    const r = runRecall();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(spawnedEnv('recall')).toBeNull();
  });

  it('unreadable dotenv path (a directory, not a file): no throw, hook still no-ops cleanly', () => {
    mkdirSync(join(projectDir, '.loop', '.env'), { recursive: true });
    const res = runGraduate();
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(spawnedEnv('graduate')).toBeNull();
  });

  it('honours a custom path from the loop_dotenv_path plugin option', () => {
    writeDotenv(projectDir, 'packages/loop-memory/.env', 'GEMINI_API_KEY=custom-path-key\n');
    const blocked = runGraduate();
    expect(spawnedEnv('graduate'), 'default path must not find it').toBeNull();

    expect(blocked.status).toBe(0);
    const res = runGraduate({
      CLAUDE_PLUGIN_OPTION_LOOP_DOTENV_PATH: 'packages/loop-memory/.env',
    });
    expect(res.status).toBe(0);
    expect(spawnedEnv('graduate')?.GEMINI_API_KEY).toBe('custom-path-key');
  });

  it('parses quoted values, `export KEY=`, and inline comments; skips junk lines', () => {
    writeDotenv(
      projectDir,
      '.loop/.env',
      [
        'not a key=value line but has spaces',
        '=novalue',
        'export GEMINI_API_KEY="quoted key" # trailing comment',
        'LOOP_DATABASE_URL=postgres://u:p@localhost:5434/db # inline',
        "LOOP_MEMORY_SIGNING_KEY='single=quoted=with=equals'",
      ].join('\n'),
    );
    const res = runGraduate();
    expect(res.status).toBe(0);
    const env = spawnedEnv('graduate');
    expect(env?.GEMINI_API_KEY).toBe('quoted key');
    expect(env?.LOOP_DATABASE_URL).toBe('postgres://u:p@localhost:5434/db');
    expect(env?.LOOP_MEMORY_SIGNING_KEY).toBe('single=quoted=with=equals');
  });
});

// A gitignored `.env` is by definition absent from a freshly-created feature worktree — which is
// exactly where an isolated agent loop runs. Without this fallback the plugin fails closed in every
// worktree, which is how the original six-week silent no-op stayed invisible.
describe('hooks — worktree fallback to the main worktree .env', () => {
  let mainRoot: string;
  let linked: string;

  const git = (args: string[], cwd: string) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'loop-memory-worktree-'));
    pluginRoot = join(base, 'plugin');
    dataDir = join(base, 'data');
    mainRoot = join(base, 'main');
    linked = join(base, 'feature-wt');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(mainRoot, { recursive: true });
    writeFakeCli();

    git(['init', '-b', 'main'], mainRoot);
    writeFileSync(join(mainRoot, 'README.md'), 'seed\n');
    git(['add', '.'], mainRoot);
    git(
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--no-gpg-sign', '-m', 'init'],
      mainRoot,
    );
    git(['worktree', 'add', '-b', 'feat', linked], mainRoot);
    mkdirSync(join(linked, '.loop', 'lessons'), { recursive: true });
    // The key lives only in the main worktree (gitignored → never copied into the linked one).
    writeDotenv(mainRoot, '.loop/.env', 'GEMINI_API_KEY=main-worktree-key\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('finds the main worktree .env when the feature worktree has none', () => {
    projectDir = linked;
    const res = runGraduate({}, linked);
    expect(res.status).toBe(0);
    const env = spawnedEnv('graduate');
    expect(env, 'fallback did not resolve — CLI never spawned').not.toBeNull();
    expect(env?.GEMINI_API_KEY).toBe('main-worktree-key');
  });

  it("prefers the worktree's own .env over the main worktree's when both exist", () => {
    projectDir = linked;
    writeDotenv(linked, '.loop/.env', 'GEMINI_API_KEY=local-worktree-key\n');
    const res = runGraduate({}, linked);
    expect(res.status).toBe(0);
    expect(spawnedEnv('graduate')?.GEMINI_API_KEY).toBe('local-worktree-key');
  });

  it('outside a git repo with no .env: still a clean no-op (no git binary crash, no throw)', () => {
    projectDir = join(base, 'not-a-repo');
    mkdirSync(join(projectDir, '.loop', 'lessons'), { recursive: true });
    const res = runGraduate({}, projectDir);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(spawnedEnv('graduate')).toBeNull();
  });
});
