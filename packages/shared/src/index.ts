import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// 基金基础
// ─────────────────────────────────────────────────────────────

/** 来自 fundcode_search.js：[代码, 拼音缩写, 名称, 类型, 全拼] */
export const FundBrief = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string(),
  type: z.string(),
  pinyinShort: z.string(),
  pinyinFull: z.string(),
});
export type FundBrief = z.infer<typeof FundBrief>;

export const NavPoint = z.object({
  /** YYYY-MM-DD */
  date: z.string(),
  /** 单位净值 */
  unitNav: z.number(),
  /** 累计净值 */
  accNav: z.number().nullable(),
  /** 日增长率 % */
  chgPct: z.number().nullable(),
});
export type NavPoint = z.infer<typeof NavPoint>;

export const OfficialNavValueKind = z.enum(['UNIT_NAV', 'TEN_THOUSAND_YIELD']);
export type OfficialNavValueKind = z.infer<typeof OfficialNavValueKind>;

const OfficialValueBase = {
  fundCode: z.string().regex(/^\d{6}$/),
  navDate: z.string(),
  source: z.string(),
  fetchedAt: z.string(),
};

/** 最新官方值。货币基金的万份收益与普通基金净值在类型层也不能混用。 */
export const LatestOfficialNav = z.discriminatedUnion('valueKind', [
  z.object({
    ...OfficialValueBase,
    valueKind: z.literal('UNIT_NAV'),
    unitNav: z.number(),
    accNav: z.number().nullable(),
    chgPct: z.number().nullable(),
    tenThousandYield: z.null(),
    sevenDayYieldPct: z.null(),
  }),
  z.object({
    ...OfficialValueBase,
    valueKind: z.literal('TEN_THOUSAND_YIELD'),
    unitNav: z.null(),
    accNav: z.null(),
    chgPct: z.null(),
    tenThousandYield: z.number(),
    sevenDayYieldPct: z.number().nullable(),
  }),
]);
export type LatestOfficialNav = z.infer<typeof LatestOfficialNav>;

/** 季报前十大重仓股，weight 为占基金净值比(%) */
export const TopHolding = z.object({
  stockCode: z.string(),
  stockName: z.string(),
  weight: z.number(),
  secid: z.string().nullable(),
});
export type TopHolding = z.infer<typeof TopHolding>;

export const AssetAllocation = z.object({
  reportDate: z.string(),
  /** 股票占净值比 % */
  stock: z.number().nullable(),
  bond: z.number().nullable(),
  cash: z.number().nullable(),
});
export type AssetAllocation = z.infer<typeof AssetAllocation>;

export const FundProfile = z.object({
  code: z.string(),
  name: z.string(),
  /** 场内标的（ETF/LOF）才有，用于 push2 实时行情 */
  secid: z.string().nullable(),
  isExchangeTraded: z.boolean(),
  managers: z.array(z.object({ id: z.string(), name: z.string() })),
  /** 申购费率原价 / 折后价 */
  rate: z.object({ source: z.number().nullable(), current: z.number().nullable() }),
  latestStockPosition: z.number().nullable(),
  assetAllocation: z.array(AssetAllocation),
  topHoldings: z.array(TopHolding),
  holdingsReportDate: z.string().nullable(),
  navHistory: z.array(NavPoint),
});
export type FundProfile = z.infer<typeof FundProfile>;

// ─────────────────────────────────────────────────────────────
// 行情
// ─────────────────────────────────────────────────────────────

export const Quote = z.object({
  secid: z.string(),
  code: z.string(),
  name: z.string(),
  /** 最新价 */
  price: z.number(),
  /** 涨跌幅 % */
  chgPct: z.number(),
  prevClose: z.number().nullable(),
});
export type Quote = z.infer<typeof Quote>;

// ─────────────────────────────────────────────────────────────
// 估值（自建引擎）
// ─────────────────────────────────────────────────────────────

/**
 * 估值精度分级。官方盘中估值已下线（fundgz 接口 404），全部自建，
 * 因此必须向用户明示精度与误差来源 —— 见 valuation/engine.ts
 */
export const ValuationPrecision = z.enum([
  'EXACT', // 场内 ETF/LOF：直接用实时成交价，就是真实价格
  'HIGH', // 被动指数基金：跟踪指数实时涨跌 × 股票仓位
  'MEDIUM', // 主动基金：前十大权重合计 ≥50% 且季报龄 ≤45 天
  'LOW', // 主动基金：前十大权重 <50% 或季报龄 >60 天
  'NONE', // 债基/货基/QDII：不可估，不显示
]);
export type ValuationPrecision = z.infer<typeof ValuationPrecision>;

export const Valuation = z.object({
  fundCode: z.string(),
  estNav: z.number().nullable(),
  estChgPct: z.number().nullable(),
  precision: ValuationPrecision,
  /** 前一交易日官方净值，估值的基准 */
  prevNav: z.number().nullable(),
  /** ISO 时间戳 */
  estTime: z.string(),
  /** 误差来源，直接渲染给用户看 */
  basis: z.object({
    /** 季报报告期，如 2026-06-30 */
    reportDate: z.string().nullable(),
    /** 持仓数据陈旧天数 */
    staleDays: z.number().nullable(),
    /** 前十大权重合计 % */
    coverageWeight: z.number().nullable(),
    /** 人类可读说明 */
    note: z.string(),
  }),
});
export type Valuation = z.infer<typeof Valuation>;

// ─────────────────────────────────────────────────────────────
// 持仓（交易流水为唯一真相源）
// ─────────────────────────────────────────────────────────────

export const TransactionType = z.enum(['SNAPSHOT', 'BUY', 'SELL', 'DIVIDEND', 'CONVERT']);
export type TransactionType = z.infer<typeof TransactionType>;

/** 场外基金 T+1 确认：15:00 前按当日净值，之后按次日 */
export const TransactionStatus = z.enum(['PENDING', 'CONFIRMED']);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const Transaction = z.object({
  id: z.string(),
  userId: z.string(),
  fundCode: z.string(),
  type: TransactionType,
  tradeDate: z.string(),
  confirmDate: z.string().nullable(),
  shares: z.number().nullable(),
  amount: z.number().nullable(),
  price: z.number().nullable(),
  fee: z.number().default(0),
  status: TransactionStatus,
  note: z.string().nullable(),
});
export type Transaction = z.infer<typeof Transaction>;

export const Position = z.object({
  fundCode: z.string(),
  fundName: z.string(),
  shares: z.number(),
  costTotal: z.number(),
  costPerShare: z.number(),
  /** 官方口径：份额 × 最新官方净值 */
  marketValue: z.number(),
  holdingReturn: z.number(),
  holdingReturnPct: z.number(),
  /** 当日收益（官方净值口径，晚间确认后填充） */
  dayReturn: z.number().nullable(),
  /** 盘中估算，与官方口径严格分离 */
  valuation: Valuation.nullable(),
});
export type Position = z.infer<typeof Position>;

// ─────────────────────────────────────────────────────────────
// secid：东财行情接口的标的标识，格式 {market}.{code}
//   1 = 上交所   0 = 深交所
// ─────────────────────────────────────────────────────────────

export function toSecid(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  const p2 = code.slice(0, 2);
  const p3 = code.slice(0, 3);
  // 上交所：主板 60、科创板 688/689、ETF 51/56/58、LOF 50、指数 000
  if (p2 === '60' || p3 === '688' || p3 === '689') return `1.${code}`;
  if (p2 === '51' || p2 === '56' || p2 === '58' || p2 === '50') return `1.${code}`;
  if (p3 === '000' && code !== '000001') return `1.${code}`; // 000300 沪深300 等指数
  // 深交所：主板 00、创业板 30、ETF 15/16、指数 399
  if (p2 === '00' || p2 === '30' || p2 === '15' || p2 === '16' || p3 === '399') return `0.${code}`;
  return null;
}

/** 场内标的（ETF/LOF）可拿到实时成交价，估值精度为 EXACT */
export function isExchangeTradedCode(code: string): boolean {
  const p2 = code.slice(0, 2);
  return ['15', '16', '50', '51', '56', '58'].includes(p2);
}

/** QDII 在 A 股时段标的市场未开盘，盘中估值无意义，必须禁用 */
export function isQdii(fundType: string, fundName: string): boolean {
  return /QDII/i.test(fundType) || /QDII|美元|人民币现汇|纳斯达克|标普|美国|全球|亚太|香港|恒生/.test(fundName);
}

export function isBondOrMoneyFund(fundType: string): boolean {
  return /债券型|货币型|理财型/.test(fundType);
}

export function isPassiveIndexFund(fundType: string, fundName: string): boolean {
  return /指数型/.test(fundType) || /指数|ETF|联接/.test(fundName);
}
