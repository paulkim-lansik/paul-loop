import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { LoopDb } from './client';
import type { Embedder } from './embedding';
import { memoryNote, memoryOp } from './schema/memory';
import { MemoryError, sha256, storeContext, memoryAccess } from './store';
import { verifyNote } from './provenance';
import { sanitizeMemory } from '../hooks/lib/privacy.mjs';

export type MemoryOpKind = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
export interface NoteInput {
  content: string;
  keywords?: string[]; tags?: string[]; context?: string; links?: string[];
  embedding?: number[]; provenance?: string; source?: string;
  corpus?: string; sourceKey?: string;
}
export interface RecallHit { id: string; content: string; distance: number }
export function toVectorLiteral(v: number[]): string {
  if (!v.length || !v.every(Number.isFinite)) throw new MemoryError('embedding_invalid');
  return `[${v.join(',')}]`;
}
export function assertEmbedder(db: LoopDb, embedder: Embedder) {
  const ctx = storeContext(db);
  if (!embedder.identity || embedder.identity !== ctx.embeddingId) throw new MemoryError('embedding_identity_mismatch');
  return ctx;
}
const sourceTag = (source?: string) => source === 'hook' || source === 'cli' ? source : undefined;
/** No content, query, free-text reason, credentials, or paths in the operation ledger. */
const audit = (content: string, source?: string) => ({ content_hash: sha256(content), chars: content.length, source: sourceTag(source) });

export async function addNote(db: LoopDb, embedder: Embedder, input: NoteInput) {
  const ctx = storeContext(db, true); assertEmbedder(db, embedder);
  const content = sanitizeMemory(input.content);
  const embedding = input.embedding ?? await embedder.embed(content);
  if (embedding.length !== embedder.dimensions) throw new MemoryError('embedding_dimensions_mismatch');
  toVectorLiteral(embedding);
  return db.transaction(async tx => {
    const [note] = await tx.insert(memoryNote).values({
      ownerId: ctx.owner, embeddingId: ctx.embeddingId, contentHash: sha256(content),
      corpus: input.corpus ?? 'untrusted', sourceKey: input.sourceKey ?? randomUUID(),
      content, keywords: (input.keywords ?? []).map(k => sanitizeMemory(k, 512)),
      tags: input.tags ?? [], context: sanitizeMemory(input.context ?? ''), links: input.links ?? [],
      embedding, provenance: input.provenance ?? null,
    }).returning();
    if (!note) throw new MemoryError('insert_no_row');
    await tx.insert(memoryOp).values({ op: 'ADD', noteId: note.id, payload: audit(content, input.source) });
    return note;
  });
}

export async function updateNote(db: LoopDb, embedder: Embedder, noteId: string, patch: Partial<NoteInput>) {
  const ctx = storeContext(db, true); assertEmbedder(db, embedder);
  const set: Partial<typeof memoryNote.$inferInsert> = { updatedAt: new Date() };
  if (patch.content !== undefined) {
    set.content = sanitizeMemory(patch.content);
    set.contentHash = sha256(set.content);
    set.embedding = patch.embedding ?? await embedder.embed(set.content);
    if (set.embedding.length !== embedder.dimensions) throw new MemoryError('embedding_dimensions_mismatch');
    toVectorLiteral(set.embedding);
  }
  if (patch.keywords !== undefined) set.keywords = patch.keywords.map(k => sanitizeMemory(k, 512));
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.context !== undefined) set.context = sanitizeMemory(patch.context);
  if (patch.links !== undefined) set.links = patch.links;
  if (patch.corpus !== undefined) set.corpus = patch.corpus;
  if (patch.sourceKey !== undefined) set.sourceKey = patch.sourceKey;
  if (patch.provenance !== undefined) set.provenance = patch.provenance;
  await db.transaction(async tx => {
    const changed = await tx.update(memoryNote).set(set).where(and(eq(memoryNote.id, noteId), eq(memoryNote.ownerId, ctx.owner), isNull(memoryNote.deletedAt))).returning({ id: memoryNote.id });
    if (!changed.length) throw new MemoryError('note_not_owned_or_active');
    await tx.insert(memoryOp).values({ op: 'UPDATE', noteId, payload: set.content === undefined ? { source: sourceTag(patch.source) } : audit(set.content, patch.source) });
  });
}

/** Retain only the tombstone identity/time, not a second permanent copy of removed private text. */
export async function softDeleteNote(db: LoopDb, noteId: string, _reason?: string) {
  const ctx = storeContext(db, true);
  await db.transaction(async tx => {
    const changed = await tx.update(memoryNote).set({ deletedAt: new Date(), updatedAt: new Date(),
      content: '', contentHash: '', embedding: null, provenance: null, context: '', keywords: [], tags: [], links: [],
    }).where(and(eq(memoryNote.id, noteId), eq(memoryNote.ownerId, ctx.owner))).returning({ id: memoryNote.id });
    if (!changed.length) throw new MemoryError('note_not_owned');
    await tx.insert(memoryOp).values({ op: 'DELETE', noteId, payload: { redacted: true } });
  });
}
export async function noop(db: LoopDb, noteId: string, _reason?: string) {
  storeContext(db, true);
  // Unchanged refreshes produce no append-only row: repeated hook invocations must not grow the ledger.
  void noteId;
}
export async function recordRecall(db: LoopDb, noteId: string, payload?: Record<string, unknown> & { source?: string }) {
  memoryAccess(true);
  const ctx = storeContext(db);
  const [note] = await db.select().from(memoryNote).where(and(eq(memoryNote.id, noteId), eq(memoryNote.ownerId, ctx.owner), isNull(memoryNote.deletedAt))).limit(1);
  if (!note || !verifyNote(note, ctx)) throw new MemoryError('recall_note_untrusted');
  await db.insert(memoryOp).values({ op: 'RECALL', noteId, payload: {
    source: sourceTag(payload?.source), corpus: note.corpus,
    distance: typeof payload?.distance === 'number' && Number.isFinite(payload.distance) ? payload.distance : null,
  } });
}
export async function recall(db: LoopDb, embedder: Embedder, query: string, k = 5): Promise<RecallHit[]> {
  const ctx = assertEmbedder(db, embedder);
  const literal = toVectorLiteral(await embedder.embed(sanitizeMemory(query, 2048)));
  const distance = sql<number>`${memoryNote.embedding} <=> ${literal}::vector`;
  const rows = await db.select({ ...memoryNoteColumns(), distance }).from(memoryNote)
    .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.ownerId, ctx.owner), eq(memoryNote.embeddingId, ctx.embeddingId), sql`${memoryNote.embedding} is not null`))
    .orderBy(distance);
  return rows.filter(r => verifyNote(r, ctx)).slice(0, k).map(r => ({ id: r.id, content: sanitizeMemory(r.content), distance: Number(r.distance) }));
}
export function memoryNoteColumns() {
  return { id: memoryNote.id, content: memoryNote.content, contentHash: memoryNote.contentHash,
    ownerId: memoryNote.ownerId, embeddingId: memoryNote.embeddingId, corpus: memoryNote.corpus,
    sourceKey: memoryNote.sourceKey, provenance: memoryNote.provenance, keywords: memoryNote.keywords };
}
