import type { Embedder } from './embedding';
import { sanitizeMemory } from '../hooks/lib/privacy.mjs';

/**
 * 외부 임베딩 API 임베더 (OpenAI / Gemini). `Embedder` 시맨의 실사용 구현.
 *
 * External embeddings receive sanitized text. This is still data egress: arbitrary confidential prose
 * cannot be classified by redaction. See HARDENING.md; disable memory for sensitive projects.
 *
 * 차원: 기본 384 = `memory_note.embedding` 컬럼과 일치. 두 프로바이더 모두 384 단축을 지원한다
 * (OpenAI `dimensions`, Gemini `outputDimensionality`). **항상 L2 정규화** — OpenAI는 이미 단위벡터지만
 * Gemini는 384 단축 시 비정규화라, 코사인 거리 일관성을 위해 한 경로로 통일한다.
 */
export type EmbedProvider = 'openai' | 'gemini';

export interface ApiEmbedderOptions {
  /** 기본: env `LOOP_EMBED_PROVIDER` → 'openai'. */
  provider?: EmbedProvider;
  /** 기본: env `OPENAI_API_KEY` / `GEMINI_API_KEY`. */
  apiKey?: string;
  /** 기본: 프로바이더별 권장 모델. */
  model?: string;
  /** 기본: 384(컬럼과 일치). 바꾸면 컬럼 마이그레이션도 함께. */
  dimensions?: number;
  /** 기본: 30000(30s). fetch 타임아웃(ms) — 벤더가 멈추면 무한 대기 대신 이 시간 후 에러(BAC-373). */
  timeoutMs?: number;
}

const DEFAULT_MODEL: Record<EmbedProvider, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
};

const KEY_ENV: Record<EmbedProvider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

// BAC-373: 벤더가 TCP 연결만 열어둔 채 진짜로 멈추면 fetch()가 무한 대기한다 — 모든 apiEmbedder 호출에
// 적용되지만 특히 syncKnowledge를 감싸는 postgres advisory lock(BAC-367, 세션-스코프)이 프로세스가 죽을
// 때까지 안 풀려 다른 동시 세션도 계속 skip만 반복하는 경로가 가장 치명적이다. 기본 30s(임베딩 API는
// 보통 수백ms~수초라 여유롭다).
const DEFAULT_TIMEOUT_MS = 30_000;

function l2normalize(v: number[]): number[] {
  if (!v.every(Number.isFinite) || !v.some(x => x !== 0)) throw new Error('embedding vector invalid');
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

interface Call {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

async function fetchWithTimeout(
  url: string,
  // 'signal'은 이 헬퍼가 직접 관리(AbortSignal.timeout) — 타입에서 제외해 호출부의 signal이
  // 조용히 덮어써지는 걸 컴파일 타임에 막는다.
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`${label}: timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  }
}

async function embedOpenAI(
  text: string,
  { apiKey, model, dimensions, timeoutMs }: Call,
): Promise<number[]> {
  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text, dimensions, encoding_format: 'float' }),
    },
    timeoutMs,
    'openai embeddings',
  );
  if (!res.ok) throw new Error(`openai embeddings HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = json.data?.[0]?.embedding;
  if (!vec) throw new Error('openai embeddings: missing data[0].embedding');
  return vec;
}

async function embedGemini(
  text: string,
  { apiKey, model, dimensions, timeoutMs }: Call,
): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
        outputDimensionality: dimensions,
      }),
    },
    timeoutMs,
    'gemini embedContent',
  );
  if (!res.ok) throw new Error(`gemini embedContent HTTP ${res.status}`);
  const json = (await res.json()) as { embedding?: { values?: number[] } };
  const vec = json.embedding?.values;
  if (!vec) throw new Error('gemini embedContent: missing embedding.values');
  return vec;
}

// 배치 임베딩(BAC-368) — 실측(BAC-354): 직렬 embed가 청크당 API round-trip(~0.43s)이라 첫 전량 졸업
// (224청크)이 ~97s, SessionStart 12s 타임아웃을 크게 넘겼다. 두 프로바이더 모두 한 요청에 여러 텍스트를
// 지원(OpenAI: ai.google.dev 대비 훨씬 단순 — `input`이 그냥 배열; Gemini: 별도 `:batchEmbedContents`
// 엔드포인트, 요청 항목마다 `model` 재기재 필요 — 둘 다 벤더 공식 문서로 확인, 2026-07-02).
//
// 청크 상한: 두 프로바이더 다 공식 문서에 명시적 "요청당 최대 텍스트 수"가 없다(Gemini 검색으로 확인한 건
// inline 요청 총 크기 20MB 권고뿐) — 그래서 보수적으로 나눠 보낸다. 정확한 상한이 아니라 안전마진이므로,
// 실사용에서 413/400이 나면 이 숫자를 낮추는 게 아니라 여기 코멘트를 프로바이더 실측치로 갱신할 것.
const MAX_BATCH_SIZE = 96;

async function embedBatchOpenAI(
  texts: string[],
  { apiKey, model, dimensions, timeoutMs }: Call,
): Promise<number[][]> {
  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts, dimensions, encoding_format: 'float' }),
    },
    timeoutMs,
    'openai embeddings(batch)',
  );
  if (!res.ok) throw new Error(`openai embeddings(batch) HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
  const data = json.data;
  if (!data || data.length !== texts.length) {
    throw new Error(
      `openai embeddings(batch): expected ${texts.length} result(s), got ${data?.length ?? 0}`,
    );
  }
  // index로 재정렬 — 동기 엔드포인트는 입력 순서를 지키지만(비동기 Batch API와는 다른 엔드포인트),
  // 인덱스가 있으니 순서를 가정하지 않고 방어적으로 맞춘다(오정렬 = 엉뚱한 청크에 엉뚱한 벡터, 조용한 손상).
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => {
      if (!d.embedding) throw new Error('openai embeddings(batch): missing embedding in a result');
      return d.embedding;
    });
}

async function embedBatchGemini(
  texts: string[],
  { apiKey, model, dimensions, timeoutMs }: Call,
): Promise<number[][]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 배치 요청 항목마다 model을 다시 적어야 한다(단건 embedContent와 달리 URL의 모델만으로 부족 —
        // 공식 문서 예시가 항목별 "models/<model>"을 요구).
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: 'SEMANTIC_SIMILARITY',
          outputDimensionality: dimensions,
        })),
      }),
    },
    timeoutMs,
    'gemini batchEmbedContents',
  );
  if (!res.ok) throw new Error(`gemini batchEmbedContents HTTP ${res.status}`);
  const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
  const embeddings = json.embeddings;
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error(
      `gemini batchEmbedContents: expected ${texts.length} result(s), got ${embeddings?.length ?? 0}`,
    );
  }
  // 응답은 "요청과 같은 순서"로 문서화돼 있다(Gemini는 OpenAI의 index 같은 상관자가 없음) — 그대로 사용.
  return embeddings.map((e) => {
    if (!e.values)
      throw new Error('gemini batchEmbedContents: missing embedding.values in a result');
    return e.values;
  });
}

export function apiEmbedder(opts: ApiEmbedderOptions = {}): Embedder {
  const provider = opts.provider ?? (process.env.LOOP_EMBED_PROVIDER as EmbedProvider) ?? 'openai';
  if (provider !== 'openai' && provider !== 'gemini') {
    throw new Error(
      `apiEmbedder: unknown provider ${JSON.stringify(provider)} (expected openai|gemini)`,
    );
  }
  const dimensions = opts.dimensions ?? 384;
  const model = opts.model ?? process.env.LOOP_EMBED_MODEL ?? DEFAULT_MODEL[provider];
  if (!model.trim() || model !== model.trim() || !Number.isInteger(dimensions) || dimensions <= 0) throw new Error('embedding identity invalid');
  const apiKey = opts.apiKey ?? process.env[KEY_ENV[provider]];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    dimensions,
    identity: `${provider}:${model}:l2-v1:${dimensions}`,
    async embed(text: string): Promise<number[]> {
      if (!apiKey) throw new Error(`apiEmbedder: missing API key (set ${KEY_ENV[provider]})`);
      const call: Call = { apiKey, model, dimensions, timeoutMs };
      const raw =
        provider === 'openai' ? await embedOpenAI(sanitizeMemory(text), call) : await embedGemini(sanitizeMemory(text), call);
      if (raw.length !== dimensions) {
        throw new Error(
          `apiEmbedder: ${provider} returned ${raw.length} dims, expected ${dimensions} (memory_note.embedding mismatch)`,
        );
      }
      return l2normalize(raw); // Gemini-384 비정규화 대비 + 스텁과 동일 경로
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      if (!apiKey) throw new Error(`apiEmbedder: missing API key (set ${KEY_ENV[provider]})`);
      const call: Call = { apiKey, model, dimensions, timeoutMs };
      const out: number[][] = [];
      // MAX_BATCH_SIZE 단위로 나눠 순차 요청 — 서브배치끼리는 순차(레이트리밋 방어), 서브배치 *안*은
      // 프로바이더 배치 엔드포인트가 병렬로 처리(그게 배치의 요점).
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const slice = texts.slice(i, i + MAX_BATCH_SIZE).map((text) => sanitizeMemory(text));
        const raw =
          provider === 'openai'
            ? await embedBatchOpenAI(slice, call)
            : await embedBatchGemini(slice, call);
        for (const vec of raw) {
          if (vec.length !== dimensions) {
            throw new Error(
              `apiEmbedder: ${provider} returned ${vec.length} dims, expected ${dimensions} (batch, memory_note.embedding mismatch)`,
            );
          }
          out.push(l2normalize(vec));
        }
      }
      return out;
    },
  };
}
