import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createLoopDb } from '../src/client';
import { stubEmbedder } from '../src/embedding';
import { addNote, recall, recordRecall, softDeleteNote } from '../src/ops';
import { memoryOp } from '../src/schema/memory';

// 통합 테스트(docker pgvector 필요): 4-op + pgvector recall + soft-delete 를 end-to-end로 증명.
const { db, pool } = createLoopDb();
const embedder = stubEmbedder();

afterAll(async () => {
  await pool.end();
});

describe('loop-memory recall (pgvector)', () => {
  it('recalls an added note and hides it once soft-deleted', async () => {
    const note = await addNote(db, embedder, {
      content: 'withTenant()로 RLS 컨텍스트를 주입하면 테넌트 격리 테스트가 GREEN이 된다',
      tags: ['rls', 'lesson'],
    });

    const before = await recall(db, embedder, note.content, 5);
    expect(before.some((h) => h.id === note.id)).toBe(true);

    await softDeleteNote(db, note.id, 'test cleanup');

    const after = await recall(db, embedder, note.content, 5);
    expect(after.some((h) => h.id === note.id)).toBe(false);
  });

  // BAC-586 선행 슬라이스: 훅이 실제 주입 확정한 노트를 memory_op에 RECALL 행으로 남겨야, 사후에
  // "그 시점 컨텍스트에 실제로 있었는가"(recall 실패표본 분류 (B))를 증명할 수 있다.
  it('recordRecall appends a RECALL row to the memory_op ledger without touching the note', async () => {
    const note = await addNote(db, embedder, {
      content: '회상 계측 대상 노트(BAC-586)',
      tags: ['lesson'],
    });

    await recordRecall(db, note.id, { distance: 0.123, corpus: 'lessons' });

    const rows = await db
      .select()
      .from(memoryOp)
      .where(and(eq(memoryOp.noteId, note.id), eq(memoryOp.op, 'RECALL')));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ distance: 0.123, corpus: 'lessons' });

    await softDeleteNote(db, note.id, 'test cleanup');
  });
});
