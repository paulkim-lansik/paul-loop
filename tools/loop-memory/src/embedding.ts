/**
 * 임베딩은 교체가능한 시맨(seam)이다. 보일러플레이트 기본값은 *의존성 없는 결정적 스텁* —
 * 실사용 시 로컬(transformers.js all-MiniLM-L6-v2) 또는 외부 임베딩 API로 교체한다.
 * `dimensions`는 memory_note.embedding 컬럼 차원과 반드시 일치해야 한다.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  /**
   * 여러 텍스트를 한 번에 임베드한다(배치, BAC-368) — 결과는 texts와 같은 순서·같은 길이여야 한다.
   * 실측(BAC-354): docs/adr 첫 전량 졸업 224청크가 직렬 embed(청크당 API round-trip)로 ~97s —
   * SessionStart 12s 타임아웃을 크게 넘겨 첫 설치가 세션 여러 번에 걸쳐 부분 수렴했다. 진짜 배치 API가
   * 없는 구현체(stubEmbedder 등)는 sequentialEmbedBatch로 순차 fallback해도 된다 — 정확성은 동일, 속도만.
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** embedBatch의 순차 폴백 — 배치 API가 없는 Embedder가 embed()를 texts 개수만큼 병렬 호출한다. */
export function sequentialEmbedBatch(
  embed: (text: string) => Promise<number[]>,
  texts: string[],
): Promise<number[][]> {
  return Promise.all(texts.map((t) => embed(t)));
}

/**
 * 결정적 해시 기반 스텁 임베더. 진짜 의미를 담지 않는다(같은 입력 → 같은 벡터일 뿐).
 * docker/모델 없이 recall 파이프라인을 end-to-end로 돌리기 위한 자리표시자다.
 * L2 정규화하여 코사인 거리와 궁합을 맞춘다.
 */
export function stubEmbedder(dimensions = 384): Embedder {
  const embed = (text: string): Promise<number[]> => {
    const v = new Array<number>(dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = code % dimensions;
      v[idx] = (v[idx] ?? 0) + ((code % 13) - 6) / 7;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return Promise.resolve(v.map((x) => x / norm));
  };
  return {
    dimensions,
    embed,
    embedBatch: (texts) => sequentialEmbedBatch(embed, texts),
  };
}
