import { describe, expect, it } from 'vitest';
import { LatestOfficialNav, Position } from '../packages/shared/src';
import { officialNavFromSearchHit, persistOfficialNavs } from '../apps/api/src/nav/sync';
import { derivePositions } from '../apps/api/src/data/transactions';
import type { Transaction } from '../packages/shared/src';
import { assemblePositionSnapshot } from '../apps/api/src/positions';
import { aggregateXRay } from '../apps/api/src/xray/service';
import { heldDaysByFund } from '../apps/api/src/xray/loader';
import { computeDailyReturns } from '../apps/api/src/returns';
import { summarizePositions } from '../apps/web/src/lib/portfolio';

const base = {
  fundCode: '000001',
  navDate: '2026-08-11',
  source: 'test',
  fetchedAt: '2026-08-11T13:00:00.000Z',
};

describe('最新官方值分型', () => {
  it('接受普通基金单位净值', () => {
    expect(
      LatestOfficialNav.safeParse({
        ...base,
        valueKind: 'UNIT_NAV',
        unitNav: 1.2345,
        accNav: 2.3456,
        chgPct: 0.5,
        tenThousandYield: null,
        sevenDayYieldPct: null,
      }).success,
    ).toBe(true);
  });

  it('拒绝把货币基金万份收益同时写进 unitNav', () => {
    expect(
      LatestOfficialNav.safeParse({
        ...base,
        valueKind: 'TEN_THOUSAND_YIELD',
        unitNav: 1.2345,
        accNav: null,
        chgPct: null,
        tenThousandYield: 0.4567,
        sevenDayYieldPct: 1.23,
      }).success,
    ).toBe(false);
  });

  it('stored 只统计 D1 实际变更并只回填实写行的 KV', async () => {
    const cacheWrites: string[] = [];
    const env = {
      DB: {
        prepare: (query: string) => ({
          bind: (...values: unknown[]) => ({
            query,
            values,
            all: async () => ({ results: [] }),
          }),
        }),
        batch: async (statements: unknown[]) =>
          statements.map((_, index) => ({
            meta: { changes: index === 0 ? 1 : 0 },
          })),
      },
      CACHE: {
        put: async (key: string) => {
          cacheWrites.push(key);
        },
      },
    } as never;
    const rows = ['000001', '000002'].map((fundCode) => ({
      ...base,
      fundCode,
      valueKind: 'TEN_THOUSAND_YIELD' as const,
      unitNav: null,
      accNav: null,
      chgPct: null,
      tenThousandYield: 0.4567,
      sevenDayYieldPct: null,
    }));

    await expect(persistOfficialNavs(env, rows)).resolves.toBe(1);
    expect(cacheWrites).toEqual(['navlatest:000001']);
  });

  it('首次录入可把搜索结果转换为共享官方值，普通净值与万份收益不混用', () => {
    const fetchedAt = '2026-08-13T01:00:00.000Z';
    const common = {
      name: '测试基金',
      pinyin: 'CSJJ',
      type: '指数型-海外股票',
      nav: 1.7166,
      navDate: '2026-08-11',
      company: '测试基金公司',
    };
    expect(
      officialNavFromSearchHit(
        { ...common, code: '017641', isMoneyFund: false },
        fetchedAt,
      ),
    ).toMatchObject({
      fundCode: '017641',
      valueKind: 'UNIT_NAV',
      unitNav: 1.7166,
      tenThousandYield: null,
    });
    expect(
      officialNavFromSearchHit(
        { ...common, code: '000009', type: '货币型-普通货币', isMoneyFund: true },
        fetchedAt,
      ),
    ).toMatchObject({
      fundCode: '000009',
      valueKind: 'TEN_THOUSAND_YIELD',
      unitNav: null,
      tenThousandYield: 1.7166,
    });
  });
});

function transaction(
  id: string,
  values: Partial<Transaction> & Pick<Transaction, 'type'>,
): Transaction {
  return {
    id,
    userId: 'user-1',
    fundCode: '000001',
    type: values.type,
    tradeDate: '2026-08-01',
    confirmDate: '2026-08-01',
    shares: null,
    amount: null,
    price: null,
    fee: 0,
    status: 'CONFIRMED',
    note: null,
    ...values,
  };
}

describe('流水推导持仓', () => {
  it('SNAPSHOT 建仓，BUY 按含费成本移动加权', () => {
    const positions = derivePositions([
      transaction('snapshot', { type: 'SNAPSHOT', shares: 100, amount: 100 }),
      transaction('buy', { type: 'BUY', shares: 50, amount: 60, fee: 1 }),
    ]);
    expect(positions).toEqual([
      {
        fundCode: '000001',
        shares: 150,
        costTotal: 161,
        costPerShare: 161 / 150,
      },
    ]);
  });

  it('部分 SELL 按当前均价减成本且均价不变，全部卖出归零', () => {
    const baseTransactions = [
      transaction('snapshot', { type: 'SNAPSHOT', shares: 100, amount: 120 }),
      transaction('sell-part', { type: 'SELL', shares: 25 }),
    ];
    expect(derivePositions(baseTransactions)).toEqual([
      { fundCode: '000001', shares: 75, costTotal: 90, costPerShare: 1.2 },
    ]);
    expect(
      derivePositions([...baseTransactions, transaction('sell-all', { type: 'SELL', shares: 75 })]),
    ).toEqual([]);
  });

  it('PENDING 不计入持仓，且超卖会明确失败', () => {
    expect(
      derivePositions([
        transaction('pending', {
          type: 'SNAPSHOT',
          shares: 100,
          amount: 100,
          status: 'PENDING',
          confirmDate: null,
        }),
      ]),
    ).toEqual([]);
    expect(() =>
      derivePositions([
        transaction('snapshot', { type: 'SNAPSHOT', shares: 10, amount: 10 }),
        transaction('oversell', { type: 'SELL', shares: 11 }),
      ]),
    ).toThrow('超卖');
  });

  it('现金分红减成本，红利再投只加份额，两者都不增加成本', () => {
    const snapshot = transaction('snapshot', { type: 'SNAPSHOT', shares: 100, amount: 100 });
    expect(
      derivePositions([snapshot, transaction('cash', { type: 'DIVIDEND', amount: 10 })]),
    ).toEqual([{ fundCode: '000001', shares: 100, costTotal: 90, costPerShare: 0.9 }]);
    expect(
      derivePositions([snapshot, transaction('reinvest', { type: 'DIVIDEND', shares: 10 })]),
    ).toEqual([
      { fundCode: '000001', shares: 110, costTotal: 100, costPerShare: 100 / 110 },
    ]);
  });

  it('CONVERT 用两条流水分别按转出 SELL 与转入 BUY 处理', () => {
    expect(
      derivePositions([
        transaction('source', { type: 'SNAPSHOT', fundCode: '000001', shares: 100, amount: 100 }),
        transaction('convert-out', { type: 'CONVERT', fundCode: '000001', shares: 25 }),
        transaction('convert-in', {
          type: 'CONVERT',
          fundCode: '000002',
          shares: 50,
          amount: 75,
          fee: 1,
        }),
      ]),
    ).toEqual([
      { fundCode: '000001', shares: 75, costTotal: 75, costPerShare: 1 },
      { fundCode: '000002', shares: 50, costTotal: 76, costPerShare: 1.52 },
    ]);
  });
});

describe('前端持仓汇总', () => {
  it('官方净值待同步时仍返回份额与成本，不伪造市值和收益', () => {
    const snapshot = assemblePositionSnapshot(
      [{ fundCode: '017641', shares: 316.53, costTotal: 550, costPerShare: 550 / 316.53 }],
      [
        {
          code: '017641',
          name: '摩根标普500指数(QDII)人民币A',
          type: '指数型-海外股票',
          isMoneyFund: false,
        },
      ],
      [null],
      new Map(),
    );

    expect(snapshot).toMatchObject({
      updatedAt: null,
      positions: [
        {
          fundCode: '017641',
          fundName: '摩根标普500指数(QDII)人民币A',
          shares: 316.53,
          costTotal: 550,
          marketValue: null,
          holdingReturn: null,
          holdingReturnPct: null,
          officialValue: null,
        },
      ],
    });
    expect(Position.safeParse(snapshot.positions[0]).success).toBe(true);
  });

  it('只从真实持仓推导汇总，并明确统计不可估基金', () => {
    const positions = [
      {
        fundCode: '000001',
        fundName: '基金甲',
        shares: 100,
        costTotal: 90,
        costPerShare: 0.9,
        marketValue: 100,
        holdingReturn: 10,
        holdingReturnPct: 100 / 9,
        dayReturn: 2,
        valuation: {
          fundCode: '000001',
          estNav: 1.05,
          estChgPct: 5,
          precision: 'MEDIUM' as const,
          prevNav: 1,
          estTime: '2026-08-13T06:55:00.000Z',
          basis: {
            reportDate: '2026-06-30',
            staleDays: 44,
            coverageWeight: 55,
            note: '测试估算',
          },
        },
      },
      {
        fundCode: '217022',
        fundName: '债券基金',
        shares: 100,
        costTotal: 100,
        costPerShare: 1,
        marketValue: 99,
        holdingReturn: -1,
        holdingReturnPct: -1,
        dayReturn: null,
        valuation: {
          fundCode: '217022',
          estNav: null,
          estChgPct: null,
          precision: 'NONE' as const,
          prevNav: 0.99,
          estTime: '2026-08-12T06:55:00.000Z',
          basis: { reportDate: null, staleDays: null, coverageWeight: null, note: '债基不可估' },
        },
      },
      {
        fundCode: '017641',
        fundName: '摩根标普500指数(QDII)人民币A',
        shares: 316.53,
        costTotal: 550,
        costPerShare: 550 / 316.53,
        marketValue: null,
        holdingReturn: null,
        holdingReturnPct: null,
        dayReturn: null,
        valuation: null,
      },
    ];

    const summary = summarizePositions(positions);
    expect(summary).toMatchObject({
      marketValue: 204,
      holdingReturn: 14,
      holdingReturnPct: (14 / 190) * 100,
      unestimatedCount: 2,
      unavailableValueCount: 1,
    });
    expect(summary.dayReturn).toBeCloseTo(5);
    expect(summary.dayReturnPct).toBeCloseTo((5 / 199) * 100);
  });
});

describe('持仓穿透聚合', () => {
  it('赎回费事实按最近一笔已确认流入计算，忽略 PENDING 与卖出', () => {
    const days = heldDaysByFund(
      [
        transaction('old', {
          type: 'SNAPSHOT',
          confirmDate: '2026-07-01',
          shares: 100,
          amount: 100,
        }),
        transaction('pending', {
          type: 'BUY',
          tradeDate: '2026-08-12',
          confirmDate: null,
          shares: 10,
          amount: 10,
          status: 'PENDING',
        }),
        transaction('new', {
          type: 'BUY',
          tradeDate: '2026-08-09',
          confirmDate: '2026-08-10',
          shares: 10,
          amount: 10,
        }),
        transaction('sell', {
          type: 'SELL',
          tradeDate: '2026-08-12',
          confirmDate: '2026-08-12',
          shares: 5,
        }),
      ],
      Date.parse('2026-08-12T15:00:00Z'),
    );
    expect(days.get('000001')).toBe(2);
  });

  it('按基金市值乘股票净值占比计算敞口，并用最旧报告期标注整体口径', () => {
    const result = aggregateXRay(
      [
        {
          fundCode: '000001',
          fundName: '基金甲',
          officialMarketValue: 900,
          estimatedMarketValue: 1_000,
          heldDays: 4,
          holdings: {
            reportDate: '2026-06-30',
            coverageWeight: 10,
            holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 10, secid: '1.600519' }],
            industries: [{ code: 'FOOD', name: '食品饮料', weight: 10 }],
          },
        },
        {
          fundCode: '000002',
          fundName: '基金乙',
          officialMarketValue: 2_000,
          estimatedMarketValue: null,
          heldDays: 20,
          holdings: {
            reportDate: '2026-03-31',
            coverageWeight: 20,
            holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 20, secid: '1.600519' }],
            industries: [{ code: 'FOOD', name: '食品饮料', weight: 20 }],
          },
        },
      ],
      new Map([['1.600519', 0.5]]),
      '2026-08-12T00:00:00Z',
    );

    // 甲 1000×10% + 乙 2000×20% = 500；总资产 3000，所以敞口 16.67%。
    expect(result.exposures[0]).toMatchObject({
      stockCode: '600519',
      value: 500,
      pct: 16.67,
      chgPct: 0.5,
    });
    expect(result.meta).toMatchObject({
      coveragePct: 16.67,
      reportDate: '2026-03-31',
      reportQuarter: '2026Q1',
      valueBasis: 'MIXED',
      estimatedFundCount: 1,
      officialFundCount: 1,
    });
    expect(result.facts.redemptionPenalty.funds).toEqual([
      { fundCode: '000001', fundName: '基金甲', heldDays: 4 },
    ]);
    expect(result.facts.industryOverlap).toEqual({ overlapPct: 100, overlappingIndustryCount: 1 });
  });
});

describe('官方日收益与归因', () => {
  it('按当日开始前已确认份额计算，并明确列出缺净值基金', () => {
    const transactions = [
      transaction('snapshot-a', {
        type: 'SNAPSHOT',
        fundCode: '000001',
        tradeDate: '2026-08-09',
        confirmDate: '2026-08-09',
        shares: 1_000,
        amount: 1_000,
      }),
      transaction('snapshot-b', {
        type: 'SNAPSHOT',
        fundCode: '000002',
        tradeDate: '2026-08-09',
        confirmDate: '2026-08-09',
        shares: 500,
        amount: 500,
      }),
      transaction('same-day-buy', {
        type: 'BUY',
        tradeDate: '2026-08-12',
        confirmDate: '2026-08-12',
        shares: 100,
        amount: 100,
      }),
    ];
    const result = computeDailyReturns(
      transactions,
      [
        { fundCode: '000001', date: '2026-08-11', kind: 'UNIT_NAV', value: 1 },
        { fundCode: '000001', date: '2026-08-12', kind: 'UNIT_NAV', value: 1.02 },
      ],
      '2026-08-12',
      '2026-08-12',
    );
    expect(result).toEqual([
      expect.objectContaining({
        date: '2026-08-12',
        dayReturn: 20,
        startMarketValue: 1_000,
        returnPct: 2,
        activeFundCount: 2,
        includedFundCount: 1,
        missingFundCodes: ['000002'],
        attribution: [
          expect.objectContaining({ fundCode: '000001', dayReturn: 20, startMarketValue: 1_000 }),
        ],
      }),
    ]);
  });
});
