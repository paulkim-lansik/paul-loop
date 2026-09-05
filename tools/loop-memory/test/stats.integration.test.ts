import { spawnSync } from './helpers/postgres-fixture';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createLoopDb, LOOP_DATABASE_URL } from './helpers/postgres-fixture';
import { stubEmbedder } from '../src/embedding';
import { softDeleteNote } from '../src/ops';
import { addNote } from './helpers/postgres-fixture';
import { memoryNote } from '../src/schema/memory';

// 통합(docker pgvector): `loop-memory stats` CLI를 서브프로세스로 굴려, loop-doctor가 의존하는 --json
// 계약(notes/corpora/ops/lastOpAt)을 end-to-end 증명한다. 핵심 *행위*는 "active vs soft-deleted 구분" —
// corpora는 삭제되지 않은 노트만 센다(loop-doctor의 '활성 지식' 카운트가 여기 걸려 있다).
const { db, pool } = createLoopDb();
const embedder = stubEmbedder(); // 결정적·무비용·무키(stats는 임베드 안 하지만 노트 seed엔 필요)
const run = randomUUID().slice(0, 8);
const tag = `stats-test-${run}`; // 이 회차만의 코퍼스 태그 — 공유 DB에 다른 태그가 있어도 내 카운트는 격리

const cliEnv: NodeJS.ProcessEnv = { ...process.env };
cliEnv.LOOP_DATABASE_URL = LOOP_DATABASE_URL; // 서브프로세스가 같은 DB를 보게
const tsx = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface StatsJson {
  notes: { total: number; active: number; softDeleted: number; embedded: number };
  corpora: Record<string, number>;
  ops: Record<string, number>;
  lastOpAt: string | null;
}
function statsJson(): StatsJson {
  const r = spawnSync(tsx, [cli, 'stats', '--json'], {
    encoding: 'utf8',
    env: cliEnv,
    timeout: 30000,
  });
  expect(r.status, `stats exited nonzero: ${r.stderr}`).toBe(0);
  const line = (r.stdout ?? '').split('\n').find((l) => l.trim().startsWith('{'));
  expect(line, `expected a JSON object line, got: ${r.stdout}`).toBeDefined();
  return JSON.parse(line as string) as StatsJson;
}

afterAll(async () => {
  const mine = await db
    .select({ id: memoryNote.id })
    .from(memoryNote)
    .where(sql`${memoryNote.content} like ${`%${run}%`}`);
  for (const m of mine) await softDeleteNote(db, m.id, 'test cleanup');
  await pool.end();
});

describe('cli stats — 스토어 요약 (서브프로세스 end-to-end)', () => {
  it('추가된 노트를 active 코퍼스로 세고 ADD op·lastOpAt을 보고한다', async () => {
    await addNote(db, embedder, { content: `stats test note ${run}`, tags: [tag] });
    const s = statsJson();
    expect(s.corpora[tag]).toBe(1); // 내 태그가 정확히 1건(활성)
    expect(s.notes.active).toBeGreaterThanOrEqual(1);
    expect(s.notes.total).toBeGreaterThanOrEqual(s.notes.active);
    expect(s.notes.embedded).toBeGreaterThanOrEqual(1);
    expect(s.ops.ADD).toBeGreaterThanOrEqual(1);
    expect(s.lastOpAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(s.lastOpAt as string))).toBe(false); // 유효한 ISO
  });

  it('soft-delete된 노트는 active 코퍼스에서 빠지고 deletedAt이 찍힌다', async () => {
    // 내 태그 노트를 찾아 soft-delete
    const [note] = await db
      .select({ id: memoryNote.id })
      .from(memoryNote)
      .where(sql`${memoryNote.content} like ${`%${run}%`} and ${memoryNote.deletedAt} is null`);
    expect(note, 'seeded note should exist').toBeDefined();
    const id = (note as { id: string }).id;
    await softDeleteNote(db, id, 'stats test soft-delete');
    const after = statsJson();
    // 런-스코프 단언(공유 스토어 견고): 내 태그가 active 코퍼스에서 사라졌는지 + 그 노트의 deletedAt 확인.
    // 전역 softDeleted 카운터는 동시 워크트리의 prune에 흔들려 flaky하므로 쓰지 않는다(멀티에이전트 리뷰).
    expect(after.corpora[tag]).toBeUndefined();
    const [check] = await db
      .select({ deletedAt: memoryNote.deletedAt })
      .from(memoryNote)
      .where(eq(memoryNote.id, id));
    expect(check?.deletedAt).not.toBeNull();
  });
});
