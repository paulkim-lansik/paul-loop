import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// BAC-371 (originally a glucofit-partners-local test, relocated to this plugin in BAC-766 once
// hooks/graduate-lessons.mjs itself moved here — the old bash test mocked a repo-local
// `packages/loop-memory/node_modules/.bin/tsx` + `src/cli.ts` pair, which no longer matches this
// hook's actual behavior: it spawns `node <CLAUDE_PLUGIN_ROOT>/dist/cli.js` directly). Locks that
// spawnSync's exit code/stderr aren't silently dropped: LOOP_GRADUATE_DEBUG=1 writes them to
// `${CLAUDE_PLUGIN_DATA}/graduate-debug.log`; without the flag, the hook stays silent and fail-open
// (matches recall-lessons.mjs's LOOP_RECALL_DEBUG parity, referenced in the hook's own header).
const HOOK = join(__dirname, '..', 'hooks', 'graduate-lessons.mjs');

let pluginRoot: string;
let dataDir: string;
let projectDir: string;
let logPath: string;

function writeFakeCli(script: string) {
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  writeFileSync(join(pluginRoot, 'dist', 'cli.js'), script);
}

function runHook(extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [HOOK], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PROJECT_DIR: projectDir,
      OPENAI_API_KEY: 'dummy-key',
      ...extraEnv,
    },
  });
}

describe('hooks/graduate-lessons.mjs — LOOP_GRADUATE_DEBUG logging (BAC-371)', () => {
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'graduate-lessons-test-'));
    pluginRoot = join(base, 'plugin');
    dataDir = join(base, 'data');
    projectDir = join(base, 'project');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(projectDir, '.loop', 'lessons'), { recursive: true });
    logPath = join(dataDir, 'graduate-debug.log');
  });

  afterEach(() => {
    rmSync(join(pluginRoot, '..'), { recursive: true, force: true });
  });

  it('logs exit code + stderr on CLI failure when LOOP_GRADUATE_DEBUG=1, hook still exits 0, stdout stays empty', () => {
    writeFakeCli(
      'process.stderr.write("boom: simulated graduate CLI failure\\n"); process.exit(1);',
    );
    const res = runHook({ LOOP_GRADUATE_DEBUG: '1' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('status=1');
    expect(log).toContain('boom: simulated graduate CLI failure');
  });

  it('stays silent and fail-open with no debug flag, writes no log file', () => {
    writeFakeCli('process.exit(1);');
    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('logs a line on CLI success too when debug is on (parity with recall-lessons.mjs)', () => {
    writeFakeCli('process.exit(0);');
    const res = runHook({ LOOP_GRADUATE_DEBUG: '1' });
    expect(res.status).toBe(0);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('status=0');
  });
});
