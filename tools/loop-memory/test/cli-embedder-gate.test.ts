import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fast unit test (NO docker needed): main() calls pickEmbedder() before createLoopDb(), so the
// fail-closed gate refuses and exits before the CLI ever opens a DB connection. A manual
// recall/graduate with no embedding key visible in process.env must refuse rather than silently
// querying/graduating with a stub embedder against a store built with a real one ("quietly wrong,
// not empty" failure mode).
const tsx = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

// 두 상한은 **함께** 움직여야 한다: TEST_TIMEOUT_MS > SPAWN_TIMEOUT_MS. 어기면 테스트가 자기 상한에
// 닿기도 전에 vitest가 먼저 죽여, 실패 메시지가 원인을 안 알려준다.
//
// 실측(2026-08-02 CI, PR #530): tsx 콜드 스타트 + CLI import 그래프 로드가 GitHub 러너에서 spawn당
// 9~13초 걸려 4건 전부 vitest 기본 5초에 타임아웃했다. 로컬은 0.3~1.0초(warm 캐시)라 통과해 왔고,
// turbo 캐시가 이 패키지를 계속 히트시켜 CI에서도 오래 가려져 있었다 — 루트 파일 변경으로 캐시가
// 무효화되자 처음 드러났다. 즉 새 회귀가 아니라 원래 있던 취약성이다.
//
// ⚠️ `spawnSync`는 **동기**라 이벤트 루프를 막는다 → vitest의 testTimeout 타이머는 spawn이 끝난 뒤에야
// 발화한다. 그래서 CI가 보고한 13.1초는 "5초에 잘렸다"가 아니라 **spawn이 실제로 13.1초 걸렸다**는
// 뜻이고, 옛 15초 spawn 상한과는 2초 차였다. 조금만 더 느린 러너에선 spawn 상한에 걸려 status=null로
// 전혀 다른 모양으로 실패했을 것이다. 관측 최악치(13초)의 3배 이상으로 둔다.
const SPAWN_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(tsx, [cli, ...args], { encoding: 'utf8', env, timeout: SPAWN_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// '' (not delete) keeps the var PRESENT but falsy in process.env, so pickEmbedder reads "no key" even
// if the parent shell running this test suite happens to export a real one. An
// unroutable LOOP_DATABASE_URL keeps this "fast lane, no docker/infra" — without it, the --allow-stub
// case below would open a real connection to whatever pgvector happens to be reachable at localhost:5434.
function noKeyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOOP_EMBED_PROVIDER: '',
    LOOP_EMBED_MODEL: '',
    LOOP_MEMORY_SIGNING_KEY: '',
    LOOP_DOTENV_PATH: '/nonexistent-loop-fixture.env',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    LOOP_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/nope',
  };
}

describe('cli — embedder fail-closed gate (ADR-0062 decision 9)', () => {
  it(
    'recall with no embedding key and no --allow-stub refuses (exit 1), never reaches the DB',
    () => {
      const r = runCli(['recall', '--query', 'anything'], noKeyEnv());
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no embedding API key/);
      expect(r.stderr).toMatch(/--allow-stub/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'graduate with no embedding key and no --allow-stub refuses (exit 1)',
    () => {
      const r = runCli(['graduate', '--lessons', '/nonexistent-lessons-dir'], noKeyEnv());
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no embedding API key/);
      expect(r.stderr).toMatch(/--allow-stub/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'recall with no embedding key but --allow-stub proceeds past the refusal gate',
    () => {
      const r = runCli(['recall', '--query', 'anything', '--allow-stub'], noKeyEnv());
      // Past the gate the CLI goes on to try a DB connection (which fails fast — noKeyEnv() points
      // LOOP_DATABASE_URL at an unroutable port, so this stays hermetic) — that's not what this test
      // asserts. It only proves --allow-stub actually routes past the fail-closed refusal (not a dead
      // flag like the deleted `--top`, ADR-0062 decision 5).
      expect(r.stderr).toMatch(/using stub \(--allow-stub\)/);
      expect(r.stderr).not.toMatch(/refusing to run/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'graduate with no embedding key but --allow-stub proceeds past the refusal gate',
    () => {
      const r = runCli(
        ['graduate', '--lessons', '/nonexistent-lessons-dir', '--allow-stub'],
        noKeyEnv(),
      );
      // Same proof as the recall case above, for the other command that shares pickEmbedder() —
      // --allow-stub must not be a flag that only recall respects.
      expect(r.stderr).toMatch(/using stub \(--allow-stub\)/);
      expect(r.stderr).not.toMatch(/refusing to run/);
    },
    TEST_TIMEOUT_MS,
  );
});


describe('CLI identity and evaluation policy before DB access', () => {
  it.each([
    [{ LOOP_EMBED_PROVIDER: 'openai', GEMINI_API_KEY: 'fixture-gemini' }, 'embedding_provider_key_missing'],
    [{ OPENAI_API_KEY: 'fixture-openai', GEMINI_API_KEY: 'fixture-gemini' }, 'embedding_provider_ambiguous'],
    [{ LOOP_EMBED_PROVIDER: 'typo', OPENAI_API_KEY: 'fixture-openai' }, 'embedding_provider_invalid'],
    [{ LOOP_MEMORY_OFF: '1' }, 'memory_off'],
  ])('fails closed with typed outcome %s', (vars, reason) => {
    const r = runCli(['recall', '--query', 'fixture', '--json'], { ...noKeyEnv(), ...vars });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ schema_version: 1, command: 'recall', outcome: 'error', reason });
  }, TEST_TIMEOUT_MS);
  it.each(['LOOP_LEARNING_OFF', 'LOOP_MEMORY_RECALL_ONLY'])('%s blocks CLI mutation before DB', flag => {
    for (const cmd of ['graduate', 'record-recall']) {
      const r = runCli([cmd, '--json'], { ...noKeyEnv(), [flag]: '1' });
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).outcome).toBe('error');
      expect(r.stderr).toMatch(/learning_off|memory_recall_only/);
    }
  }, TEST_TIMEOUT_MS);
});
