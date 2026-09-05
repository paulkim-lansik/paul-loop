import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createLoopDb } from './helpers/postgres-fixture';
import { type Embedder, stubEmbedder } from '../src/embedding';
import {
  ADR_TAG,
  CONTEXT_TAG,
  graduateContext,
  graduateKnowledge,
  graduateMarkdownDir,
  type KnowledgeChunk,
  LOCK_NAMESPACE,
  RESEARCH_TAG,
  recallKnowledge,
  sha8,
  syncKnowledge,
} from '../src/knowledge';
import { softDeleteNote } from '../src/ops';
import { memoryNote, memoryOp } from '../src/schema/memory';

// 통합(docker pgvector): ADR 미러-싱크 4-op(ADD/UPDATE/DELETE/NOOP) + 원장 + recall을 end-to-end 증명.
const { db, pool } = createLoopDb();
const embedder = stubEmbedder();

// 이 회차만의 고유 태그/키 — DB가 회차 간 누적돼도 다른 노트를 건드리지 않게 격리.
const run = randomUUID().slice(0, 8);
const RUN_TAG = `kb:adr:test-${run}`;

const chunkFor = (tag: string, ns: string, section: string, body: string): KnowledgeChunk => {
  const content = `ADR-test ${ns} — ${section}\n\n${body}`;
  return {
    key: `kb:adr:${ns}#${section}`,
    tag,
    content,
    hash: sha8(content),
    context: `ADR-test ${ns}`,
  };
};
const chunk = (section: string, body: string): KnowledgeChunk =>
  chunkFor(RUN_TAG, run, section, body);

// 임베드된 텍스트 개수를 세는 래퍼 — "변경 없으면 재임베드 안 함"(비용 절감의 핵심)을 카운트가 아니라
// 실제로 증명. syncKnowledge는 BAC-368부터 embedBatch()로 ADD/UPDATE 대상을 한 번에 넘기므로, 두 경로
// (embed 단건·embedBatch 배치) 모두 "몇 개의 텍스트가 임베드됐는가"로 통일해서 센다. batchInvocations/
// singleInvocations는 "텍스트 개수는 맞는데 실은 배치가 아니라 단건 embed()를 N번 돌려서 맞춘" 회귀를
// 잡기 위한 것 — calls()만으로는 이 회귀를 구분 못 한다(총 텍스트 수는 어느 경로든 같으므로).
function countingEmbedder(base: Embedder = stubEmbedder()): {
  embedder: Embedder;
  calls: () => number;
  batchInvocations: () => number;
  singleInvocations: () => number;
} {
  let calls = 0;
  let batchInvocations = 0;
  let singleInvocations = 0;
  const embedder: Embedder = {
    dimensions: base.dimensions,
    identity: base.identity,
    embed: (text: string) => {
      calls += 1;
      singleInvocations += 1;
      return base.embed(text);
    },
    embedBatch: (texts: string[]) => {
      calls += texts.length;
      batchInvocations += 1;
      return base.embedBatch(texts);
    },
  };
  return {
    embedder,
    calls: () => calls,
    batchInvocations: () => batchInvocations,
    singleInvocations: () => singleInvocations,
  };
}

interface NoteRow {
  id: string;
  content: string;
  deletedAt: Date | null;
}

async function findNote(key: string): Promise<NoteRow | undefined> {
  const [row] = await db
    .select({ id: memoryNote.id, content: memoryNote.content, deletedAt: memoryNote.deletedAt })
    .from(memoryNote)
    .where(sql`${key} = any(${memoryNote.keywords})`)
    .orderBy(sql`${memoryNote.createdAt} desc`)
    .limit(1);
  return row;
}

async function tombstone(id: string) {
  const [row] = await db.select().from(memoryNote).where(eq(memoryNote.id, id));
  expect(row).toMatchObject({ content: '', embedding: null, provenance: null, keywords: [] });
  expect(row?.deletedAt).not.toBeNull();
  return row!;
}

async function mustFindNote(key: string): Promise<NoteRow> {
  const row = await findNote(key);
  if (!row) throw new Error(`expected a note for key ${key}`);
  return row;
}

async function opsFor(noteId: string): Promise<string[]> {
  const rows = await db
    .select({ op: memoryOp.op })
    .from(memoryOp)
    .where(eq(memoryOp.noteId, noteId));
  return rows.map((r) => r.op);
}

afterAll(async () => {
  const mine = await db
    .select({ id: memoryNote.id })
    .from(memoryNote)
    .where(sql`${RUN_TAG} = any(${memoryNote.tags})`);
  for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
  await pool.end();
});

describe('syncKnowledge — 미러-싱크 4-op + 원장 + recall', () => {
  it('ADD → NOOP(재실행) → UPDATE(섹션 편집) → DELETE(섹션 소실)을 멱등하게 수렴시키고 의미 recall된다', async () => {
    const ctx = chunk('컨텍스트', '멀티테넌트 격리는 RLS로 강제한다. withTenant 트랜잭션 스코프.');
    const decision = chunk(
      '결정',
      'Drizzle ORM을 채택한다. 트랜잭션 콜백으로 테넌트 GUC를 주입한다.',
    );

    // 1) ADD — 없는 키 2개.
    expect(await syncKnowledge(db, pool, embedder, RUN_TAG, [ctx, decision])).toEqual({
      added: 2,
      updated: 0,
      deleted: 0,
      noop: 0,
    });
    const ctxId = (await mustFindNote(ctx.key)).id;
    const decId = (await mustFindNote(decision.key)).id;
    expect(await opsFor(decId)).toContain('ADD');

    // 2) NOOP — 파일 변경 없이 재실행 = 전부 NOOP (멱등, 재임베드 없음).
    expect(await syncKnowledge(db, pool, embedder, RUN_TAG, [ctx, decision])).toEqual({
      added: 0,
      updated: 0,
      deleted: 0,
      noop: 2,
    });
    expect(await opsFor(decId)).not.toContain('NOOP'); // unchanged refresh must not append audit rows

    // 3) UPDATE — 결정 섹션 본문만 편집(새 hash) → 그 노트만 UPDATE, 컨텍스트는 NOOP.
    const decisionV2 = chunk(
      '결정',
      'Drizzle ORM을 채택한다. RLS FORCE + BYPASSRLS 없는 런타임 역할로 이중방어.',
    );
    expect(decisionV2.hash).not.toBe(decision.hash);
    expect(await syncKnowledge(db, pool, embedder, RUN_TAG, [ctx, decisionV2])).toEqual({
      added: 0,
      updated: 1,
      deleted: 0,
      noop: 1,
    });
    const decV2 = await mustFindNote(decision.key);
    expect(decV2.id).toBe(decId); // 같은 노트가 in-place 갱신
    expect(decV2.content).toContain('이중방어');
    expect(await opsFor(decId)).toContain('UPDATE');

    // 4) DELETE — 컨텍스트 섹션이 desired에서 사라짐 → soft-delete.
    expect(await syncKnowledge(db, pool, embedder, RUN_TAG, [decisionV2])).toEqual({
      added: 0,
      updated: 0,
      deleted: 1,
      noop: 1,
    });
    await tombstone(ctxId);
    expect(await opsFor(ctxId)).toContain('DELETE');

    // 5) recall — 결정 내용과 가까운 질의로 tag 필터 recall하면 결정 노트가 잡히고, 삭제된 컨텍스트는 빠진다.
    const hits = await recallKnowledge(
      db,
      embedder,
      '테넌트 격리 RLS 이중방어 Drizzle',
      5,
      RUN_TAG,
    );
    expect(hits.some((h) => h.id === decId)).toBe(true);
    expect(hits.some((h) => h.id === ctxId)).toBe(false);
  });

  it('변경 없는 재실행은 재임베드하지 않고(embed 0회), UPDATE는 정확히 1회만 임베드한다', async () => {
    const tag = `kb:adr:test-spy-${run}`;
    const spy = countingEmbedder();
    const a = chunkFor(tag, `spy-${run}`, '컨텍스트', 'RLS 격리 근거.');
    const b = chunkFor(tag, `spy-${run}`, '결정', 'Drizzle 채택.');

    await syncKnowledge(db, pool, spy.embedder, tag, [a, b]); // ADD → 2회 임베드
    const afterAdd = spy.calls();
    await syncKnowledge(db, pool, spy.embedder, tag, [a, b]); // NOOP → 재임베드 없음
    expect(spy.calls() - afterAdd).toBe(0);

    const a2 = chunkFor(tag, `spy-${run}`, '컨텍스트', 'RLS 격리 근거 (개정).');
    const beforeUpdate = spy.calls();
    await syncKnowledge(db, pool, spy.embedder, tag, [a2, b]); // UPDATE a(1) + NOOP b(0)
    expect(spy.calls() - beforeUpdate).toBe(1);

    // BAC-368: 텍스트 개수만 맞는 게 아니라 실제로 배치 경로(embedBatch)를 탄다는 것도 직접 증명 —
    // "총 텍스트 수는 맞는데 실은 embed()를 N번 돌려서 맞춘" 회귀는 위 카운트만으로는 못 잡는다.
    // ADD 2건 → embedBatch 1회(2텍스트), embed(단건) 0회. UPDATE 1건 → embedBatch 1회(1텍스트) 추가.
    expect(spy.singleInvocations()).toBe(0);
    expect(spy.batchInvocations()).toBe(2); // ADD 시점 1회 + UPDATE 시점 1회(NOOP만 있던 재실행은 0회 유지)

    const mine = await db
      .select({ id: memoryNote.id })
      .from(memoryNote)
      .where(sql`${tag} = any(${memoryNote.tags})`);
    for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
  });

  // 리뷰 지적(code-reviewer + silent-failure-hunter, PR #38 둘 다 최상위 항목으로 지적) — 지금까지의
  // 테스트는 매 syncKnowledge 호출이 toAdd 또는 toUpdate 둘 중 하나만 채워진 채로 돌았다. 그런데
  // knowledge.ts의 배치 재조립(embedTargets = [...toAdd, ...toUpdate], 공유 카운터 ei로 두 루프를
  // 순서대로 소진)이 실제로 위험한 지점은 *둘 다 비어있지 않을 때*의 경계다 — 이 테스트 전엔 그 경계를
  // 넘는 호출이 코드베이스에 하나도 없었다(회귀가 나도 green으로 통과했을 것). 게다가 개수/카운트가
  // 아니라 "각 노트가 자기 콘텐츠의 벡터를 받았는가"를 recall 정체성으로 직접 증명한다 — 벡터가
  // 뒤바뀌어도 개수·차원·정규화는 여전히 정상으로 보이는 조용한 손상 클래스라서.
  it('ADD 2건+UPDATE 1건이 한 호출에 섞여도 각 노트가 자기 콘텐츠의 임베딩을 받는다(배치 재조립 경계, BAC-368)', async () => {
    const tag = `kb:adr:test-mix-${run}`;
    const existing = chunkFor(tag, `mix-${run}`, '결정', 'AAAA 초기 콘텐츠 결정.');
    await syncKnowledge(db, pool, embedder, tag, [existing]); // 베이스라인 — 이걸 UPDATE 대상으로 쓴다.

    // 한 호출에 toAdd(2) + toUpdate(1)를 동시에 채워 embedTargets 경계·ei 공유 카운터를 실제로 넘긴다.
    const updated = chunkFor(tag, `mix-${run}`, '결정', 'ZZZZ 완전히 다른 개정 내용.');
    const addedX = chunkFor(tag, `mix-${run}`, '컨텍스트X', 'BBBB 신규 청크 X 콘텐츠.');
    const addedY = chunkFor(tag, `mix-${run}`, '컨텍스트Y', 'CCCC 신규 청크 Y 콘텐츠 전혀다름.');

    const result = await syncKnowledge(db, pool, embedder, tag, [addedX, addedY, updated]);
    expect(result).toEqual({ added: 2, updated: 1, deleted: 0, noop: 0 });

    const updatedId = (await mustFindNote(updated.key)).id;
    const addedXId = (await mustFindNote(addedX.key)).id;
    const addedYId = (await mustFindNote(addedY.key)).id;

    // 각 노트를 "자기 콘텐츠"로 질의하면 자기 자신이 top-1이어야 한다 — 벡터가 뒤바뀌었으면 실패한다
    // (서로 콘텐츠가 완전히 달라 cross-wiring이 있으면 다른 노트가 top-1으로 튀어나온다).
    const hitsForUpdated = await recallKnowledge(db, embedder, updated.content, 1, tag);
    expect(hitsForUpdated[0]?.id).toBe(updatedId);
    const hitsForX = await recallKnowledge(db, embedder, addedX.content, 1, tag);
    expect(hitsForX[0]?.id).toBe(addedXId);
    const hitsForY = await recallKnowledge(db, embedder, addedY.content, 1, tag);
    expect(hitsForY[0]?.id).toBe(addedYId);

    const mine = await db
      .select({ id: memoryNote.id })
      .from(memoryNote)
      .where(sql`${tag} = any(${memoryNote.tags})`);
    for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
  });
});

describe('syncKnowledge — 동시 졸업 advisory-lock 가드(BAC-367)', () => {
  // 동시성은 타이밍에 기대면 결정적으로 못 쓴다(issue 자신의 지적) — 별도 커넥션에서 같은 잠금을
  // *직접* 선점해 "다른 세션이 이미 돌고 있는 상태"를 재현한다. 진짜 두 프로세스 레이스가 아니라
  // 잠금 메커니즘 자체를 단정하는 것 — 그게 이 가드가 실제로 지키는 계약이다.
  it('다른 세션이 같은 tag의 잠금을 쥐고 있으면 이번 실행은 아무 것도 쓰지 않고 locked:true로 skip한다', async () => {
    const tag = `kb:adr:test-lock-${run}`;
    const chunk = chunkFor(tag, `lock-${run}`, '컨텍스트', '잠금 테스트 콘텐츠.');

    // 세션-스코프 락(pg_advisory_lock, xact 아님) — connect() 자체가 실패해도 반드시 pool.end()로
    // 정리되게 connect()도 바깥 try 안에(리뷰 지적: connect 실패 시 pool 누수 방지).
    const other = createLoopDb();
    try {
      const client = await other.pool.connect();
      try {
        const { rows } = await client.query(
          'select pg_try_advisory_lock($1, hashtext($2)) as locked',
          [LOCK_NAMESPACE, tag],
        );
        expect(rows[0]?.locked).toBe(true); // 선점 성공 — "다른 세션이 먼저 락을 쥔 상태"를 실제로 재현

        const result = await syncKnowledge(db, pool, embedder, tag, [chunk]);
        expect(result).toEqual({ added: 0, updated: 0, deleted: 0, noop: 0, locked: true });
        expect(await findNote(chunk.key)).toBeUndefined(); // 정말 아무 것도 안 씀(skip, 부분수행 아님)

        await client.query('select pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE, tag]);
      } finally {
        client.release();
      }
    } finally {
      // 세션-스코프 락은 release()만으론 안 풀린다(커넥션이 풀로 되돌아갈 뿐 안 닫힘) — pool.end()로
      // 실제 커넥션을 닫아야 postgres가 확실히 해제한다. unlock 호출이 중간에 스킵돼도 이게 최종 안전망.
      await other.pool.end();
    }

    // 잠금이 풀린 뒤엔 같은 태그·같은 청크로 재시도하면 정상 수렴한다(skip은 영구 손실이 아니다).
    const result2 = await syncKnowledge(db, pool, embedder, tag, [chunk]);
    expect(result2).toEqual({ added: 1, updated: 0, deleted: 0, noop: 0 });

    const mine = await db
      .select({ id: memoryNote.id })
      .from(memoryNote)
      .where(sql`${tag} = any(${memoryNote.tags})`);
    for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
  });
});

describe('graduateKnowledge — 파일 읽기 end-to-end + 폐기 제외', () => {
  it('디렉토리의 accepted ADR 섹션만 인덱싱하고, 폐기 ADR·템플릿·README는 제외한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-adr-'));
    // graduateKnowledge는 파일명 앞 숫자를 ADR 번호로 쓴다(^\d+) → 번호는 순수 숫자여야 한다(run은 hex).
    const numRun = String(Number.parseInt(run.slice(0, 6), 16));
    const acceptedId = `9${numRun}`; // 유일 번호
    const supersededId = `8${numRun}`;
    try {
      writeFileSync(
        join(dir, `${acceptedId}-accepted.md`),
        `# ADR-${acceptedId}: 채택된 결정\n\n- **상태**: accepted\n\n## 컨텍스트\n\n배경.\n\n## 결정\n\n채택 내용.\n`,
      );
      writeFileSync(
        join(dir, `${supersededId}-old.md`),
        `# ADR-${supersededId}: 폐기된 결정\n\n- **상태**: **폐기됨**\n\n## 결정\n\n옛 내용.\n`,
      );
      writeFileSync(join(dir, 'README.md'), '# 인덱스\n\n제외 대상.\n');
      writeFileSync(join(dir, '0000-template.md'), '# ADR-0000: 템플릿\n\n## 컨텍스트\n\n제외.\n');

      // accepted ADR의 2섹션만 ADD, 폐기/README/템플릿 0.
      const first = await graduateKnowledge(db, pool, embedder, dir);
      expect(first.added).toBe(2);
      expect(await findNote(`kb:adr:${acceptedId}#컨텍스트`)).toBeDefined();
      expect(await findNote(`kb:adr:${acceptedId}#결정`)).toBeDefined();
      expect(await findNote(`kb:adr:${supersededId}#결정`)).toBeUndefined();
      expect(await findNote('kb:adr:0000#컨텍스트')).toBeUndefined();

      // 재실행 = 멱등(내 ADR 2섹션은 NOOP, 새 ADD 없음).
      const second = await graduateKnowledge(db, pool, embedder, dir);
      expect(second.added).toBe(0);
    } finally {
      // 이 회차 kb:adr 노트 정리.
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(
          and(
            isNull(memoryNote.deletedAt),
            sql`${ADR_TAG} = any(${memoryNote.tags})`,
            sql`exists (select 1 from unnest(${memoryNote.keywords}) kw where kw like ${`kb:adr:${acceptedId}#%`})`,
          ),
        );
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepted로 인덱싱된 ADR을 폐기로 뒤집으면 다음 graduate에서 그 노트들이 soft-delete된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-adr-'));
    const numRun = String(Number.parseInt(run.slice(0, 6), 16));
    const flipId = `7${numRun}`; // 폐기로 뒤집힐 ADR
    const stableId = `6${numRun}`; // desired가 비지 않게 하는 안정 ADR(빈-desired 가드 회피)
    const acceptedFlip = `# ADR-${flipId}: 뒤집힐 결정\n\n- **상태**: accepted\n\n## 컨텍스트\n\n배경.\n\n## 결정\n\n내용.\n`;
    try {
      writeFileSync(join(dir, `${flipId}-x.md`), acceptedFlip);
      writeFileSync(
        join(dir, `${stableId}-stable.md`),
        `# ADR-${stableId}: 안정\n\n- **상태**: accepted\n\n## 결정\n\n유지.\n`,
      );
      await graduateKnowledge(db, pool, embedder, dir);
      const ctxId = (await mustFindNote(`kb:adr:${flipId}#컨텍스트`)).id;
      const decisionId = (await mustFindNote(`kb:adr:${flipId}#결정`)).id;
      expect((await mustFindNote(`kb:adr:${flipId}#컨텍스트`)).deletedAt).toBeNull();

      // 같은 파일 상태를 폐기로 뒤집는다(지정자 폐기됨) → 다음 graduate에서 desired에서 빠진다.
      writeFileSync(
        join(dir, `${flipId}-x.md`),
        acceptedFlip.replace(
          '- **상태**: accepted',
          `- **상태**: **폐기됨** (ADR-${stableId}로 대체)`,
        ),
      );
      await graduateKnowledge(db, pool, embedder, dir);

      // 뒤집힌 ADR의 두 노트는 soft-delete, 안정 ADR은 유지.
      await tombstone(ctxId);
      await tombstone(decisionId);
      expect((await mustFindNote(`kb:adr:${stableId}#결정`)).deletedAt).toBeNull();
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(
          and(
            isNull(memoryNote.deletedAt),
            sql`${ADR_TAG} = any(${memoryNote.tags})`,
            sql`exists (select 1 from unnest(${memoryNote.keywords}) kw where kw like ${`kb:adr:${flipId}#%`} or kw like ${`kb:adr:${stableId}#%`})`,
          ),
        );
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 리뷰 지적(pr-test-analyzer): 빈-desired 가드("잘못 가리킨 디렉토리가 전체 코퍼스를 지우면 안 된다")를
  // 실제로 증명하는 테스트가 어디에도 없었다 — 기존 두 테스트는 desired가 항상 비지 않게 fixture를 짜서
  // 가드 자체는 우회하고 있었다. 이 테스트가 그 갭을 메운다: 기존 kb:adr 노트가 있는 상태에서 desired=[]가
  // 나오는 디렉토리로 재실행해도 그 노트가 살아남는지 직접 확인.
  it('desired가 빈 디렉토리(README·템플릿만)로 재실행해도 기존 kb:adr 코퍼스를 지우지 않는다(빈-desired 가드)', async () => {
    const numRun = String(Number.parseInt(run.slice(0, 6), 16));
    const guardId = `5${numRun}`;
    const seedChunk = chunkFor(ADR_TAG, `guard-${run}`, '컨텍스트', `가드 테스트 노트 ${guardId}.`);
    const emptyDir = mkdtempSync(join(tmpdir(), 'loop-adr-empty-'));
    try {
      // 1) 기존 kb:adr 노트 하나를 심는다("이미 존재하는 코퍼스"를 흉내).
      await syncKnowledge(db, pool, embedder, ADR_TAG, [seedChunk]);
      const seedId = (await mustFindNote(seedChunk.key)).id;

      // 2) desired가 반드시 []가 되는 디렉토리(README·템플릿만, 둘 다 SKIP_FILES)로 graduateKnowledge 실행.
      writeFileSync(join(emptyDir, 'README.md'), '# 인덱스\n\n제외 대상.\n');
      writeFileSync(
        join(emptyDir, '0000-template.md'),
        '# ADR-0000: 템플릿\n\n## 컨텍스트\n\n제외.\n',
      );
      const result = await graduateKnowledge(db, pool, embedder, emptyDir);
      expect(result).toEqual({ added: 0, updated: 0, deleted: 0, noop: 0, incomplete: true });

      // 3) 가드가 없었다면 이 노트가 "desired에 없다"로 오인돼 soft-delete됐을 것 — 살아있어야 한다.
      expect((await mustFindNote(seedChunk.key)).deletedAt).toBeNull();
      expect(seedId).toBe((await mustFindNote(seedChunk.key)).id);
    } finally {
      await softDeleteNote(db, (await mustFindNote(seedChunk.key)).id, 'test cleanup');
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// BAC-355: CONTEXT.md·research/design 신규 소스 — 파일 읽기 end-to-end + skip 로깅 + 통합 recall.
describe('graduateContext — CONTEXT.md 파일 읽기 end-to-end', () => {
  it('용어 단위로 졸업하고, 재실행은 멱등(NOOP)이다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-context-'));
    const contextPath = join(dir, 'CONTEXT.md');
    try {
      writeFileSync(
        contextPath,
        `# repo\n\n## Framework — dev harness (${run})\n\n` +
          `**Verifier ${run}** (검증기):\n그라운드트루스 신호 ${run}.\n\n` +
          `**Gate ${run}**:\n위험기반 승인 게이트 ${run}.\n`,
      );
      const first = await graduateContext(db, pool, embedder, contextPath);
      expect(first.added).toBe(2);
      expect(
        await findNote(`kb:context:Framework — dev harness (${run}):Verifier ${run}`),
      ).toBeDefined();

      const second = await graduateContext(db, pool, embedder, contextPath);
      expect(second).toEqual({ added: 0, updated: 0, deleted: 0, noop: 2 });
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(and(isNull(memoryNote.deletedAt), sql`${memoryNote.content} like ${`%${run}%`}`));
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // graduateKnowledge와 같은 갭(위 참조) — graduateContext 자기 것도 실제로 증명.
  it('용어가 하나도 없는 CONTEXT.md(헤딩만, 서두 프로즈뿐)로 재실행해도 기존 kb:context 코퍼스를 지우지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-context-empty-'));
    const contextPath = join(dir, 'CONTEXT.md');
    const seedContent = `kb:context-test ${run} — 용어\n\n가드 테스트 노트.`;
    const seedKey = `kb:context:guard-${run}#용어`;
    try {
      await syncKnowledge(db, pool, embedder, CONTEXT_TAG, [
        {
          key: seedKey,
          tag: CONTEXT_TAG,
          content: seedContent,
          hash: sha8(seedContent),
          context: 'guard',
        },
      ]);
      const seedId = (await mustFindNote(seedKey)).id;

      // 헤딩만 있고 **용어**: 정의가 하나도 없음 → parseContextChunks가 [] → desired=[].
      writeFileSync(contextPath, `# repo\n\n## 헤딩만 있음\n\n용어 정의 없는 프리앰블 프로즈뿐.\n`);
      await expect(graduateContext(db, pool, embedder, contextPath)).rejects.toThrow('source_format_unrecognized');
      expect((await mustFindNote(seedKey)).deletedAt).toBeNull();
      expect(seedId).toBe((await mustFindNote(seedKey)).id);
    } finally {
      await softDeleteNote(db, (await mustFindNote(seedKey)).id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graduateMarkdownDir — research/design 공용 파일 읽기 + skip 로깅', () => {
  it('.md만 졸업하고, .html은 조용히 안 버리고 사유와 함께 skipped에 담는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-research-'));
    try {
      writeFileSync(
        join(dir, `${run}-doc.md`),
        `# 리서치 ${run}\n\n## 발견\n\n고유표식 ${run} 발견 내용.\n`,
      );
      writeFileSync(join(dir, `${run}-report.html`), '<html>텍스트 추출 미구현 대상</html>');

      const result = await graduateMarkdownDir(db, pool, embedder, dir, RESEARCH_TAG, dir);
      expect(result.added).toBe(1);
      expect(await findNote(`kb:research:${run}-doc#발견`)).toBeDefined();

      // silent truncation 금지(AC) — HTML은 skipped에 사유와 함께.
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.file).toBe(`${run}-report.html`);
      expect(result.skipped[0]?.reason).toMatch(/HTML/);

      // 재실행 = 멱등.
      const second = await graduateMarkdownDir(db, pool, embedder, dir, RESEARCH_TAG, dir);
      expect(second.added).toBe(0);
      expect(second.noop).toBe(1);
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(and(isNull(memoryNote.deletedAt), sql`${memoryNote.content} like ${`%${run}%`}`));
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // graduateKnowledge/graduateContext와 같은 갭 — graduateMarkdownDir 자기 것도 실제로 증명.
  it('.md가 하나도 없는 디렉토리(HTML만)로 재실행해도 기존 kb:research 코퍼스를 지우지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-research-empty-'));
    const seedContent = `kb:research-test ${run} — 발견\n\n가드 테스트 노트.`;
    const seedKey = `kb:research:guard-${run}#발견`;
    try {
      await syncKnowledge(db, pool, embedder, RESEARCH_TAG, [
        {
          key: seedKey,
          tag: RESEARCH_TAG,
          content: seedContent,
          hash: sha8(seedContent),
          context: 'guard',
        },
      ]);
      const seedId = (await mustFindNote(seedKey)).id;

      // .md가 전혀 없음(HTML만) → desired=[].
      writeFileSync(join(dir, `${run}-only.html`), '<html>텍스트 추출 미구현</html>');
      const result = await graduateMarkdownDir(db, pool, embedder, dir, RESEARCH_TAG, dir);
      expect(result.added).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expect((await mustFindNote(seedKey)).deletedAt).toBeNull();
      expect(seedId).toBe((await mustFindNote(seedKey)).id);
    } finally {
      await softDeleteNote(db, (await mustFindNote(seedKey)).id, 'test cleanup');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recallKnowledge — 다중 태그 합집합(BAC-355)', () => {
  it('기본값(KNOWLEDGE_TAGS)은 여러 kb:* 소스를 한 번에 recall하고, 단일 태그로 좁히면 그 소스만 나온다', async () => {
    // chunkFor()는 key를 kb:adr: 접두로 고정하므로(ADR 전용 헬퍼) 다른 태그엔 혼란스럽다 — 로컬로 직접 구성.
    const multiTagChunk = (tag: string, section: string, body: string): KnowledgeChunk => {
      const content = `${tag}-test ${run} — ${section}\n\n${body}`;
      return { key: `${tag}:${run}#${section}`, tag, content, hash: sha8(content), context: tag };
    };
    const ctxChunk = multiTagChunk(CONTEXT_TAG, '용어', `고유표식 ${run} 컨텍스트 용어 정의.`);
    const researchChunk = multiTagChunk(RESEARCH_TAG, '발견', `고유표식 ${run} 리서치 발견 내용.`);
    try {
      // 두 syncKnowledge 호출도 try 안 — 첫 호출이 커밋된 뒤 둘째가 던지면 finally 없이 고아 노트가
      // 남는다(리뷰 지적: RUN_TAG 아닌 태그라 파일 상단 afterAll의 RUN_TAG 청소망도 못 걸림).
      await syncKnowledge(db, pool, embedder, CONTEXT_TAG, [ctxChunk]);
      await syncKnowledge(db, pool, embedder, RESEARCH_TAG, [researchChunk]);

      // 기본값 — 두 태그 다 recall 대상에 들어간다(합집합).
      const both = await recallKnowledge(db, embedder, `고유표식 ${run}`, 10);
      expect(both.some((h) => h.content.includes('컨텍스트 용어'))).toBe(true);
      expect(both.some((h) => h.content.includes('리서치 발견'))).toBe(true);

      // 단일 태그로 좁히면 그 소스만.
      const onlyContext = await recallKnowledge(db, embedder, `고유표식 ${run}`, 10, CONTEXT_TAG);
      expect(onlyContext.some((h) => h.content.includes('컨텍스트 용어'))).toBe(true);
      expect(onlyContext.some((h) => h.content.includes('리서치 발견'))).toBe(false);
    } finally {
      const mine = await db
        .select({ id: memoryNote.id })
        .from(memoryNote)
        .where(and(isNull(memoryNote.deletedAt), sql`${memoryNote.content} like ${`%${run}%`}`));
      for (const n of mine) await softDeleteNote(db, n.id, 'test cleanup');
    }
  });
});
