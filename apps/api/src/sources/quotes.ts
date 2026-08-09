/**
 * 实时行情的降级链。
 *
 * 背景（2026-08-09 从 Cloudflare LAX 出口实测）：
 *   push2.eastmoney.com 主域       502  稳定不可用
 *   2/5/99.push2                   520
 *   3/19/33/50.push2               200  3.6–5.9s
 *   push2delay                     200  2.0s（延时行情）
 *   qt.gtimg.cn（腾讯）            200  2.8s（实时）
 *   hq.sinajs.cn（新浪）           200  2.8s（实时）
 *   query1.finance.yahoo.com       200  0.1s（快 25 倍，但**无批量接口**）
 *
 * 分片健康度会漂移，所以不写死主机而是按序试；东财全灭时切腾讯/新浪。
 * 雅虎排在境内三家之后、延时源之前：它是唯一的境外源（相关性最低的退路），
 * 但一次只能查一只，标的数超过上限就跳过，不做扇出。
 * 延时源排最后：可用性最好，但滞后的行情会让盘中估值失真，只作兜底。
 *
 * ⚠️ 腾讯/新浪返回的名称是 GBK 乱码，本模块统一置空。
 *    调用方需要股票名称时从我们自己的库取，不要用行情源的 name。
 */

import type { Quote } from '@lookthru/shared';
import { EM_QUOTE_HOSTS, EM_QUOTE_HOST_DELAYED, fetchQuotes } from './eastmoney';
import { fetchQuotesTencent } from './tencent';
import { fetchQuotesSina } from './sina';
import { fetchQuotesYahoo, YAHOO_MAX_SYMBOLS } from './yahoo';

export interface QuoteAttempt {
  provider: string;
  ok: boolean;
  ms: number;
  count: number;
  error: string | null;
}

export interface QuoteResult {
  quotes: Map<string, Quote>;
  /** 实际命中的源 */
  provider: string | null;
  /** 命中的是延时行情 —— 必须向上传递到估值精度，不能当实时用 */
  delayed: boolean;
  attempts: QuoteAttempt[];
}

interface Provider {
  name: string;
  delayed: boolean;
  fetch: (secids: string[]) => Promise<Map<string, Quote>>;
  /** 无批量接口的源（雅虎）：标的数超过此值直接跳过，不做扇出 */
  maxSymbols?: number;
}

const PROVIDERS: Provider[] = [
  ...EM_QUOTE_HOSTS.map((host) => ({
    name: `em:${host}`,
    delayed: false,
    fetch: (secids: string[]) => fetchQuotes(secids, host),
  })),
  { name: 'tencent', delayed: false, fetch: fetchQuotesTencent },
  { name: 'sina', delayed: false, fetch: fetchQuotesSina },
  // 雅虎是唯一的境外源 —— 上面三家同属境内，从 CF 出口是同一类风险，
  // 相关性最低的退路值得留着。但它无批量接口，只在标的数少时可用。
  { name: 'yahoo', delayed: false, fetch: fetchQuotesYahoo, maxSymbols: YAHOO_MAX_SYMBOLS },
  {
    name: `em:${EM_QUOTE_HOST_DELAYED}`,
    delayed: true,
    fetch: (secids: string[]) => fetchQuotes(secids, EM_QUOTE_HOST_DELAYED),
  },
];

export async function fetchQuotesResilient(secids: string[]): Promise<QuoteResult> {
  const attempts: QuoteAttempt[] = [];
  if (secids.length === 0) {
    return { quotes: new Map(), provider: null, delayed: false, attempts };
  }

  const uniqCount = new Set(secids).size;

  for (const p of PROVIDERS) {
    if (p.maxSymbols !== undefined && uniqCount > p.maxSymbols) {
      attempts.push({
        provider: p.name,
        ok: false,
        ms: 0,
        count: 0,
        error: `跳过：${uniqCount} 只超过该源上限 ${p.maxSymbols}`,
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const quotes = await p.fetch(secids);
      attempts.push({
        provider: p.name,
        ok: quotes.size > 0,
        ms: Date.now() - t0,
        count: quotes.size,
        error: quotes.size === 0 ? '返回 0 条' : null,
      });
      // 空 Map 视为失败：主机可能 200 但内容为空，继续降级
      if (quotes.size > 0) {
        return { quotes, provider: p.name, delayed: p.delayed, attempts };
      }
    } catch (e) {
      attempts.push({
        provider: p.name,
        ok: false,
        ms: Date.now() - t0,
        count: 0,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
    }
  }

  return { quotes: new Map(), provider: null, delayed: false, attempts };
}
