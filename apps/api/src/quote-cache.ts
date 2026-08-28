import { Quote, type Quote as QuoteValue } from '@lookthru/shared';
import { z } from 'zod';
import type { Defer, Env } from './env';
import { consumeRateLimit } from './rate-limit';
import { fetchQuotesResilient, type QuoteResult } from './sources/quotes';

const HOT_TTL_SECONDS = 60;
const LAST_KNOWN_TTL_SECONDS = 7 * 24 * 60 * 60;
const COLD_FOREGROUND_BUDGET_MS = 1_500;

const QuoteEnvelope = z.object({
  quote: Quote,
  provider: z.string().min(1),
  delayed: z.boolean(),
  fetchedAt: z.string().datetime(),
});

type QuoteEnvelope = z.infer<typeof QuoteEnvelope>;

export interface CachedQuoteResult {
  provider: string | null;
  delayed: boolean;
  fetchedAt: string | null;
  quotes: Map<string, QuoteValue>;
  staleSecids: string[];
  unavailableSecids: string[];
}

async function readEnvelope(cache: KVNamespace, key: string): Promise<QuoteEnvelope | null> {
  const parsed = QuoteEnvelope.safeParse(await cache.get<unknown>(key, 'json'));
  return parsed.success ? parsed.data : null;
}

function resultFromEnvelopes(
  requested: string[],
  envelopes: ReadonlyMap<string, QuoteEnvelope>,
  staleSecids: ReadonlySet<string>,
): CachedQuoteResult {
  const providers = [...new Set([...envelopes.values()].map((entry) => entry.provider))].sort();
  // 一组行情的可信时间取最旧一项，不能让一只新行情掩盖其余旧值。
  const fetchedAt = [...envelopes.values()]
    .map((entry) => entry.fetchedAt)
    .sort()
    .at(0) ?? null;
  return {
    provider: providers.length === 0 ? null : providers.length === 1 ? providers[0]! : 'mixed',
    delayed: [...envelopes.values()].some((entry) => entry.delayed),
    fetchedAt,
    quotes: new Map([...envelopes].map(([secid, entry]) => [secid, entry.quote])),
    staleSecids: [...staleSecids].filter((secid) => envelopes.has(secid)).sort(),
    unavailableSecids: requested.filter((secid) => !envelopes.has(secid)).sort(),
  };
}

/** 估值 Cron 与用户后台刷新共用同一套写入，避免抓完行情却让详情再次请求上游。 */
export async function cacheQuoteResult(env: Env, result: QuoteResult): Promise<void> {
  if (result.provider === null || result.quotes.size === 0) return;
  const fetchedAt = new Date().toISOString();
  const writes: Promise<void>[] = [];
  for (const [secid, quote] of result.quotes) {
    const envelope: QuoteEnvelope = {
      quote,
      provider: result.provider,
      delayed: result.delayed,
      fetchedAt,
    };
    const serialized = JSON.stringify(envelope);
    writes.push(
      env.CACHE.put(`quote:${secid}`, serialized, { expirationTtl: HOT_TTL_SECONDS }),
      env.CACHE.put(`quote-lkg:${secid}`, serialized, {
        expirationTtl: LAST_KNOWN_TTL_SECONDS,
      }),
    );
  }
  const outcomes = await Promise.allSettled(writes);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      console.error('[quotes] KV 写入失败', outcome.reason);
    }
  }
}

async function saveRefreshResult(env: Env, secids: string[], result: QuoteResult): Promise<void> {
  if (result.provider === null) {
    console.warn(
      `[quotes] 后台刷新全链失败 secids=${secids.length} ${result.attempts
        .map((attempt) => `${attempt.provider}=${attempt.error}`)
        .join(' | ')}`,
    );
    return;
  }
  await cacheQuoteResult(env, result);
}

function refreshColdInBackground(env: Env, secids: string[], defer: Defer): Promise<QuoteResult> {
  const refresh = fetchQuotesResilient(secids);
  defer(
    refresh
      .then((result) => saveRefreshResult(env, secids, result))
      .catch((error) => {
        console.error('[quotes] 后台刷新异常', error);
      }),
  );
  return refresh;
}

function refreshStaleInBackground(env: Env, secids: string[], defer: Defer): void {
  defer(
    (async () => {
      try {
        const allowed = await consumeRateLimit(
          env.SHARED_REFRESH_RATE_LIMITER,
          `quotes:${secids.join(',')}`,
        );
        if (!allowed) return;
        await saveRefreshResult(env, secids, await fetchQuotesResilient(secids));
      } catch (error) {
        console.error('[quotes] 后台刷新异常', error);
      }
    })(),
  );
}

/**
 * 新鲜值立即返回；热缓存过期后先返回 last-known-good，再后台刷新。
 * 真正冷启动只给上游 1.5 秒前台预算，避免整条降级链阻塞页面。
 */
export async function getCachedQuotes(
  env: Env,
  requested: string[],
  defer: Defer,
): Promise<CachedQuoteResult> {
  const secids = [...new Set(requested)].sort();
  const envelopes = new Map<string, QuoteEnvelope>();
  const hotMissing: string[] = [];
  await Promise.all(
    secids.map(async (secid) => {
      try {
        const envelope = await readEnvelope(env.CACHE, `quote:${secid}`);
        if (envelope) envelopes.set(secid, envelope);
        else hotMissing.push(secid);
      } catch (error) {
        console.warn(`[quotes] 热缓存读取失败 secid=${secid}`, error);
        hotMissing.push(secid);
      }
    }),
  );
  if (hotMissing.length === 0) return resultFromEnvelopes(secids, envelopes, new Set());

  const staleSecids = new Set<string>();
  await Promise.all(
    hotMissing.map(async (secid) => {
      try {
        const envelope = await readEnvelope(env.CACHE, `quote-lkg:${secid}`);
        if (!envelope) return;
        envelopes.set(secid, envelope);
        staleSecids.add(secid);
      } catch (error) {
        console.warn(`[quotes] last-known-good 读取失败 secid=${secid}`, error);
      }
    }),
  );

  const trulyMissing = hotMissing.filter((secid) => !envelopes.has(secid));
  if (trulyMissing.length === 0) {
    refreshStaleInBackground(env, hotMissing, defer);
    return resultFromEnvelopes(secids, envelopes, staleSecids);
  }

  const refresh = refreshColdInBackground(env, hotMissing, defer);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const foreground = await Promise.race([
    refresh.then((result) => ({ kind: 'fresh' as const, result })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), COLD_FOREGROUND_BUDGET_MS);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  if (foreground.kind === 'fresh' && foreground.result.provider !== null) {
    const fetchedAt = new Date().toISOString();
    for (const [secid, quote] of foreground.result.quotes) {
      envelopes.set(secid, {
        quote,
        provider: foreground.result.provider,
        delayed: foreground.result.delayed,
        fetchedAt,
      });
      staleSecids.delete(secid);
    }
  }
  return resultFromEnvelopes(secids, envelopes, staleSecids);
}
