import { describe, expect, it } from 'vitest';
import { checkProbeTargets } from '../apps/api/src/probe';

describe('出口探针计时', () => {
  it('成功请求使用数据源内部延时，不把外层排队时间算进 P0 基线', async () => {
    const results = await checkProbeTargets([
      {
        source: 'same-origin-second-request',
        check: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { detail: 123, latencyMs: 11 };
        },
      },
    ]);

    expect(results[0]).toMatchObject({ ok: true, latencyMs: 11, detail: '123' });
  });
});
