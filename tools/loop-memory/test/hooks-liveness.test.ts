import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeLiveness } from '../src/liveness';

// paul-loop issue #35. Both hooks are fail-open, so from the outside a hook that never ran, one that
// self-gated, one that legitimately found nothing, and one that broke are all "exit 0, empty stdout,
// nothing on disk". These tests drive the **real hook processes** (the same technique as
// test/hooks-dotenv.test.ts — the thing that broke last time was the wiring, not a unit) and assert
// that each of those states leaves a distinguishable, always-on record without anyone having enabled
// LOOP_RECALL_DEBUG first.
const GRADUATE = join(__dirname, '..', 'hooks', 'graduate-lessons.mjs');
const RECALL = join(__dirname, '..', 'hooks', 'recall-lessons.mjs');
const SESSION = 'sess-abc123';

// The two "never blocks on stdin" tests need a pipe that never reaches EOF, which needs `mkfifo`.
// Probed once here and wired through `it.runIf` so a host without it reports the test as **skipped**
// rather than passed: a guard clause that silently `return`s inside the test body would turn a
// missing capability into a green tick, which is the failure mode these tests exist to prevent.
const HAS_MKFIFO = spawnSync('sh', ['-c', 'command -v mkfifo']).status === 0;

/** Creates a FIFO at `path` and returns it. Held open O_RDWR by the caller, it always has a writer,
 *  so a reader never sees EOF — exactly the fd 0 that wedged a hook during development. */
function mkfifo(path: string): string {
  const r = spawnSync('mkfifo', [path]);
  if (r.status !== 0) throw new Error(`mkfifo failed: ${r.stderr?.toString() ?? r.status}`);
  return path;
}

let base: string;
let pluginRoot: string;
let dataDir: string;
let projectDir: string;

interface LedgerEvent {
  id: string;
  type: string;
  ts: string;
  aggregate_id: string;
  // biome-ignore lint/suspicious/noExplicitAny: the ledger payload is deliberately open-shaped here
  payload: any;
  version: number;
}

/** Fake `dist/cli.js`. `CLI_MODE` steers what the hooks' subprocess does, so a test can put the real
 *  hook into each of the four outcomes without a database or an embedding key. */
function writeFakeCli(mode = 'hit') {
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'dist', 'cli.js'),
    [
      "const mode = process.env.CLI_MODE || 'hit';",
      "if (mode === 'fail') process.exit(3);",
      "if (process.argv[2] === 'recall') {",
      "  const far = { lessons: [{ id: 'l1', content: 'a far lesson', distance: 0.9 }], knowledge: [] };",
      "  const near = { lessons: [{ id: 'l1', content: 'a recalled lesson', distance: 0.1 }], knowledge: [] };",
      "  const empty = { lessons: [], knowledge: [] };",
      "  const body = mode === 'far' ? far : mode === 'empty' ? empty : near;",
      "  process.stdout.write(JSON.stringify(body) + '\\n');",
      '}',
      'process.exit(0);',
    ].join('\n'),
  );
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    ...extra,
  } as NodeJS.ProcessEnv;
}

function runRecall(
  extra: Record<string, string> = {},
  stdin: unknown = {
    session_id: SESSION,
    hook_event_name: 'UserPromptSubmit',
    user_input: 'a prompt long enough to pass the length gate',
  },
) {
  return spawnSync('node', [RECALL], {
    cwd: projectDir,
    encoding: 'utf8',
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    env: baseEnv(extra),
  });
}

/** graduate takes its lifecycle name from argv (never stdin — see the hook's header) and its session
 *  id from CLAUDE_CODE_SESSION_ID, so it is driven exactly the way hooks/hooks.json drives it. */
function runGraduate(extra: Record<string, string> = {}, event: string | null = 'SessionStart') {
  return spawnSync('node', event ? [GRADUATE, '--event', event] : [GRADUATE], {
    cwd: projectDir,
    encoding: 'utf8',
    env: baseEnv({ CLAUDE_CODE_SESSION_ID: SESSION, ...extra }),
    timeout: 10_000,
  });
}

function runsDir() {
  return join(projectDir, '.loop', 'runs');
}

/** Every ledger event under the project's `.loop/runs/`, across all run files. */
function ledger(): LedgerEvent[] {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(runsDir(), f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as LedgerEvent),
    );
}

function only(type: string): LedgerEvent {
  const events = ledger().filter((e) => e.type === type);
  expect(events, `expected exactly one ${type} event, got ${events.length}`).toHaveLength(1);
  return events[0] as LedgerEvent;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'loop-memory-liveness-'));
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

describe('recall liveness — the four states fail-open otherwise flattens into one', () => {
  it('NEVER FIRED: nothing runs → no ledger at all (and the summary says zero, not an error)', () => {
    expect(existsSync(runsDir())).toBe(false);
    const s = summarizeLiveness(projectDir);
    expect(s.runsScanned).toBe(0);
    expect(s.recall.total).toBe(0);
  });

  it('SELF-GATED (no key): fired, exit 0, empty stdout — but the ledger says which gate stopped it', () => {
    const res = runRecall();
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(''); // externally identical to "never fired"...
    const e = only('memory.recall'); // ...and internally not
    expect(e.payload.outcome).toBe('skipped');
    expect(e.payload.reason).toBe('no_embedding_key');
    expect(e.payload.key).toBe(false);
    expect(e.payload.dotenv).toBe(false);
  });

  it('SELF-GATED (recall off) is a different reason from no-key', () => {
    runRecall({ LOOP_RECALL_OFF: '1', GEMINI_API_KEY: 'k' });
    expect(only('memory.recall').payload.reason).toBe('recall_off');
  });

  // The two gates that fire before stdin is read must not depend on fd 0 reaching EOF — an
  // unconfigured install runs them on *every* prompt, and a read-to-EOF wedges forever on a pipe
  // nobody closes. A FIFO held open O_RDWR is that pipe, deterministically.
  it.runIf(HAS_MKFIFO)(
    'the pre-stdin gates never block on a stdin that never reaches EOF, and still record',
    () => {
      const fd = openSync(mkfifo(join(base, 'recall-never-eof')), constants.O_RDWR);
      try {
        const res = spawnSync('node', [RECALL], {
          cwd: projectDir,
          env: baseEnv({ CLAUDE_CODE_SESSION_ID: SESSION }), // no key → gated before the stdin read
          stdio: [fd, 'pipe', 'pipe'],
          timeout: 5_000,
        });
        expect(
          res.signal,
          'the hook was killed by the timeout — it blocked reading stdin',
        ).toBeNull();
        expect(res.status).toBe(0);
      } finally {
        closeSync(fd);
      }
      const e = only('memory.recall');
      expect(e.payload.reason).toBe('no_embedding_key');
      expect(e.aggregate_id).toBe(SESSION); // attributed via the env fallback, not stdin
    },
  );

  it('SELF-GATED (prompt too short) records the length, never the prompt', () => {
    runRecall({ GEMINI_API_KEY: 'k' }, { session_id: SESSION, user_input: 'hi' });
    const e = only('memory.recall');
    expect(e.payload.reason).toBe('prompt_too_short');
    expect(e.payload.prompt_chars).toBe(2);
  });

  // ── issue #35: the prompt field. Claude Code's UserPromptSubmit payload carries the prompt as
  // `prompt`; this hook read `user_input`, which the payload does not have. Every firing therefore
  // saw an empty string, self-gated as "prompt too short", and exited 0 — indistinguishable from a
  // user who typed something short. Measured in the consuming repo's run ledger: 176 firings,
  // 176 × `prompt_too_short`, every one with `prompt_chars: 0` and `key: true`.
  //
  // These tests could not have caught it: every one of them fed `user_input`, i.e. they agreed with
  // the code's wrong premise instead of checking it. `user_input` is kept as a second accepted field
  // because loop-engine's own context-budget.mjs (O1b) spawns this hook with that shape — two real
  // callers, two shapes, not a legacy alias.
  it('reads the real UserPromptSubmit field (`prompt`), not just `user_input`', () => {
    runRecall(
      { GEMINI_API_KEY: 'k' },
      { session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt: 'a prompt long enough to pass the length gate' },
    );
    const e = only('memory.recall');
    expect(e.payload.prompt_chars).toBe('a prompt long enough to pass the length gate'.length);
    expect(e.payload.reason).not.toBe('prompt_too_short');
    expect(e.payload.reason).not.toBe('prompt_field_missing');
  });

  it('still reads `user_input` — context-budget.mjs spawns the hook with that shape', () => {
    runRecall(
      { GEMINI_API_KEY: 'k' },
      { session_id: SESSION, user_input: 'a prompt long enough to pass the length gate' },
    );
    const e = only('memory.recall');
    expect(e.payload.prompt_chars).toBe('a prompt long enough to pass the length gate'.length);
    expect(e.payload.reason).not.toBe('prompt_too_short');
  });

  it('a payload carrying NO recognised prompt field is its own reason, not "too short"', () => {
    // The whole point of the fix: if the field is ever renamed again, the ledger says so instead of
    // looking like 176 short prompts in a row.
    runRecall({ GEMINI_API_KEY: 'k' }, { session_id: SESSION, hook_event_name: 'UserPromptSubmit' });
    const e = only('memory.recall');
    expect(e.payload.reason).toBe('prompt_field_missing');
    expect(e.payload.prompt_chars).toBe(0);
  });

  it('an empty-string prompt field is "too short", not "missing" — the field was there', () => {
    runRecall({ GEMINI_API_KEY: 'k' }, { session_id: SESSION, prompt: '' });
    expect(only('memory.recall').payload.reason).toBe('prompt_too_short');
  });

  it('SELF-GATED (unparseable stdin) is recorded rather than lost', () => {
    runRecall({ GEMINI_API_KEY: 'k' }, 'not json at all');
    expect(only('memory.recall').payload.reason).toBe('stdin_parse_fail');
  });

  it('NO MATCH (hits, all above the cutoff): the pipeline ran — that must not look broken', () => {
    const res = runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'far' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const e = only('memory.recall');
    expect(e.payload.outcome).toBe('no_match'); // NOT 'error', NOT 'skipped'
    expect(e.payload.reason).toBe('above_cutoff');
    expect(e.payload.key).toBe(true);
    // The numbers that make an honest miss actionable later: something WAS found, at 0.9, against a
    // 0.65 cutoff — a calibration question, not a dead hook.
    expect(e.payload.lessons).toMatchObject({ candidates: 1, near: 0, nearest: 0.9 });
    expect(e.payload.cutoffs).toMatchObject({ lessons: 0.65, knowledge: 0.65 });
  });

  it('NO MATCH (empty corpus) is a distinct reason from "everything was too far"', () => {
    runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'empty' });
    const e = only('memory.recall');
    expect(e.payload.outcome).toBe('no_match');
    expect(e.payload.reason).toBe('no_hits');
    expect(e.payload.lessons.candidates).toBe(0);
  });

  it('INJECTED: records that context actually reached the session, and how much', () => {
    const res = runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'hit' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('a recalled lesson');
    const e = only('memory.recall');
    expect(e.payload.outcome).toBe('injected');
    expect(e.payload.injected_chars).toBe(res.stdout.length);
    expect(e.payload.lessons).toMatchObject({ candidates: 1, near: 1, nearest: 0.1 });
  });

  it('ERROR: a failing CLI is `error`, not a quiet skip, and carries the exit code', () => {
    const res = runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'fail' });
    expect(res.status).toBe(0); // still fail-open
    const e = only('memory.recall');
    expect(e.payload.outcome).toBe('error');
    expect(e.payload.reason).toBe('cli_failed');
    expect(e.payload.cli_status).toBe(3);
  });
});

describe('graduate liveness', () => {
  it('records which lifecycle event fired it and that it synced', () => {
    const res = runGraduate({ GEMINI_API_KEY: 'k' });
    expect(res.status).toBe(0);
    const e = only('memory.graduate');
    expect(e.payload).toMatchObject({
      outcome: 'synced',
      reason: 'ok',
      event: 'SessionStart',
      key: true,
      cli_status: 0,
    });
  });

  it('SessionEnd is distinguishable from SessionStart (the same script is wired to both)', () => {
    runGraduate({ GEMINI_API_KEY: 'k' }, 'SessionEnd');
    expect(only('memory.graduate').payload.event).toBe('SessionEnd');
  });

  it('is driven exactly the way hooks.json drives it', () => {
    const hooks = JSON.parse(
      readFileSync(join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'),
    ) as Record<string, Record<string, { hooks: { command: string }[] }[]>>;
    const cmd = (name: string) => hooks.hooks?.[name]?.[0]?.hooks?.[0]?.command ?? '';
    expect(cmd('SessionStart')).toContain('--event SessionStart');
    expect(cmd('SessionEnd')).toContain('--event SessionEnd');
  });

  it('self-gates without a key, and says so', () => {
    runGraduate();
    expect(only('memory.graduate').payload).toMatchObject({
      outcome: 'skipped',
      reason: 'no_embedding_key',
    });
  });

  it('a failing CLI is `error` with its exit code, not silence', () => {
    const res = runGraduate({ GEMINI_API_KEY: 'k', CLI_MODE: 'fail' });
    expect(res.status).toBe(0);
    expect(only('memory.graduate').payload).toMatchObject({
      outcome: 'error',
      reason: 'cli_failed',
      cli_status: 3,
    });
  });

  // Regression: an earlier revision took the lifecycle name off stdin, and a read-to-EOF wedged the
  // process forever whenever fd 0 was an inherited pipe nobody closed (reproduced by hand-running it
  // inside `$(...)`). A hanging SessionStart hook stalls session startup — much worse than the label
  // it was buying. A FIFO held open O_RDWR is that fd 0, deterministically: there is always a writer,
  // so a reader never sees EOF.
  it.runIf(HAS_MKFIFO)(
    'never blocks on stdin, even when fd 0 is a pipe that never reaches EOF',
    () => {
      // O_RDWR: doesn't block on open, and keeps a writer alive so the reader never sees EOF.
      const fd = openSync(mkfifo(join(base, 'never-eof')), constants.O_RDWR);
      try {
        const res = spawnSync('node', [GRADUATE, '--event', 'SessionStart'], {
          cwd: projectDir,
          env: baseEnv(),
          stdio: [fd, 'pipe', 'pipe'],
          timeout: 5_000,
        });
        expect(
          res.signal,
          'the hook was killed by the timeout — it blocked reading stdin',
        ).toBeNull();
        expect(res.status).toBe(0);
      } finally {
        closeSync(fd);
      }
    },
  );

  it('falls back to the unattributed run bucket when no session id is available', () => {
    const res = spawnSync('node', [GRADUATE, '--event', 'SessionStart'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: baseEnv(), // no CLAUDE_CODE_SESSION_ID
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(only('memory.graduate').aggregate_id).toBe('unknown'); // honest, and still a recorded firing
  });
});

describe('ledger shape — reuses loop-engine run-ledger schema v1 rather than a parallel format', () => {
  it('writes to .loop/runs/<session-id>.jsonl in the v1 event shape', () => {
    runRecall({ GEMINI_API_KEY: 'k' });
    expect(existsSync(join(runsDir(), `${SESSION}.jsonl`))).toBe(true);
    const e = only('memory.recall');
    expect(Object.keys(e).sort()).toEqual([
      'aggregate_id',
      'id',
      'payload',
      'ts',
      'type',
      'version',
    ]);
    expect(e.version).toBe(1);
    expect(e.aggregate_id).toBe(SESSION);
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('a session_id that could steer a path is sanitised into a safe filename', () => {
    runRecall({ GEMINI_API_KEY: 'k' }, { session_id: '../../escape', user_input: 'long enough now' });
    expect(readdirSync(runsDir())).toEqual(['escape.jsonl']);
  });

  it('appends alongside loop-engine events in the same run file without disturbing them', () => {
    mkdirSync(runsDir(), { recursive: true });
    const engineEvent = {
      id: 'e1',
      type: 'run.started',
      ts: '2026-08-24T00:00:00.000Z',
      aggregate_id: SESSION,
      payload: { cwd: '/x' },
      version: 1,
    };
    writeFileSync(join(runsDir(), `${SESSION}.jsonl`), `${JSON.stringify(engineEvent)}\n`);
    runRecall({ GEMINI_API_KEY: 'k' });
    const all = ledger();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(engineEvent); // byte-identical, still first
    expect(all[1]?.type).toBe('memory.recall');
  });
});

describe('never records secrets or free text', () => {
  it('the serialised ledger contains neither the API key nor the prompt', () => {
    const secret = 'sk-super-secret-key-value';
    const prompt = 'a very distinctive prompt about tenant isolation';
    writeFileSync(join(projectDir, '.loop', '.env'), `LOOP_MEMORY_SIGNING_KEY=${secret}\n`);
    runRecall(
      { GEMINI_API_KEY: secret, CLI_MODE: 'hit' },
      { session_id: SESSION, user_input: prompt },
    );
    const raw = readFileSync(join(runsDir(), `${SESSION}.jsonl`), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(prompt);
    expect(raw).not.toContain('a recalled lesson'); // nor the recalled note's content
    // What it does carry instead: the dotenv file was found, and the prompt's *length*.
    const e = only('memory.recall');
    expect(e.payload.dotenv).toBe(true);
    expect(e.payload.prompt_chars).toBe(prompt.length);
  });
});

describe('cost and safety — the write is bounded and never affects the session', () => {
  it('FAIL-OPEN: an unwritable ledger path leaves behaviour byte-identical', () => {
    // `.loop/runs` as a *file* makes mkdir/append fail deterministically for any uid (a chmod-based
    // version would silently pass when tests run as root).
    mkdirSync(join(projectDir, '.loop'), { recursive: true });
    writeFileSync(join(projectDir, '.loop', 'runs'), 'not a directory');
    const res = runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'hit' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toContain('a recalled lesson'); // the real work still happened

    const gated = runRecall(); // ...and so does the no-op path
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe('');
  });

  it('stops appending once the run file passes the size cap', () => {
    mkdirSync(runsDir(), { recursive: true });
    writeFileSync(join(runsDir(), `${SESSION}.jsonl`), `${'x'.repeat(200)}\n`);
    const res = runRecall({ GEMINI_API_KEY: 'k', LOOP_LIVENESS_MAX_BYTES: '100' });
    expect(res.status).toBe(0);
    expect(readFileSync(join(runsDir(), `${SESSION}.jsonl`), 'utf8')).toBe(`${'x'.repeat(200)}\n`);
  });

  it('LOOP_LIVENESS_OFF=1 writes nothing at all', () => {
    const res = runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'hit', LOOP_LIVENESS_OFF: '1' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('a recalled lesson');
    expect(existsSync(runsDir())).toBe(false);
  });

  it('exactly one event per firing — the hot path must not multiply writes', () => {
    runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'hit' });
    runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'far' });
    expect(ledger().filter((e) => e.type === 'memory.recall')).toHaveLength(2);
  });
});

describe('summarizeLiveness — what a loop-doctor-style consumer asserts on', () => {
  it('folds real firings into per-outcome counts and reasons', () => {
    runGraduate({ GEMINI_API_KEY: 'k' });
    runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'hit' });
    runRecall({ GEMINI_API_KEY: 'k', CLI_MODE: 'far' });
    // No key and no CLAUDE_CODE_SESSION_ID: gated before stdin is read, so this one honestly lands in
    // the `unknown` run bucket — a second run file, still folded in.
    runRecall();

    const s = summarizeLiveness(projectDir);
    expect(s.runsScanned).toBe(2);
    expect(s.runsWithRecall).toBe(2);
    expect(s.recall).toMatchObject({ total: 3, injected: 1, no_match: 1, skipped: 1, error: 0 });
    expect(s.recall.reasons).toEqual({ injected: 1, above_cutoff: 1, no_embedding_key: 1 });
    expect(s.graduate).toMatchObject({ total: 1, injected: 0 });
    expect(s.lastInjectedAt).not.toBeNull();
    expect(s.skippedLines).toBe(0);
  });

  it('ignores loop-engine events sharing the file, and counts unparseable lines instead of hiding them', () => {
    mkdirSync(runsDir(), { recursive: true });
    writeFileSync(
      join(runsDir(), `${SESSION}.jsonl`),
      `${JSON.stringify({ type: 'run.started', ts: 'x', payload: {} })}\n{ broken\n`,
    );
    runRecall({ GEMINI_API_KEY: 'k' });
    const s = summarizeLiveness(projectDir);
    expect(s.recall.total).toBe(1);
    expect(s.graduate.total).toBe(0);
    expect(s.skippedLines).toBe(1);
  });

  it('only looks at the most recent run files, so a hook that died last week cannot stay green', () => {
    runRecall({ GEMINI_API_KEY: 'k' }); // lands in SESSION.jsonl
    runRecall({ GEMINI_API_KEY: 'k' }, { session_id: 'newer', user_input: 'long enough prompt' });
    expect(summarizeLiveness(projectDir, { runs: 1 }).runsScanned).toBe(1);
    expect(summarizeLiveness(projectDir).runsScanned).toBe(2);
  });
});
