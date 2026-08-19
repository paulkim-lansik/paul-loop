import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, isNull, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { LoopDb } from './client';
import type { Embedder } from './embedding';
import { LOCK_NAMESPACE } from './knowledge';
import { addNote, type RecallHit, softDeleteNote, toVectorLiteral, updateNote } from './ops';
import { signContent, verifySignature } from './provenance';
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
  return l.verified && !l.rejected && !l.retired;
}

/**
 * `.loop/lessons/<id>.json` 전부를 판정 상태(verified/rejected/retired)까지 포함해 읽는다.
 * 손상/수기편집 파일은 조용히 건너뛴다(코어를 오도하지 못함, lessons.mjs와 동일). 내부 전용이 아니라
 * export하는 이유: `graduateLessons`(회수 패스)와 테스트가 같은 파서를 공유해야 판정이 갈리지 않는다.
 */
export function readLessonRecords(dir: string): LessonRecord[] {
  if (!existsSync(dir)) return [];
  const out: LessonRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as Record<string, unknown>;
    if (typeof l.id !== 'string' || !l.id) continue;
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
      verified: l.verified === true,
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
export function readVerifiedLessons(dir: string): LessonFile[] {
  return readLessonRecords(dir)
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
  return [l.title, l.fix ? `fix: ${l.fix}` : '', l.signature.join(' | ')]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
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
  return `[퇴역] ${l.title}\n이미 ${where}로 코디파이됨 — 원문 참조. (원 교훈 id: ${l.id})`;
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
 * ⚠️ `rec`이 `undefined`(이 호출이 그 파일을 못 봄)면 반드시 `keep` — "안 봤다"를 "지워야 한다"로
 * 해석하지 않는다. `graduateLessons`는 CLI/훅뿐 아니라 테스트에서도 다양한 임시/부분 디렉터리로
 * 호출되는데(예: cli.integration.test.ts가 `--knowledge`만 검증하려고 빈 `--lessons` 디렉터리를
 * 넘기는 경우), "이 dir엔 없음 = 파일이 실제로 사라짐"으로 취급하면 그 호출이 다른 테스트/실행이 만든
 * 무관한 노트까지 회수해버린다. 그래서 이 함수는 **파일을 실제로 읽어 retired/rejected를 확인한
 * 경우에만** 능동적으로 판단하고, 모르면 손대지 않는다(fail-closed 방향은 "회수하지 않는 쪽").
 *
 * - `rec.retired`면 → `stub`(코디파이 위치를 가리키는 대체 콘텐츠로 UPDATE). 이미 그 스텁이면 `keep`.
 * - `rec.rejected`면 → `purge`(soft-delete, 코디파이 위치가 없으므로 스텁도 없음).
 * - 그 외(`rec` 없음, 또는 여전히 활성 교훈) → `keep`.
 */
export function decideLessonReap(
  currentContent: string,
  rec: LessonRecord | undefined,
): LessonReapDecision {
  if (!rec) return { op: 'keep' };
  if (rec.retired) {
    const desired = lessonStub(rec, rec.retiredRef);
    return currentContent === desired ? { op: 'keep' } : { op: 'stub', content: desired };
  }
  if (rec.rejected) return { op: 'purge', reason: 'challenge verdict=reject' };
  return { op: 'keep' };
}

export interface GraduateResult {
  added: number;
  skipped: number;
  /** 이미 졸업된 노트 중 퇴역으로 판정돼 스텁 콘텐츠로 대체(UPDATE, 재임베드)한 건수(BAC-580). */
  stubbed: number;
  /** 이미 졸업된 노트 중 회수(soft-delete)한 건수 — challenge.verdict === 'reject'로 판정(BAC-580). */
  purged: number;
  /** true면 동시 졸업 잠금을 못 얻어 이번 실행은 아무 것도 안 하고 skip했다(BAC-372, syncKnowledge의
   * KnowledgeSyncResult.locked와 대칭) — 나머지 카운트는 전부 0. */
  locked?: true;
}

/**
 * 파일 lessons의 *verified* 교훈을 의미검색 층으로 졸업시키고, 이미 졸업된 노트를 현재 파일 상태로
 * 수렴시킨다(BAC-580 미러-싱크 패스).
 * ADD: 멱등 — 같은 교훈 id는 한 번만 ADD(keywords의 `lesson:<id>`로 dedup). 재실행해도 중복 노트를
 * 만들지 않는다. (UPDATE-on-change·자동 링크 진화는 후속 — ADR-0023의 op 결정 LLM 시맨.)
 * 회수(REAP, BAC-580): 필터(readVerifiedLessons)만으론 부족하다 — 졸업은 add-once라 파일이 나중에
 * retire/reject 되어도 이미 pgvector에 박힌 노트는 그대로 남는다. knowledge.ts의 syncKnowledge(미러-싱크:
 * 파일 desired 상태로 노트를 수렴)와 같은 정신을 lessons에 맞게 적용하되, 판단은 **이 호출이 실제로 읽은
 * 파일에 한해서만** 능동적이다(decideLessonReap 참고) — knowledge.ts처럼 "desired에 없으면 무조건
 * DELETE"는 아니다(부분/빈 디렉터리로 호출될 때 무관한 노트를 회수해버리는 사고를 막기 위함).
 * `decideLessonReap`이 순수 결정을, 여기 루프가 그 결정의 실행만 맡는다.
 *
 * 동시 졸업 가드(BAC-372, syncKnowledge/BAC-367과 동일 메커니즘): 여러 SessionStart가 동시에 같은
 * 미졸업 교훈을 각자 "없음"으로 읽고 각자 addNote(ON CONFLICT 없는 순수 INSERT)하면 같은 lesson id의
 * 중복 노트가 영구 잔류한다(BAC-580의 회수 패스는 파일 상태 대비 id 단위 mirror-sync일 뿐 중복 제거가
 * 아니라서 이 레이스는 여전히 advisory lock으로만 막는다). 세션-스코프 advisory lock
 * (pg_try_advisory_lock/pg_advisory_unlock, 트랜잭션-스코프 아님)으로 함수 전체(ADD+회수)를
 * 직렬화하되, 개별 쓰기는 여전히 auto-commit(트랜잭션으로 안 묶음) — db.transaction()으로 감싸면
 * 함수 전체가 원자적 트랜잭션이 되어 SessionStart 훅의 12s 타임아웃(graduate-lessons.mjs)에 걸려
 * SIGTERM되면 그때까지의 쓰기가 전부 롤백된다(syncKnowledge가 BAC-367 PR #39 리뷰에서 실측으로
 * 지적받은 회귀 — "개별 커밋 → 세션마다 증분 수렴" 설계 계약을 깨므로 여기서도 재도입하지 않는다).
 * pool에서 커넥션 하나를 명시로 checkout해 락 획득/해제를 그 커넥션에 고정한다(세션-스코프 락은
 * 커넥션에 묶이므로). 연결 종료(크래시 포함) 시 postgres가 자동 해제.
 *
 * write-path provenance(BAC-619, README "위협모델" 참고): `signingKey`가 있으면 이 함수가 ADD/스텁
 * UPDATE하는 노트의 content를 HMAC-SHA256으로 서명해 `memory_note.provenance`에 남긴다 — secret을
 * 모르는 다른 쓰기 경로(직접 SQL INSERT 등)는 이 서명을 위조할 수 없어, `recallLessons`가 구조적으로
 * 걸러낸다. `signingKey`가 없으면(secret 미설정) 서명 없이 그대로 쓴다 — 쓰기 자체를 막지 않는다
 * (fail-closed는 recall 쪽 책임, README 참고).
 */
export async function graduateLessons(
  db: LoopDb,
  pool: Pool,
  embedder: Embedder,
  dir: string,
  signingKey: string | undefined,
): Promise<GraduateResult> {
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
      return { added: 0, skipped: 0, stubbed: 0, purged: 0, locked: true };
    }
    try {
      let added = 0;
      let skipped = 0;
      for (const l of readVerifiedLessons(dir)) {
        const key = lessonKey(l.id);
        const [existing] = await db
          .select({ id: memoryNote.id })
          .from(memoryNote)
          .where(and(isNull(memoryNote.deletedAt), sql`${key} = any(${memoryNote.keywords})`))
          .limit(1);
        if (existing) {
          skipped++;
          continue;
        }
        const content = lessonContent(l);
        await addNote(db, embedder, {
          content,
          keywords: [key],
          tags: [LESSON_TAG, l.source],
          context: l.source,
          provenance: signingKey ? signContent(content, signingKey) : undefined,
        });
        added++;
      }

      // 회수 패스(BAC-580) — 이미 졸업된 노트 전부를 현재 파일 상태와 대조.
      let stubbed = 0;
      let purged = 0;
      const byId = new Map(readLessonRecords(dir).map((l) => [l.id, l]));
      const graduated = await db
        .select({ id: memoryNote.id, keywords: memoryNote.keywords, content: memoryNote.content })
        .from(memoryNote)
        .where(and(isNull(memoryNote.deletedAt), sql`${LESSON_TAG} = any(${memoryNote.tags})`));
      for (const note of graduated) {
        const id = note.keywords
          .find((k) => k.startsWith(LESSON_KEY_PREFIX))
          ?.slice(LESSON_KEY_PREFIX.length);
        if (!id) continue; // lesson 노트인데 lesson:<id> 키워드가 없음 — 있을 수 없지만 방어적으로 skip
        const decision = decideLessonReap(note.content, byId.get(id));
        if (decision.op === 'stub') {
          await updateNote(db, embedder, note.id, {
            content: decision.content,
            provenance: signingKey ? signContent(decision.content, signingKey) : undefined,
          });
          stubbed++;
        } else if (decision.op === 'purge') {
          await softDeleteNote(db, note.id, decision.reason);
          purged++;
        }
      }

      return { added, skipped, stubbed, purged };
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
  keywords: string[];
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
  // signingKey 없으면 결과는 항상 []다 — 임베드 API 호출·DB 질의를 낼 필요 없이 여기서 바로 반환한다.
  if (!signingKey) return [];
  const literal = toVectorLiteral(await embedder.embed(query));
  const distance = sql<number>`${memoryNote.embedding} <=> ${literal}::vector`;
  const rows = await db
    .select({
      id: memoryNote.id,
      content: memoryNote.content,
      distance,
      provenance: memoryNote.provenance,
      keywords: memoryNote.keywords,
    })
    .from(memoryNote)
    .where(
      and(
        isNull(memoryNote.deletedAt),
        sql`${memoryNote.embedding} is not null`,
        sql`${LESSON_TAG} = any(${memoryNote.tags})`,
      ),
    )
    .orderBy(distance)
    .limit(k);
  return rows
    .filter((r) => verifySignature(r.content, signingKey, r.provenance))
    .map((r) => ({ id: r.id, content: r.content, distance: Number(r.distance), keywords: r.keywords }));
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

/** 얇은 shell — 활성 lesson 노트 전부(임베딩 포함)를 읽는다. dedup·pre-scoring 둘 다 같은 스캔을
 *  공유해 DB 왕복을 하나로 줄인다(consolidateLessonMemory). */
async function fetchLessonEmbeddings(db: LoopDb): Promise<LessonEmbeddingRow[]> {
  const notes = await db
    .select({ id: memoryNote.id, keywords: memoryNote.keywords, embedding: memoryNote.embedding })
    .from(memoryNote)
    .where(
      and(
        isNull(memoryNote.deletedAt),
        sql`${LESSON_TAG} = any(${memoryNote.tags})`,
        sql`${memoryNote.embedding} is not null`,
      ),
    );
  const out: LessonEmbeddingRow[] = [];
  for (const n of notes) {
    const lessonId = n.keywords
      .find((k) => k.startsWith(LESSON_KEY_PREFIX))
      ?.slice(LESSON_KEY_PREFIX.length);
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
 */
export async function findDuplicateLessons(
  db: LoopDb,
  threshold = DEDUP_DISTANCE_THRESHOLD,
): Promise<DuplicateCandidate[]> {
  const rows = await fetchLessonEmbeddings(db);
  return clusterBySimilarity(rows, threshold);
}

export interface PromotionSignal {
  lessonId: string;
  /** 자신을 포함한 클러스터 크기 — "의미적으로 비슷한 실패가 몇 번 나타났는가". */
  clusterSize: number;
  /** 같은 클러스터의 다른 lesson id들. */
  peerLessonIds: string[];
}

function toPromotionSignals(clusters: SimilarityCluster[]): PromotionSignal[] {
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
 */
export async function scorePromotionCandidates(
  db: LoopDb,
  threshold = PROMOTION_DISTANCE_THRESHOLD,
): Promise<PromotionSignal[]> {
  const rows = await fetchLessonEmbeddings(db);
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
 */
export async function consolidateLessonMemory(
  db: LoopDb,
  dedupThreshold = DEDUP_DISTANCE_THRESHOLD,
  promotionThreshold = PROMOTION_DISTANCE_THRESHOLD,
): Promise<ConsolidationReport> {
  const rows = await fetchLessonEmbeddings(db);
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
      const lessonId = h.keywords
        .find((kw) => kw.startsWith(LESSON_KEY_PREFIX))
        ?.slice(LESSON_KEY_PREFIX.length);
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
