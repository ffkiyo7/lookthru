import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * 常规单元测试。
 *
 * 必须排掉 `*.live.test.ts` —— 那套打真实上游端点，会因为上游抖动随机变红。
 * 混进 `npm test` 的话，「改了代码跑一下」就成了掷骰子，人很快会开始无视红色，
 * 而这套件唯一的价值恰恰是「红了就说明上游变了」。它走 npm run test:live 和每日 workflow。
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, '**/dist/**', 'tests/**/*.live.test.ts'],
  },
});
