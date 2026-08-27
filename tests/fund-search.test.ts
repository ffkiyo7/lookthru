import { describe, expect, it, vi } from 'vitest';
import { fundMatchesTypeFilter, parseFundTypeFilter } from '../packages/shared/src/index';
import {
  createFundListMemory,
  loadFundSearchIndex,
  parseFundListPayload,
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
    const hits = await searchFundsForQuery('白酒', 'all', index, upstream);
    expect(codes(hits)).toEqual(['161725']);
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
    const hits = await searchFundsForQuery('999999', 'all', index, upstream);
    expect(codes(hits)).toEqual(['999999']);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('部分名称或拼音 0 命中也不回源', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('不应请求东财 suggest');
    });
    expect(await searchFundsForQuery('不存在的主题', 'all', index, upstream)).toEqual([]);
    expect(await searchFundsForQuery('zzzzzz', 'all', index, upstream)).toEqual([]);
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
