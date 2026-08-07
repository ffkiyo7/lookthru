import { defineConfig } from 'vitest/config';

/**
 * 契约测试：直接打真实上游端点。
 * 这些端点是无合约的抓取源，随时可能变结构 —— 定期跑本套件是唯一的早期预警。
 * 不进常规 CI（会被上游抖动干扰），走独立 workflow 每日跑一次。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 上游有限流，串行跑
    fileParallelism: false,
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
