/**
 * 后端 API 客户端。前端与 Worker 同源（Workers Static Assets），
 * 所以是相对路径、无 CORS、无需带 base URL。
 */

export interface SearchHit {
  code: string;
  name: string;
  pinyin: string;
  /** 细分类型：货币型-普通货币 / 混合型-偏股 等 */
  type: string;
  /** ⚠️ 货币基金这里是「万份收益」而非净值，展示时须换标签 */
  nav: number | null;
  navDate: string | null;
  company: string | null;
  isMoneyFund: boolean;
  /** 与一小时基金信息缓存分离，按 60 秒刷新；上游故障时会标陈旧或不可用。 */
  chgPct: number | null;
  changeTime: string | null;
  changeStale: boolean;
  changeUnavailable: boolean;
}

/** 「混合型-偏股」→「混合型」，列表里只显示大类 */
export function shortType(type: string): string {
  return type.split('-')[0] ?? type;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function searchFunds(keyword: string): Promise<SearchHit[]> {
  return get<SearchHit[]>(`/api/funds/search?q=${encodeURIComponent(keyword)}`);
}

export interface HoldingsResponse {
  reportDate: string | null;
  holdings: { stockCode: string; stockName: string; weight: number; secid: string | null }[];
  coverageWeight: number;
  industries: { code: string; name: string; weight: number }[];
  fetchedAt: string;
  stale: boolean;
}

export function fetchHoldings(code: string): Promise<HoldingsResponse> {
  return get<HoldingsResponse>(`/api/funds/${code}/holdings`);
}

export interface Quote {
  secid: string;
  code: string;
  /** ⚠️ 降级到腾讯/新浪源时为空串（GBK 乱码不可用），名称需从基金库取 */
  name: string;
  price: number;
  chgPct: number;
  prevClose: number | null;
}

export interface QuoteResponse {
  /** 实际命中的行情源，null 表示全链失败 */
  provider: string | null;
  /** true = 延时行情，不能当实时展示，估值精度需相应降级 */
  delayed: boolean;
  fetchedAt: string | null;
  staleSecids: string[];
  unavailableSecids: string[];
  quotes: Record<string, Quote>;
}

export function fetchQuotes(secids: string[]): Promise<QuoteResponse> {
  return get<QuoteResponse>(`/api/quotes?secids=${secids.join(',')}`);
}

/** 公开基金详情只能取该基金披露持仓对应的行情，不能传任意 secid。 */
export function fetchFundQuotes(code: string): Promise<
  QuoteResponse & { holdingsReportDate: string | null; holdingsStale: boolean }
> {
  return get(`/api/funds/${code}/quotes`);
}
