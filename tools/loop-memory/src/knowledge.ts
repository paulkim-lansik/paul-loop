import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { LoopDb } from './client';
import type { Embedder } from './embedding';
import { addNote, noop, type RecallHit, softDeleteNote, toVectorLiteral, updateNote } from './ops';
import { memoryNote } from './schema/memory';
import { signNote, verifyNote } from './provenance';
import { storeContext, MemoryError, sha256 } from './store';
import { assertEmbedder, memoryNoteColumns } from './ops';
import { sanitizeMemory } from '../hooks/lib/privacy.mjs';

/**
 * META 지식 코퍼스 → loop-memory 졸업 (ADR-0033).
 *
 * lessons(append-only, 폐기 없음)와 달리 knowledge는 레포 파일의 **파생 미러**다 —
 * SSOT는 레포 문서, pgvector는 파생(design-sync 패턴, ADR-0005·0029). 그래서 lessons의 append-only가
 * 아니라 Mem0 4-op **미러-싱크**(ADD/UPDATE/DELETE/NOOP)로 파일 상태를 따라간다.
 *
 * 안정키 `kb:<source>:<docid>#<section>` + `hash:<sha8>`(keywords)로 재실행을 멱등하게(변경 없으면
 * 전부 NOOP·재임베드 없음) 만들고, 한 섹션만 바뀌면 그 노트만 UPDATE, 섹션이 사라지면 soft-delete 한다.
 */

export interface KnowledgeChunk {
  /** 안정키 — kb:adr:<번호>#<섹션 헤딩>. 원본이 이 키로 노트를 다시 찾는다. */
  key: string;
  /** 코퍼스 판별자 — kb:adr. tag 필터 recall이 이걸로 knowledge를 lessons와 분리한다. */
  tag: string;
  /** 임베딩 대상 텍스트(출처+섹션 헤딩+본문). */
  content: string;
  /** content의 sha8 — 변경 감지(멱등 NOOP vs UPDATE)의 급소. */
  hash: string;
  /** 사람이 읽는 출처(ADR-NNNN: 제목) — recall 결과 가독성. */
  context: string;
}

/** ADR 코퍼스 판별 태그. lessons(tag=lesson)와 분리 recall 하기 위한 네임스페이스. */
export const ADR_TAG = 'kb:adr';
/** CONTEXT.md 용어집 코퍼스 태그(BAC-355) — Framework+Product 2겹 글로서리가 한 네임스페이스로 졸업. */
export const CONTEXT_TAG = 'kb:context';
/** docs/research/* 코퍼스 태그(BAC-355). */
export const RESEARCH_TAG = 'kb:research';
/** docs/product/design/* 코퍼스 태그(BAC-355, 승격된 확정 설계). */
export const DESIGN_TAG = 'kb:design';
/** knowledge recall이 뒤지는 전체 코퍼스 태그 목록 — 새 소스 추가 시 여기 등록하면 recallKnowledge
 * 기본값이 자동 포함한다(호출부 변경 불필요). */
export const KNOWLEDGE_TAGS: string[] = [ADR_TAG, CONTEXT_TAG, RESEARCH_TAG, DESIGN_TAG];

/** 콘텐츠 변경 감지용 짧은 해시. 코퍼스 전체가 공유하는 단일 출처. */
export function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

// 폐기/대체 ADR은 인덱싱 제외(ADR-0033). 상태 *지정자*(선두 토큰)만 본다 — 주석에 "폐기된 ADR-XXXX의
// 후계" 같은 산문이 있어도 오탐하지 않게(0000-template 지정자: 제안됨·승인됨·폐기됨·대체됨).
const SUPERSEDED_RE = /^\**\s*(폐기|대체|superseded|deprecated)/i;
// 서두의 `- **상태**: <값>` 한 줄.
const STATUS_RE = /^(?:-\s*)?\*\*(?:상태|status)\*\*\s*:\s*(.+)$/im;
// 1번째 줄 `# ADR-NNNN: <제목>`.
const TITLE_RE = /^#\s+ADR-\S+:\s*(.+)$/m;
// 정확히 `## ` 섹션 헤딩(### 하위섹션은 매칭 안 됨 → 부모 본문에 흡수).
const SECTION_RE = /^##\s+(.+)$/;

/**
 * ADR 마크다운 한 편을 `##` 섹션 청크로 파싱한다(순수). 폐기 상태면 `[]`.
 * 서두(상태/날짜 목록)는 청크가 아니다 — `##` 섹션만.
 */
export function parseAdrChunks(markdown: string, adrId: string): KnowledgeChunk[] {
  const status = markdown.match(STATUS_RE)?.[1] ?? '';
  if (SUPERSEDED_RE.test(status)) return [];

  const title = markdown.match(TITLE_RE)?.[1]?.trim() ?? '';
  const provenance = `ADR-${adrId}: ${title}`;

  const chunks: KnowledgeChunk[] = [];
  const usedHeadings = new Map<string, number>();
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading === null) return;
    const content = `${provenance} — ${heading}\n\n${body.join('\n').trim()}`;
    chunks.push({
      key: `${ADR_TAG}:${adrId}#${heading}`,
      tag: ADR_TAG,
      content,
      hash: sha8(content),
      context: provenance,
    });
  };

  for (const line of markdown.split('\n')) {
    const m = line.match(SECTION_RE);
    if (m?.[1]) {
      flush();
      // 같은 ADR 안 중복 헤딩은 키 충돌 → 카운터 접미로 유일화(미러-싱크 수렴성 보장).
      const raw = m[1].trim();
      const n = (usedHeadings.get(raw) ?? 0) + 1;
      usedHeadings.set(raw, n);
      heading = n === 1 ? raw : `${raw} (${n})`;
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

// ── S3 신규 소스(BAC-355): CONTEXT.md·docs/research·docs/product/design ─────────────────────────
// parseAdrChunks는 건드리지 않는다(이미 프로덕션에서 도는 파서 — 재검증 위험 없이 신규 소스만 위에 얹는다).

/**
 * `##` 섹션 청킹의 범용판(parseAdrChunks와 같은 알고리즘, ADR 전용 상태체크·제목 정규식 없음) —
 * research/design처럼 "폐기" 개념이 없는 문서군에 재사용. 같은 문서 안 중복 헤딩은 카운터 접미로
 * 유일화(미러-싱크 수렴성).
 */
function chunkByH2(
  markdown: string,
  tag: string,
  keyPrefix: string,
  provenance: string,
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const usedHeadings = new Map<string, number>();
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading === null) return;
    const content = `${provenance} — ${heading}\n\n${body.join('\n').trim()}`;
    chunks.push({
      key: `${keyPrefix}#${heading}`,
      tag,
      content,
      hash: sha8(content),
      context: provenance,
    });
  };

  for (const line of markdown.split('\n')) {
    const m = line.match(SECTION_RE);
    if (m?.[1]) {
      flush();
      const raw = m[1].trim();
      const n = (usedHeadings.get(raw) ?? 0) + 1;
      usedHeadings.set(raw, n);
      heading = n === 1 ? raw : `${raw} (${n})`;
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

const DOC_TITLE_RE = /^#\s+(.+)$/m;

/**
 * research/design 공용 파서(BAC-355) — 문서 H1 제목을 provenance로 삼고 `##` 섹션 단위로 청킹한다.
 * ADR류 "폐기" 상태 개념이 없는 문서군(리서치·확정설계)에 쓴다. `sourceLabel`은 사람이 읽는 출처 접두
 * (예: `docs/research/2026-06-30-loop-carry-forward.md`).
 */
export function parseMarkdownChunks(
  markdown: string,
  tag: string,
  docId: string,
  sourceLabel: string,
): KnowledgeChunk[] {
  const title = markdown.match(DOC_TITLE_RE)?.[1]?.trim() ?? docId;
  const provenance = `${sourceLabel}: ${title}`;
  return chunkByH2(markdown, tag, `${tag}:${docId}`, provenance);
}

// CONTEXT.md는 `##`/`###` 헤딩이 계층 라벨(Framework/Product + 하위도메인)이고, 그 *안*의 각
// `**용어**:` 단락이 개별 청크다 — 섹션 전체가 아니라 용어 단위 recall이 목표(BAC-355 AC).
const CONTEXT_HEADING_RE = /^(#{2,3})\s+(.+)$/;
// 굵게 처리된 용어 헤더 줄 — `**Framework** (하네스 / Harness):`·`**병원 / Hospital**:` 둘 다 매칭.
// 괄호 별칭은 optional, 그 뒤 콜론이 있어야 "용어 정의 시작" 줄로 인정(그냥 굵은 글씨 강조와 구분).
const CONTEXT_TERM_RE = /^\*\*([^*]+)\*\*\s*(?:\([^)]*\))?\s*:/;

/**
 * CONTEXT.md 글로서리를 `**용어**:` 단위로 청킹한다(BAC-355) — 퍼지 동의어 질의가 섹션 전체가 아니라
 * 정본 용어 한 항목을 건지도록. 헤딩(`##`/`###`) 직후 용어 정의가 시작되기 전의 프리앰블 프로즈(문서
 * 서두 소개문 등)는 어느 용어에도 안 속해 제외된다. 같은 헤딩 안 중복 용어명은 카운터 접미로 유일화.
 */
export function parseContextChunks(markdown: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const usedKeys = new Map<string, number>();
  let section: string | null = null;
  let term: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (term === null || section === null) return;
    const context = `CONTEXT.md — ${section}`;
    const content = `${context} — **${term}**\n\n${body.join('\n').trim()}`;
    const rawKey = `${section}:${term}`;
    const n = (usedKeys.get(rawKey) ?? 0) + 1;
    usedKeys.set(rawKey, n);
    const key = `${CONTEXT_TAG}:${rawKey}${n === 1 ? '' : ` (${n})`}`;
    chunks.push({ key, tag: CONTEXT_TAG, content, hash: sha8(content), context });
  };

  for (const line of markdown.split('\n')) {
    const h = line.match(CONTEXT_HEADING_RE);
    if (h?.[2]) {
      flush();
      section = h[2].trim();
      term = null;
      body = [];
      continue;
    }
    const t = line.match(CONTEXT_TERM_RE);
    if (t?.[1] && section !== null) {
      flush();
      term = t[1].trim();
      body = [line];
      continue;
    }
    if (term !== null) body.push(line);
  }
  flush();
  return chunks;
}

export interface KnowledgeSyncResult {
  incomplete?: true;
  added: number;
  updated: number;
  deleted: number;
  noop: number;
  /** true면 동시 졸업 잠금을 못 얻어 이번 실행은 아무 것도 안 하고 skip했다(BAC-367) — 나머지 카운트는
   * 전부 0. "이미 최신"과 구분해야 해서(silent truncation 금지, BAC-355) 명시 필드로 드러낸다. */
  locked?: true;
}

const HASH_PREFIX = 'hash:';
const opaqueKey = (tag: string, key: string) => `${tag}:${sha256(key)}`;
const noteKeywords = (chunk: KnowledgeChunk): string[] => [
  chunk.key,
  `${HASH_PREFIX}${chunk.hash}`,
];

// 동시 졸업 가드(BAC-367) — 이 저장소는 상시 동시 세션(CLAUDE.md §8). 여러 SessionStart가 동시에
// 같은 tag를 미수렴 상태에서 졸업하면, 둘 다 stored를 "없음"으로 읽고 각자 addNote(ON CONFLICT 없는
// 순수 INSERT)해 중복 노트가 영구 잔류한다(DELETE 패스는 desired에 없는 키만 지우니 중복은 안 지워짐).
//
// 세션-스코프 advisory lock(pg_try_advisory_lock/pg_advisory_unlock, 트랜잭션-스코프 아님)을 골랐다 —
// 리뷰(PR #39, code-reviewer+silent-failure-hunter 둘 다 독립적으로 지적)에서 처음엔 xact-스코프로
// db.transaction() 전체를 감쌌는데, 그러면 이 함수 전체(배치 임베드 외부 API 호출 포함, 실측 13.8s)가
// 하나의 원자적 트랜잭션이 돼 SessionStart 훅의 12s 타임아웃(graduate-lessons.mjs, ADR-0033 §6)에 걸려
// SIGTERM되면 그때까지의 ADD/UPDATE/DELETE가 통째로 롤백됐다 — "노트별 개별 커밋 → 세션마다 증분 수렴"
// 이라는 기존 설계 계약을 깨는 회귀였다(리뷰가 실측 숫자로 지적). 세션-스코프 락은 트랜잭션에 안 묶여서
// 노트별 auto-commit을 그대로 두고도(증분 수렴 유지) 함수 전체 동안 락을 쥘 수 있다 — pool에서 커넥션
// 하나를 명시로 checkout해 락 획득/해제를 그 커넥션에 고정한다(세션-스코프 락은 커넥션에 묶이므로).
// 연결 종료(크래시 포함) 시 postgres가 자동 해제 — 죽은 세션이 락을 영구히 쥘 위험은 여전히 없다.
// 네임스페이스 상수는 이 락 용도만 표시하는 임의값 — 다른 advisory lock 용처와 안 겹치게 하려는
// 목적뿐, 값 자체는 무의미.
// export: 결정적 동시성 테스트가 별도 커넥션에서 같은 잠금을 직접 선점해야 한다(advisory-lock 단정).
export const LOCK_NAMESPACE = 0x6b6e6c67;

/**
 * 미러-싱크: 한 `tag` 네임스페이스의 삭제 안 된 노트를 `desired` 청크 상태로 수렴시킨다(Mem0 4-op).
 * 키 없음 → ADD · 해시 동일 → NOOP(재임베드 skip) · 해시 변경 → UPDATE(재임베드) · desired에 없는 저장키 → DELETE(soft).
 * 모든 op은 `memory_op` 원장에 남는다(ops.ts가 자동 기록).
 *
 * ⚠️ `tag` 네임스페이스 *전체*를 수렴시킨다 — 그 tag의 desired에 없는 노트는 soft-delete된다.
 * 그래서 폐기 ADR(parseAdrChunks가 []를 냄)의 섹션은 다음 graduate에서 자동 소멸한다.
 *
 * 배치 임베딩(BAC-368): ADD/UPDATE 대상을 먼저 전부 분류(임베드 없이)한 뒤, 그 content를 한 번에
 * embedBatch()로 임베드하고 나서야 실제로 쓴다 — 청크당 API round-trip이던 걸 배치 수만큼으로 줄인다
 * (실측 BAC-354: 직렬 224청크 ~97s → 배치는 초 단위). NOOP 대상은 여전히 임베드 자체를 안 한다.
 *
 * 동시 졸업 가드(BAC-367): 함수 진입 시 세션-스코프 advisory lock을 걸고(획득 실패 시 즉시 skip),
 * 이후 쓰기는 여전히 노트별 개별 auto-commit(트랜잭션으로 안 묶음) — 12s SessionStart 타임아웃에
 * 잘려도 그때까지 커밋된 노트는 살아남아 다음 세션이 이어받는다(기존 증분 수렴 설계 유지).
 *
 * 호출 출처 태그(paul-loop 이슈 #35): `source`가 있으면 ADD/UPDATE하는 memory_op 행의 `payload.source`로
 * 남는다(ops.ts의 NoteInput.source 참고) — graduateKnowledge/graduateContext/graduateMarkdownDir이
 * 그대로 흘려보낸다. NOOP/DELETE는 ops.ts 범위 밖(addNote/updateNote/recordRecall만 payload.source를
 * 지원) — 그대로 둔다.
 */
export async function syncKnowledge(
  db: LoopDb,
  pool: Pool,
  embedder: Embedder,
  tag: string,
  desiredSource: KnowledgeChunk[] | (() => KnowledgeChunk[] | null),
  source?: string,
): Promise<KnowledgeSyncResult> {
  const ctx = storeContext(db, true);
  assertEmbedder(db, embedder);
  if (!/^kb:[a-zA-Z0-9_:-]+$/.test(tag)) throw new MemoryError('knowledge_source_invalid');
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1, hashtext($2)) as locked',
      [LOCK_NAMESPACE, tag],
    );
    if (lock.rows.length !== 1) {
      // select <스칼라> as locked는 정상 동작이면 항상 정확히 1행 — 0/2+행은 드라이버 이상이지
      // "다른 세션이 쥠"과 같은 결과가 아니다. 조용히 skip으로 뭉개지 않고 명확한 에러로 드러낸다.
      throw new Error(`syncKnowledge: pg_try_advisory_lock returned ${lock.rows.length} rows`);
    }
    if (!lock.rows[0]?.locked) {
      return { added: 0, updated: 0, deleted: 0, noop: 0, locked: true };
    }

    try {
      // Filesystem adapters pass a reader, never a pre-lock snapshot. Arrays remain an explicit
      // caller-supplied snapshot API; they do not establish freshness of an external source.
      const snapshot = typeof desiredSource === 'function' ? desiredSource() : desiredSource;
      if (snapshot === null) return { added: 0, updated: 0, deleted: 0, noop: 0, incomplete: true };
      if (snapshot.some(c => c.tag !== tag) || new Set(snapshot.map(c => c.key)).size !== snapshot.length) throw new MemoryError('knowledge_source_invalid');
      const desired = snapshot.map(c => { const content = sanitizeMemory(c.content); return { ...c, content, hash: sha256(content) }; });
      const stored = await db
        .select(memoryNoteColumns())
        .from(memoryNote)
        .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.corpus, tag), eq(memoryNote.ownerId, ctx.owner)));

      const byKey = new Map<string, { id: string; hash: string; valid: boolean }>();
      for (const n of stored) {
        const key = n.sourceKey;
        const hash = n.contentHash;
        if (key) byKey.set(key, { id: n.id, hash, valid: verifyNote(n, ctx) });
      }

      const result: KnowledgeSyncResult = { added: 0, updated: 0, deleted: 0, noop: 0 };
      const desiredKeys = new Set<string>();

      // 1차 패스: 임베드 없이 분류만 — ADD/UPDATE 대상 content를 모아 한 번에 배치 임베드하기 위해.
      const toAdd: KnowledgeChunk[] = [];
      const toUpdate: Array<{ chunk: KnowledgeChunk; noteId: string }> = [];
      const toNoop: string[] = [];

      for (const chunk of desired) {
        desiredKeys.add(opaqueKey(tag, chunk.key));
        const existing = byKey.get(opaqueKey(tag, chunk.key));
        if (!existing) {
          toAdd.push(chunk);
        } else if (existing.hash === chunk.hash && existing.valid) {
          toNoop.push(existing.id);
        } else {
          toUpdate.push({ chunk, noteId: existing.id });
        }
      }

      // 2차: ADD+UPDATE content를 한 번에 배치 임베드. 순서를 그대로 유지해야 아래 3차에서 인덱스로
      // 정확히 매칭된다(오매칭 = 엉뚱한 청크에 엉뚱한 벡터가 붙는 조용한 손상 — embedBatch 구현체가 이미
      // 순서/개수를 보장하도록 계약돼 있다, embedding-api.ts).
      const embedTargets = [
        ...toAdd.map((c) => c.content),
        ...toUpdate.map((u) => u.chunk.content),
      ];
      const embeddings = embedTargets.length > 0 ? await embedder.embedBatch(embedTargets) : [];
      if (embeddings.length !== embedTargets.length) throw new MemoryError('embedding_batch_count_mismatch');
      for (const v of embeddings) {
        if (v.length !== embedder.dimensions) throw new MemoryError('embedding_dimensions_mismatch');
        toVectorLiteral(v);
      }

      // 3차: 실제 쓰기 — 사전 계산된 임베딩을 넘겨 addNote/updateNote가 재임베드하지 않게(ops.ts).
      // 노트별 개별 auto-commit(트랜잭션 아님) — 12s 타임아웃에 잘려도 그때까지 커밋분은 살아남는다.
      let ei = 0;
      for (const chunk of toAdd) {
        await addNote(db, embedder, {
          content: chunk.content,
          keywords: noteKeywords(chunk),
          // 수렴 대상 네임스페이스(tag)로 저장 — chunk.tag가 아니라 tag로 불변식을 구조적으로 보장.
          tags: [tag], corpus: tag, sourceKey: opaqueKey(tag, chunk.key),
          provenance: signNote(chunk.content, tag, opaqueKey(tag, chunk.key), ctx),
          context: chunk.context,
          embedding: embeddings[ei++],
          source,
        });
        result.added++;
      }
      for (const { chunk, noteId } of toUpdate) {
        await updateNote(db, embedder, noteId, {
          content: chunk.content,
          provenance: signNote(chunk.content, tag, opaqueKey(tag, chunk.key), ctx),
          keywords: noteKeywords(chunk),
          context: chunk.context,
          embedding: embeddings[ei++],
          source,
        });
        result.updated++;
      }
      for (const noteId of toNoop) {
        await noop(db, noteId, 'unchanged');
        result.noop++;
      }

      for (const [key, { id }] of byKey) {
        if (!desiredKeys.has(key)) {
          await softDeleteNote(db, id, 'source section removed');
          result.deleted++;
        }
      }

      return result;
    } finally {
      await client.query('select pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE, tag]);
    }
  } finally {
    client.release();
  }
}

// 파싱 제외: 템플릿·인덱스.
function sourceText(path: string): string {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new MemoryError('source_symlink');
  return readFileSync(path, 'utf8');
}
function validateParsed(text: string, chunks: KnowledgeChunk[], retired = false) {
  if (!chunks.length && text.trim() && !retired && !text.includes('<!-- loop-memory: empty -->')) throw new MemoryError('source_format_unrecognized');
  return chunks;
}

const SKIP_FILES = new Set(['0000-template.md', 'README.md']);

/**
 * ADR 디렉토리 → 파싱 → 미러-싱크. 파일명 앞 숫자를 ADR 번호로, 폐기본은 parseAdrChunks가 []를 내
 * desired에서 빠지므로 다음 실행에서 soft-delete된다. `kb:adr` 태그 네임스페이스 전체를 수렴시킨다.
 */
export async function graduateKnowledge(
  db: LoopDb,
  pool: Pool,
  embedder: Embedder,
  adrDir: string,
  source?: string,
): Promise<KnowledgeSyncResult> {
  storeContext(db, true);
  return syncKnowledge(db, pool, embedder, ADR_TAG, () => {
    const desired: KnowledgeChunk[] = [];
    const files = readdirSync(adrDir);
    let parsed = 0;
    for (const f of files) {
      if (!f.endsWith('.md') || SKIP_FILES.has(f)) continue;
      const adrId = f.match(/^(\d+)/)?.[1];
      if (!adrId) continue;
      parsed++;
      const text = sourceText(join(adrDir, f));
      desired.push(...validateParsed(text, parseAdrChunks(text, adrId), SUPERSEDED_RE.test(text.match(STATUS_RE)?.[1] ?? '')));
    }
    if (files.length && !parsed) return null;
    // A parsed empty authoritative snapshot retracts its owner-scoped corpus.
    return desired;
  }, source);
}

/**
 * CONTEXT.md(단일 파일) → 파싱 → 미러-싱크(BAC-355). 빈-결과 가드는 graduateKnowledge와 동일 이유
 * (파싱이 깨지면 desired=[]가 되어 전체 kb:context 코퍼스가 soft-delete될 수 있어 — 실 CONTEXT.md는
 * 항상 용어를 낸다).
 */
export async function graduateContext(
  db: LoopDb,
  pool: Pool,
  embedder: Embedder,
  contextPath: string,
  source?: string,
): Promise<KnowledgeSyncResult> {
  storeContext(db, true);
  return syncKnowledge(db, pool, embedder, CONTEXT_TAG, () => {
    const text = sourceText(contextPath);
    return validateParsed(text, parseContextChunks(text));
  }, source);
}

export interface GraduateMarkdownDirResult extends KnowledgeSyncResult {
  /** .md가 아니라 건너뛴 항목 — 조용히 드롭하지 않는다(BAC-355 AC), 사유 포함. */
  skipped: { file: string; reason: string }[];
}

/**
 * docs/research·docs/product/design 공용(BAC-355) — 디렉토리의 `.md`를 전부 `parseMarkdownChunks`로
 * 청킹해 미러-싱크. `.md`가 아닌 항목(예: HTML 리포트)은 조용히 넘기지 않고 `skipped`에 사유와 함께
 * 담아 반환 — 호출자(CLI)가 로그로 드러낼 수 있게(silent truncation 금지).
 */
export async function graduateMarkdownDir(
  db: LoopDb,
  pool: Pool,
  embedder: Embedder,
  dir: string,
  tag: string,
  sourceLabel: string,
  // 호출 출처 태그(paul-loop 이슈 #35, syncKnowledge 참고) — `sourceLabel`(사람이 읽는 문서 출처 접두)과는
  // 무관한 별개 파라미터. 이름 충돌에 주의.
  source?: string,
): Promise<GraduateMarkdownDirResult> {
  storeContext(db, true);
  const skipped: { file: string; reason: string }[] = [];
  const result = await syncKnowledge(db, pool, embedder, tag, () => {
    const desired: KnowledgeChunk[] = [];
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.')) continue; // 진짜 숨김파일(.gitkeep 등) — 소스 후보조차 아님, 스킵 사유 불필요
      if (!f.endsWith('.md')) {
        const reason = f.toLowerCase().endsWith('.html')
          ? 'HTML — 텍스트 추출 미구현(BAC-355 범위: 명시 제외)'
          : '.md 아님(미지원 확장자)';
        skipped.push({ file: f, reason });
        continue;
      }
      const docId = f.replace(/\.md$/, '');
      const text = sourceText(join(dir, f));
      desired.push(...validateParsed(text, parseMarkdownChunks(text, tag, docId, `${sourceLabel}/${f}`)));
    }
    if (!desired.length && skipped.length) return null;
    // Missing paths throw; a present empty directory is an authoritative empty snapshot.
    return desired;
  }, source);
  return { ...result, skipped };
}

/**
 * 현재 프롬프트와 의미적으로 가까운 *knowledge* 노트 top-k. lessons와 분리된 코퍼스(tag 필터, ADR-0033).
 * 기본값은 KNOWLEDGE_TAGS 전체(BAC-355 — ADR+CONTEXT+research+design을 한 번에 recall). 특정 소스만
 * 보고 싶으면 단일 태그(문자열) 또는 부분집합(배열)을 넘긴다 — 하위호환: 기존 호출부가 단일 문자열
 * 태그를 넘기던 관례를 그대로 받는다.
 * (S2가 이걸 recall 훅에 결선한다 — lessons k=3 + knowledge k=3, 각자 거리컷오프.)
 */
export async function recallKnowledge(
  db: LoopDb,
  embedder: Embedder,
  query: string,
  k = 5,
  tags: string | string[] = KNOWLEDGE_TAGS,
): Promise<RecallHit[]> {
  const ctx = assertEmbedder(db, embedder);
  const literal = toVectorLiteral(await embedder.embed(sanitizeMemory(query, 2048)));
  const distance = sql<number>`${memoryNote.embedding} <=> ${literal}::vector`;
  const tagList = Array.isArray(tags) ? tags : [tags];
  if (tagList.length === 0) return [];
  const tagFilter = or(...tagList.map(t => eq(memoryNote.corpus, t)));
  const rows = await db.select({ ...memoryNoteColumns(), distance }).from(memoryNote)
    .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.ownerId, ctx.owner), eq(memoryNote.embeddingId, ctx.embeddingId), sql`${memoryNote.embedding} is not null`, tagFilter))
    .orderBy(distance);
  return rows.filter(r => verifyNote(r, ctx)).slice(0, k)
    .map(r => ({ id: r.id, content: sanitizeMemory(r.content), distance: Number(r.distance) }));
}
