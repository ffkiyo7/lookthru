import {
  fundMatchesTypeFilter,
  type FundTypeFilter,
} from '@lookthru/shared/fund-types';
import type { FundListIndex, SearchableFund } from './fund-list';
import type { FundSearchHit } from './sources/eastmoney';

export const LOCAL_SEARCH_LIMIT = 30;

export const FUND_LIST_UNAVAILABLE_ERROR = 'fund list unavailable';

export type LocalMatchKind = 'code' | 'pinyin' | 'name';

export interface SearchQueryResult {
  hits: FundSearchHit[];
  /** 冷启动且没有可用索引。名称/拼音必须 503，不能伪装成「未找到」。 */
  degraded: boolean;
  /** isolate 正在用 last-known-good，刷新失败。响应仍是 200 数组。 */
  stale: boolean;
}

/**
 * 只有完整 6 位代码、且本地列表里没有这只基金时，才允许打东财 suggest。
 * 部分名称 / 拼音 / 短数字绝不能回源——那会把「每次按键打上游」加回来。
 */
export function shouldUseEastMoneyFallback(query: string, index: FundListIndex | null): boolean {
  if (!/^\d{6}$/.test(query)) return false;
  if (index === null) return true;
  return !index.byCode.has(query);
}

export function matchLocalFund(fund: SearchableFund, query: string): LocalMatchKind | null {
  const q = query.trim();
  if (!q) return null;
  const qLower = q.toLowerCase();
  const digitsOnly = /^\d+$/.test(q);
  if (digitsOnly) return fund.code.includes(q) ? 'code' : null;
  if (
    /[a-z]/i.test(q) &&
    (fund.pinyinShortLower.includes(qLower) || fund.pinyinFullLower.includes(qLower))
  ) {
    return 'pinyin';
  }
  if (fund.name.includes(q) || fund.name.toLowerCase().includes(qLower)) return 'name';
  return null;
}

function rank(fund: SearchableFund, query: string, kind: LocalMatchKind): number {
  const qLower = query.toLowerCase();
  if (kind === 'code') {
    if (fund.code === query) return 0;
    if (fund.code.startsWith(query)) return 1;
    return 2;
  }
  if (kind === 'pinyin') {
    if (fund.pinyinShortLower === qLower) return 10;
    if (fund.pinyinShortLower.startsWith(qLower)) return 11;
    if (fund.pinyinFullLower === qLower) return 12;
    if (fund.pinyinFullLower.startsWith(qLower)) return 13;
    return 14;
  }
  if (fund.name.startsWith(query)) return 20;
  return 21;
}

export function toSearchHit(fund: SearchableFund): FundSearchHit {
  return {
    code: fund.code,
    name: fund.name,
    pinyin: fund.pinyinShort,
    type: fund.type,
    nav: null,
    navDate: null,
    company: null,
    isMoneyFund: fund.isMoneyFund,
  };
}

/**
 * 在已解析的全量列表上做本地匹配。
 * 类型筛选只作用于名称命中：按代码或拼音找到的基金，选了「债券」也不能被藏起来，
 * 否则用户输入 000001 却因为上次筛过类型而看到空结果，会以为基金不存在。
 */
export function searchLocalFunds(
  funds: readonly SearchableFund[],
  query: string,
  typeFilter: FundTypeFilter = 'all',
  limit = LOCAL_SEARCH_LIMIT,
): FundSearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const scored: { score: number; fund: SearchableFund }[] = [];
  for (const fund of funds) {
    const kind = matchLocalFund(fund, q);
    if (!kind) continue;
    if (kind === 'name' && !fundMatchesTypeFilter(fund.type, typeFilter)) continue;
    scored.push({ score: rank(fund, q, kind), fund });
  }
  scored.sort((a, b) => a.score - b.score || a.fund.code.localeCompare(b.fund.code));
  return scored.slice(0, limit).map(({ fund }) => toSearchHit(fund));
}

export async function searchFundsForQuery(
  query: string,
  typeFilter: FundTypeFilter,
  index: FundListIndex | null,
  searchUpstream: (keyword: string) => Promise<FundSearchHit[]>,
  stale = false,
): Promise<SearchQueryResult> {
  if (index) {
    const local = searchLocalFunds(index.funds, query, typeFilter);
    if (local.length > 0) return { hits: local, degraded: false, stale };
    if (!shouldUseEastMoneyFallback(query, index)) {
      return { hits: [], degraded: false, stale };
    }
    const upstream = await searchUpstream(query);
    return {
      hits: upstream.filter((hit) => hit.code === query),
      degraded: false,
      stale,
    };
  }

  if (shouldUseEastMoneyFallback(query, null)) {
    try {
      const upstream = await searchUpstream(query);
      const hits = upstream.filter((hit) => hit.code === query);
      if (hits.length > 0) return { hits, degraded: false, stale: false };
    } catch (error) {
      console.warn('[fund-search] 无本地索引时东财回源失败', error);
    }
    return { hits: [], degraded: true, stale: false };
  }

  return { hits: [], degraded: true, stale: false };
}
