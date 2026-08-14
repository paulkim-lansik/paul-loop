import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEmbedder, type EmbedProvider } from '../src/embedding-api';

// 단위 테스트(네트워크 불필요) — API 임베더의 계약만 검증한다. 게이트는 오프라인·무과금으로 유지.
describe('apiEmbedder (offline contract)', () => {
  it('defaults to 384 dimensions (memory_note.embedding과 일치)', () => {
    expect(apiEmbedder({ provider: 'openai' }).dimensions).toBe(384);
  });

  it('honors a custom dimension', () => {
    expect(apiEmbedder({ provider: 'gemini', dimensions: 768 }).dimensions).toBe(768);
  });

  it('rejects an unknown provider at construction', () => {
    expect(() => apiEmbedder({ provider: 'bogus' as EmbedProvider })).toThrow(/unknown provider/);
  });

  it('throws a clear error when the API key is missing', async () => {
    const e = apiEmbedder({ provider: 'openai', apiKey: '' });
    await expect(e.embed('x')).rejects.toThrow(/missing API key.*OPENAI_API_KEY/);
  });

  // BAC-368: embedBatch도 같은 계약을 지켜야 한다(키 없으면 네트워크 호출 전에 명확히 실패).
  it('embedBatch도 API 키가 없으면 명확히 실패한다', async () => {
    const e = apiEmbedder({ provider: 'gemini', apiKey: '' });
    await expect(e.embedBatch(['x', 'y'])).rejects.toThrow(/missing API key.*GEMINI_API_KEY/);
  });

  it('embedBatch([])는 키 없이도(네트워크 호출 없이) 빈 배열을 낸다', async () => {
    const e = apiEmbedder({ provider: 'openai', apiKey: '' });
    await expect(e.embedBatch([])).resolves.toEqual([]);
  });
});

// BAC-373: 벤더가 TCP 연결만 열어둔 채 진짜로 멈추면 fetch()가 무한 대기한다(BAC-367 advisory lock을
// 프로세스가 죽을 때까지 쥔 채로). fetch를 stub해 "응답이 안 온다"를 흉내내고, 실제 fetch/undici가
// AbortSignal.timeout 만료 시 하는 동작(abort 이벤트로 reject)을 재현한다.
describe('apiEmbedder (timeout — BAC-373)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubHangingFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          });
        });
      }),
    );
  }

  it.each([
    'openai',
    'gemini',
  ] as const)('%s: embed()는 벤더가 응답하지 않으면 timeoutMs 후 명확한 에러로 실패한다(무한 대기 없음)', async (provider) => {
    stubHangingFetch();
    const e = apiEmbedder({ provider, apiKey: 'test-key', timeoutMs: 20 });
    await expect(e.embed('x')).rejects.toThrow(/timed out after 20ms/);
  });

  it.each([
    'openai',
    'gemini',
  ] as const)('%s: embedBatch()도 벤더가 응답하지 않으면 timeoutMs 후 명확한 에러로 실패한다(무한 대기 없음)', async (provider) => {
    stubHangingFetch();
    const e = apiEmbedder({ provider, apiKey: 'test-key', timeoutMs: 20 });
    await expect(e.embedBatch(['x', 'y'])).rejects.toThrow(/timed out after 20ms/);
  });

  it.each([
    'openai',
    'gemini',
  ] as const)('%s: 정상 응답이면 timeoutMs 설정과 무관하게 영향 없다(회귀 없음)', async (provider) => {
    const vec = [1, 0, 0];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          provider === 'openai'
            ? { data: [{ embedding: vec, index: 0 }] }
            : { embedding: { values: vec } },
        ),
      ),
    );
    const e = apiEmbedder({ provider, apiKey: 'test-key', dimensions: 3, timeoutMs: 20_000 });
    await expect(e.embed('x')).resolves.toEqual(vec);
  });

  it.each([
    'openai',
    'gemini',
  ] as const)('%s: embedBatch도 정상 응답이면 timeoutMs 설정과 무관하게 영향 없다(회귀 없음)', async (provider) => {
    const vecs = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          provider === 'openai'
            ? { data: vecs.map((embedding, index) => ({ embedding, index })) }
            : { embeddings: vecs.map((values) => ({ values })) },
        ),
      ),
    );
    const e = apiEmbedder({ provider, apiKey: 'test-key', dimensions: 3, timeoutMs: 20_000 });
    await expect(e.embedBatch(['a', 'b'])).resolves.toEqual(vecs);
  });
});

// 실호출 테스트(과금 발생) — 기본 SKIP. `LOOP_EMBED_LIVE=1` + 키가 있을 때만 돈다.
// 예: LOOP_EMBED_LIVE=1 LOOP_EMBED_PROVIDER=openai OPENAI_API_KEY=sk-... pnpm --filter ...loop-memory test
describe('apiEmbedder (live — opt-in)', () => {
  it.runIf(process.env.LOOP_EMBED_LIVE === '1')(
    'embeds a real 384-dim L2-normalized vector',
    async () => {
      const v = await apiEmbedder().embed('RLS 격리 테스트를 withTenant로 고쳤다');
      expect(v).toHaveLength(384);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    },
    20_000,
  );

  // BAC-368: 실 배치 엔드포인트(:batchEmbedContents/OpenAI input=array)가 진짜 동작하는지 — 문서만 보고
  // 짠 요청/응답 파싱이 실제로 맞는지는 실 호출로만 증명된다.
  it.runIf(process.env.LOOP_EMBED_LIVE === '1')(
    '배치로 여러 텍스트를 임베드하면 embed() 단건 결과와 같은 벡터를 낸다(순서·매칭 정확성)',
    async () => {
      const e = apiEmbedder();
      const texts = [
        'RLS 격리 테스트를 withTenant로 고쳤다',
        'Drizzle 트랜잭션 콜백',
        '세 번째 텍스트',
      ];
      const batch = await e.embedBatch(texts);
      expect(batch).toHaveLength(3);
      for (const v of batch) {
        expect(v).toHaveLength(384);
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        expect(norm).toBeCloseTo(1, 5);
      }
      // 순서 매칭 검증 — 배치의 i번째 결과가 texts[i]의 단건 embed()와 (근사) 같은 벡터여야 한다.
      // 완전 동일은 아닐 수 있음(taskType 등 미세 차이 가능성) → 코사인 유사도로 "같은 텍스트를 가리킨다"만 확인.
      const single = await e.embed(texts[1] as string);
      const cos = batch[1]?.reduce((s, x, i) => s + x * (single[i] ?? 0), 0) ?? 0;
      expect(cos).toBeGreaterThan(0.99);
    },
    30_000,
  );
});
