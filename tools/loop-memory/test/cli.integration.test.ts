import { lessonJSON } from './helpers/postgres-fixture';
import { spawnSync } from './helpers/postgres-fixture';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createLoopDb, LOOP_DATABASE_URL } from './helpers/postgres-fixture';
import { stubEmbedder } from '../src/embedding';
import { LESSON_TAG } from '../src/lessons';
import { softDeleteNote } from '../src/ops';
import { addNote } from './helpers/postgres-fixture';
import { signContent } from '../src/provenance';
import { memoryNote, memoryOp } from '../src/schema/memory';

// 통합(docker pgvector): 실제 CLI 서브프로세스를 굴려 graduate/recall JSON 계약을 end-to-end 증명한다.
// 훅이 의존하는 것은 정확히 이 argv 파싱 + stdout JSON shape이므로, 라이브러리 함수가 아니라 CLI를 스폰한다.
const { db, pool } = createLoopDb(() => SIGNING_KEY);

// 이 회차만의 고유 표식 — 질의 토큰과 ADR 번호에 심어, DB에 다른 kb:adr/lesson 잔여가 있어도 내 노트가
// 유일 최근접이 되게. (게다가 내 fixture는 in-test stub 임베드, 실 코퍼스는 Gemini 임베드 → stub 질의 대비
// 실 노트는 거리 ~1.0 노이즈, run 토큰 공유하는 내 fixture가 압도적 최근접 → 공유 DB 오염에도 견고.)
const run = randomUUID().slice(0, 8);
// graduateKnowledge는 파일명 앞 숫자를 ADR 번호로 쓴다(^\d+) → 순수 숫자여야 한다(run은 hex).
const numRun = String(Number.parseInt(run.slice(0, 6), 16));
const adrId = `9${numRun}`;
const supersededId = `8${numRun}`;
// 4개 교훈 + 4섹션 ADR → k=3이 진짜 제약이 되게(비굶김·각자 쿼터를 증명하려면 코퍼스마다 k보다 많아야).
const lessonIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

// stub 임베더 강제(키 제거) → 결정적·무비용. graduate/recall이 같은 임베더여야 거리가 유의미하다(§3 함정).
// ''(delete 아님)로 — 존재하되 falsy라, 이 프로세스를 실행하는 셸에 실 키가 export돼 있어도 pickEmbedder가
// "키 없음"으로 읽는다(비결정·비용 함정 방지).
const cliEnv: NodeJS.ProcessEnv = { ...process.env };
cliEnv.OPENAI_API_KEY = '';
cliEnv.GEMINI_API_KEY = '';
cliEnv.LOOP_DATABASE_URL = LOOP_DATABASE_URL; // 서브프로세스가 같은 DB를 보게
// 이슈 #35 — '' (delete 아님, 위 두 키와 같은 이유)로 존재하되 falsy: 이 프로세스를 실행하는 셸에
// LOOP_MEMORY_SOURCE가 export돼 있어도(예: 사람이 훅 디버깅 중) "source 없음" 테스트들이 결정적이게.
cliEnv.LOOP_MEMORY_SOURCE = '';
// write-path provenance(BAC-619) — 없으면 lesson recall이 fail-closed로 항상 빈 배열이라(README
// "위협모델"), 이 CLI 서브프로세스 테스트도 고정 테스트 secret을 명시로 심어준다(실 dev 워크스테이션의
// .env 값이 있어도 덮어써 결정적으로).
const SIGNING_KEY = 'bac-619-cli-test-signing-key'; // gitleaks:allow — fixed test fixture
cliEnv.LOOP_MEMORY_SIGNING_KEY = SIGNING_KEY;

const tsx = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(tsx, [cli, ...args], { encoding: 'utf8', env: cliEnv, timeout: 30000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const lessonsDir = mkdtempSync(join(tmpdir(), 'loop-cli-lessons-'));
const adrDir = mkdtempSync(join(tmpdir(), 'loop-cli-adr-'));

// 검증된 교훈 4건(졸업 대상). 코퍼스-고유 토큰 `blocked`(ADR엔 없음) + 공유 토큰 `run`.
for (const [i, id] of lessonIds.entries()) {
  writeFileSync(
    join(lessonsDir, `${id}.json`),
    lessonJSON({
      id,
      title: `withTenant 누락 RLS 교훈${i} ${run}`,
      fix: 'withTenant 트랜잭션 스코프 주입',
      source: 'loop-fix',
      verified: true,
      signature: [`rls blocked ${run} sig${i}`],
    }),
  );
}
// 채택 ADR(4섹션) + 폐기 ADR(제외 대상). 코퍼스-고유 토큰 `채택`(교훈엔 없음) + 공유 토큰 `run`.
writeFileSync(
  join(adrDir, `${adrId}-x.md`),
  `# ADR-${adrId}: 결선 결정 ${run}\n\n- **상태**: accepted\n\n` +
    `## 컨텍스트\n\n고유표식 ${run} 채택 배경 withTenant RLS 격리.\n\n` +
    `## 결정\n\n고유표식 ${run} 채택 Drizzle 트랜잭션 withTenant 격리.\n\n` +
    `## 결과\n\n고유표식 ${run} 채택 결과 트레이드오프 격리.\n\n` +
    `## 근거\n\n고유표식 ${run} 채택 근거 RLS 이중방어 격리.\n`,
);
writeFileSync(
  join(adrDir, `${supersededId}-old.md`),
  `# ADR-${supersededId}: 폐기 ${run}\n\n- **상태**: **폐기됨**\n\n## 결정\n\n옛 내용 ${run}.\n`,
);

afterAll(async () => {
  // 내 노트는 전부 content에 run을 담는다(교훈 title/signature·ADR provenance) → 한 clause로 정리.
  const mine = await db
    .select({ id: memoryNote.id })
    .from(memoryNote)
    .where(sql`${memoryNote.content} like ${`%${run}%`}`);
  for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
  rmSync(lessonsDir, { recursive: true, force: true });
  rmSync(adrDir, { recursive: true, force: true });
  await pool.end();
});

describe('cli — graduate/recall knowledge 결선 (서브프로세스 end-to-end)', () => {
  it('graduate --knowledge는 lessons와 ADR 코퍼스를 둘 다 졸업하고 폐기 ADR은 제외한다', () => {
    const r = runCli(['graduate', '--lessons', lessonsDir, '--knowledge', adrDir, '--allow-stub']);
    expect(r.status, r.stderr).toBe(0);
    // lessons 카운트 라인(4건).
    expect(r.stdout).toMatch(/graduated 4 new lesson/);
    // knowledge 카운트 라인 — 채택 ADR의 4섹션만 ADD(폐기 ADR의 섹션이 세어졌다면 5가 된다 → 제외 증명).
    expect(r.stdout).toMatch(/knowledge/i);
    expect(r.stdout).toMatch(/4 added/);
  });

  it('recall --json은 {lessons, knowledge}를 각자 k로 분리해 내고(비굶김) 코퍼스를 뒤섞지 않는다', () => {
    // 질의는 두 코퍼스와 겹치는 토큰 + 유일 토큰 run을 담아 양쪽에서 내 fixture가 최근접이 되게.
    const r = runCli([
      'recall',
      '--query',
      `고유표식 ${run} 채택 withTenant RLS blocked 격리`,
      '--json',
      '--k',
      '3',
      '--allow-stub',
    ]);
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    expect(line, `expected a JSON object line, got: ${r.stdout}`).toBeDefined();
    const parsed = JSON.parse(line as string) as {
      lessons: Array<{ id: string; content: string; distance: number }>;
      knowledge: Array<{ id: string; content: string; distance: number }>;
    };
    // 각자 k 존중 — 코퍼스마다 4개 중 정확히 top-3(단일 union top-3였다면 한쪽이 3 미만이 된다).
    expect(parsed.lessons.length).toBe(3);
    expect(parsed.knowledge.length).toBe(3);
    // 반환된 것이 전부 내 fixture(최근접) — 공유 DB 오염과 무관하게 run 토큰이 지배.
    expect(parsed.lessons.every((h) => h.content.includes(run))).toBe(true);
    expect(parsed.knowledge.every((h) => h.content.includes(run))).toBe(true);
    // 코퍼스 라벨이 안 뒤바뀜(swap 방지): lessons엔 lesson-고유 토큰, knowledge엔 ADR-고유 토큰.
    // (recall 훅이 코퍼스별로 *다른 거리컷오프*를 적용하므로 swap은 조용히 잘못된 컷오프를 쓰게 만든다.)
    expect(parsed.lessons.every((h) => h.content.includes('blocked'))).toBe(true);
    expect(parsed.knowledge.every((h) => h.content.includes('채택'))).toBe(true);
    // distance는 훅이 typeof === 'number'로 거르므로 런타임 타입도 잠근다.
    expect(typeof parsed.knowledge[0]?.distance).toBe('number');
  });

  it('graduate는 --knowledge 없으면 knowledge 경로를 건너뛴다(조건부 분기)', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'loop-cli-empty-'));
    try {
      const r = runCli(['graduate', '--lessons', emptyDir, '--allow-stub']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/graduated 0 new lesson/);
      expect(r.stdout).not.toMatch(/knowledge/i); // knowledge 라인 없음
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // 리뷰 지적(pr-test-analyzer): graduateMarkdownDir의 skipped[]는 라이브러리 레벨로 검증됐지만,
  // "silent truncation 금지" AC가 실제로 사람/운영자에게 보이는 지점은 CLI stdout(graduate-lessons.mjs
  // 훅은 의도적 무출력이라 이 CLI 출력이 유일한 관측 지점) — 그게 검증 안 돼 있었다. 여기서 직접 증명.
  it('graduate --research는 .md 아닌 파일(HTML)을 사유와 함께 stdout에 찍는다(silent truncation 금지)', async () => {
    const researchDir = mkdtempSync(join(tmpdir(), 'loop-cli-research-'));
    const emptyLessonsDir = mkdtempSync(join(tmpdir(), 'loop-cli-empty2-'));
    try {
      writeFileSync(
        join(researchDir, `${run}-doc.md`),
        `# 리서치 ${run}\n\n## 발견\n\n고유표식 ${run} 발견.\n`,
      );
      writeFileSync(join(researchDir, `${run}-report.html`), '<html>skip 대상</html>');

      const r = runCli([
        'graduate',
        '--lessons',
        emptyLessonsDir,
        '--research',
        researchDir,
        '--allow-stub',
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/knowledge \(research\) — 1 added/);
      // 실제 AC 표면 — 사유 포함 skip 줄이 stdout에 있어야 한다(라이브러리 skipped[] 값이 아니라).
      expect(r.stdout).toContain(`${run}-report.html`);
      expect(r.stdout).toMatch(/HTML/);
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(sql`${memoryNote.content} like ${`%${run}%`}`);
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(researchDir, { recursive: true, force: true });
      rmSync(emptyLessonsDir, { recursive: true, force: true });
    }
  });
});

// 이슈 #35: hooks/*.mjs가 CLI 서브프로세스를 spawn할 때만 LOOP_MEMORY_SOURCE=hook을 심고, cli.ts가 그
// 값을 graduate/record-recall이 쓰는 memory_op 행의 payload.source로 흘려보내는 배관을 CLI 서브프로세스
// 경계까지 포함해 end-to-end로 증명한다(hooks/*.mjs 자체는 별도 프로세스라 이 테스트가 흉내내는 것이
// 실제 계약). ⚠️ 이 태그는 자기신고 메타데이터일 뿐이다 — 셸 접근이 있는 누구나 같은 env를 손으로
// 심어 이 테스트가 검증하는 것과 동일한 payload.source="hook" 행을 만들 수 있다. 이 테스트는 배관이
// 정확한지를 증명하는 것이지, 실제 라이브 세션에서 훅이 발동했다는 증거를 만드는 게 아니다(이슈 #35의
// 그 부분은 여전히 미해결).
describe('cli — LOOP_MEMORY_SOURCE env → memory_op.payload.source (issue #35, 훅 경로 표시 태그 배관)', () => {
  it('LOOP_MEMORY_SOURCE=hook으로 graduate를 돌리면 ADD 행의 payload.source가 "hook"으로 남는다', async () => {
    const id = randomUUID();
    const key = `lesson:${id}`;
    const dir = mkdtempSync(join(tmpdir(), 'loop-cli-source-tagged-'));
    writeFileSync(
      join(dir, `${id}.json`),
      lessonJSON({
        id,
        title: `source env 확인 교훈 ${run}`,
        fix: 'LOOP_MEMORY_SOURCE=hook',
        source: 'manual',
        verified: true,
        signature: [`source env fixture ${run}`],
      }),
    );
    try {
      const r = spawnSync(tsx, [cli, 'graduate', '--lessons', dir, '--allow-stub'], {
        encoding: 'utf8',
        env: { ...cliEnv, LOOP_MEMORY_SOURCE: 'hook' },
        timeout: 30000,
      });
      expect(r.status, r.stderr).toBe(0);
      const [note] = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(sql`${key} = any(${memoryNote.keywords})`);
      expect(note).toBeDefined();
      const [op] = await db
        .select({ payload: memoryOp.payload })
        .from(memoryOp)
        .where(and(eq(memoryOp.noteId, note?.id as string), eq(memoryOp.op, 'ADD')));
      expect((op?.payload as Record<string, unknown> | null)?.source).toBe('hook');
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(sql`${key} = any(${memoryNote.keywords})`);
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('LOOP_MEMORY_SOURCE 없이(수동 CLI 호출) graduate를 돌리면 payload에 source 키가 없다', async () => {
    const id = randomUUID();
    const key = `lesson:${id}`;
    const dir = mkdtempSync(join(tmpdir(), 'loop-cli-source-absent-'));
    writeFileSync(
      join(dir, `${id}.json`),
      lessonJSON({
        id,
        title: `source 부재 확인 교훈 ${run}`,
        fix: '수동 CLI 호출은 LOOP_MEMORY_SOURCE를 안 심는다',
        source: 'manual',
        verified: true,
        signature: [`source absent fixture ${run}`],
      }),
    );
    try {
      const r = runCli(['graduate', '--lessons', dir, '--allow-stub']); // cliEnv에는 LOOP_MEMORY_SOURCE가 ''(falsy)
      expect(r.status, r.stderr).toBe(0);
      const [note] = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(sql`${key} = any(${memoryNote.keywords})`);
      expect(note).toBeDefined();
      const [op] = await db
        .select({ payload: memoryOp.payload })
        .from(memoryOp)
        .where(and(eq(memoryOp.noteId, note?.id as string), eq(memoryOp.op, 'ADD')));
      expect(Object.hasOwn((op?.payload ?? {}) as object, 'source')).toBe(false);
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(sql`${key} = any(${memoryNote.keywords})`);
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// BAC-586 선행 슬라이스: 훅이 실제 주입 확정한 노트 id를 memory_op에 RECALL 행으로 남기는 계측.
// 임베더가 필요 없다(노트/거리는 훅이 이미 확정한 값을 그대로 적을 뿐) — 키 없이도 동작해야 한다.
describe('cli — record-recall (계측, 임베더 불필요)', () => {
  it('훅이 넘긴 주입-확정 노트 id마다 memory_op에 RECALL 행을 append한다(lessons+knowledge 혼합 배열)', async () => {
    // 실제 훅은 nearLessons+nearKnowledge를 한 배열로 합쳐 한 번에 넘긴다 — 단건이 아니라 이 형태로 검증.
    const stub = stubEmbedder();
    const noteA = await addNote(db, stub, { content: `record-recall 계측 대상 A ${run}` });
    const noteB = await addNote(db, stub, { content: `record-recall 계측 대상 B ${run}` });
    try {
      const hits = [
        { id: noteA.id, distance: 0.123, corpus: 'lessons' },
        { id: noteB.id, distance: 0.045, corpus: 'knowledge' },
      ];
      const r = runCli(['record-recall', '--hits', lessonJSON(hits)]);
      expect(r.status, r.stderr).toBe(0);

      const rows = await db
        .select()
        .from(memoryOp)
        .where(
          and(eq(memoryOp.op, 'RECALL'), sql`${memoryOp.noteId} in (${noteA.id}, ${noteB.id})`),
        );
      expect(rows).toHaveLength(2);
      const byNote = new Map(rows.map((row) => [row.noteId, row.payload]));
      expect(byNote.get(noteA.id)).toEqual({ distance: 0.123, corpus: noteA.corpus });
      expect(byNote.get(noteB.id)).toEqual({ distance: 0.045, corpus: noteB.corpus });
    } finally {
      await softDeleteNote(db, noteA.id, 'test cleanup');
      await softDeleteNote(db, noteB.id, 'test cleanup');
    }
  });

  // 이슈 #35: hooks/recall-lessons.mjs가 record-recall 하위프로세스에 LOOP_MEMORY_SOURCE=hook을 심는
  // 실제 경로 — 그 값이 CLI를 거쳐 payload.source로 남는지 서브프로세스 경계까지 포함해 증명한다.
  it('LOOP_MEMORY_SOURCE=hook으로 record-recall을 돌리면 RECALL 행의 payload.source가 "hook"으로 남는다', async () => {
    const stub = stubEmbedder();
    const note = await addNote(db, stub, { content: `record-recall source 태그 대상 ${run}` });
    try {
      const hits = [{ id: note.id, distance: 0.2, corpus: 'lessons' }];
      const r = spawnSync(tsx, [cli, 'record-recall', '--hits', lessonJSON(hits)], {
        encoding: 'utf8',
        env: { ...cliEnv, LOOP_MEMORY_SOURCE: 'hook' },
        timeout: 30000,
      });
      expect(r.status, r.stderr).toBe(0);
      const rows = await db
        .select()
        .from(memoryOp)
        .where(and(eq(memoryOp.op, 'RECALL'), eq(memoryOp.noteId, note.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({ distance: 0.2, corpus: note.corpus, source: 'hook' });
    } finally {
      await softDeleteNote(db, note.id, 'test cleanup');
    }
  });

  it('--hits가 없거나 빈 배열이면 아무 것도 쓰지 않고 exit 0(no-op, fail-open과 일관)', () => {
    const r = runCli(['record-recall', '--hits', '[]']);
    expect(r.status, r.stderr).toBe(0);
  });
});

// consolidate 서브커맨드(BAC/paul-loop #12, sleep-time consolidation) — 임베더가 필요 없다(이미 저장된
// 임베딩끼리 코사인 거리를 재는 것뿐). 노트는 addNote로 직접 심어 정확한 거리를 통제한다(graduate를
// 거치지 않는다 — consolidate.integration.test.ts와 같은 패턴).
describe('cli — consolidate (sleep-time consolidation, 서브프로세스 end-to-end)', () => {
  it('LOOP_MEMORY_SIGNING_KEY가 있으면 사실상 동일한 서명된 노트 쌍을 dedup 후보로 보고한다', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const contentA = `consolidate cli fixture A ${run}`;
    const contentB = `consolidate cli fixture B (사실상 동일) ${run}`;
    const stub = stubEmbedder();
    const embedding = await stub.embed(`consolidate cli shared vector ${run}`);
    const noteA = await addNote(db, stub, {
      content: contentA,
      keywords: [`lesson:${idA}`],
      tags: [LESSON_TAG, 'manual'],
      context: 'manual',
      embedding,
      provenance: signContent(contentA, SIGNING_KEY),
    });
    const noteB = await addNote(db, stub, {
      content: contentB,
      keywords: [`lesson:${idB}`],
      tags: [LESSON_TAG, 'manual'],
      context: 'manual',
      embedding, // A와 완전히 같은 벡터 — distance=0, dedup 문턱(기본 0.05) 안.
      provenance: signContent(contentB, SIGNING_KEY),
    });
    try {
      const r = runCli(['consolidate', '--json']);
      expect(r.status, r.stderr).toBe(0);
      const line = r.stdout.split('\n').find((l) => l.trim().startsWith('{'));
      expect(line, `expected a JSON object line, got: ${r.stdout}`).toBeDefined();
      const report = JSON.parse(line as string) as {
        duplicates: Array<{ lessonIds: string[] }>;
        promotionSignals: Array<{ lessonId: string; peerLessonIds: string[] }>;
      };
      expect(
        report.duplicates.some((c) => c.lessonIds.includes(idA) && c.lessonIds.includes(idB)),
      ).toBe(true);
    } finally {
      await softDeleteNote(db, noteA.id, 'test cleanup');
      await softDeleteNote(db, noteB.id, 'test cleanup');
    }
  });

  it('LOOP_MEMORY_SIGNING_KEY 없으면 duplicate 후보가 실제로 있어도 빈 결과(fail-closed, BAC-619)', () => {
    // signingKey를 안 준 별도 env — cliEnv를 그대로 복제하되 이 값만 비운다(다른 테스트에 영향 없음).
    const envNoKey: NodeJS.ProcessEnv = { ...cliEnv, LOOP_MEMORY_SIGNING_KEY: '' };
    const r = spawnSync(tsx, [cli, 'consolidate', '--json'], {
      encoding: 'utf8',
      env: envNoKey,
      timeout: 30000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/signing_key_missing/);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: 'consolidate', outcome: 'error', reason: 'signing_key_missing' });
  });
});

// recall --decay(BAC/paul-loop #12) — lessons 코퍼스만 decay 랭킹으로 재정렬한다. 쿼리 텍스트를 실제로
// CLI가 쓰는 stubEmbedder로 미리 임베드해(같은 함수를 이 테스트 프로세스에서도 그대로 호출) 정확한
// raw distance를 통제한다 — 그람-슈미트로 그 벡터와 직교하는 축을 뽑아 코사인 유사도를 정확한 값으로
// 섞는다(consolidate.integration.test.ts의 basis/mix와 같은 발상, 다만 기준벡터가 임의값이라 직접 만든다).
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
function normalizeVec(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
}
function orthogonalUnit(v: number[]): number[] {
  const dim = v.length;
  const seed = new Array(dim).fill(0);
  const axis = Math.abs(v[0] ?? 0) < 0.9 ? 0 : 1; // v의 지배축을 피해 시작축을 고른다.
  seed[axis] = 1;
  const proj = dot(seed, v);
  return normalizeVec(seed.map((x, i) => x - proj * (v[i] ?? 0)));
}
/** v(단위벡터)와 코사인 유사도가 정확히 cosTheta인 단위벡터. distance = 1 - cosTheta가 정확히 보장된다. */
function mixToward(v: number[], cosTheta: number): number[] {
  const w = orthogonalUnit(v);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  return v.map((x, i) => cosTheta * x + sinTheta * (w[i] ?? 0));
}

describe('cli — recall --decay (서브프로세스 end-to-end)', () => {
  it('JSON 출력은 score(decay-adjusted)로 정렬되고, 텍스트 출력도 raw distance가 아니라 그 score를 찍는다', async () => {
    const idOld = randomUUID(); // raw로 더 가깝지만(강한 매칭) 아주 오래 전 마지막 재발
    const idRecent = randomUUID(); // raw로는 더 멀지만(약한 매칭) 방금 재발
    const queryText = `decay cli fixture 질의 ${run}`;
    const stub = stubEmbedder();
    const queryVec = normalizeVec(await stub.embed(queryText));
    const oldVec = mixToward(queryVec, 0.95); // distance = 0.05(강한 매칭)
    const recentVec = mixToward(queryVec, 0.8); // distance = 0.2(약한 매칭)
    const contentOld = `decay cli fixture old ${run}`;
    const contentRecent = `decay cli fixture recent ${run}`;

    const noteOld = await addNote(db, stub, {
      content: contentOld,
      keywords: [`lesson:${idOld}`],
      tags: [LESSON_TAG, 'manual'],
      context: 'manual',
      embedding: oldVec,
      provenance: signContent(contentOld, SIGNING_KEY),
    });
    const noteRecent = await addNote(db, stub, {
      content: contentRecent,
      keywords: [`lesson:${idRecent}`],
      tags: [LESSON_TAG, 'manual'],
      context: 'manual',
      embedding: recentVec,
      provenance: signContent(contentRecent, SIGNING_KEY),
    });

    const decayLessonsDir = mkdtempSync(join(tmpdir(), 'loop-cli-decay-'));
    // count=0·halfLifeDays=30(CLI 기본값) 기준 90일 전 → decayFactor=2^3=8 → score=0.05*8=0.4(idRecent의
    // raw 0.2보다 크다 — raw로는 idOld가 이기지만 decay로는 idRecent가 이기도록 뒤집는다).
    const oldLastSeen = new Date(Date.now() - 90 * 86_400_000).toISOString();
    writeFileSync(
      join(decayLessonsDir, `${idOld}.json`),
      lessonJSON({ id: idOld, title: 'old', verified: true, count: 0, last_seen: oldLastSeen }),
    );
    writeFileSync(
      join(decayLessonsDir, `${idRecent}.json`),
      lessonJSON({
        id: idRecent,
        title: 'recent',
        verified: true,
        count: 0,
        last_seen: new Date().toISOString(),
      }),
    );

    try {
      const jsonR = runCli([
        'recall',
        '--query',
        queryText,
        '--json',
        '--decay',
        '--k',
        '5',
        '--lessons',
        decayLessonsDir,
        '--allow-stub',
      ]);
      expect(jsonR.status).toBe(0);
      const line = jsonR.stdout.split('\n').find((l) => l.trim().startsWith('{'));
      expect(line, `expected a JSON object line, got: ${jsonR.stdout}`).toBeDefined();
      const parsed = JSON.parse(line as string) as {
        lessons: Array<{ id: string; content: string; distance: number; score: number }>;
      };
      const hitOld = parsed.lessons.find((h) => h.id === noteOld.id);
      const hitRecent = parsed.lessons.find((h) => h.id === noteRecent.id);
      expect(hitOld, `expected idOld in lessons, got: ${lessonJSON(parsed.lessons)}`).toBeDefined();
      expect(hitRecent).toBeDefined();
      // raw distance는 idOld가 더 작다(더 가깝다)지만, decayed score는 뒤집힌다.
      expect(hitOld?.distance).toBeLessThan(hitRecent?.distance ?? Number.POSITIVE_INFINITY);
      expect(hitOld?.score).toBeGreaterThan(hitRecent?.score ?? 0);
      // JSON 배열 순서 자체가 score 오름차순 — idRecent가 idOld보다 앞선다.
      const idxOld = parsed.lessons.findIndex((h) => h.id === noteOld.id);
      const idxRecent = parsed.lessons.findIndex((h) => h.id === noteRecent.id);
      expect(idxRecent).toBeLessThan(idxOld);

      // 텍스트(non-JSON) 출력 — 리뷰 지적(고칠 것 2): 정렬에 쓰인 decayed score를 찍어야지 raw distance를
      // 찍으면 안 된다. idOld 줄의 표시값이 score(0.4 근방)여야지 raw distance(0.05)면 버그.
      const textR = runCli([
        'recall',
        '--query',
        queryText,
        '--decay',
        '--k',
        '5',
        '--lessons',
        decayLessonsDir,
        '--allow-stub',
      ]);
      expect(textR.status).toBe(0);
      const lessonsSection = textR.stdout.split('knowledge:')[0] ?? '';
      const lineFor = (marker: string) =>
        lessonsSection.split('\n').find((l) => l.includes(marker));
      const oldLine = lineFor('fixture old');
      const recentLine = lineFor('fixture recent');
      expect(oldLine, `expected a text line for idOld, got: ${lessonsSection}`).toBeDefined();
      expect(recentLine).toBeDefined();
      const numOf = (l: string) => Number(l.match(/\(([\d.]+)\)/)?.[1]);
      expect(numOf(oldLine as string)).toBeCloseTo(hitOld?.score as number, 2);
      expect(numOf(oldLine as string)).not.toBeCloseTo(hitOld?.distance as number, 2);
      expect(numOf(recentLine as string)).toBeCloseTo(hitRecent?.score as number, 2);
    } finally {
      await softDeleteNote(db, noteOld.id, 'test cleanup');
      await softDeleteNote(db, noteRecent.id, 'test cleanup');
      rmSync(decayLessonsDir, { recursive: true, force: true });
    }
  });
});
