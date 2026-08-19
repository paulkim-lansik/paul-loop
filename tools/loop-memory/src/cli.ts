#!/usr/bin/env node
/**
 * loop-memory CLI — the deterministic wiring the Claude Code hooks call (방향 A, 훅 기반 구동).
 *
 * `claude -p`(헤드리스 에이전트, M5)를 쓰지 않으므로, 의미 recall은 *훅*이 이 CLI를 호출해 굴린다:
 *   SessionStart  → `graduate` : 검증된 파일 교훈(.loop/lessons)을 pgvector 의미층으로 졸업(멱등).
 *   UserPromptSubmit → `recall` : 현재 프롬프트/실패를 임베드해 의미적으로 가까운 교훈 top-k를 회상.
 *
 * 임베더: 키(OPENAI_API_KEY / GEMINI_API_KEY — plugin hooks inject these from userConfig; a
 * standalone CLI invocation reads them straight from the shell, no .env file involved)가 있으면
 * `apiEmbedder`, 없으면 기본은 **거부(exit 1)** — 스토어가 실 임베더로 채워졌는데 stub으로 질의/졸업하면
 * 결과가 비어 있는 게 아니라 조용히 틀린 값이 되기 때문. 명시적으로 stub을 쓰려면
 * `--allow-stub`(오프라인 수동 배선 점검 전용, 경고를 낸다).
 * ⚠️ graduate와 recall은 **같은 임베더**여야 거리가 유의미하다(stub 저장 + API 질의 = 쓰레기).
 * 그래서 훅은 *키가 있을 때만* 이 CLI를 부른다 — pgvector 스토어는 실 임베더로만 채워진다.
 *
 * Commands:
 *   loop-memory graduate      [--lessons <dir>] [--knowledge <adrDir>] [--context <file>]
 *                             [--research <dir>] [--design <dir>] [--allow-stub]
 *   loop-memory recall        (--query "<text>" | --query-file <f>) [--k N] [--json] [--decay] [--allow-stub]
 *                             --decay: lessons 코퍼스만 decay 랭킹(오래되고 최근 재발 없는 교훈은 감쇠)
 *                             으로 재정렬 — knowledge 코퍼스는 영향 없음(파일 count/lastSeen 개념이 없다).
 *   loop-memory consolidate   [--json]   — sleep-time consolidation 배치(BAC/paul-loop #12, read-only):
 *                             dedup 병합 후보 + 승격 사전 채점 신호를 한 번에 스캔해 보고한다. 실시간
 *                             훅 경로가 아니라 사람/주기 실행 전용 — 아무것도 쓰지 않는다(자동 병합·삭제
 *                             ·승격 없음, 후보만 표시).
 *   loop-memory stats         [--json]   — 읽기 전용 스토어 요약(임베더/키 불필요). loop-doctor가 호출.
 *   loop-memory record-recall --hits <json>  — 훅이 실제 주입 확정한 노트를 memory_op에 RECALL 행으로
 *                             남긴다(계측, BAC-586). --hits는 [{id, distance?, corpus?}, ...] JSON
 *                             배열. 임베더 불필요(키 없이도 동작) — 이미 확정된 값을 그대로 적을 뿐.
 *
 * knowledge 코퍼스는 4개 소스(BAC-355) — ADR(kb:adr)·CONTEXT.md 글로서리(kb:context)·
 * docs/research(kb:research)·docs/product/design(kb:design). 각자 독립 플래그, 안 주면 그 소스는
 * 건너뛴다. recall은 **코퍼스별로 분리**해 낸다(ADR-0033 §5): lessons(tag=lesson)와 knowledge(4개
 * kb:* 태그 합집합)를 각자 top-k 질의해 `{lessons, knowledge}`로 반환 — 단일 top-k는 한 코퍼스가
 * 독식한다. 거리컷오프·untrusted 프레이밍은 호출자(훅)가 코퍼스별로 적용한다.
 *
 * Exit: 0 ok · 2 usage · 1 runtime(연결/임베드 실패). 호출자(훅)는 nonzero/빈 출력을 "회상 없음"으로
 * 보고 그냥 진행한다(fail-open) — 메모리 인프라가 없거나 죽어도 세션을 절대 막지 않는다.
 *
 * `LOOP_MEMORY_SOURCE`(paul-loop 이슈 #35): graduate/record-recall이 쓰는 memory_op 행의 `payload.source`
 * 로 그대로 남는 호출 출처 태그. hooks/*.mjs가 이 CLI를 spawn할 때만 `hook`으로 심는다 — 수동 CLI
 * 호출·테스트는 안 심으므로 생략(payload에 키 자체가 안 남는다).
 * ⚠️ 이건 **자기신고(self-reported) 관측용 메타데이터**일 뿐, 보안/위조방지 신호가 아니다. 셸 접근이
 * 있는 누구나(사람이 디버깅 중이든, CI 스크립트든, 테스트든, 다른 에이전트든, 손으로
 * `LOOP_MEMORY_SOURCE=hook`을 export해두고 잊었든) `node dist/cli.js graduate ...`를 직접 돌려 이
 * env를 손으로 심으면 실제 훅 발동과 바이트 단위로 구분 불가능한 행이 남는다 — DB를 직접 질의하는 것과
 * 같은 신뢰 수준이다. 이 값이 있고 없고가 증명하는 건 "훅 코드 경로에서 왔다고 명시적으로 표시됨" 대
 * "표시 안 됨" 뿐이다. "실제 라이브 세션에서 훅이 발동했다"는 더 강한 주장은 이걸로 증명되지 않는다
 * (paul-loop 이슈 #35는 이 커밋으로 완전히 닫히지 않는다 — 그 증거는 여전히 없다).
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createLoopDb } from './client';
import { type Embedder, stubEmbedder } from './embedding';
import { apiEmbedder, type EmbedProvider } from './embedding-api';
import {
  DESIGN_TAG,
  graduateContext,
  graduateKnowledge,
  graduateMarkdownDir,
  type KnowledgeSyncResult,
  RESEARCH_TAG,
  recallKnowledge,
} from './knowledge';
import {
  type ConsolidationReport,
  consolidateLessonMemory,
  type DecayedRecallHit,
  graduateLessons,
  recallLessons,
  recallLessonsDecayed,
} from './lessons';
import { recordRecall } from './ops';
import { signingKeyFromEnv } from './provenance';

/** 키가 있으면 실 임베더. 없으면 기본은 거부(fail closed) — 스토어가 실 임베더로 채워졌는데 stub으로
 *  질의/졸업하면 결과가 *비어 있는* 게 아니라 *조용히 틀린* 값이 되기 때문(ADR-0062 결정 9). 명시적
 *  opt-in(`--allow-stub`)일 때만 경고와 함께 스텁으로 진행한다. graduate/recall이 같은 선택을 쓰도록
 *  한 곳에 둔다. */
function pickEmbedder(allowStub: boolean): Embedder {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (!hasOpenAI && !hasGemini) {
    if (!allowStub) {
      process.stderr.write(
        'loop-memory: no embedding API key (OPENAI_API_KEY/GEMINI_API_KEY) — refusing to run with a stub embedder against a store built with a real one (results would look valid but be meaningless). Pass --allow-stub to force it anyway.\n',
      );
      process.exit(1);
    }
    process.stderr.write(
      'loop-memory: no embedding API key (OPENAI_API_KEY/GEMINI_API_KEY) — using stub (--allow-stub); recall is NOT semantic.\n',
    );
    return stubEmbedder();
  }
  // LOOP_EMBED_PROVIDER는 *그 프로바이더의 키가 있을 때만* 존중한다. 스테일/오타 값(또는 키와 불일치)이면
  // 실제 존재하는 키로 추론 — 안 그러면 키가 멀쩡한데 키없는 프로바이더로 빌드돼 throw→훅이 영영 no-op.
  const requested = process.env.LOOP_EMBED_PROVIDER;
  const provider: EmbedProvider =
    requested === 'openai' && hasOpenAI
      ? 'openai'
      : requested === 'gemini' && hasGemini
        ? 'gemini'
        : hasOpenAI
          ? 'openai'
          : 'gemini';
  return apiEmbedder({ provider });
}

/** 같은 텍스트의 임베딩 중복 호출 제거. recall이 두 코퍼스에 *같은 쿼리*를 임베드하므로 API 1회로 줄인다
 *  (hot path — UserPromptSubmit마다 돎). Promise를 캐시 → Promise.all 동시 호출도 in-flight 하나를 공유. */
function memoizeEmbedder(base: Embedder): Embedder {
  const cache = new Map<string, Promise<number[]>>();
  return {
    dimensions: base.dimensions,
    embed(text: string): Promise<number[]> {
      let p = cache.get(text);
      if (!p) {
        p = base.embed(text);
        cache.set(text, p);
      }
      return p;
    },
    // recall 경로는 batch를 안 쓴다(질의 1건)지만 Embedder 계약을 만족해야 한다 — base로 그대로 위임.
    embedBatch: (texts: string[]) => base.embedBatch(texts),
  };
}

// locked를 "0 added, 0 updated..."와 구분해 찍는다(BAC-367) — 동시 졸업 중이라 이번엔 아무 것도
// 안 봤다는 뜻이지 "이미 최신"이 아니다. silent truncation 금지 원칙(BAC-355)의 연장.
function printKnowledgeResult(label: string, r: KnowledgeSyncResult): void {
  if (r.locked) {
    process.stdout.write(
      `loop-memory: knowledge (${label}) — skipped (동시 졸업 진행 중, 다음 세션이 이어감)\n`,
    );
    return;
  }
  process.stdout.write(
    `loop-memory: knowledge (${label}) — ${r.added} added, ${r.updated} updated, ${r.deleted} deleted, ${r.noop} unchanged\n`,
  );
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opt = {
  lessons: process.env.LESSONS_DIR || '.loop/lessons',
  knowledge: '', // ADR 디렉토리(예: docs/adr). 비면 graduate가 knowledge를 건너뛴다.
  context: '', // CONTEXT.md 경로(BAC-355). 비면 graduate가 건너뛴다.
  research: '', // docs/research 디렉토리(BAC-355). 비면 graduate가 건너뛴다.
  design: '', // docs/product/design 디렉토리(BAC-355). 비면 graduate가 건너뛴다.
  query: '',
  queryFile: '',
  k: 5,
  json: false,
  allowStub: false,
  decay: false, // recall --decay: lessons 코퍼스를 decay 랭킹(BAC/paul-loop #12)으로 재정렬
  hits: '', // record-recall: [{id, distance?, corpus?}, ...] JSON 문자열 (BAC-586)
};
// source 태그(paul-loop 이슈 #35). hooks/graduate-lessons.mjs와 hooks/recall-lessons.mjs가
// "node dist/cli.js ..." 하위프로세스를 spawn할 때만 이 env를 심는다(env `LOOP_MEMORY_SOURCE=hook`) —
// 수동 CLI 호출·테스트는 안 심으므로 undefined로 남는다. graduate/record-recall이 이 값을
// memory_op.payload.source에 그대로 적는다. ⚠️ 자기신고 메타데이터일 뿐 위조방지 신호가 아니다 — 셸
// 접근이 있으면 누구든 이 env를 손으로 심어 진짜 훅 발동과 구분 불가능한 행을 만들 수 있다(DB 직접
// 질의와 같은 신뢰 수준). "훅 코드 경로로 명시 표시됨" 대 "표시 안 됨"만 구분하지, "실제 훅이
// 발동했다"는 증명하지 않는다. 없어도 오도하는 기본값(예: 'cli')으로 채우지 않는다 — 생략은 생략인 채로
// 남는다.
const source = process.env.LOOP_MEMORY_SOURCE || undefined;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined) {
      process.stderr.write(`loop-memory: ${a} requires a value\n`);
      process.exit(2);
    }
    return v;
  };
  switch (a) {
    case '--lessons':
      opt.lessons = val();
      break;
    case '--knowledge':
      opt.knowledge = val();
      break;
    case '--context':
      opt.context = val();
      break;
    case '--research':
      opt.research = val();
      break;
    case '--design':
      opt.design = val();
      break;
    case '--query':
      opt.query = val();
      break;
    case '--query-file':
      opt.queryFile = val();
      break;
    case '--k': {
      const n = Number(val());
      opt.k = Number.isInteger(n) && n > 0 ? n : 5;
      break;
    }
    case '--json':
      opt.json = true;
      break;
    case '--allow-stub':
      opt.allowStub = true;
      break;
    case '--decay':
      opt.decay = true;
      break;
    case '--hits':
      opt.hits = val();
      break;
    case '--':
      break; // bare separator(예: `pnpm run recall -- ...`)는 무시
    default:
      process.stderr.write(`loop-memory: unknown arg ${a}\n`);
      process.exit(2);
  }
}

/** stats: 관측 전용 — pgvector 스토어의 현재 상태를 요약한다(임베더/키 불필요, 읽기만). loop-doctor가
 *  raw SQL 대신 이걸 호출한다. graduate/recall과 달리 embedder를 만들지 않는다(키 없어도 동작). */
async function runStats(json: boolean): Promise<void> {
  const { db, pool } = createLoopDb();
  try {
    const notesRes = await db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where deleted_at is null)::int as active,
             count(*) filter (where deleted_at is not null)::int as soft_deleted,
             count(*) filter (where embedding is not null)::int as embedded
      from memory_note`);
    const n = notesRes.rows[0] as {
      total: number;
      active: number;
      soft_deleted: number;
      embedded: number;
    };
    const corporaRes = await db.execute(sql`
      select tag, count(*)::int as c
      from (select unnest(tags) as tag from memory_note where deleted_at is null) t
      group by tag order by c desc`);
    const corpora = corporaRes.rows as Array<{ tag: string; c: number }>;
    const opsRes = await db.execute(
      sql`select op, count(*)::int as c from memory_op group by op order by c desc`,
    );
    const ops = opsRes.rows as Array<{ op: string; c: number }>;
    const lastRes = await db.execute(sql`select max(created_at) as last_op from memory_op`);
    const lastOp = (lastRes.rows[0] as { last_op: Date | string | null }).last_op;
    const lastOpAt = lastOp ? new Date(lastOp).toISOString() : null;

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          notes: {
            total: n.total,
            active: n.active,
            softDeleted: n.soft_deleted,
            embedded: n.embedded,
          },
          corpora: Object.fromEntries(corpora.map((r) => [r.tag, r.c])),
          ops: Object.fromEntries(ops.map((r) => [r.op, r.c])),
          lastOpAt,
        })}\n`,
      );
      return;
    }
    const fmtCorpora = corpora.map((r) => `${r.tag} ${r.c}`).join(' · ') || '(none)';
    const fmtOps = ops.map((r) => `${r.op} ${r.c}`).join(' · ') || '(none)';
    process.stdout.write('loop-memory stats:\n');
    process.stdout.write(
      `  notes: ${n.active} active (${n.soft_deleted} soft-deleted, ${n.total} total) · ${n.embedded}/${n.total} embedded\n`,
    );
    process.stdout.write(`  corpora (active): ${fmtCorpora}\n`);
    process.stdout.write(`  ops: ${fmtOps}\n`);
    process.stdout.write(`  last graduate op: ${lastOpAt ?? '(never)'}\n`);
  } finally {
    await pool.end();
  }
}

/** record-recall: 훅이 실제로 주입한 노트 id들을 memory_op에 RECALL 행으로 남긴다(계측, BAC-586).
 *  임베더가 필요 없다(노트/거리는 이미 훅이 확정한 값을 그대로 받아 적을 뿐) — pickEmbedder를 거치지
 *  않아 임베딩 키 없이도 동작한다. --hits는 [{id, distance?, corpus?}, ...] JSON 배열. */
async function runRecordRecall(hitsJson: string, source: string | undefined): Promise<void> {
  let hits: unknown;
  try {
    hits = JSON.parse(hitsJson || '[]');
  } catch {
    process.stderr.write('loop-memory: record-recall --hits must be valid JSON\n');
    process.exit(2);
  }
  if (!Array.isArray(hits) || hits.length === 0) return;
  const { db, pool } = createLoopDb();
  try {
    for (const h of hits as Array<{ id?: string; distance?: number; corpus?: string }>) {
      if (!h?.id) continue;
      await recordRecall(db, h.id, { distance: h.distance, corpus: h.corpus, source });
    }
  } finally {
    await pool.end();
  }
}

/** consolidate: sleep-time consolidation 배치(BAC/paul-loop #12, read-only) — dedup 병합 후보 +
 *  승격 사전 채점 신호를 한 번의 스캔으로 보고한다. 임베더/키가 필요 없다(이미 저장된 임베딩끼리
 *  코사인 거리를 재는 것뿐, 새 텍스트를 임베드하지 않는다) — stats와 같은 이유로 pickEmbedder를 거치지
 *  않는다. 아무것도 쓰지 않는다: 병합/삭제/승격은 사람 또는 lessons.mjs(retire/challenge) 몫.
 *  write-path provenance(BAC-619) — `signingKey` 없으면 lesson 코퍼스를 fail-closed로 아무것도 못
 *  읽어(consolidateLessonMemory 참고) duplicates/promotionSignals 둘 다 항상 빈 배열로 나온다. */
async function runConsolidate(json: boolean, signingKey: string | undefined): Promise<void> {
  const { db, pool } = createLoopDb();
  try {
    const report: ConsolidationReport = await consolidateLessonMemory(db, signingKey);
    if (json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }
    process.stdout.write('loop-memory consolidate:\n');
    if (report.duplicates.length === 0) {
      process.stdout.write('  duplicates: (none)\n');
    } else {
      process.stdout.write(`  duplicates (${report.duplicates.length} cluster(s)):\n`);
      for (const c of report.duplicates) {
        process.stdout.write(`    - ${c.lessonIds.join(', ')}\n`);
      }
    }
    if (report.promotionSignals.length === 0) {
      process.stdout.write('  promotion signals: (none)\n');
    } else {
      process.stdout.write(`  promotion signals (${report.promotionSignals.length}):\n`);
      for (const s of report.promotionSignals) {
        process.stdout.write(
          `    - ${s.lessonId} (cluster size ${s.clusterSize}, peers: ${s.peerLessonIds.join(', ')})\n`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (cmd === 'stats') {
    await runStats(opt.json);
    return;
  }
  if (cmd === 'record-recall') {
    await runRecordRecall(opt.hits, source);
    return;
  }
  if (cmd === 'consolidate') {
    // write-path provenance(BAC-619) — graduate/recall과 같은 경고: 없으면 lesson 코퍼스 읽기가
    // fail-closed로 항상 빈 결과다(runConsolidate 참고). knowledge 코퍼스 개념은 consolidate에 없다.
    const signingKey = signingKeyFromEnv();
    if (!signingKey) {
      process.stderr.write(
        'loop-memory: LOOP_MEMORY_SIGNING_KEY not set — consolidate returns empty (fail-closed, BAC-619 write-path provenance)\n',
      );
    }
    await runConsolidate(opt.json, signingKey);
    return;
  }
  if (cmd !== 'graduate' && cmd !== 'recall') {
    process.stderr.write(
      'Usage: loop-memory <graduate|recall|consolidate|stats|record-recall> [options]\n',
    );
    process.exit(2);
  }
  const embedder = pickEmbedder(opt.allowStub);
  // write-path provenance(BAC-619) — LOOP_MEMORY_SIGNING_KEY 없으면 graduate는 서명 없이 쓰고(쓰기는
  // 막지 않음), recall은 아무것도 검증할 수 없어 lesson 코퍼스가 fail-closed로 항상 빈 결과다(README
  // "위협모델"). knowledge 코퍼스(ADR/CONTEXT/research/design)는 이 secret과 무관 — 계속 정상 동작.
  const signingKey = signingKeyFromEnv();
  if (!signingKey) {
    process.stderr.write(
      'loop-memory: LOOP_MEMORY_SIGNING_KEY not set — lesson writes are unsigned and lesson recall returns 0 (fail-closed, BAC-619 write-path provenance; knowledge corpus unaffected)\n',
    );
  }
  const { db, pool } = createLoopDb();
  try {
    if (cmd === 'graduate') {
      const r = await graduateLessons(db, pool, embedder, opt.lessons, signingKey, source);
      // locked를 "0 added, 0 skipped"와 구분해 찍는다(BAC-372, printKnowledgeResult와 동일 이유) —
      // 동시 졸업 중이라 이번엔 아무 것도 안 봤다는 뜻이지 "이미 최신"이 아니다.
      if (r.locked) {
        process.stdout.write(
          'loop-memory: lessons — skipped (동시 졸업 진행 중, 다음 세션이 이어감)\n',
        );
      } else {
        process.stdout.write(
          `loop-memory: graduated ${r.added} new lesson(s), ${r.skipped} already present, ${r.stubbed} stubbed (retired), ${r.purged} purged (rejected/no-longer-verified)\n`,
        );
      }
      // knowledge 코퍼스(BAC-355: ADR·CONTEXT·research·design 4개 소스, 각자 독립 플래그가 주어질
      // 때만). 전부 멱등(증분 재임베드) — syncKnowledge 미러-싱크 위에 얹혀 있다.
      if (opt.knowledge) {
        const k = await graduateKnowledge(db, pool, embedder, opt.knowledge, source);
        printKnowledgeResult('ADR', k);
      }
      if (opt.context) {
        const c = await graduateContext(db, pool, embedder, opt.context, source);
        printKnowledgeResult('CONTEXT', c);
      }
      if (opt.research) {
        const r2 = await graduateMarkdownDir(
          db,
          pool,
          embedder,
          opt.research,
          RESEARCH_TAG,
          opt.research,
          source,
        );
        printKnowledgeResult('research', r2);
        // silent truncation 금지(BAC-355 AC) — .md 아닌 항목(HTML 리포트 등)은 사유와 함께 드러낸다.
        for (const s of r2.skipped) {
          process.stdout.write(`loop-memory: knowledge (research) skip ${s.file} — ${s.reason}\n`);
        }
      }
      if (opt.design) {
        const d = await graduateMarkdownDir(
          db,
          pool,
          embedder,
          opt.design,
          DESIGN_TAG,
          opt.design,
          source,
        );
        printKnowledgeResult('design', d);
        for (const s of d.skipped) {
          process.stdout.write(`loop-memory: knowledge (design) skip ${s.file} — ${s.reason}\n`);
        }
      }
      return;
    }
    // recall — 코퍼스별 분리(ADR-0033 §5). 두 질의는 독립이라 병렬로 돌린다.
    let q = opt.query;
    if (!q && opt.queryFile) q = readFileSync(opt.queryFile, 'utf8');
    q = q.trim();
    if (!q) {
      process.stderr.write('loop-memory: recall needs --query or --query-file\n');
      process.exit(2);
    }
    // 두 코퍼스에 같은 쿼리를 임베드하므로 메모이즈로 임베드 API 1회(질의는 병렬 유지, ADR-0033 §5).
    const memo = memoizeEmbedder(embedder);
    // --decay(BAC/paul-loop #12): lessons 코퍼스만 decay 랭킹으로 재정렬 — 훅의 실시간 경로
    // (recallLessons)는 opt.decay가 false인 기본 호출이라 전혀 안 건드린다. knowledge는 파일 기반
    // count/lastSeen 개념이 없어(레포 문서라 "재발" 개념 자체가 안 맞음) decay 대상이 아니다.
    const [lessons, knowledge] = await Promise.all([
      opt.decay
        ? recallLessonsDecayed(db, memo, q, signingKey, opt.lessons, opt.k)
        : recallLessons(db, memo, q, signingKey, opt.k),
      recallKnowledge(db, memo, q, opt.k),
    ]);
    if (opt.json) {
      // 신 shape: 훅이 코퍼스별 거리컷오프·프레이밍을 하도록 두 배열을 구분해 낸다.
      process.stdout.write(`${JSON.stringify({ lessons, knowledge })}\n`);
      return;
    }
    const fmt = (h: { distance: number; content: string }) =>
      `- (${h.distance.toFixed(3)}) ${h.content.replace(/\n/g, ' / ')}\n`;
    process.stdout.write('lessons:\n');
    for (const h of lessons) {
      // --decay: 정렬에 실제로 쓰인 건 decayed score(raw distance 아님) — 텍스트 출력도 그 값을 보여줘야
      // 사람이 읽는 순서와 표시값이 일치한다(그렇지 않으면 --json은 score로 정렬해놓고 텍스트는 distance를
      // 찍어, distance 오름차순이 아닌 것처럼 보이는 줄이 섞인다).
      const shown = opt.decay ? (h as DecayedRecallHit).score : h.distance;
      process.stdout.write(`- (${shown.toFixed(3)}) ${h.content.replace(/\n/g, ' / ')}\n`);
    }
    process.stdout.write('knowledge:\n');
    for (const h of knowledge) process.stdout.write(fmt(h));
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`loop-memory: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
