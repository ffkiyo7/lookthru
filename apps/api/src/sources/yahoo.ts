/**
 * 雅虎财经 —— 唯一一个不在中国境内的行情源。
 *
 * 定位（实测 2026-08-09，CF LAX 出口）：
 *   优点：96–142ms（比东财/腾讯/新浪快约 25 倍）；数据与东财逐位一致；
 *         沪深股票 + ETF 全覆盖；**名称是干净 UTF-8**，补上了腾讯/新浪 GBK 乱码的缺口
 *   死穴：**没有可用的批量接口**。v7 quote 需 crumb+cookie（401），v6 已下线（404），
 *         只剩 v8 chart 一次一只
 *
 * 因此它不能当主源：估值引擎每分钟要刷上百只重仓股，逐只请求既违反
 * 「中央化抓取」铁律（plan 3.3），也必然被限流。它的价值在于**独立性** ——
 * 东财/腾讯/新浪同属境内，从 CF 出口是同一类风险；雅虎全灭的相关性最低。
 *
 * ⚠️ A 股行情雅虎通常延时，但 chart meta 未声明 `exchangeDataDelayedBy`，
 *    实际延时需在交易日实测后再决定是否要置 delayed 标记。
 */

import type { Quote } from '@lookthru/shared';
import { fetchJson } from './http';

/** 超过这个数量就不走雅虎 —— 它会扇出成 N 个请求 */
export const YAHOO_MAX_SYMBOLS = 25;

/** 并发上限：既要快，也不能瞬间打出几十个请求 */
const CONCURRENCY = 8;

/** secid `1.600519` → `600519.SS`；`0.159915` → `159915.SZ` */
export function secidToYahoo(secid: string): string | null {
  const [market, code] = secid.split('.');
  if (!code) return null;
  if (market === '1') return `${code}.SS`;
  if (market === '0') return `${code}.SZ`;
  return null;
}

interface ChartResp {
  chart?: {
    result?:
      | {
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            shortName?: string;
            longName?: string;
          };
        }[]
      | null;
  } | null;
}

async function fetchOne(secid: string, symbol: string): Promise<[string, Quote] | null> {
  const j = await fetchJson<ChartResp>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
    { source: 'yahoo:quote', timeoutMs: 8_000, retries: 1 },
  );
  const meta = j.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!meta || !Number.isFinite(price) || price <= 0) return null;

  const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose);
  const hasPrev = Number.isFinite(prevClose) && prevClose > 0;

  return [
    secid,
    {
      secid,
      code: secid.split('.')[1] ?? '',
      name: meta.shortName ?? meta.longName ?? '',
      price,
      chgPct: hasPrev ? Number((((price - prevClose) / prevClose) * 100).toFixed(4)) : 0,
      prevClose: hasPrev ? prevClose : null,
    },
  ];
}

export async function fetchQuotesYahoo(secids: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const pairs = [...new Set(secids)]
    .map((s) => [s, secidToYahoo(s)] as const)
    .filter((p): p is readonly [string, string] => p[1] !== null);

  if (pairs.length > YAHOO_MAX_SYMBOLS) {
    throw new Error(`雅虎无批量接口，${pairs.length} 只超过上限 ${YAHOO_MAX_SYMBOLS}`);
  }

  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const batch = pairs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(([s, sym]) => fetchOne(s, sym)));
    for (const r of settled) {
      // 单只失败不影响其余：调用方按 last-known-good 兜底
      if (r.status === 'fulfilled' && r.value) out.set(r.value[0], r.value[1]);
    }
  }
  return out;
}
