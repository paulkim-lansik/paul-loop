import { and, eq, isNull, sql } from 'drizzle-orm';
import type { LoopDb } from './client';
import type { Embedder } from './embedding';
import { memoryNote, memoryOp } from './schema/memory';

// Mem0 4-op 프로토콜. *어떤* op을 적용할지는 에이전트/LLM이 결정한다(이 패키지 밖, 후속 시맨).
// 여기서는 그 4개의 결정적 *원시 연산*과 감사 원장 기록만 제공한다.
export type MemoryOpKind = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export interface NoteInput {
  content: string;
  keywords?: string[];
  tags?: string[];
  context?: string;
  links?: string[];
  /** 사전 계산된 임베딩(BAC-368 배치 임베딩) — 있으면 embedder.embed()를 다시 호출하지 않고 그대로 쓴다.
   * syncKnowledge가 ADD/UPDATE 대상을 모아 한 번에 배치 임베드한 뒤 넘긴다. 없으면(기존 호출부 그대로)
   * 이전처럼 embedder.embed(content)로 단건 임베드한다. */
  embedding?: number[];
  /** write-path provenance(BAC-619) — HMAC-SHA256(content, secret) hex. lessons.ts의 graduateLessons만
   * 채운다(src/provenance.ts). 생략하면 컬럼은 null(서명 없음 — recallLessons가 제외한다). */
  provenance?: string;
  /** 호출 출처 태그(paul-loop 이슈 #35) — memory_op.payload.source로 그대로 남는다. hooks/*.mjs가
   * "node dist/cli.js graduate ..." 하위프로세스를 spawn할 때만 env `LOOP_MEMORY_SOURCE=hook`을 심어
   * cli.ts가 이 값을 채운다. 수동 CLI 호출·테스트는 안 심으므로 생략(undefined) — 생략 시 이 필드는
   * payload에 키 자체가 안 남는다(JSON.stringify가 undefined 값을 드롭), 'cli' 같은 오도하는 기본값으로
   * 채우지 않는다. lessons.ts의 `LessonFile.source`(교훈 파일 자체의 출처, 예: 'loop-fix')와는 무관한
   * 별개 개념 — 혼동 주의. */
  source?: string;
}

export interface RecallHit {
  id: string;
  content: string;
  distance: number;
}

/** pgvector 리터럴 인코딩. recall과 lessons 졸업 recall이 공유하는 단일 출처. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** ADD: 새 노트 + op-log. 임베딩은 Embedder 시맨으로 채운다(사전 계산된 게 있으면 재사용, BAC-368). */
export async function addNote(db: LoopDb, embedder: Embedder, input: NoteInput) {
  const embedding = input.embedding ?? (await embedder.embed(input.content));
  const [note] = await db
    .insert(memoryNote)
    .values({
      content: input.content,
      keywords: input.keywords ?? [],
      tags: input.tags ?? [],
      context: input.context ?? '',
      links: input.links ?? [],
      embedding,
      provenance: input.provenance ?? null,
    })
    .returning();
  if (!note) throw new Error('addNote: insert returned no row');
  // payload에서 embedding은 뺀다 — memory_note.embedding에 이미 저장되니 원장(memory_op)에 큰 벡터를
  // 중복·비대화하지 않는다.
  await db.insert(memoryOp).values({
    op: 'ADD',
    noteId: note.id,
    payload: {
      content: input.content,
      keywords: input.keywords,
      tags: input.tags,
      context: input.context,
      links: input.links,
      source: input.source,
    },
  });
  return note;
}

/** UPDATE: 노트 변경 + op-log. content가 바뀌면 임베딩을 재계산(사전 계산된 게 있으면 재사용, BAC-368). */
export async function updateNote(
  db: LoopDb,
  embedder: Embedder,
  noteId: string,
  patch: Partial<NoteInput>,
) {
  const set: Partial<typeof memoryNote.$inferInsert> = { updatedAt: new Date() };
  if (patch.content !== undefined) {
    set.content = patch.content;
    set.embedding = patch.embedding ?? (await embedder.embed(patch.content));
  }
  if (patch.keywords !== undefined) set.keywords = patch.keywords;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.context !== undefined) set.context = patch.context;
  if (patch.links !== undefined) set.links = patch.links;
  // provenance는 content와 별개로만 갱신한다(호출부 명시 전달 시). content가 바뀌었는데 호출부가 새
  // provenance를 안 넘기면 컬럼은 옛 서명 그대로 남아 — 옛 서명은 새 content와 안 맞으니
  // verifySignature가 자동으로 무효 판정한다(BAC-619, 별도 무효화 로직 불필요).
  if (patch.provenance !== undefined) set.provenance = patch.provenance;
  await db.update(memoryNote).set(set).where(eq(memoryNote.id, noteId));
  // payload에서 embedding은 뺀다(addNote와 동일 이유).
  await db.insert(memoryOp).values({
    op: 'UPDATE',
    noteId,
    payload: {
      content: patch.content,
      keywords: patch.keywords,
      tags: patch.tags,
      context: patch.context,
      links: patch.links,
      source: patch.source,
    },
  });
}

/** DELETE: hard-delete 하지 않는다 — deletedAt만 찍고 op-log에 남긴다(감사). */
export async function softDeleteNote(db: LoopDb, noteId: string, reason?: string) {
  await db
    .update(memoryNote)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(memoryNote.id, noteId));
  await db.insert(memoryOp).values({ op: 'DELETE', noteId, payload: reason ? { reason } : null });
}

/** NOOP: 아무것도 바꾸지 않되 "변경 없음"을 명시적으로 기록한다(Mem0 4-op의 일부). */
export async function noop(db: LoopDb, noteId: string, reason?: string) {
  await db.insert(memoryOp).values({ op: 'NOOP', noteId, payload: reason ? { reason } : null });
}

/** RECALL: 훅이 노트를 실제로 컨텍스트에 주입했음을 기록한다(계측, BAC-586). 노트/임베딩은 안
 *  건드리고 원장(memory_op)에만 이벤트를 남긴다 — recall()의 후보 반환과 달리, 훅의 거리컷오프를
 *  통과해 *실제 주입*된 노트만 이걸 호출해야 사후에 "그 시점 컨텍스트에 실제로 있었는가"를 증명할 수
 *  있다(회상 실패표본 분류 (B): lesson이 있었고 주입됐는데 무시됨). */
export async function recordRecall(
  db: LoopDb,
  noteId: string,
  // source(paul-loop 이슈 #35): NoteInput.source와 같은 개념 — 호출부(cli.ts)가 이미 완성된 payload
  // 객체를 통째로 넘기므로 여기서 별도 병합은 없다. 타입에만 명시해 호출부가 이 필드를 discover하게 한다.
  payload?: Record<string, unknown> & { source?: string },
) {
  await db.insert(memoryOp).values({ op: 'RECALL', noteId, payload: payload ?? null });
}

/** 현재 과제와 의미적으로 가까운 (삭제되지 않은) 노트 top-k. pgvector 코사인 거리. */
export async function recall(
  db: LoopDb,
  embedder: Embedder,
  query: string,
  k = 5,
): Promise<RecallHit[]> {
  const literal = toVectorLiteral(await embedder.embed(query));
  const distance = sql<number>`${memoryNote.embedding} <=> ${literal}::vector`;
  const rows = await db
    .select({ id: memoryNote.id, content: memoryNote.content, distance })
    .from(memoryNote)
    .where(and(isNull(memoryNote.deletedAt), sql`${memoryNote.embedding} is not null`))
    .orderBy(distance)
    .limit(k);
  return rows.map((r) => ({ id: r.id, content: r.content, distance: Number(r.distance) }));
}
