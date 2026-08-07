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
}

export function fetchHoldings(code: string): Promise<HoldingsResponse> {
  return get<HoldingsResponse>(`/api/funds/${code}/holdings`);
}

export interface QuoteResponse {
  [secid: string]: {
    secid: string;
    code: string;
    name: string;
    price: number;
    chgPct: number;
    prevClose: number | null;
  };
}

export function fetchQuotes(secids: string[]): Promise<QuoteResponse> {
  return get<QuoteResponse>(`/api/quotes?secids=${secids.join(',')}`);
}
