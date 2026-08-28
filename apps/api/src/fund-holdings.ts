import { z } from 'zod';
import type { Defer, Env } from './env';
import { consumeRateLimit } from './rate-limit';
import { fetchHoldings } from './sources/eastmoney';

const HOT_TTL_SECONDS = 6 * 60 * 60;
const LAST_KNOWN_TTL_SECONDS = 180 * 24 * 60 * 60;

const Holdings = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  holdings: z.array(
    z.object({
      stockCode: z.string().min(1),
      stockName: z.string(),
      weight: z.number().finite().min(0).max(100),
      secid: z.string().nullable(),
    }),
  ),
  coverageWeight: z.number().finite().min(0).max(100),
  industries: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      weight: z.number().finite().min(0).max(100),
    }),
  ),
});

export type CachedHoldings = z.infer<typeof Holdings>;

const Envelope = z.object({
  data: Holdings,
  fetchedAt: z.string().datetime(),
});
type Envelope = z.infer<typeof Envelope>;

const ArchivedHoldings = Holdings.extend({
  generatedAt: z.string().datetime(),
  fundCode: z.string().regex(/^\d{6}$/),
});

export interface HoldingsSnapshot {
  data: CachedHoldings;
  fetchedAt: string;
  stale: boolean;
}

async function readEnvelope(cache: KVNamespace, key: string): Promise<Envelope | null> {
  const raw = await cache.get<unknown>(key, 'json');
  if (raw === null) return null;
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[holdings] 缓存格式非法 key=${key}`, parsed.error.message);
    return null;
  }
  return parsed.data;
}

async function readArchive(env: Env, code: string): Promise<Envelope | null> {
  const object = await env.ARCHIVE.get(`holdings/${code}/latest.json`);
  if (!object) return null;
  const archived = ArchivedHoldings.parse(await object.json<unknown>());
  if (archived.fundCode !== code) {
    throw new Error(`R2 持仓基金代码不匹配 expected=${code} actual=${archived.fundCode}`);
  }
  return { data: Holdings.parse(archived), fetchedAt: archived.generatedAt };
}

async function fetchHoldingsEnvelope(code: string, signal?: AbortSignal): Promise<Envelope> {
  return {
    data: Holdings.parse(await fetchHoldings(code, signal)),
    fetchedAt: new Date().toISOString(),
  };
}

async function cacheHoldings(env: Env, code: string, envelope: Envelope): Promise<void> {
  const serialized = JSON.stringify(envelope);
  const writes = await Promise.allSettled([
    env.CACHE.put(`holdings:${code}`, serialized, { expirationTtl: HOT_TTL_SECONDS }),
    env.CACHE.put(`holdings-lkg:${code}`, serialized, { expirationTtl: LAST_KNOWN_TTL_SECONDS }),
  ]);
  for (const write of writes) {
    if (write.status === 'rejected') {
      console.error(`[holdings] KV 写入失败 code=${code}`, write.reason);
    }
  }
}

function refreshHoldingsInBackground(env: Env, code: string, defer: Defer): void {
  defer(
    (async () => {
      try {
        const allowed = await consumeRateLimit(
          env.SHARED_REFRESH_RATE_LIMITER,
          `holdings:${code}`,
        );
        if (!allowed) return;
        await cacheHoldings(env, code, await fetchHoldingsEnvelope(code));
      } catch (error) {
        console.error(`[holdings] 后台刷新失败 code=${code}`, error);
      }
    })(),
  );
}

async function readLocalFallback(env: Env, code: string): Promise<Envelope | null> {
  try {
    const lastKnown = await readEnvelope(env.CACHE, `holdings-lkg:${code}`);
    if (lastKnown) return lastKnown;
  } catch (error) {
    console.error(`[holdings] last-known-good 读取失败 code=${code}`, error);
  }
  try {
    return await readArchive(env, code);
  } catch (error) {
    console.error(`[holdings] R2 归档读取失败 code=${code}`, error);
    return null;
  }
}

/**
 * 用户请求走本地优先：热 KV → last-known-good → R2。命中旧值后立即返回，
 * 上游刷新由 waitUntil 完成。只有从未见过的基金才同步等待一次东财。
 */
export async function getHoldingsForRequest(
  env: Env,
  code: string,
  defer: Defer,
  signal?: AbortSignal,
): Promise<HoldingsSnapshot> {
  try {
    const hot = await readEnvelope(env.CACHE, `holdings:${code}`);
    if (hot) return { ...hot, stale: false };
  } catch (error) {
    console.error(`[holdings] 热缓存读取失败 code=${code}`, error);
  }

  const local = await readLocalFallback(env, code);
  if (local) {
    refreshHoldingsInBackground(env, code, defer);
    return { ...local, stale: true };
  }

  try {
    const fresh = await fetchHoldingsEnvelope(code, signal);
    defer(cacheHoldings(env, code, fresh));
    return { ...fresh, stale: false };
  } catch (error) {
    throw new Error(`持仓上游失败且没有本地数据 code=${code}`, { cause: error });
  }
}

/** 定时估值需要主动刷新过期热缓存，失败时仍可使用本地旧值继续并明确降级。 */
export async function getFreshHoldings(env: Env, code: string): Promise<HoldingsSnapshot> {
  try {
    const hot = await readEnvelope(env.CACHE, `holdings:${code}`);
    if (hot) return { ...hot, stale: false };
  } catch (error) {
    console.error(`[holdings] 热缓存读取失败 code=${code}`, error);
  }

  try {
    const fresh = await fetchHoldingsEnvelope(code);
    await cacheHoldings(env, code, fresh);
    return { ...fresh, stale: false };
  } catch (upstreamError) {
    const local = await readLocalFallback(env, code);
    if (local) {
      console.warn(`[holdings] 上游失败，使用本地旧值 code=${code}`, upstreamError);
      return { ...local, stale: true };
    }
    throw new Error(`持仓上游失败且没有本地数据 code=${code}`, { cause: upstreamError });
  }
}
