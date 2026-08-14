import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid, varchar, vector } from 'drizzle-orm/pg-core';

/**
 * A dev-loop memory note (a *reimplementation* of the A-MEM note schema, not a code port).
 * Lives in its own dedicated DB (loop_memory), deliberately separate from any product database —
 * it holds dev lessons only, never product/tenant data, so it carries no RLS/tenant columns.
 *
 * soft-delete: rows are never hard-deleted, only `deletedAt`-stamped (append-only audit).
 * Every mutation is also recorded in the `memory_op` ledger.
 */
export const memoryNote = pgTable(
  'memory_note',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    content: text('content').notNull(),
    keywords: text('keywords').array().notNull().default(sql`'{}'`),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    context: text('context').notNull().default(''),
    // 다른 노트로의 연결(A-MEM의 링크 진화). 보일러플레이트에선 자리만 — 자동 링크생성은 후속.
    links: uuid('links').array().notNull().default(sql`'{}'`),
    // 의미검색용 임베딩. 차원은 Embedder.dimensions와 반드시 일치(기본 384 = all-MiniLM-L6-v2).
    // nullable: 임베더 없이 노트만 먼저 쌓는 경로 허용. recall은 non-null만 본다.
    embedding: vector('embedding', { dimensions: 384 }),
    // write-path provenance(BAC-619) — HMAC-SHA256(content, LOOP_MEMORY_SIGNING_KEY) hex, lesson 노트만
    // 채운다(src/provenance.ts). nullable: knowledge 코퍼스는 무관 + signing key 미설정 시 서명 없이도
    // 쓰기는 허용(recall이 걸러낸다 — 쓰기를 막지 않고 주입만 막는 fail-closed, README "위협모델" 참고).
    provenance: text('provenance'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // pgvector HNSW(코사인). recall()의 ORDER BY embedding <=> query 를 가속.
    index('memory_note_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/**
 * Mem0 4-op 프로토콜의 append-only 감사 원장. 절대 UPDATE/DELETE 하지 않는다.
 * 어떤 op(ADD/UPDATE/DELETE/NOOP)이 어느 노트에 왜 일어났는지의 불변 기록.
 */
export const memoryOp = pgTable('memory_op', {
  id: uuid('id').defaultRandom().primaryKey(),
  op: varchar('op', { length: 8 }).notNull(),
  noteId: uuid('note_id').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
