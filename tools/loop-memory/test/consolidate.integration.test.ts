import { lessonJSON } from './helpers/postgres-fixture';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoopDb } from './helpers/postgres-fixture';
import type { Embedder } from '../src/embedding';
import {
  consolidateLessonMemory,
  findDuplicateLessons,
  LESSON_TAG,
  recallLessons,
  recallLessonsDecayed,
  scorePromotionCandidates,
} from '../src/lessons';
import { softDeleteNote } from '../src/ops';
import { addNote } from './helpers/postgres-fixture';
import { signContent } from '../src/provenance';
import { memoryNote } from '../src/schema/memory';

// 통합 테스트(docker pgvector 필요): sleep-time consolidation 배치(BAC/paul-loop #12) 3종을 end-to-end로
// 증명한다. 임베딩을 손으로 정확히 구성해(코사인 거리를 정확한 값으로 통제) DB에 직접 addNote로 심는다
// — lessons.integration.test.ts처럼 graduateLessons를 거치지 않고 write-path provenance만 직접 서명해
// "정상 졸업된 것처럼" 만든다(같은 패턴, 그 파일의 "write-path provenance" describe 참고).
const { db, pool } = createLoopDb(() => SIGNING_KEY);
const DIM = 384;
const SIGNING_KEY = 'bac-618-consolidate-test-signing-key'; // gitleaks:allow — fixed test fixture

function basis(idx: number): number[] {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
}
/** idxA·idxB 두 축의 선형결합 — distance(결과, basis(idxA)) === 1 - cosTheta가 정확히 보장된다. */
function mix(idxA: number, idxB: number, cosTheta: number): number[] {
  const v = new Array(DIM).fill(0);
  v[idxA] = cosTheta;
  v[idxB] = Math.sqrt(1 - cosTheta * cosTheta);
  return v;
}

async function plantLessonNote(
  lessonId: string,
  embedding: number[],
  content: string,
): Promise<string> {
  const note = await addNote(db, stubUnused, {
    content,
    keywords: [`lesson:${lessonId}`],
    tags: [LESSON_TAG, 'manual'],
    context: 'manual',
    embedding, // 사전 계산된 임베딩을 넘기므로 embedder는 호출되지 않는다.
    provenance: signContent(content, SIGNING_KEY),
  });
  return note.id;
}

// addNote(db, embedder, input) 시그니처를 만족만 시키는 더미 — embedding을 항상 넘기므로 실제로 embed()가
// 호출될 일이 없다(호출되면 바로 throw해서 그 사실을 드러낸다).
const stubUnused: Embedder = {
  dimensions: DIM,
  identity: "stub:character-hash:v1:384",
  embed: () => Promise.reject(new Error('embed() should not be called — embedding was precomputed')),
  embedBatch: () =>
    Promise.reject(new Error('embedBatch() should not be called — embedding was precomputed')),
};

async function cleanup(noteIds: string[], dirs: string[]): Promise<void> {
  for (const id of noteIds) await softDeleteNote(db, id, 'test cleanup');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

afterAll(async () => {
  await pool.end();
});

describe('findDuplicateLessons — dedup 후보 표시(#1, BAC/paul-loop #12)', () => {
  // 각 it()이 자기 fixture를 스스로 만들고 정리한다 — 실행 순서/생략에 서로 의존하지 않는다(리뷰 지적,
  // 두 번째 it이 예전엔 첫 번째가 남긴 noteIds 부작용에 기대고 있었다).

  it('임베딩이 사실상 같은(distance=0) 서로 다른 lesson id 노트를 병합 후보로 묶는다', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const idC = randomUUID();
    const noteA = await plantLessonNote(idA, basis(10), 'dedup fixture A');
    const noteB = await plantLessonNote(idB, basis(10), 'dedup fixture B (사실상 동일)');
    const noteC = await plantLessonNote(idC, basis(11), 'dedup fixture C (무관, 직교)');
    try {
      const candidates = await findDuplicateLessons(db, SIGNING_KEY, 0.05);
      const mine = candidates.find(
        (c) => c.lessonIds.includes(idA) && c.lessonIds.includes(idB),
      );
      expect(mine).toBeDefined();
      expect(mine?.noteIds.sort()).toEqual([noteA, noteB].sort());

      // C는 threshold 밖 — 어떤 클러스터에도 idC가 섞여 있으면 안 된다.
      expect(candidates.some((c) => c.lessonIds.includes(idC))).toBe(false);
    } finally {
      await cleanup([noteA, noteB, noteC], []);
    }
  });

  it('자동으로 병합/삭제하지 않는다 — 후보로 표시된 뒤에도 두 노트 다 여전히 활성(soft-delete 안 됨)', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const noteA = await plantLessonNote(idA, basis(12), 'dedup fixture A2 (독립 케이스)');
    const noteB = await plantLessonNote(idB, basis(12), 'dedup fixture B2 (독립 케이스, 사실상 동일)');
    try {
      await findDuplicateLessons(db, SIGNING_KEY, 0.05); // read-only임을 확인할 대상 호출
      for (const id of [noteA, noteB]) {
        const [n] = await db
          .select({ deletedAt: memoryNote.deletedAt })
          .from(memoryNote)
          .where(eq(memoryNote.id, id));
        expect(n?.deletedAt).toBeNull();
      }
    } finally {
      await cleanup([noteA, noteB], []);
    }
  });
});

describe('scorePromotionCandidates — 승격 후보 사전 채점(#3, BAC/paul-loop #12)', () => {
  const idA = randomUUID();
  const idB = randomUUID();
  const idC = randomUUID();
  let noteIds: string[] = [];

  afterAll(async () => {
    await cleanup(noteIds, []);
  });

  it('dedup 문턱보다 느슨한 threshold로 "비슷하지만 동일하지 않은" 클러스터를 신호로 채점한다', async () => {
    const noteA = await plantLessonNote(idA, basis(20), 'prescore fixture A');
    const noteB = await plantLessonNote(idB, mix(20, 21, 0.9), 'prescore fixture B (distance≈0.1)'); // dedup(0.05)엔 안 걸림
    const noteC = await plantLessonNote(idC, basis(22), 'prescore fixture C (무관)');
    noteIds = [noteA, noteB, noteC];

    // dedup 문턱으로는 A·B가 후보로 안 잡힌다는 걸 먼저 확인(전제 조건).
    const dedup = await findDuplicateLessons(db, SIGNING_KEY, 0.05);
    expect(dedup.some((c) => c.lessonIds.includes(idA) && c.lessonIds.includes(idB))).toBe(false);

    // 느슨한 pre-scoring 문턱(0.15)에서는 A·B가 클러스터로 잡혀 서로를 승격 신호로 지목한다.
    const signals = await scorePromotionCandidates(db, SIGNING_KEY, 0.15);
    const sigA = signals.find((s) => s.lessonId === idA);
    const sigB = signals.find((s) => s.lessonId === idB);
    expect(sigA).toBeDefined();
    expect(sigB).toBeDefined();
    expect(sigA?.clusterSize).toBeGreaterThanOrEqual(2);
    expect(sigA?.peerLessonIds).toContain(idB);
    expect(sigB?.peerLessonIds).toContain(idA);

    // C는 무관 — 신호에 안 잡힌다.
    expect(signals.some((s) => s.lessonId === idC)).toBe(false);
  });
});

describe('consolidateLessonMemory — dedup+pre-scoring 한 번의 스캔(편의 배치)', () => {
  const idA = randomUUID();
  const idB = randomUUID();
  let noteIds: string[] = [];

  afterAll(async () => {
    await cleanup(noteIds, []);
  });

  it('duplicates와 promotionSignals을 한 번에 반환한다 — 완전 동일 쌍은 둘 다에 나타난다', async () => {
    const noteA = await plantLessonNote(idA, basis(30), 'consolidate fixture A');
    const noteB = await plantLessonNote(idB, basis(30), 'consolidate fixture B (완전 동일)');
    noteIds = [noteA, noteB];

    const report = await consolidateLessonMemory(db, SIGNING_KEY, 0.05, 0.15);
    expect(
      report.duplicates.some((c) => c.lessonIds.includes(idA) && c.lessonIds.includes(idB)),
    ).toBe(true);
    expect(
      report.promotionSignals.some((s) => s.lessonId === idA && s.peerLessonIds.includes(idB)),
    ).toBe(true);
  });
});

describe('write-path provenance(BAC-619) — consolidation 배치도 recallLessons과 같은 신뢰경계를 지킨다', () => {
  const idA = randomUUID();
  const idB = randomUUID();
  let noteIds: string[] = [];

  afterAll(async () => {
    await cleanup(noteIds, []);
  });

  it('signingKey 없으면 서명된 duplicate 후보가 있어도 findDuplicateLessons/scorePromotionCandidates/consolidateLessonMemory 전부 빈 결과(fail-closed)', async () => {
    const noteA = await plantLessonNote(idA, basis(60), 'provenance fixture A');
    const noteB = await plantLessonNote(idB, basis(60), 'provenance fixture B (사실상 동일, 정상 서명됨)');
    noteIds = [noteA, noteB];

    // 전제 조건: signingKey가 있으면 이 두 노트는 실제로 중복 후보로 잡힌다(정상 동작 확인).
    const withKey = await findDuplicateLessons(db, SIGNING_KEY, 0.05);
    expect(withKey.some((c) => c.lessonIds.includes(idA) && c.lessonIds.includes(idB))).toBe(true);

    // signingKey 없음 — 서명을 검증할 수 없으므로 아무 것도 안 본다(비어있는 게 아니라 조용히 틀린
    // 결과를 내느니 아무것도 안 하는 쪽).
    expect(await findDuplicateLessons(db, undefined, 0.05)).toEqual([]);
    expect(await scorePromotionCandidates(db, undefined, 0.05)).toEqual([]);
    const report = await consolidateLessonMemory(db, undefined, 0.05, 0.15);
    expect(report.duplicates).toEqual([]);
    expect(report.promotionSignals).toEqual([]);
  });

  it('signingKey가 있어도 그 키로 서명되지 않은 노트는 클러스터링 대상에서 제외된다(다른 secret으로 위조 불가)', async () => {
    const idC = randomUUID();
    const idD = randomUUID();
    const wrongContent = 'provenance fixture C (다른 secret으로 서명됨)';
    const noteC = await addNote(db, stubUnused, {
      content: wrongContent,
      keywords: [`lesson:${idC}`],
      tags: [LESSON_TAG, 'manual'],
      context: 'manual',
      embedding: basis(61),
      provenance: signContent(wrongContent, 'a-completely-different-secret'), // gitleaks:allow — fixture
    });
    const noteD = await plantLessonNote(idD, basis(61), 'provenance fixture D (정상 서명, 사실상 동일)');
    try {
      const candidates = await findDuplicateLessons(db, SIGNING_KEY, 0.05);
      // C는 서명 불일치라 후보 풀에 아예 없다 — D와 묶인 클러스터가 없어야 한다.
      expect(candidates.some((c) => c.lessonIds.includes(idC))).toBe(false);
    } finally {
      await cleanup([noteC.id, noteD], []);
    }
  });
});

describe('recallLessonsDecayed — decay 랭킹(#2, BAC/paul-loop #12)', () => {
  const idOld = randomUUID(); // raw distance가 더 가깝지만(강한 매칭) 아주 오래 전에 마지막으로 봄
  const idRecent = randomUUID(); // raw distance는 더 멀지만(약한 매칭) 방금 재발함
  let noteIds: string[] = [];
  let dir: string;
  const now = new Date('2026-08-19T00:00:00.000Z');

  // 질의 텍스트와 무관하게 항상 같은 고정 벡터를 내는 가짜 임베더 — raw distance를 정확히 통제하기 위함
  // (stubEmbedder의 문자 해시 기반 근사 유사도에 기대면 raw distance를 손으로 예측하기 어렵다).
  const fixedQueryEmbedder: Embedder = {
    dimensions: DIM,
  identity: "stub:character-hash:v1:384",
    embed: () => Promise.resolve(basis(40)),
    embedBatch: (texts) => Promise.resolve(texts.map(() => basis(40))),
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loop-consolidate-decay-'));
    // idOld: 쿼리 벡터(basis(40))와 distance=0.05(강한 매칭) — 하지만 파일상 2020년에 마지막으로 봄.
    const noteOld = await plantLessonNote(
      idOld,
      mix(40, 41, 0.95),
      'decay fixture — old strong match',
    );
    // idRecent: distance=0.2(약한 매칭) — 하지만 파일상 지금(now) 막 재발.
    const noteRecent = await plantLessonNote(
      idRecent,
      mix(40, 41, 0.8),
      'decay fixture — recent weak match',
    );
    noteIds = [noteOld, noteRecent];

    writeFileSync(
      join(dir, `${idOld}.json`),
      lessonJSON({
        id: idOld,
        title: '오래되고 최근 재발 없는 교훈',
        verified: true,
        count: 0,
        last_seen: '2020-01-01T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(dir, `${idRecent}.json`),
      lessonJSON({
        id: idRecent,
        title: '방금 재발한 교훈',
        verified: true,
        count: 5,
        last_seen: now.toISOString(),
      }),
    );
  });

  afterAll(async () => {
    await cleanup(noteIds, [dir]);
  });

  it('raw 최근접 거리로는 idOld가 이기지만, decay 랭킹에서는 idRecent가 앞선다', async () => {
    const ranked = await recallLessonsDecayed(
      db,
      fixedQueryEmbedder,
      'query text is irrelevant — fixedQueryEmbedder ignores it',
      SIGNING_KEY,
      dir,
      5,
      now,
      30,
    );
    const idxOld = ranked.findIndex((h) => h.id === noteIds[0]);
    const idxRecent = ranked.findIndex((h) => h.id === noteIds[1]);
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxRecent).toBeGreaterThanOrEqual(0);
    // raw distance만으로는 idOld(0.05) < idRecent(0.2)라 idOld가 앞서야 정상이지만,
    // decay가 오래된 idOld에 큰 페널티를 줘 idRecent가 앞선다.
    expect(idxRecent).toBeLessThan(idxOld);
    const hitOld = ranked[idxOld];
    const hitRecent = ranked[idxRecent];
    expect(hitOld?.distance).toBeLessThan(hitRecent?.distance ?? Number.POSITIVE_INFINITY); // raw는 반대
    expect(hitOld?.score).toBeGreaterThan(hitRecent?.score ?? 0); // decay score는 뒤집힘
  });
});

describe('recallLessonsDecayed — 후보풀 확대(Math.max(k*4,20))가 raw top-k 밖 후보도 살린다', () => {
  // idFar: raw distance=0.15로 decoy 10개(0.01~0.10)보다 전부 멀어 raw rank 11위(k=5 밖) — 그러나
  // 방금 재발(age=0)이라 decay 페널티가 없다. decoy 10개는 raw로 더 가깝지만 전부 200일 전(무거운 decay
  // 페널티). 후보풀이 k(5)로 좁았다면 idFar는 애초에 후보에 안 들어와 최종 결과에 나타날 수 없다 —
  // pool=max(5*4,20)=20 확장이 있어야만 raw rank 11위인 idFar를 재정렬 대상에 포함시킬 수 있다.
  const idFar = randomUUID();
  const decoyIds = Array.from({ length: 10 }, () => randomUUID());
  let noteFar = '';
  let decoyNoteIds: string[] = [];
  let dir: string;
  const now = new Date('2026-08-19T00:00:00.000Z');
  const oldLastSeen = new Date(now.getTime() - 200 * 86_400_000).toISOString();

  const fixedQueryEmbedder: Embedder = {
    dimensions: DIM,
  identity: "stub:character-hash:v1:384",
    embed: () => Promise.resolve(basis(50)),
    embedBatch: (texts) => Promise.resolve(texts.map(() => basis(50))),
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loop-consolidate-pool-'));
    decoyNoteIds = [];
    for (let i = 0; i < decoyIds.length; i++) {
      const id = decoyIds[i] as string;
      const cosTheta = 1 - 0.01 * (i + 1); // distances 0.01..0.10 — 전부 idFar(distance 0.15)보다 raw로 더 가깝다.
      const noteId = await plantLessonNote(id, mix(50, 51, cosTheta), `pool decoy ${i}`);
      decoyNoteIds.push(noteId);
      writeFileSync(
        join(dir, `${id}.json`),
        lessonJSON({ id, title: `decoy ${i}`, verified: true, count: 0, last_seen: oldLastSeen }),
      );
    }
    noteFar = await plantLessonNote(idFar, mix(50, 51, 0.85), 'pool far fixture — 방금 재발');
    writeFileSync(
      join(dir, `${idFar}.json`),
      lessonJSON({ id: idFar, title: 'far recent', verified: true, count: 0, last_seen: now.toISOString() }),
    );
  });

  afterAll(async () => {
    await cleanup([...decoyNoteIds, noteFar], [dir]);
  });

  it('raw top-5(비확장)에는 idFar가 없지만, 확장된 후보풀(20)에선 decay로 1위까지 올라온다', async () => {
    const rawTop5 = await recallLessons(db, fixedQueryEmbedder, 'irrelevant', SIGNING_KEY, 5);
    expect(rawTop5.some((h) => h.id === noteFar)).toBe(false); // 전제 조건: k=5 raw로는 애초에 안 잡힘

    const decayed = await recallLessonsDecayed(
      db,
      fixedQueryEmbedder,
      'irrelevant',
      SIGNING_KEY,
      dir,
      5,
      now,
      30,
    );
    expect(decayed[0]?.id).toBe(noteFar); // 확장된 풀에서 재정렬돼 1위로 올라옴
  });
});
