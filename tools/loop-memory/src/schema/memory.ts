import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar, vector } from 'drizzle-orm/pg-core';

/** Owner-scoped derived memory. May hold sensitive development text; not a product tenant store.
 * Scoped retraction scrubs content/vector/metadata and retains a tombstone. Audit payloads are minimal.
 * The store binding is a local guardrail, not RLS or protection against a database administrator. */
export const memoryNote = pgTable(
  'memory_note',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: text('owner_id').notNull().default(''),
    corpus: text('corpus').notNull().default(''),
    sourceKey: text('source_key').notNull().default(''),
    embeddingId: text('embedding_id').notNull().default(''),
    contentHash: text('content_hash').notNull().default(''),
    content: text('content').notNull(),
    keywords: text('keywords').array().notNull().default(sql`'{}'`),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    context: text('context').notNull().default(''),
    // 다른 노트로의 연결(A-MEM의 링크 진화). 보일러플레이트에선 자리만 — 자동 링크생성은 후속.
    links: uuid('links').array().notNull().default(sql`'{}'`),
    // 의미검색용 임베딩. 차원은 Embedder.dimensions와 반드시 일치(기본 384 = all-MiniLM-L6-v2).
    // nullable: 임베더 없이 노트만 먼저 쌓는 경로 허용. recall은 non-null만 본다.
    embedding: vector('embedding', { dimensions: 384 }),
    // Scope-bound HMAC: owner, corpus, source key, embedding identity, full content hash.
    // Unsigned/legacy rows remain representable for migration but never enter trusted recall.
    provenance: text('provenance'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // pgvector HNSW(코사인). recall()의 ORDER BY embedding <=> query 를 가속.
    index('memory_note_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    uniqueIndex('memory_note_owner_source_active_idx').on(t.ownerId, t.corpus, t.sourceKey)
      .where(sql`${t.deletedAt} is null and ${t.sourceKey} <> ''`),
  ],
);

/**
 * Minimal operation history: identities, hashes, lengths, and bounded observation metadata.
 * Unchanged refreshes do not append NOOP rows. Retention of old stores/backups needs separate review.
 */
export const memoryOp = pgTable('memory_op', {
  id: uuid('id').defaultRandom().primaryKey(),
  op: varchar('op', { length: 8 }).notNull(),
  noteId: uuid('note_id').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One DB belongs to one canonical repository and one embedding space. No automatic legacy adoption. */
export const memoryStore = pgTable('memory_store', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  embeddingId: text('embedding_id').notNull(),
});
