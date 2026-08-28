import { describe, expect, it, vi } from 'vitest';
import { fundMatchesTypeFilter, parseFundTypeFilter } from '../packages/shared/src/fund-types';
import {
  createFundListMemory,
  expireFundListMemory,
  INDEX_BACKOFF_MS,
  loadFundSearchIndex,
  parseFundListPayload,
  PRODUCTION_MIN_FUNDS,
  type FundListIndex,
} from '../apps/api/src/fund-list';
import {
  searchFundsForQuery,
  searchLocalFunds,
  shouldUseEastMoneyFallback,
} from '../apps/api/src/fund-search';
import type { FundSearchHit } from '../apps/api/src/sources/eastmoney';

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
  {
    code: '000009',
    name: '易方达天天理财货币',
    type: '货币型-普通货币',
    pinyinShort: 'YFDTTL',
    pinyinFull: 'yifangdatianshuili',
  },
  {
    code: '110022',
    name: '易方达消费行业股票',
    type: '股票型',
    pinyinShort: 'YFDXF',
    pinyinFull: 'yifangdaxiaofei',
  },
  {
    code: '000961',
    name: '天弘沪深300ETF联接',
    type: '联接基金',
    pinyinShort: 'THHS300',
    pinyinFull: 'tianhonghushen300',
  },
  {
    code: '001838',
    name: '国投瑞银中高等级债券',
    type: '债券型',
    pinyinShort: 'GTRY',
    pinyinFull: 'guotouruiyin',
  },
];

function indexFrom(
  funds: typeof FIXTURE_FUNDS = FIXTURE_FUNDS,
  generatedAt = '2026-08-28T00:00:00.000Z',
): FundListIndex {
  const parsed = parseFundListPayload({ generatedAt, funds });
  if (!parsed) throw new Error('夹具无法解析');
  return {
    generatedAt: parsed.generatedAt,
    etag: 'etag-v1',
    funds: parsed.funds,
    byCode: new Map(parsed.funds.map((fund) => [fund.code, fund])),
  };
}

function codes(hits: FundSearchHit[]): string[] {
  return hits.map((hit) => hit.code);
}

describe('全量列表解析', () => {
  it('接受 pipeline 产出的 { generatedAt, funds }', () => {
    const parsed = parseFundListPayload({
      generatedAt: '2026-08-28T00:00:00.000Z',
      funds: FIXTURE_FUNDS,
    });
    expect(parsed?.funds.map((fund) => fund.code)).toEqual(FIXTURE_FUNDS.map((fund) => fund.code));
    expect(parsed?.funds[2]?.isMoneyFund).toBe(true);
    expect(parsed?.funds[0]?.isMoneyFund).toBe(false);
  });

  it('外壳坏了才整份作废，脏行和重复代码只跳过', () => {
    expect(parseFundListPayload({ generatedAt: 'x' })).toBeNull();
    const withDup = parseFundListPayload({
      generatedAt: '2026-08-28T00:00:00.000Z',
      funds: [
        FIXTURE_FUNDS[0],
        { ...FIXTURE_FUNDS[0], name: '重复代码' },
        FIXTURE_FUNDS[1],
      ],
    });
    expect(withDup?.funds.map((fund) => fund.code)).toEqual(['000001', '161725']);
    const mixed = parseFundListPayload({
      generatedAt: '2026-08-28T00:00:00.000Z',
      funds: [
        { ...FIXTURE_FUNDS[0], code: '51' },
        FIXTURE_FUNDS[0],
        { name: '缺代码' },
      ],
    });
    expect(mixed?.funds.map((fund) => fund.code)).toEqual(['000001']);
    expect(
      parseFundListPayload({
        generatedAt: '2026-08-28T00:00:00.000Z',
        funds: [{ ...FIXTURE_FUNDS[0], code: '51' }],
      }),
    ).toBeNull();
  });
});

describe('本地搜索匹配', () => {
  const funds = indexFrom().funds;

  it('按代码、名称、拼音缩写和全拼命中', () => {
    expect(codes(searchLocalFunds(funds, '000001'))).toEqual(['000001']);
    expect(codes(searchLocalFunds(funds, '000'))).toContain('000001');
    expect(codes(searchLocalFunds(funds, '白酒'))).toEqual(['161725']);
    expect(codes(searchLocalFunds(funds, 'hxcc'))).toEqual(['000001']);
    expect(codes(searchLocalFunds(funds, 'HX'))).toEqual(['000001']);
    expect(codes(searchLocalFunds(funds, 'huaxiachengzhang'))).toEqual(['000001']);
    expect(codes(searchLocalFunds(funds, 'hs300'))).toEqual(['000961']);
  });

  it('类型筛选不隐藏代码或拼音命中', () => {
    expect(codes(searchLocalFunds(funds, '000001', 'bond'))).toEqual(['000001']);
    expect(codes(searchLocalFunds(funds, 'hxcc', 'money'))).toEqual(['000001']);
    expect(codes(searchLocalFunds(funds, '000009', 'stock'))).toEqual(['000009']);
  });

  it('类型筛选会去掉仅名称命中、类型不符的结果', () => {
    expect(codes(searchLocalFunds(funds, '白酒', 'all'))).toEqual(['161725']);
    expect(codes(searchLocalFunds(funds, '白酒', 'bond'))).toEqual([]);
    expect(codes(searchLocalFunds(funds, '白酒', 'index'))).toEqual(['161725']);
    expect(codes(searchLocalFunds(funds, '白酒', 'stock'))).toEqual([]);
    expect(codes(searchLocalFunds(funds, '消费', 'stock'))).toEqual(['110022']);
    expect(codes(searchLocalFunds(funds, '消费', 'hybrid'))).toEqual([]);
  });

  it('货币基金标记与类型筛选项一致', () => {
    expect(searchLocalFunds(funds, '000009')[0]).toMatchObject({
      code: '000009',
      isMoneyFund: true,
      nav: null,
    });
    expect(codes(searchLocalFunds(funds, '理财', 'money'))).toEqual(['000009']);
  });
});

describe('东财回源边界', () => {
  const index = indexFrom();

  it('普通名称、拼音、短数字都不允许打东财', () => {
    expect(shouldUseEastMoneyFallback('白酒', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('hxcc', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('000', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('000001', index)).toBe(false);
  });

  it('只有本地没有的精确 6 位代码才回源', () => {
    expect(shouldUseEastMoneyFallback('999999', index)).toBe(true);
    expect(shouldUseEastMoneyFallback('999999', null)).toBe(true);
    expect(shouldUseEastMoneyFallback('白酒', null)).toBe(false);
  });

  it('本地能命中时不调用东财', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('不应请求东财 suggest');
    });
    const result = await searchFundsForQuery('白酒', 'all', index, upstream);
    expect(codes(result.hits)).toEqual(['161725']);
    expect(result.degraded).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('本地没有的 6 位代码才调用东财，且只保留精确代码', async () => {
    const upstream = vi.fn(async (keyword: string): Promise<FundSearchHit[]> => {
      expect(keyword).toBe('999999');
      return [
        {
          code: '999999',
          name: '新发基金',
          pinyin: 'XFXJ',
          type: '混合型',
          nav: 1,
          navDate: '2026-08-27',
          company: null,
          isMoneyFund: false,
        },
        {
          code: '000001',
          name: '不应出现的连带结果',
          pinyin: 'HXCC',
          type: '混合型',
          nav: 1,
          navDate: '2026-08-27',
          company: null,
          isMoneyFund: false,
        },
      ];
    });
    const result = await searchFundsForQuery('999999', 'all', index, upstream);
    expect(codes(result.hits)).toEqual(['999999']);
    expect(result.degraded).toBe(false);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('部分名称或拼音 0 命中也不回源', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('不应请求东财 suggest');
    });
    expect(await searchFundsForQuery('不存在的主题', 'all', index, upstream)).toMatchObject({
      hits: [],
      degraded: false,
    });
    expect(await searchFundsForQuery('zzzzzz', 'all', index, upstream)).toMatchObject({
      hits: [],
      degraded: false,
    });
    expect(upstream).not.toHaveBeenCalled();
  });
  it('名称搜索在无索引时标记 degraded 且不打东财', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('不应请求东财 suggest');
    });
    expect(await searchFundsForQuery('白酒', 'all', null, upstream)).toEqual({
      hits: [],
      degraded: true,
      stale: false,
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('类型筛选取值', () => {
  it('空值当全部，非法值拒绝', () => {
    expect(parseFundTypeFilter(undefined)).toBe('all');
    expect(parseFundTypeFilter('')).toBe('all');
    expect(parseFundTypeFilter('stock')).toBe('stock');
    expect(parseFundTypeFilter('股票')).toBeNull();
  });

  it('股票档不吞股票指数', () => {
    expect(fundMatchesTypeFilter('股票型', 'stock')).toBe(true);
    expect(fundMatchesTypeFilter('股票指数', 'stock')).toBe(false);
    expect(fundMatchesTypeFilter('股票指数', 'index')).toBe(true);
    expect(fundMatchesTypeFilter('QDII-指数', 'qdii')).toBe(true);
  });
});

describe('基金列表内存缓存', () => {
  const payload = { generatedAt: '2026-08-28T00:00:00.000Z', funds: FIXTURE_FUNDS };

  it('同一 isolate 内不重复解析 R2 对象', async () => {
    let gets = 0;
    let heads = 0;
    const env = {
      ARCHIVE: {
        head: async () => {
          heads += 1;
          return { etag: 'etag-v1' };
        },
        get: async () => {
          gets += 1;
          return { etag: 'etag-v1', json: async () => payload };
        },
      },
    } as never;
    const memory = createFundListMemory();
    const first = await loadFundSearchIndex(env, 1_000, memory);
    const second = await loadFundSearchIndex(env, 2_000, memory);
    expect(first?.byCode.has('000001')).toBe(true);
    expect(second).toBe(first);
    expect(gets).toBe(1);
    expect(heads).toBe(0);
  });

  it('TTL 过期后 etag 未变则只 head 不 get', async () => {
    let gets = 0;
    let heads = 0;
    const env = {
      ARCHIVE: {
        head: async () => {
          heads += 1;
          return { etag: 'etag-v1' };
        },
        get: async () => {
          gets += 1;
          return { etag: 'etag-v1', json: async () => payload };
        },
      },
    } as never;
    const memory = createFundListMemory();
    await loadFundSearchIndex(env, 0, memory);
    await loadFundSearchIndex(env, 31 * 60 * 1000, memory);
    expect(gets).toBe(1);
    expect(heads).toBe(1);
  });
});

describe('isolate 索引 singleflight / backoff / 替换阈值', () => {
  const payload = { generatedAt: '2026-08-28T00:00:00.000Z', funds: FIXTURE_FUNDS };

  function envWith(
    handlers: {
      get?: () => Promise<{ etag: string; json: () => Promise<unknown> } | null>;
      head?: () => Promise<{ etag: string } | null>;
    },
  ) {
    return {
      ARCHIVE: {
        head: handlers.head ?? (async () => ({ etag: 'etag-v1' })),
        get: handlers.get ?? (async () => ({ etag: 'etag-v1', json: async () => payload })),
      },
    } as never;
  }

  it('N 个并发冷启动只 get/parse 一次', async () => {
    let gets = 0;
    let parses = 0;
    const env = envWith({
      get: async () => {
        gets += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          etag: 'etag-v1',
          json: async () => {
            parses += 1;
            return payload;
          },
        };
      },
    });
    const memory = createFundListMemory();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadFundSearchIndex(env, 0, memory, { minFunds: 1 })),
    );
    expect(gets).toBe(1);
    expect(parses).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]?.funds).toHaveLength(FIXTURE_FUNDS.length);
  });

  it('R2 全失败且无索引时返回 null，backoff 内不再打 R2', async () => {
    let gets = 0;
    const env = envWith({
      get: async () => {
        gets += 1;
        throw new Error('r2 down');
      },
    });
    const memory = createFundListMemory();
    expect(await loadFundSearchIndex(env, 0, memory)).toBeNull();
    expect(await loadFundSearchIndex(env, 5_000, memory)).toBeNull();
    expect(gets).toBe(1);
    expect(memory.failUntil).toBe(INDEX_BACKOFF_MS);
  });

  it('R2 失败后仍返回 last-known-good 并标 stale', async () => {
    let gets = 0;
    let fail = false;
    const env = envWith({
      head: async () => {
        if (fail) throw new Error('r2 down');
        return { etag: 'etag-v1' };
      },
      get: async () => {
        gets += 1;
        if (fail) throw new Error('r2 down');
        return { etag: 'etag-v1', json: async () => payload };
      },
    });
    const memory = createFundListMemory();
    const first = await loadFundSearchIndex(env, 0, memory, { minFunds: 1 });
    fail = true;
    expireFundListMemory(memory, 31 * 60 * 1000);
    const second = await loadFundSearchIndex(env, 31 * 60 * 1000, memory, { minFunds: 1 });
    expect(second).toBe(first);
    expect(memory.stale).toBe(true);
    const third = await loadFundSearchIndex(env, 31 * 60 * 1000 + 5_000, memory, { minFunds: 1 });
    expect(third).toBe(first);
    expect(gets).toBe(1);
  });

  it('未达阈值的脏对象不能替换健康索引', async () => {
    const memory = createFundListMemory();
    const healthy = envWith({
      get: async () => ({ etag: 'etag-v1', json: async () => payload }),
    });
    const first = await loadFundSearchIndex(healthy, 0, memory, { minFunds: 1 });
    const corruptFunds = [
      FIXTURE_FUNDS[0],
      FIXTURE_FUNDS[1],
      ...Array.from({ length: 20 }, (_, i) => ({ name: `脏行${i}` })),
    ];
    const corrupt = envWith({
      head: async () => ({ etag: 'etag-corrupt' }),
      get: async () => ({
        etag: 'etag-corrupt',
        json: async () => ({ generatedAt: '2026-08-29T00:00:00.000Z', funds: corruptFunds }),
      }),
    });
    expireFundListMemory(memory, 31 * 60 * 1000);
    const second = await loadFundSearchIndex(corrupt, 31 * 60 * 1000, memory);
    expect(second).toBe(first);
    expect(memory.index?.etag).toBe('etag-v1');
    expect(memory.stale).toBe(true);
  });

  it('低于生产下限的夹具只有显式测试选项才允许替换', async () => {
    const memory = createFundListMemory();
    const firstEnv = envWith({
      get: async () => ({ etag: 'etag-v1', json: async () => payload }),
    });
    const first = await loadFundSearchIndex(firstEnv, 0, memory, { minFunds: 1 });
    const nextPayload = {
      generatedAt: '2026-08-29T00:00:00.000Z',
      funds: FIXTURE_FUNDS.slice(0, 3),
    };
    const nextEnv = envWith({
      head: async () => ({ etag: 'etag-v2' }),
      get: async () => ({ etag: 'etag-v2', json: async () => nextPayload }),
    });
    expireFundListMemory(memory, 31 * 60 * 1000);
    const rejected = await loadFundSearchIndex(nextEnv, 31 * 60 * 1000, memory);
    expect(rejected).toBe(first);
    expect(rejected?.funds).toHaveLength(FIXTURE_FUNDS.length);

    expireFundListMemory(memory, 62 * 60 * 1000);
    const accepted = await loadFundSearchIndex(nextEnv, 62 * 60 * 1000, memory, { minFunds: 1 });
    expect(accepted).not.toBe(first);
    expect(accepted?.funds).toHaveLength(3);
    expect(accepted?.etag).toBe('etag-v2');
    expect(PRODUCTION_MIN_FUNDS).toBe(10_000);
  });
});
