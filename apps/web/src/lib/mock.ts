import type { Position, TopHolding, Valuation } from '@lookthru/shared';

/**
 * 演示数据。全部按 @lookthru/shared 的真实类型构造，接后端时只换数据来源、不改组件。
 *
 * 数值取自设计稿；基金详情部分是实测的真实数据（161725 的 2026Q2 季报与费率）。
 * 待 P1 持仓 API 就绪后整个文件删除。
 */

function val(
  fundCode: string,
  estNav: number | null,
  estChgPct: number | null,
  precision: Valuation['precision'],
  prevNav: number,
  note: string,
  basis: Partial<Valuation['basis']> = {},
): Valuation {
  return {
    fundCode,
    estNav,
    estChgPct,
    precision,
    prevNav,
    estTime: '2026-08-07T06:23:00.000Z',
    basis: {
      reportDate: basis.reportDate ?? null,
      staleDays: basis.staleDays ?? null,
      coverageWeight: basis.coverageWeight ?? null,
      note,
    },
  };
}

/** 这份 fixture 的「抓取时刻」—— FreshnessLine 用它演示实时态。接后端时换成 dataUpdatedAt */
export const MOCK_UPDATED_AT = Date.now() - 40_000;

export const MOCK_POSITIONS: Position[] = [
  {
    fundCode: '161725',
    fundName: '招商中证白酒指数(LOF)A',
    shares: 12_450,
    costTotal: 8_182.14,
    costPerShare: 0.6572,
    marketValue: 7_014.7,
    holdingReturn: -1_203.4,
    holdingReturnPct: -14.65,
    dayReturn: 34.86,
    valuation: val('161725', 0.5634, 0.5, 'EXACT', 0.5606, '场内实时成交价'),
  },
  {
    fundCode: '005827',
    fundName: '易方达蓝筹精选混合',
    shares: 8_200,
    costTotal: 10_078.05,
    costPerShare: 1.2293,
    marketValue: 12_488.6,
    holdingReturn: 2_410.55,
    holdingReturnPct: 23.92,
    dayReturn: -31.28,
    valuation: val('005827', 1.523, -0.25, 'MEDIUM', 1.5268, '基于 2026Q2 前十大（占 62%）', {
      reportDate: '2026-06-30',
      staleDays: 38,
      coverageWeight: 62,
    }),
  },
  {
    fundCode: '000001',
    fundName: '华夏成长混合',
    shares: 5_600,
    costTotal: 6_510.28,
    costPerShare: 1.1626,
    marketValue: 7_400.4,
    holdingReturn: 890.12,
    holdingReturnPct: 13.67,
    dayReturn: 36.4,
    valuation: val('000001', 1.3215, 0.49, 'LOW', 1.315, '前十大仅占 41%，误差较大', {
      reportDate: '2026-06-30',
      staleDays: 38,
      coverageWeight: 41,
    }),
  },
  {
    fundCode: '217022',
    fundName: '招商产业债券A',
    shares: 20_000,
    costTotal: 24_223.7,
    costPerShare: 1.2112,
    marketValue: 24_680.0,
    holdingReturn: 456.3,
    holdingReturnPct: 1.88,
    dayReturn: null,
    valuation: val('217022', null, null, 'NONE', 1.234, '债券型基金不提供盘中估算'),
  },
];

/** 汇总由持仓推导 —— 真实实现也必须这样，绝不单独维护一份总数 */
export function summarize(positions: Position[]) {
  const marketValue = positions.reduce((a, p) => a + p.marketValue, 0);
  const costTotal = positions.reduce((a, p) => a + p.costTotal, 0);
  const dayReturn = positions.reduce((a, p) => a + (p.dayReturn ?? 0), 0);
  const holdingReturn = positions.reduce((a, p) => a + p.holdingReturn, 0);
  const prevValue = marketValue - dayReturn;
  return {
    marketValue,
    dayReturn,
    dayReturnPct: prevValue > 0 ? (dayReturn / prevValue) * 100 : 0,
    holdingReturn,
    holdingReturnPct: costTotal > 0 ? (holdingReturn / costTotal) * 100 : 0,
    /** 有基金当日无估算（债基/QDII）时必须告知，否则总数会被误读为完整 */
    unestimatedCount: positions.filter((p) => p.valuation?.precision === 'NONE').length,
  };
}

// ─────────────────────────────────────────────────────────────
// 基金详情（161725）—— 以下为实测真实数据
// ─────────────────────────────────────────────────────────────

export const MOCK_HOLDINGS: (TopHolding & { chgPct: number; delta: string })[] = [
  {
    stockCode: '600519',
    stockName: '贵州茅台',
    weight: 17.28,
    secid: '1.600519',
    chgPct: 0.82,
    delta: '减 1.05',
  },
  {
    stockCode: '600809',
    stockName: '山西汾酒',
    weight: 15.19,
    secid: '1.600809',
    chgPct: 1.34,
    delta: '增 0.87',
  },
  {
    stockCode: '000568',
    stockName: '泸州老窖',
    weight: 15.03,
    secid: '0.000568',
    chgPct: -0.45,
    delta: '增 0.33',
  },
  {
    stockCode: '000858',
    stockName: '五粮液',
    weight: 14.22,
    secid: '0.000858',
    chgPct: 0.28,
    delta: '减 1.92',
  },
  {
    stockCode: '002304',
    stockName: '洋河股份',
    weight: 7.88,
    secid: '0.002304',
    chgPct: -0.91,
    delta: '增 0.14',
  },
];

export const MOCK_FUND_DETAIL = {
  code: '161725',
  name: '招商中证白酒指数(LOF)A',
  typeLabel: '指数型 · 场内LOF',
  officialNav: 0.5606,
  officialDate: '2026-08-06',
  reportDate: '2026-06-30',
  coverageWeight: 85.95,
  allocation: { stock: 94.79, bond: 0, cash: 6.15 },
  manager: { name: '侯昊', workTime: '8年352天', fundCount: 23, fundSize: '443.39亿' },
  rate: { source: 1.0, current: 0.1 },
  scale: { value: 197.4, date: '2026-06-30', momPct: -23.6 },
  /** 持有 4 天 —— 7 日内赎回费 1.5% 的惩罚性档位，纯事实提示 */
  heldDays: 4,
};

// ─────────────────────────────────────────────────────────────
// 持仓穿透
// ─────────────────────────────────────────────────────────────

export interface ExposureRow {
  stockCode: string;
  stockName: string;
  /** 占总资产比 % */
  pct: number;
  value: number;
  chgPct: number;
  funds: { name: string; contribPct: number }[];
}

export const MOCK_EXPOSURE: ExposureRow[] = [
  {
    stockCode: '600519',
    stockName: '贵州茅台',
    pct: 8.24,
    value: 10_584,
    chgPct: 0.11,
    funds: [
      { name: '招商中证白酒指数(LOF)A', contribPct: 3.8 },
      { name: '易方达蓝筹精选混合', contribPct: 2.6 },
      { name: '华夏成长混合', contribPct: 1.84 },
    ],
  },
  {
    stockCode: '000858',
    stockName: '五粮液',
    pct: 5.13,
    value: 6_589,
    chgPct: 1.42,
    funds: [
      { name: '招商中证白酒指数(LOF)A', contribPct: 3.1 },
      { name: '易方达蓝筹精选混合', contribPct: 2.03 },
    ],
  },
  {
    stockCode: '000568',
    stockName: '泸州老窖',
    pct: 4.87,
    value: 6_255,
    chgPct: -0.63,
    funds: [
      { name: '招商中证白酒指数(LOF)A', contribPct: 3.0 },
      { name: '华夏成长混合', contribPct: 1.87 },
    ],
  },
  {
    stockCode: '300750',
    stockName: '宁德时代',
    pct: 3.02,
    value: 3_879,
    chgPct: 2.1,
    funds: [{ name: '易方达蓝筹精选混合', contribPct: 3.02 }],
  },
  {
    stockCode: '600809',
    stockName: '山西汾酒',
    pct: 2.94,
    value: 3_776,
    chgPct: 0.55,
    funds: [{ name: '招商中证白酒指数(LOF)A', contribPct: 2.94 }],
  },
];

export const MOCK_SECTORS = [
  { name: '食品饮料', pct: 42.3, color: 'var(--color-sector-1)' },
  { name: '电力设备', pct: 12.1, color: 'var(--color-sector-2)' },
  { name: '医药生物', pct: 9.8, color: 'var(--color-sector-3)' },
  { name: '电子', pct: 8.4, color: 'var(--color-sector-4)' },
  { name: '其他', pct: 27.4, color: 'var(--color-sector-5)' },
];

export const MOCK_XRAY_META = {
  fundCount: 4,
  coveragePct: 78.3,
  reportQuarter: '2026Q2',
  staleDays: 38,
  top5Pct: 24.2,
};

// ─────────────────────────────────────────────────────────────
// 搜索
// ─────────────────────────────────────────────────────────────

export const MOCK_WATCHLIST = [
  { code: '161725', name: '招商中证白酒指数(LOF)A', type: '指数型', nav: 0.5634, chgPct: 0.5 },
  { code: '000001', name: '华夏成长混合', type: '混合型', nav: 1.3215, chgPct: 0.49 },
  { code: '005827', name: '易方达蓝筹精选混合', type: '混合型', nav: 1.523, chgPct: -0.25 },
  { code: '217022', name: '招商产业债券A', type: '债券型', nav: 1.234, chgPct: null },
];

export const HOT_KEYWORDS = [
  '白酒',
  '医药',
  '新能源',
  '半导体',
  '沪深300',
  '中概互联',
  '黄金',
  '红利低波',
  '纳指ETF',
  '军工',
];
