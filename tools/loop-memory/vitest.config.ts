import { configDefaults, defineConfig } from 'vitest/config';

// 단위(빠른) 테스트: 통합(*.integration.test.ts)은 제외 — docker pgvector가 필요하므로 deep 게이트로 분리.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
