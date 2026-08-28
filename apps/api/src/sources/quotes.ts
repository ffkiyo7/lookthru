/**
 * 实时行情的有界降级链。
 *
 * Cloudflare 出口实测中，腾讯/新浪约 2.8s，东财实时分片约 3.6–5.9s，
 * 且东财分片健康度会漂移。链路按近期成功与延迟排序，只尝试有限数量的
 * 实时源，再把明确标为 delayed 的东财延时源放在最后。这样单个坏源不会
 * 把一次用户后台刷新拖到一分钟，同时仍保留相互独立的实时源退路。
 *
 * ⚠️ 腾讯/新浪返回的名称是 GBK 乱码，本模块统一置空。调用方需要名称时
 *    从自己的持仓库取，不要使用行情源的 name。
 */

import type { Quote } from '@lookthru/shared';
import { EM_QUOTE_HOSTS, EM_QUOTE_HOST_DELAYED, fetchQuotes } from './eastmoney';
import { fetchQuotesTencent } from './tencent';
import { fetchQuotesSina } from './sina';

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
  /** 命中的是延时行情 —— 必须向上传递到 UI 与估值精度，不能当实时用 */
  delayed: boolean;
  attempts: QuoteAttempt[];
}

interface Provider {
  name: string;
  delayed: boolean;
  fetch: (
    secids: string[],
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<Map<string, Quote>>;
}

interface ProviderHealth {
  averageMs: number;
  succeededAt: number;
  cooldownUntil: number;
}

const QUOTE_CHAIN_BUDGET_MS = 20_000;
const PROVIDER_BUDGET_MS = 4_000;
const MAX_REAL_PROVIDER_ATTEMPTS = 4;
const FAILED_PROVIDER_COOLDOWN_MS = 60_000;

// 只保存数值健康度，不保存跨请求 Promise。隔离实例重启后回到实测初始顺序即可。
const providerHealth = new Map<string, ProviderHealth>();

const PROVIDERS: Provider[] = [
  // 这两个独立实时源从 Cloudflare 出口通常快于东财实时分片。
  { name: 'tencent', delayed: false, fetch: fetchQuotesTencent },
  { name: 'sina', delayed: false, fetch: fetchQuotesSina },
  ...EM_QUOTE_HOSTS.map((host) => ({
    name: `em:${host}`,
    delayed: false,
    fetch: (secids: string[], signal: AbortSignal, timeoutMs: number) =>
      fetchQuotes(secids, host, signal, timeoutMs),
  })),
  {
    name: `em:${EM_QUOTE_HOST_DELAYED}`,
    delayed: true,
    fetch: (secids: string[], signal: AbortSignal, timeoutMs: number) =>
      fetchQuotes(secids, EM_QUOTE_HOST_DELAYED, signal, timeoutMs),
  },
];

function orderedProviders(now: number): Provider[] {
  const delayed = PROVIDERS.find((provider) => provider.delayed);
  if (!delayed) throw new Error('行情降级链缺少延时兜底源');
  const initialOrder = new Map(PROVIDERS.map((provider, index) => [provider.name, index]));
  const real = PROVIDERS.filter((provider) => !provider.delayed)
    .sort((left, right) => {
      const leftHealth = providerHealth.get(left.name);
      const rightHealth = providerHealth.get(right.name);
      const leftCooling = (leftHealth?.cooldownUntil ?? 0) > now;
      const rightCooling = (rightHealth?.cooldownUntil ?? 0) > now;
      if (leftCooling !== rightCooling) return leftCooling ? 1 : -1;
      if ((leftHealth?.succeededAt ?? 0) !== (rightHealth?.succeededAt ?? 0)) {
        return (rightHealth?.succeededAt ?? 0) - (leftHealth?.succeededAt ?? 0);
      }
      if ((leftHealth?.averageMs ?? Infinity) !== (rightHealth?.averageMs ?? Infinity)) {
        return (leftHealth?.averageMs ?? Infinity) - (rightHealth?.averageMs ?? Infinity);
      }
      return initialOrder.get(left.name)! - initialOrder.get(right.name)!;
    })
    .slice(0, MAX_REAL_PROVIDER_ATTEMPTS);
  // 延时行情永远排在实时源之后，不能因为更快就被健康排序提前。
  return [...real, delayed];
}

function recordProviderSuccess(name: string, ms: number, now: number): void {
  const previous = providerHealth.get(name);
  providerHealth.set(name, {
    averageMs: previous ? previous.averageMs * 0.7 + ms * 0.3 : ms,
    succeededAt: now,
    cooldownUntil: 0,
  });
}

function recordProviderFailure(name: string, now: number): void {
  const previous = providerHealth.get(name);
  providerHealth.set(name, {
    averageMs: previous?.averageMs ?? Infinity,
    succeededAt: previous?.succeededAt ?? 0,
    cooldownUntil: now + FAILED_PROVIDER_COOLDOWN_MS,
  });
}

export async function fetchQuotesResilient(secids: string[]): Promise<QuoteResult> {
  const attempts: QuoteAttempt[] = [];
  if (secids.length === 0) {
    return { quotes: new Map(), provider: null, delayed: false, attempts };
  }

  const startedAt = Date.now();
  const chainSignal = AbortSignal.timeout(QUOTE_CHAIN_BUDGET_MS);
  for (const provider of orderedProviders(startedAt)) {
    const remainingMs = QUOTE_CHAIN_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const attemptStartedAt = Date.now();
    try {
      const quotes = await provider.fetch(
        secids,
        chainSignal,
        Math.min(PROVIDER_BUDGET_MS, remainingMs),
      );
      const elapsed = Date.now() - attemptStartedAt;
      attempts.push({
        provider: provider.name,
        ok: quotes.size > 0,
        ms: elapsed,
        count: quotes.size,
        error: quotes.size === 0 ? '返回 0 条' : null,
      });
      if (quotes.size > 0) {
        recordProviderSuccess(provider.name, elapsed, Date.now());
        return { quotes, provider: provider.name, delayed: provider.delayed, attempts };
      }
      recordProviderFailure(provider.name, Date.now());
    } catch (error) {
      recordProviderFailure(provider.name, Date.now());
      attempts.push({
        provider: provider.name,
        ok: false,
        ms: Date.now() - attemptStartedAt,
        count: 0,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      });
    }
  }

  return { quotes: new Map(), provider: null, delayed: false, attempts };
}
