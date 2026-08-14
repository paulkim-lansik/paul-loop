import { describe, expect, it } from 'vitest';
import { stubEmbedder } from '../src/embedding';

// 단위 테스트(docker 불필요) — 임베딩 시맨의 계약만 검증한다.
describe('stubEmbedder', () => {
  it('produces a vector of the configured dimension', async () => {
    const v = await stubEmbedder(384).embed('RLS 테스트 실패를 어떻게 고쳤나');
    expect(v).toHaveLength(384);
  });

  it('is deterministic (same input → same vector)', async () => {
    const e = stubEmbedder(16);
    expect(await e.embed('lesson')).toEqual(await e.embed('lesson'));
  });

  it('is L2-normalized', async () => {
    const v = await stubEmbedder(32).embed('verifier = ceiling');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
