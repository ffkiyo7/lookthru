import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../apps/api/src/index';
import {
  expireFundListMemory,
  FUND_LIST_INDEX_HEADER,
  loadFundSearchIndex,
  resetFundListMemory,
} from '../apps/api/src/fund-list';
import { FUND_LIST_UNAVAILABLE_ERROR } from '../apps/api/src/fund-search';
import type { Env } from '../apps/api/src/env';

const FIXTURE_FUNDS = [
  {
    code: '000001',
    name: '华夏成长混合',
    type: '混合型-偏股',
    pinyinShort: 'HXCC',
    pinyinFull: 'huaxiachengzhang',
  },
  {
    code: '161725',
    name: '招商中证白酒指数',
    type: '股票指数',
    pinyinShort: 'ZSZJ',
    pinyinFull: 'zhaoshangbaijiu',
  },
];

const PAYLOAD = { generatedAt: '2026-08-28T00:00:00.000Z', funds: FIXTURE_FUNDS };

class FakeKV {
  private values = new Map<string, string>();

  async get(key: string, type?: 'json' | 'text'): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'text' ? value : JSON.parse(value);
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function allowAllLimiter() {
  return { limit: async () => ({ success: true }) };
}

function executionCtx(): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      void promise;
    },
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
}

function makeEnv(archive: {
  get: () => Promise<{ etag: string; json: () => Promise<unknown> } | null>;
  head?: () => Promise<{ etag: string } | null>;
}): { env: Env; cache: FakeKV } {
  const cache = new FakeKV();
  const env = {
    CACHE: cache,
    ARCHIVE: {
      get: archive.get,
      head: archive.head ?? (async () => ({ etag: 'etag-v1' })),
    },
    PUBLIC_FUNDS_RATE_LIMITER: allowAllLimiter(),
    PUBLIC_AUTH_RATE_LIMITER: allowAllLimiter(),
    PUBLIC_STATUS_RATE_LIMITER: allowAllLimiter(),
    SHARED_REFRESH_RATE_LIMITER: allowAllLimiter(),
  } as unknown as Env;
  return { env, cache };
}

async function search(
  env: Env,
  query: string,
  type?: string,
): Promise<Response> {
  const params = new URLSearchParams({ q: query });
  if (type) params.set('type', type);
  return app.request(`/api/funds/search?${params}`, {}, env, executionCtx());
}

beforeEach(() => {
  resetFundListMemory();
});

describe('/api/funds/search 降级契约', () => {
  it('冷启动且没有索引时名称搜索返回 503 而不是空数组', async () => {
    const { env } = makeEnv({ get: async () => null });
    const res = await search(env, '白酒');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: FUND_LIST_UNAVAILABLE_ERROR,
      degraded: true,
    });
  });

  it('拼音搜索在无索引时同样 503', async () => {
    const { env } = makeEnv({ get: async () => null });
    const res = await search(env, 'hxcc');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; degraded: boolean };
    expect(body.degraded).toBe(true);
    expect(body.error).toBe('fund list unavailable');
  });

  it('last-known-good 在 R2 失败后仍返回 200 数组并带 stale 头', async () => {
    let fail = false;
    const { env } = makeEnv({
      get: async () => {
        if (fail) throw new Error('r2 down');
        return { etag: 'etag-v1', json: async () => PAYLOAD };
      },
      head: async () => {
        if (fail) throw new Error('r2 down');
        return { etag: 'etag-v1' };
      },
    });
    await loadFundSearchIndex(env, Date.now(), undefined, { minFunds: 1 });
    fail = true;
    expireFundListMemory();
    const res = await search(env, '白酒');
    expect(res.status).toBe(200);
    expect(res.headers.get(FUND_LIST_INDEX_HEADER)).toBe('stale');
    const hits = (await res.json()) as { code: string }[];
    expect(hits.map((hit) => hit.code)).toEqual(['161725']);
  });

  it('有健康索引时名称零命中仍是 200 空数组', async () => {
    const { env } = makeEnv({
      get: async () => ({ etag: 'etag-v1', json: async () => PAYLOAD }),
    });
    await loadFundSearchIndex(env, Date.now(), undefined, { minFunds: 1 });
    const res = await search(env, '不存在的主题');
    expect(res.status).toBe(200);
    expect(res.headers.get(FUND_LIST_INDEX_HEADER)).toBeNull();
    expect(await res.json()).toEqual([]);
  });

  it('非法 type 返回 400，缺 q 返回 400', async () => {
    const { env } = makeEnv({ get: async () => null });
    const missing = await search(env, '');
    // q= 会 trim 成空
    expect(missing.status).toBe(400);
    const badType = await search(env, '白酒', '股票');
    expect(badType.status).toBe(400);
    expect(await badType.json()).toEqual({ error: 'invalid type' });
  });

  it('无索引时精确 6 位代码若缓存命中仍 200', async () => {
    const { env, cache } = makeEnv({ get: async () => null });
    const hit = {
      code: '999999',
      name: '新发基金',
      pinyin: 'XFXJ',
      type: '混合型',
      nav: 1,
      navDate: '2026-08-27',
      company: null,
      isMoneyFund: false,
    };
    await cache.put(
      'search:999999',
      JSON.stringify({ __lookthruCache: 1, value: [hit] }),
    );
    const res = await search(env, '999999');
    expect(res.status).toBe(200);
    const hits = (await res.json()) as { code: string }[];
    expect(hits.map((row) => row.code)).toEqual(['999999']);
  });
});
