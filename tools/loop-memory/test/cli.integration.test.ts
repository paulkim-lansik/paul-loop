import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createLoopDb, LOOP_DATABASE_URL } from '../src/client';
import { stubEmbedder } from '../src/embedding';
import { addNote, softDeleteNote } from '../src/ops';
import { memoryNote, memoryOp } from '../src/schema/memory';

// 통합(docker pgvector): 실제 CLI 서브프로세스를 굴려 graduate/recall JSON 계약을 end-to-end 증명한다.
// 훅이 의존하는 것은 정확히 이 argv 파싱 + stdout JSON shape이므로, 라이브러리 함수가 아니라 CLI를 스폰한다.
const { db, pool } = createLoopDb();

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
// write-path provenance(BAC-619) — 없으면 lesson recall이 fail-closed로 항상 빈 배열이라(README
// "위협모델"), 이 CLI 서브프로세스 테스트도 고정 테스트 secret을 명시로 심어준다(실 dev 워크스테이션의
// .env 값이 있어도 덮어써 결정적으로).
cliEnv.LOOP_MEMORY_SIGNING_KEY = 'bac-619-cli-test-signing-key';

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
    JSON.stringify({
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
    expect(r.status).toBe(0);
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
    expect(r.status).toBe(0);
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
      expect(r.status).toBe(0);
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
      expect(r.status).toBe(0);
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
      const r = runCli(['record-recall', '--hits', JSON.stringify(hits)]);
      expect(r.status).toBe(0);

      const rows = await db
        .select()
        .from(memoryOp)
        .where(
          and(eq(memoryOp.op, 'RECALL'), sql`${memoryOp.noteId} in (${noteA.id}, ${noteB.id})`),
        );
      expect(rows).toHaveLength(2);
      const byNote = new Map(rows.map((row) => [row.noteId, row.payload]));
      expect(byNote.get(noteA.id)).toEqual({ distance: 0.123, corpus: 'lessons' });
      expect(byNote.get(noteB.id)).toEqual({ distance: 0.045, corpus: 'knowledge' });
    } finally {
      await softDeleteNote(db, noteA.id, 'test cleanup');
      await softDeleteNote(db, noteB.id, 'test cleanup');
    }
  });

  it('--hits가 없거나 빈 배열이면 아무 것도 쓰지 않고 exit 0(no-op, fail-open과 일관)', () => {
    const r = runCli(['record-recall', '--hits', '[]']);
    expect(r.status).toBe(0);
  });
});
