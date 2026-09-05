import { defineConfig } from 'vitest/config';

// 명시적으로 이름 붙인 disposable 로컬 pgvector DB만 허용한다. 자동 격리/정리는
// npm run test:postgres-fixture가 담당하고, 각 파일도 별도의 임시 스키마를 사용한다.
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    // 파일별 CLI subprocess/DDL 작업을 순차 실행해 로컬 fixture 자원 사용을 제한한다.
    fileParallelism: false,
  },
});
