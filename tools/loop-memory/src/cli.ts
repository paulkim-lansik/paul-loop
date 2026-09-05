#!/usr/bin/env node
/**
 * Optional memory CLI. CLI/hooks share runtime-env precedence, repository ownership, model identity,
 * signing, privacy and evaluation write guards. See HARDENING.md and MIGRATION-0.7.md.
 * graduate: canonical source synchronization; recall: sanitized query (prefer --query-stdin).
 * stats/consolidate: authenticated reads; record-recall: minimal observed telemetry; liveness: local logs.
 * --json emits schema_version:1/command/outcome for graduate/recall/errors. Lock/partial is not synced.
 * Exit 0 preserves hook compatibility, 1 runtime/configuration, 2 usage. Hooks preserve sessions but
 * distinguish an error from an honest empty result. No-key and malformed output never become success.
 */
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
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
import { formatLiveness, RECALL_TYPE, summarizeLiveness } from './liveness';
import { recordRecall } from './ops';
import { signingKeyFromEnv } from './provenance';
import { bindStore, repositoryIdentity, MemoryError, memoryAccess } from './store';
import { runtimeEnv } from '../hooks/lib/runtime-env.mjs';
import { sanitizeMemory } from '../hooks/lib/privacy.mjs';

const runtime = runtimeEnv(process.cwd());
Object.assign(process.env, runtime.env);
async function openBound(embeddingId = '') {
  const repository = repositoryIdentity(process.cwd());
  const signingKey = signingKeyFromEnv();
  if (!signingKey) throw new MemoryError('signing_key_missing');
  const connection = createLoopDb();
  try {
    await bindStore(connection.db, connection.pool, { ...repository, embeddingId, signingKey });
    return connection;
  } catch (e) { await connection.pool.end(); throw e; }
}
function sourcePath(value: string) {
  const root = realpathSync(process.cwd());
  const target = realpathSync(resolve(root, value));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new MemoryError('source_outside_repository');
  return target;
}

/** 키가 있으면 실 임베더. 없으면 기본은 거부(fail closed) — 스토어가 실 임베더로 채워졌는데 stub으로
 *  질의/졸업하면 결과가 *비어 있는* 게 아니라 *조용히 틀린* 값이 되기 때문(ADR-0062 결정 9). 명시적
 *  opt-in(`--allow-stub`)일 때만 경고와 함께 스텁으로 진행한다. graduate/recall이 같은 선택을 쓰도록
 *  한 곳에 둔다. */
function pickEmbedder(allowStub: boolean): Embedder {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const requested = process.env.LOOP_EMBED_PROVIDER;
  if (requested && requested !== 'openai' && requested !== 'gemini') throw new MemoryError('embedding_provider_invalid');
  if ((requested === 'openai' && !hasOpenAI) || (requested === 'gemini' && !hasGemini)) throw new MemoryError('embedding_provider_key_missing');
  if (!hasOpenAI && !hasGemini) {
    if (!allowStub) {
      process.stderr.write(
        'loop-memory: no embedding API key (OPENAI_API_KEY/GEMINI_API_KEY) — refusing to run with a stub embedder against a store built with a real one (results would look valid but be meaningless). Pass --allow-stub to force it anyway.\n',
      );
      throw new MemoryError('embedding_key_missing');
    }
    process.stderr.write(
      'loop-memory: no embedding API key (OPENAI_API_KEY/GEMINI_API_KEY) — using stub (--allow-stub); recall is NOT semantic.\n',
    );
    return stubEmbedder();
  }
  if (!requested && hasOpenAI && hasGemini) throw new MemoryError('embedding_provider_ambiguous');
  const provider: EmbedProvider = requested as EmbedProvider || (hasOpenAI ? 'openai' : 'gemini');
  return apiEmbedder({ provider });
}

/** 같은 텍스트의 임베딩 중복 호출 제거. recall이 두 코퍼스에 *같은 쿼리*를 임베드하므로 API 1회로 줄인다
 *  (hot path — UserPromptSubmit마다 돎). Promise를 캐시 → Promise.all 동시 호출도 in-flight 하나를 공유. */
function memoizeEmbedder(base: Embedder): Embedder {
  const cache = new Map<string, Promise<number[]>>();
  return {
    dimensions: base.dimensions,
    identity: base.identity,
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
  queryStdin: false,
  k: 5,
  json: false,
  allowStub: false,
  decay: false, // recall --decay: lessons 코퍼스를 decay 랭킹(BAC/paul-loop #12)으로 재정렬
  hits: '', // record-recall: [{id, distance?, corpus?}, ...] JSON 문자열 (BAC-586)
  root: '', // liveness: 원장을 찾을 레포 루트. 비면 cwd.
  runs: 20, // liveness: 최근 몇 개의 런 파일까지 볼지(mtime 최신순)
  assert: false, // liveness: 스캔 창에 recall 발동이 0건이면 exit 1
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
    case '--query-stdin':
      opt.queryStdin = true;
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
    case '--root':
      opt.root = val();
      break;
    case '--runs': {
      const n = Number(val());
      opt.runs = Number.isInteger(n) && n > 0 ? n : 20;
      break;
    }
    case '--assert':
      opt.assert = true;
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
  const { db, pool } = await openBound();
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
    process.stdout.write(`  last memory op: ${lastOpAt ?? '(never)'}\n`);
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
  const { db, pool } = await openBound();
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
  const { db, pool } = await openBound();
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
  if (cmd !== 'liveness') memoryAccess(cmd === 'graduate' || cmd === 'record-recall');
  if (cmd === 'stats') {
    await runStats(opt.json);
    return;
  }
  if (cmd === 'record-recall') {
    await runRecordRecall(opt.hits, source);
    return;
  }
  if (cmd === 'liveness') {
    // 순수 파일시스템 — createLoopDb/pickEmbedder를 전혀 거치지 않는다. 스토어가 죽어 있고 키가 없어도
    // "훅이 발동은 했는가"에는 답이 나와야 하기 때문(그게 이 명령의 존재 이유다).
    const summary = summarizeLiveness(opt.root || process.cwd(), { runs: opt.runs });
    process.stdout.write(opt.json ? `${JSON.stringify(summary)}\n` : formatLiveness(summary));
    // 실패로 보는 건 "한 번도 안 발동" 단 하나다. skipped(자기게이팅)·no_match(정상적으로 못 찾음)는
    // 훅이 살아 있다는 증거이므로 통과 — 그 둘을 실패로 보면 정직한 무매치가 알람이 되고, 결국
    // 아무도 안 보는 체크가 된다.
    if (opt.assert && summary.recall.total === 0) {
      process.stderr.write(
        `loop-memory: liveness assertion failed — no ${RECALL_TYPE} events in the last ${opt.runs} run file(s) under ${join(summary.root, '.loop', 'runs')} (the UserPromptSubmit hook has not fired)\n`,
      );
      process.exit(1);
    }
    return;
  }
  if (cmd === 'consolidate') {
    const signingKey = signingKeyFromEnv();
    if (!signingKey) throw new MemoryError('signing_key_missing');
    await runConsolidate(opt.json, signingKey);
    return;
  }
  if (cmd !== 'graduate' && cmd !== 'recall') {
    process.stderr.write(
      'Usage: loop-memory <graduate|recall|consolidate|stats|record-recall|liveness> [options]\n',
    );
    process.exit(2);
  }
  const embedder = pickEmbedder(opt.allowStub);
  const signingKey = signingKeyFromEnv();
  if (!signingKey) throw new MemoryError('signing_key_missing');
  const { db, pool } = await openBound(embedder.identity);
  try {
    if (cmd === 'graduate') {
      const repository = repositoryIdentity(process.cwd());
      if (!repository.writable) {
        process.stdout.write(JSON.stringify({ schema_version: 1, command: 'graduate', outcome: 'skipped', reason: 'worktree_read_only' }) + '\n');
        return;
      }
      const canonicalLessons = join(repository.current, '.loop', 'lessons');
      if ((existsSync(opt.lessons) ? realpathSync(opt.lessons) : resolve(opt.lessons)) !== canonicalLessons) throw new MemoryError('lesson_source_not_canonical');
      const r = existsSync(canonicalLessons)
        ? await graduateLessons(db, pool, embedder, sourcePath(canonicalLessons), signingKey, source)
        : { added: 0, updated: 0, skipped: 0, stubbed: 0, purged: 0, missing: true };
      const knowledge: Record<string, KnowledgeSyncResult> = {};
      if (opt.knowledge) knowledge.adr = await graduateKnowledge(db, pool, embedder, sourcePath(opt.knowledge), source);
      if (opt.context) knowledge.context = await graduateContext(db, pool, embedder, sourcePath(opt.context), source);
      if (opt.research) knowledge.research = await graduateMarkdownDir(db, pool, embedder, sourcePath(opt.research), RESEARCH_TAG, 'research', source);
      if (opt.design) knowledge.design = await graduateMarkdownDir(db, pool, embedder, sourcePath(opt.design), DESIGN_TAG, 'design', source);
      const results = [r, ...Object.values(knowledge)];
      const locked = results.filter(result => 'locked' in result && result.locked).length;
      const missing = 'missing' in r;
      const omitted = Object.values(knowledge).some(result => ('skipped' in result && Array.isArray(result.skipped) && result.skipped.length > 0) || result.incomplete);
      const outcome = locked === results.length ? 'locked' : locked || missing || omitted ? 'partial' : 'synced';
      if (opt.json) process.stdout.write(JSON.stringify({ schema_version: 1, command: 'graduate', outcome,
        reason: locked ? 'lock_busy' : missing ? 'lesson_source_missing' : 'ok', lessons: r, knowledge }) + '\n');
      else {
        process.stdout.write(`loop-memory: ${outcome} — graduated ${r.added} new lesson(s), ${r.updated} updated, ${r.skipped} already present, ${r.stubbed} stubbed, ${r.purged} purged\n`);
        for (const [name, value] of Object.entries(knowledge)) {
          printKnowledgeResult(name, value);
          if ('skipped' in value && Array.isArray(value.skipped)) for (const item of value.skipped) process.stdout.write(`  skipped ${sanitizeMemory(item.file)}: ${item.reason}\n`);
        }
      }
      return;
    }
    // recall — 코퍼스별 분리(ADR-0033 §5). 두 질의는 독립이라 병렬로 돌린다.
    let q = opt.queryStdin ? readFileSync(0, 'utf8') : opt.query;
    if (!q && opt.queryFile) q = readFileSync(opt.queryFile, 'utf8');
    q = sanitizeMemory(q, 2048).trim();
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
      process.stdout.write(`${JSON.stringify({ schema_version: 1, command: 'recall', outcome: 'ok', lessons, knowledge })}\n`);
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
  const reason = e instanceof MemoryError ? e.code : 'runtime_error';
  if (opt.json) process.stdout.write(JSON.stringify({ schema_version: 1, command: cmd, outcome: 'error', reason }) + '\n');
  process.stderr.write(`loop-memory: ${reason}\n`);
  process.exit(1);
});
