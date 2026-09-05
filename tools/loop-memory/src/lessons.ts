import { lstatSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { LoopDb } from './client';
import type { Embedder } from './embedding';
import { LOCK_NAMESPACE } from './knowledge';
import { addNote, type RecallHit, softDeleteNote, toVectorLiteral, updateNote } from './ops';
import { signNote, verifyNote } from './provenance';
import { MemoryError, storeContext } from './store';
import { assertEmbedder, memoryNoteColumns } from './ops';
import { sanitizeMemory } from '../hooks/lib/privacy.mjs';
import { lessonState } from '../../loop-engine/lib/lesson-state.mjs';
import { memoryNote } from './schema/memory';

/**
 * lessons ↔ loop-memory 졸업(graduation) 어댑터.
 *
 * loop-engine의 파일 기반 `lessons`(`.loop/lessons/<key>.json`, OUTER 루프 v0)는 *정확한* 실패
 * 시그니처 해시로만 recall한다 → 비슷하지만 똑같지 않은 실패는 과거 수정을 놓친다. 이 어댑터는
 * **검증된** 교훈만 의미검색 층(loop-memory)으로 올려, 유사 실패도 의미로 건지게 한다.
 *
 * 공존 모델(ADR-0023): lessons 파일은 그대로 정전(canonical) v0로 두고, 여기서는 *복제*만 한다.
 * 파일 쪽 퇴역(retire)/기각(challenge --verdict reject) 판정도 이 복제로 미러링된다(BAC-580) —
 * 안 그러면 승격 게이트(promote/challenge/retire)가 파일 계층에서만 의미를 갖고 실제 회상(recall)
 * 경로에는 효력이 없어, retired·reject된(현행 CLAUDE.md와 정반대인 경우 포함) 교훈이 계속 주입된다.
 */

/** `.loop/lessons/<key>.json` 한 건에서 신뢰 가능한 부분. lessons.mjs의 coerce 원칙과 같다. */
export interface LessonFile {
  id: string;
  title: string;
  fix: string;
  source: string;
  signature: string[];
  /** lessons.mjs가 유지하는 top-level 재발 횟수(`count`). decay 랭킹(아래 decayedScore)이 "자주 재발하는
   *  교훈은 오래돼도 덜 감쇠"에 쓴다. 파일에 없거나 손상돼 있으면 0(정보 없음 = 반감기 가산 없음 —
   *  decayedScore 쪽에서 이 기본값이 "감쇠 완화 없음"으로 자연히 처리된다). */
  count: number;
  /** lessons.mjs가 유지하는 top-level `last_seen`(ISO8601). 파일에 없거나 손상돼 있으면 빈 문자열
   *  (decayedScore가 "정보 없음 = age 0(페널티 없음)"으로 처리 — fail-open: 모르는 걸 벌하지 않는다). */
  lastSeen: string;
}

/**
 * `LessonFile` + 졸업 판단에 필요한 상태(퇴역/기각). `readVerifiedLessons`(ADD 대상 필터)와
 * `decideLessonReap`(이미 졸업된 노트의 회수 판단)가 공유하는 단일 파서의 산출물 — 두 판단이 서로
 * 다른 정의로 갈리지 않게 한다.
 */
export interface LessonRecord extends LessonFile {
  verified: boolean;
  invalidated: boolean;
  /** 회의적 평가가 명시적으로 기각(challenge.verdict === 'reject') — 영구 배제, 코디파이 위치가
   *  없으므로 스텁도 남기지 않는다(아래 decideLessonReap). */
  rejected: boolean;
  /** 퇴역(코디파이 완료) 여부. lessons.mjs의 coerce 규칙과 동일(fail-closed, lessons.mjs 약 182-187행
   *  참고): retired는 object이고 `.at`이 비지 않은 문자열일 때만 유효 — 손상/수기편집 필드가 조용히
   *  퇴역시키지 못하게. */
  retired: boolean;
  /** retired일 때 코디파이 위치(예: "CLAUDE.md §8"). `lessons retire --ref`가 비어있을 수 있어(옵션),
   *  그 경우 빈 문자열. */
  retiredRef: string;
}

/** lesson 코퍼스 판별 태그이자 동시 졸업 잠금 키(BAC-372) — knowledge.ts의 `kb:*` 태그들과 나란히 export. */
export const LESSON_TAG = 'lesson';
const LESSON_KEY_PREFIX = 'lesson:';
const lessonKey = (id: string) => `${LESSON_KEY_PREFIX}${id}`;

/** ADD 대상 여부 — 검증됐고, 기각되지 않았고, 퇴역하지 않은 교훈만 졸업 자격이 있다. */
function isGraduationEligible(l: LessonRecord): boolean {
  return l.verified && !l.invalidated && !l.rejected && !l.retired;
}

/**
 * `.loop/lessons/<id>.json` 전부를 판정 상태(verified/rejected/retired)까지 포함해 읽는다.
 * 손상/수기편집 파일은 조용히 건너뛴다(코어를 오도하지 못함, lessons.mjs와 동일). 내부 전용이 아니라
 * export하는 이유: `graduateLessons`(회수 패스)와 테스트가 같은 파서를 공유해야 판정이 갈리지 않는다.
 */
export function readLessonRecords(dir: string, options: { root?: string } = {}): LessonRecord[] {
  if (!existsSync(dir)) return [];
  const out: LessonRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    if (!lstatSync(join(dir, f)).isFile() || lstatSync(join(dir, f)).isSymbolicLink()) throw new MemoryError('source_symlink');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as Record<string, unknown>;
    if (typeof l.id !== 'string' || !l.id) continue;
    const state = lessonState(l, options);
    const challenge =
      l.challenge && typeof l.challenge === 'object'
        ? (l.challenge as Record<string, unknown>)
        : null;
    const retiredRaw =
      l.retired && typeof l.retired === 'object' ? (l.retired as Record<string, unknown>) : null;
    const retired = !!(retiredRaw && typeof retiredRaw.at === 'string' && retiredRaw.at);
    out.push({
      id: l.id,
      title: typeof l.title === 'string' ? l.title : '',
      fix: typeof l.fix === 'string' ? l.fix : '',
      source: typeof l.source === 'string' && l.source ? l.source : 'manual',
      signature: Array.isArray(l.signature)
        ? l.signature.filter((s): s is string => typeof s === 'string')
        : [],
      // count/last_seen: lessons.mjs와 동일한 fail-closed coerce(§166-168 참고) — 손상/수기편집 필드가
      // 조용히 decay 계산을 오염시키지 못하게.
      count: Number.isInteger(l.count) && (l.count as number) >= 0 ? (l.count as number) : 0,
      lastSeen: typeof l.last_seen === 'string' ? l.last_seen : '',
      verified: state.verified,
      invalidated: state.invalidated,
      rejected: challenge?.verdict === 'reject',
      retired,
      retiredRef: retired && typeof retiredRaw?.ref === 'string' ? retiredRaw.ref : '',
    });
  }
  return out;
}

/**
 * verified 교훈만 골라 읽는다. **검증기만이 교훈을 정한다** — 졸업도 `verified === true`만.
 * BAC-580: `retired`(코디파이 완료)와 `challenge.verdict === 'reject'`(명시적 기각)도 제외한다 —
 * 둘 다 "더 이상 주입돼선 안 되는" 상태이고, 이전엔 이 필터가 `verified`만 봐서 승격 게이트
 * (promote/challenge/retire)가 회상 경로엔 효력이 없었다.
 */
export function readVerifiedLessons(dir: string, options: { root?: string } = {}): LessonFile[] {
  return readLessonRecords(dir, options)
    .filter(isGraduationEligible)
    .map(({ id, title, fix, source, signature, count, lastSeen }) => ({
      id,
      title,
      fix,
      source,
      signature,
      count,
      lastSeen,
    }));
}

/** 교훈 → 임베딩 대상 텍스트. 실패의 *의미*와 고친 방법을 함께 담아 의미검색이 걸리게 한다. */
export function lessonContent(l: LessonFile): string {
  return sanitizeMemory([l.title, l.fix ? `fix: ${l.fix}` : '', l.signature.join(' | ')]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n'));
}

/**
 * 퇴역(코디파이 완료) 교훈의 대체 콘텐츠 — 원 fix/시그니처 대신 코디파이 위치만 가리킨다.
 *
 * 선택 근거(BAC-580 AC — 완전 회수 대신 스텁을 고른 이유): 완전히 soft-delete하면 "이미 다뤄졌다"는
 * 신호 자체가 사라진다. lessons 파일 계층의 dedup은 *정확한* 실패 시그니처 해시만 보므로(lessons.mjs),
 * 훗날 의미적으로는 비슷하지만 다른 표현의 실패가 다시 "새 교훈"으로 기록·재검증되는 낭비가 생긴다.
 * 스텁은 recall 가능성(같은 실패가 다시 질의될 때 여전히 걸림)은 유지하되, 주입되는 *본문*을 "원문
 * 참조"로 좁혀 스테일하거나 현행 CLAUDE.md와 상충하는 콘텐츠(이 이슈가 발견한 실사례 — origin/main
 * 기준 워크트리 생성 지시 등)가 다시 주입되는 걸 막는다.
 * reject(코디파이 안 됨 — 애초에 가리킬 위치가 없음)는 스텁 없이 완전 회수한다(decideLessonReap).
 */
export function lessonStub(l: Pick<LessonFile, 'id' | 'title'>, ref: string): string {
  const where = ref || '(위치 미기록)';
  return sanitizeMemory(`[퇴역] ${l.title}\n이미 ${where}로 코디파이됨 — 원문 참조. (원 교훈 id: ${l.id})`);
}

export type LessonReapDecision =
  | { op: 'keep' }
  | { op: 'stub'; content: string }
  | { op: 'purge'; reason: string };

/**
 * 이미 졸업된 노트 하나를 현재 파일 상태와 대조해 미러-싱크 결정을 낸다(순수 함수 — ADR-0042/§5
 * 함수형 코어 추출: "이미 읽어온 데이터에 대한 결정"이 여기 있고, 그 결정의 실행(DB I/O)은
 * `graduateLessons`의 얇은 shell이 맡는다). `rec`은 `readLessonRecords`가 파일에서 읽은 현재 상태 —
 * 해당 id의 파일을 이번 호출이 못 봤으면(다른 디렉터리를 가리켰거나, 부분/빈 디렉터리로 호출됐거나)
 * `undefined`.
 *
 * This pure decision helper preserves undefined for compatibility. The owner-bound authoritative
 * snapshot adapter treats a missing source as retraction after validating the source directory.
 */
export function decideLessonReap(
  currentContent: string,
  rec: LessonRecord | undefined,
): LessonReapDecision {
  if (!rec) return { op: 'keep' };
  if (rec.invalidated) return { op: 'purge', reason: 'invalidated' };
  if (!rec.verified) return { op: 'purge', reason: 'verification retracted or legacy' };
  if (rec.rejected) return { op: 'purge', reason: 'challenge verdict=reject' };
  if (rec.retired) {
    const desired = lessonStub(rec, rec.retiredRef);
    return currentContent === desired ? { op: 'keep' } : { op: 'stub', content: desired };
  }
  return { op: 'keep' };
}

export interface GraduateResult {
  added: number;
  updated: number;
  skipped: number;
  /** 이미 졸업된 노트 중 퇴역으로 판정돼 스텁 콘텐츠로 대체(UPDATE, 재임베드)한 건수(BAC-580). */
  stubbed: number;
  /** 이미 졸업된 노트 중 회수(soft-delete)한 건수 — challenge.verdict === 'reject'로 판정(BAC-580). */
  purged: number;
  /** true면 동시 졸업 잠금을 못 얻어 이번 실행은 아무 것도 안 하고 skip했다(BAC-372, syncKnowledge의
   * KnowledgeSyncResult.locked와 대칭) — 나머지 카운트는 전부 0. */
  locked?: true;
}

/** Mirror one authoritative owner-scoped lesson snapshot. Content changes and key rotation update
 * existing rows; invalidated/retracted/rejected/missing sources are scrubbed, retired sources become
 * authenticated stubs. A session advisory lock serializes synchronization, while each note+op commits
 * atomically so an interrupted refresh can resume. Signing is mandatory. */
export async function graduateLessons(
  db: LoopDb,
  pool: Pool,
  embedder: Embedder,
  dir: string,
  signingKey: string | undefined,
  source?: string,
): Promise<GraduateResult> {
  const ctx = storeContext(db, true);
  assertEmbedder(db, embedder);
  if (!signingKey || signingKey !== ctx.signingKey) throw new MemoryError('signing_key_mismatch');
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1, hashtext($2)) as locked',
      [LOCK_NAMESPACE, LESSON_TAG],
    );
    if (lock.rows.length !== 1) {
      // select <스칼라> as locked는 정상 동작이면 항상 정확히 1행 — 0/2+행은 드라이버 이상이지
      // "다른 세션이 쥠"과 같은 결과가 아니다. 조용히 skip으로 뭉개지 않고 명확한 에러로 드러낸다
      // (knowledge.ts의 syncKnowledge와 동일한 판단).
      throw new Error(`graduateLessons: pg_try_advisory_lock returned ${lock.rows.length} rows`);
    }
    if (!lock.rows[0]?.locked) {
      return { added: 0, updated: 0, skipped: 0, stubbed: 0, purged: 0, locked: true };
    }
    try {
      // Snapshot only after serialization: a delayed connection must not replay source state read
      // before another graduation completed a retraction.
      if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new MemoryError('lesson_source_missing');
      const records = readLessonRecords(dir, { root: ctx.canonical || process.cwd() });
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const l of records.filter(isGraduationEligible)) {
        const key = lessonKey(l.id);
        const content = lessonContent(l);
        const [existing] = await db.select(memoryNoteColumns()).from(memoryNote)
          .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.ownerId, ctx.owner), eq(memoryNote.corpus, LESSON_TAG), eq(memoryNote.sourceKey, key))).limit(1);
        const provenance = signNote(content, LESSON_TAG, key, ctx);
        if (existing) {
          if (existing.content === content && verifyNote(existing, ctx)) { skipped++; continue; }
          await updateNote(db, embedder, existing.id, { content, provenance, source });
          updated++;
        } else {
          await addNote(db, embedder, { content, keywords: [key], tags: [LESSON_TAG],
            corpus: LESSON_TAG, sourceKey: key, context: l.source, provenance, source });
          added++;
        }
      }

      // 회수 패스(BAC-580) — 이미 졸업된 노트 전부를 현재 파일 상태와 대조.
      let stubbed = 0;
      let purged = 0;
      const byId = new Map(records.map((l) => [l.id, l]));
      const graduated = await db
        .select(memoryNoteColumns())
        .from(memoryNote)
        .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.corpus, LESSON_TAG), eq(memoryNote.ownerId, ctx.owner)));
      for (const note of graduated) {
        const id = note.sourceKey.startsWith(LESSON_KEY_PREFIX) ? note.sourceKey.slice(LESSON_KEY_PREFIX.length) : '';
        if (!id) continue; // lesson 노트인데 lesson:<id> 키워드가 없음 — 있을 수 없지만 방어적으로 skip
        const rec = byId.get(id);
        const decision = decideLessonReap(note.content, rec);
        // A snapshot is authoritative only for this owner's configured directory. Missing/corrupt
        // source is not safe to recall; quarantine it instead of resurrecting old guidance.
        if (!rec) { await softDeleteNote(db, note.id, 'source missing'); purged++; continue; }
        if (decision.op === 'stub' || (decision.op === 'keep' && rec.retired && !verifyNote(note, ctx))) {
          const content = lessonStub(rec, rec.retiredRef);
          await updateNote(db, embedder, note.id, {
            content,
            provenance: signNote(content, LESSON_TAG, note.sourceKey, ctx),
            source,
          });
          stubbed++;
        } else if (decision.op === 'purge') {
          await softDeleteNote(db, note.id, decision.reason);
          purged++;
        }
      }

      return { added, updated, skipped, stubbed, purged };
    } finally {
      await client.query('select pg_advisory_unlock($1, hashtext($2))', [
        LOCK_NAMESPACE,
        LESSON_TAG,
      ]);
    }
  } finally {
    client.release();
  }
}

/**
 * 현재 실패와 의미적으로 가까운 *교훈* top-k. lessons.mjs의 정확-시그니처 매칭을 넘어 유사 실패도 건진다.
 * (졸업된 lesson 노트로 한정 — tag `lesson`.)
 *
 * write-path provenance 필터(BAC-619, README "위협모델" 참고): `signingKey`가 없으면 아무 서명도
 * 검증할 수 없으므로 **전부 제외**(fail-closed — 서명 없이 recall하느니 아무것도 안 하는 쪽이 안전).
 * `signingKey`가 있으면 `memory_note.provenance`가 그 content를 실제로 서명한 값과 일치하는 노트만
 * 남긴다 — 서명 없음(직접 SQL INSERT 등 secret을 모르는 쓰기)이나 content-서명 불일치(예: content만
 * 바뀌고 재서명 안 된 stale 서명)는 injection 후보에서 제외된다.
 */
interface RecallHitWithKeywords extends RecallHit {
  sourceKey: string;
}

/**
 * recallLessons의 실제 질의 본체 — keywords까지 포함해 반환한다(내부 전용). `recallLessonsDecayed`가
 * lesson id(→ 파일 lastSeen/count) 매칭에 keywords가 필요해 분리했다. `recallLessons`는 이 함수를
 * keywords만 벗겨 감싼 얇은 래퍼 — 외부 계약(핫패스, UserPromptSubmit 훅)은 그대로 두면서 SQL을
 * 중복시키지 않는다.
 */
async function recallLessonsRaw(
  db: LoopDb,
  embedder: Embedder,
  query: string,
  signingKey: string | undefined,
  k: number,
): Promise<RecallHitWithKeywords[]> {
  if (!signingKey) return [];
  const ctx = assertEmbedder(db, embedder);
  if (ctx.signingKey !== signingKey) throw new MemoryError('signing_key_mismatch');
  const literal = toVectorLiteral(await embedder.embed(sanitizeMemory(query, 2048)));
  const distance = sql<number>`${memoryNote.embedding} <=> ${literal}::vector`;
  const rows = await db.select({ ...memoryNoteColumns(), distance }).from(memoryNote)
    .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.ownerId, ctx.owner),
      eq(memoryNote.embeddingId, ctx.embeddingId), eq(memoryNote.corpus, LESSON_TAG), sql`${memoryNote.embedding} is not null`))
    .orderBy(distance);
  // Authenticate before top-k so unsigned nearest neighbours cannot starve genuine matches.
  return rows.filter(r => verifyNote(r, ctx)).slice(0, k)
    .map(r => ({ id: r.id, content: sanitizeMemory(r.content), distance: Number(r.distance), sourceKey: r.sourceKey }));

}

export async function recallLessons(
  db: LoopDb,
  embedder: Embedder,
  query: string,
  signingKey: string | undefined,
  k = 5,
): Promise<RecallHit[]> {
  const rows = await recallLessonsRaw(db, embedder, query, signingKey, k);
  return rows.map(({ id, content, distance }) => ({ id, content, distance }));
}

// ── Sleep-time consolidation (BAC/paul-loop #12) ────────────────────────────────────────────────
//
// 아래 3개 배치는 이 파일 위쪽의 졸업(graduate)·회수(reap)와 달리 **실시간 요청 경로가 아니다** —
// SessionStart/UserPromptSubmit 훅이 부르는 게 아니라, 사람 또는 주기 실행(cron/CLI `consolidate`
// 서브커맨드)이 굴리는 정리 작업이다. 셋 다 lessons.mjs의 실패-시그니처 *정확* 해시 매칭을 넘어,
// 이미 졸업된 lesson 노트들의 pgvector 임베딩을 봐야만 알 수 있는 *의미적* 신호를 뽑아낸다:
//
//   1. findDuplicateLessons  — 거의 같은 노트가 서로 다른 lesson id로 중복 졸업됐는지 표시(자동 병합 없음).
//   2. scorePromotionCandidates — "의미적으로 비슷한 실패가 몇 번 나타났는가"를 승격 보조 신호로 채점.
//   3. decayedScore/recallLessonsDecayed — 오래되고 최근 재발 없는 교훈은 랭킹에서 감쇠.
//
// 1·2는 전체 lesson 코퍼스를 한 번 스캔해 순수 함수(clusterBySimilarity)로 클러스터링만 할 뿐 아무것도
// 쓰지 않는다(read-only) — graduateLessons/syncKnowledge와 달리 advisory lock이 필요 없다(동시에 여러
// 세션이 돌려도 서로의 쓰기를 밟을 게 없다). 병합·삭제·승격의 최종 판단은 여전히 사람/스켑틱(lessons.mjs의
// challenge/retire)이 한다 — 이 배치는 후보를 "표시"만 한다.

/** 코사인 거리 — pgvector `<=>` 연산자와 같은 공식(1 - cosine similarity). 순수 JS라 DB 없이도
 *  clusterBySimilarity를 단위테스트할 수 있다. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

export interface LessonEmbeddingRow {
  /** memory_note.id */
  noteId: string;
  /** `lesson:<id>` keyword에서 뽑은 원 lesson id. */
  lessonId: string;
  embedding: number[];
}

export interface SimilarityCluster {
  noteIds: string[];
  lessonIds: string[];
}

/**
 * 순수 함수: 서로 코사인 거리 < threshold인 노트들을 union-find로 묶어 클러스터를 낸다. dedup(#1, 타이트한
 * threshold)과 pre-scoring(#3, 느슨한 threshold)이 이 함수 하나를 threshold만 다르게 재사용한다 — "얼마나
 * 가까워야 같은 클러스터로 볼지"만 다를 뿐 클러스터링 자체는 같은 문제라서. 크기 1인 클러스터(다른 어떤
 * 노트와도 안 묶인 단독)는 결과에서 뺀다 — 신호가 없다.
 */
export function clusterBySimilarity(
  rows: LessonEmbeddingRow[],
  threshold: number,
): SimilarityCluster[] {
  const parent = rows.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      const p = parent[i] as number;
      parent[i] = parent[p] as number;
      i = p;
    }
    return i;
  }
  function union(i: number, j: number): void {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]?.embedding;
      const b = rows[j]?.embedding;
      if (a && b && cosineDistance(a, b) < threshold) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    const arr = groups.get(root);
    if (arr) arr.push(i);
    else groups.set(root, [i]);
  }
  const clusters: SimilarityCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    clusters.push({
      noteIds: idxs.map((i) => rows[i]?.noteId as string),
      lessonIds: idxs.map((i) => rows[i]?.lessonId as string),
    });
  }
  return clusters;
}

/**
 * 얇은 shell — 활성 lesson 노트 전부(임베딩 포함)를 읽는다. dedup·pre-scoring 둘 다 같은 스캔을
 * 공유해 DB 왕복을 하나로 줄인다(consolidateLessonMemory).
 *
 * write-path provenance 필터(BAC-619, README "위협모델" 참고) — recallLessonsRaw와 같은 신뢰경계:
 * `signingKey`가 없으면 아무 서명도 검증할 수 없으므로 **전부 제외**(fail-closed — 서명 없이 클러스터링
 * 하느니 아무것도 안 하는 쪽이 안전. dedup·승격 신호는 사람 판단의 입력이 되므로, 서명 안 된/위조된
 * 노트가 섞이면 그 판단 자체가 오염된다). `signingKey`가 있으면 `memory_note.provenance`가 그 content를
 * 실제로 서명한 값과 일치하는 노트만 남긴다.
 */
async function fetchLessonEmbeddings(
  db: LoopDb,
  signingKey: string | undefined,
): Promise<LessonEmbeddingRow[]> {
  if (!signingKey) return [];
  const ctx = storeContext(db);
  if (ctx.signingKey !== signingKey) throw new MemoryError('signing_key_mismatch');
  const notes = await db.select({ ...memoryNoteColumns(), embedding: memoryNote.embedding }).from(memoryNote)
    .where(and(isNull(memoryNote.deletedAt), eq(memoryNote.ownerId, ctx.owner),
      eq(memoryNote.embeddingId, ctx.embeddingId), eq(memoryNote.corpus, LESSON_TAG), sql`${memoryNote.embedding} is not null`));

  const out: LessonEmbeddingRow[] = [];
  for (const n of notes) {
    if (!verifyNote(n, ctx)) continue;
    const lessonId = n.sourceKey.startsWith(LESSON_KEY_PREFIX) ? n.sourceKey.slice(LESSON_KEY_PREFIX.length) : '';
    if (!lessonId || !n.embedding) continue;
    out.push({ noteId: n.id, lessonId, embedding: n.embedding });
  }
  return out;
}

/** 노트 간 사실상 동일(코사인 거리 < threshold)로 보는 기본 문턱값. */
const DEDUP_DISTANCE_THRESHOLD = 0.05;
/** "의미적으로 비슷한 실패"로 보는 기본 문턱값 — dedup보다 훨씬 느슨하다(사실상 동일이 아니라 같은
 *  주제군인지만 본다). */
const PROMOTION_DISTANCE_THRESHOLD = 0.2;

export interface DuplicateCandidate {
  noteIds: string[];
  lessonIds: string[];
}

/**
 * 배치(#1, dedup): 졸업된 lesson 노트 중 임베딩이 사실상 같은(코사인 거리 < threshold) 서로 다른 lesson
 * id 노트들을 병합 후보로 표시한다. **자동 병합/삭제하지 않는다** — lessons.mjs의 retire/challenge와
 * 같은 정신으로 사람/스켑틱이 최종 판단해야 한다(호출자가 이 목록을 보고 `lessons challenge` 등으로 이어간다).
 *
 * `signingKey` 없으면 fail-closed로 빈 배열(fetchLessonEmbeddings 참고, BAC-619).
 */
export async function findDuplicateLessons(
  db: LoopDb,
  signingKey: string | undefined,
  threshold = DEDUP_DISTANCE_THRESHOLD,
): Promise<DuplicateCandidate[]> {
  const rows = await fetchLessonEmbeddings(db, signingKey);
  return clusterBySimilarity(rows, threshold);
}

export interface PromotionSignal {
  lessonId: string;
  /** 자신을 포함한 클러스터 크기 — "의미적으로 비슷한 실패가 몇 번 나타났는가". */
  clusterSize: number;
  /** 같은 클러스터의 다른 lesson id들. */
  peerLessonIds: string[];
}

/** clusterBySimilarity 결과 → PromotionSignal 변환의 순수 코어(scorePromotionCandidates가 감싸는
 *  DB-free 부분) — clusterSize 내림차순 정렬을 DB 없이 단위테스트할 수 있도록 export한다. */
export function toPromotionSignals(clusters: SimilarityCluster[]): PromotionSignal[] {
  const out: PromotionSignal[] = [];
  for (const c of clusters) {
    for (const lessonId of c.lessonIds) {
      out.push({
        lessonId,
        clusterSize: c.lessonIds.length,
        peerLessonIds: c.lessonIds.filter((id) => id !== lessonId),
      });
    }
  }
  return out.sort((a, b) => b.clusterSize - a.clusterSize);
}

/**
 * 배치(#3, pre-scoring): "의미적으로 비슷한 실패가 여러 번 나타났다"는 신호를 loop-memory 쪽에서
 * 사전 채점한다 — lessons.mjs의 promote(정확 시그니처 재발 `count` 기반)와는 독립된 보조 신호다. 실제
 * 승격 판단(verified+recurring+challenge 게이트)은 여전히 lessons.mjs 몫 — 이 함수는 계산해서
 * 반환할 뿐 어디에도 자동 반영하지 않는다.
 *
 * `signingKey` 없으면 fail-closed로 빈 배열(fetchLessonEmbeddings 참고, BAC-619).
 */
export async function scorePromotionCandidates(
  db: LoopDb,
  signingKey: string | undefined,
  threshold = PROMOTION_DISTANCE_THRESHOLD,
): Promise<PromotionSignal[]> {
  const rows = await fetchLessonEmbeddings(db, signingKey);
  return toPromotionSignals(clusterBySimilarity(rows, threshold));
}

export interface ConsolidationReport {
  duplicates: DuplicateCandidate[];
  promotionSignals: PromotionSignal[];
}

/**
 * findDuplicateLessons + scorePromotionCandidates를 한 번의 스캔으로 묶은 편의 배치 — 둘 다 같은 활성
 * lesson 임베딩 집합 위에서 clusterBySimilarity를 threshold만 다르게 두 번 돌릴 뿐이라, DB 왕복을
 * 하나로 줄인다(CLI `consolidate` 서브커맨드가 이걸 부른다). decay 랭킹(#2)은 질의(query)가 있어야
 * 의미가 있는 recall 계열이라 여기 안 묶고 `recallLessonsDecayed`로 별도로 둔다.
 *
 * `signingKey` 없으면 fail-closed로 duplicates/promotionSignals 둘 다 빈 배열(fetchLessonEmbeddings
 * 참고, BAC-619).
 */
export async function consolidateLessonMemory(
  db: LoopDb,
  signingKey: string | undefined,
  dedupThreshold = DEDUP_DISTANCE_THRESHOLD,
  promotionThreshold = PROMOTION_DISTANCE_THRESHOLD,
): Promise<ConsolidationReport> {
  const rows = await fetchLessonEmbeddings(db, signingKey);
  return {
    duplicates: clusterBySimilarity(rows, dedupThreshold),
    promotionSignals: toPromotionSignals(clusterBySimilarity(rows, promotionThreshold)),
  };
}

/** decay 반감기 기본값(일) — count=0인 교훈이 이 기간마다 거리 페널티 2배. */
const DEFAULT_DECAY_HALF_LIFE_DAYS = 30;

export interface DecayInput {
  /** 원 코사인 거리(pgvector `<=>`). */
  distance: number;
  /** lessons.mjs top-level `last_seen`(ISO8601). 빈 문자열/파싱 불가 = 정보 없음. */
  lastSeen: string;
  /** lessons.mjs top-level `count`(재발 횟수). 정보 없으면 0. */
  count: number;
}

/**
 * 순수 함수: decay-adjusted 랭킹 스코어. distance와 같은 방향(낮을수록 더 관련 있음 — 오름차순 정렬).
 * 오래 안 쓰인(lastSeen이 오래된) 교훈일수록 거리에 페널티를 곱해 랭킹에서 밀어낸다. count가 높을수록
 * (자주 재발) 반감기가 늘어나 감쇠가 완만해진다 — 자주 재발하는 교훈은 오래돼도 덜 밀린다.
 * lastSeen이 없으면(빈 문자열/파싱 불가) age=0으로 취급해 페널티를 주지 않는다 — 정보가 없다고 불리하게
 * 두지 않는 fail-open 방향(이 배치는 삭제가 아니라 랭킹 보조 신호일 뿐이라, 모르는 걸 벌하면 파일에
 * count/last_seen이 없는 수기 작성 교훈이 부당하게 밀린다).
 */
export function decayedScore(
  input: DecayInput,
  now: Date,
  halfLifeDays = DEFAULT_DECAY_HALF_LIFE_DAYS,
): number {
  const seenAt = input.lastSeen ? new Date(input.lastSeen) : null;
  const ageDays =
    seenAt && !Number.isNaN(seenAt.getTime())
      ? Math.max(0, (now.getTime() - seenAt.getTime()) / 86_400_000)
      : 0;
  const effectiveHalfLife = halfLifeDays * (1 + Math.max(0, input.count));
  const decayFactor = 2 ** (ageDays / effectiveHalfLife);
  return input.distance * decayFactor;
}

export interface DecayedRecallHit extends RecallHit {
  score: number;
}

/**
 * 배치(#2, decay 랭킹): recallLessons과 같은 lesson 코퍼스 질의를 하되, 파일 쪽 count/lastSeen으로
 * decay-랭크해 반환한다. 실시간 recall 훅 경로(recallLessons, cli.ts의 UserPromptSubmit 결선)는 전혀
 * 안 건드린다 — 이 함수는 별도 배치/진단 엔트리(CLI `recall --decay`)로, 오래되고 최근 재발 없는 교훈이
 * 순수 최근접 거리만으로 상위를 차지하는 걸 완화해서 보여준다.
 * raw 후보를 k보다 넉넉히(`max(k*4, 20)`) 뽑아 재정렬 후 상위 k만 남긴다 — decay가 순서를 뒤집을 수
 * 있어 raw top-k만 보면 재정렬 여지가 없다.
 */
export async function recallLessonsDecayed(
  db: LoopDb,
  embedder: Embedder,
  query: string,
  signingKey: string | undefined,
  dir: string,
  k = 5,
  now: Date = new Date(),
  halfLifeDays = DEFAULT_DECAY_HALF_LIFE_DAYS,
): Promise<DecayedRecallHit[]> {
  const candidates = await recallLessonsRaw(db, embedder, query, signingKey, Math.max(k * 4, 20));
  const meta = new Map(readLessonRecords(dir).map((l) => [l.id, l]));
  return candidates
    .map((h) => {
      const lessonId = h.sourceKey.startsWith(LESSON_KEY_PREFIX) ? h.sourceKey.slice(LESSON_KEY_PREFIX.length) : '';
      const m = lessonId ? meta.get(lessonId) : undefined;
      const score = decayedScore(
        { distance: h.distance, lastSeen: m?.lastSeen ?? '', count: m?.count ?? 0 },
        now,
        halfLifeDays,
      );
      return { id: h.id, content: h.content, distance: h.distance, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, k);
}
