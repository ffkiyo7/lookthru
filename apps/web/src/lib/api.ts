/**
 * 后端 API 客户端。前端与 Worker 同源（Workers Static Assets），
 * 所以是相对路径、无 CORS、无需带 base URL。
 */

import type {
  LatestOfficialNav,
  Position,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '@lookthru/shared';
import type { FundTypeFilter } from '@lookthru/shared/fund-types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let body: unknown = null;
    try {
      body = (await res.json()) as { error?: unknown };
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // 错误响应不是 JSON 时保留 HTTP 状态；不能把解析失败伪装成成功。
    }
    throw new ApiError(res.status, message, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function get<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

function json<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface SessionResponse {
  userId: string;
}

export function fetchSession(): Promise<SessionResponse> {
  return get('/api/auth/session');
}

export function redeemInvite(inviteCode: string): Promise<SessionResponse & { recoveryCode: string }> {
  return json('/api/auth/redeem', 'POST', { inviteCode });
}

export function recoverSession(recoveryCode: string): Promise<SessionResponse> {
  return json('/api/auth/recover', 'POST', { recoveryCode });
}

export function logout(): Promise<void> {
  return request('/api/auth/logout', { method: 'POST' });
}

export interface SearchFundsResult {
  hits: SearchHit[];
  stale: boolean;
}

export async function searchFunds(
  keyword: string,
  type: FundTypeFilter = 'all',
  signal?: AbortSignal,
): Promise<SearchFundsResult> {
  const params = new URLSearchParams({ q: keyword });
  if (type !== 'all') params.set('type', type);
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  const res = await fetch(`/api/funds/search?${params}`, { headers, credentials: 'same-origin', signal });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let body: unknown = null;
    try {
      body = (await res.json()) as { error?: unknown };
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // 错误响应不是 JSON 时保留 HTTP 状态；不能把解析失败伪装成成功。
    }
    throw new ApiError(res.status, message, body);
  }
  return {
    hits: (await res.json()) as SearchHit[],
    stale: res.headers.get('X-Lookthru-Index') === 'stale',
  };
}

export interface HoldingsResponse {
  reportDate: string | null;
  holdings: { stockCode: string; stockName: string; weight: number; secid: string | null }[];
  coverageWeight: number;
  industries: { code: string; name: string; weight: number }[];
  fetchedAt: string;
  stale: boolean;
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

export interface FundDetailResponse {
  fund: SearchHit;
  holdings: HoldingsResponse;
  quotes: QuoteResponse & { holdingsReportDate: string | null; holdingsStale: boolean };
}

export function fetchFundDetail(code: string, signal?: AbortSignal): Promise<FundDetailResponse> {
  return get<FundDetailResponse>(`/api/funds/${code}/detail`, { signal });
}

export interface PositionsResponse {
  updatedAt: string | null;
  positions: Array<Position & { officialValue: LatestOfficialNav | null }>;
}

export function fetchPositions(): Promise<PositionsResponse> {
  return get('/api/positions');
}

export interface XRayResponse {
  exposures: {
    stockCode: string;
    stockName: string;
    pct: number;
    value: number;
    chgPct: number | null;
    funds: { name: string; contribPct: number }[];
  }[];
  sectors: { name: string; pct: number; value: number; fundCount: number }[];
  meta: {
    fundCount: number;
    coveragePct: number;
    reportDate: string | null;
    reportQuarter: string | null;
    staleDays: number | null;
    top5Pct: number;
    valueBasis: 'ESTIMATED' | 'OFFICIAL' | 'MIXED' | 'EMPTY';
    estimatedFundCount: number;
    officialFundCount: number;
  };
  facts: {
    redemptionPenalty: {
      ratePct: 1.5;
      funds: { fundCode: string; fundName: string; heldDays: number }[];
    };
    concentration: { top5Pct: number };
    industryOverlap: { overlapPct: number; overlappingIndustryCount: number };
  };
  updatedAt: string | null;
  unavailableValueFundCount: number;
  holdingsStaleFundCount: number;
  quoteProvider: string | null;
  quoteDelayed: boolean;
  quoteStaleSecids: string[];
  quoteUnavailableSecids: string[];
}

export function fetchXRay(): Promise<XRayResponse> {
  return get('/api/xray');
}

export interface CreateTransactionInput {
  fundCode: string;
  type: TransactionType;
  tradeDate: string;
  confirmDate: string | null;
  shares: number | null;
  amount: number | null;
  price: number | null;
  fee: number;
  status: TransactionStatus;
  note: string | null;
}

export function createTransaction(
  input: CreateTransactionInput,
): Promise<{ transaction: Transaction }> {
  return json('/api/transactions', 'POST', input);
}

export type NotifyKind = 'DAILY' | 'ALERT';

export interface NotifyBindingState {
  kind: NotifyKind;
  provider: 'DISCORD';
  configured: boolean;
}

export function fetchNotifyBindings(): Promise<{ bindings: NotifyBindingState[] }> {
  return get('/api/notify-bindings');
}

export function saveNotifyBinding(
  kind: NotifyKind,
  webhookUrl: string,
): Promise<NotifyBindingState> {
  return json(`/api/notify-bindings/${kind}`, 'PUT', { webhookUrl });
}

export function removeNotifyBinding(kind: NotifyKind): Promise<void> {
  return request(`/api/notify-bindings/${kind}`, { method: 'DELETE' });
}

export function testNotifyBinding(
  kind: NotifyKind,
): Promise<{ kind: NotifyKind; delivered: true; status: number }> {
  return request(`/api/notify-bindings/${kind}/test`, { method: 'POST' });
}
