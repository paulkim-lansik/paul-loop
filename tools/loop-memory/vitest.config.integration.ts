import { defineConfig } from 'vitest/config';

// 통합 테스트: docker pgvector 필요. `pnpm verify:memory`가 db:up→migrate→이 설정으로 실행한다.
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    // 공유 docker DB 통합테스트는 파일 순차 실행. 여럿이 같은 tag 네임스페이스(kb:adr)를 수렴시키면
    // 병렬 시 서로의 노트를 soft-delete해 flaky해진다(knowledge/cli 미러-싱크). 파일 내 test는 원래 순차.
    fileParallelism: false,
  },
});
