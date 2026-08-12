import { z } from 'zod';
import type { Env } from './env';
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

const ArchivedHoldings = Holdings.extend({
  generatedAt: z.string().datetime(),
  fundCode: z.string().regex(/^\d{6}$/),
});

export interface HoldingsSnapshot {
  data: CachedHoldings;
  fetchedAt: string;
  stale: boolean;
}

async function readEnvelope(cache: KVNamespace, key: string): Promise<z.infer<typeof Envelope> | null> {
  const raw = await cache.get<unknown>(key, 'json');
  if (raw === null) return null;
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[holdings] 缓存格式非法 key=${key}`, parsed.error.message);
    return null;
  }
  return parsed.data;
}

async function readArchive(env: Env, code: string): Promise<z.infer<typeof Envelope> | null> {
  const object = await env.ARCHIVE.get(`holdings/${code}/latest.json`);
  if (!object) return null;
  const archived = ArchivedHoldings.parse(await object.json<unknown>());
  if (archived.fundCode !== code) {
    throw new Error(`R2 持仓基金代码不匹配 expected=${code} actual=${archived.fundCode}`);
  }
  return { data: Holdings.parse(archived), fetchedAt: archived.generatedAt };
}

export async function getCachedHoldings(env: Env, code: string): Promise<HoldingsSnapshot> {
  const hotKey = `holdings:${code}`;
  const lastKnownKey = `holdings-lkg:${code}`;
  try {
    const hot = await readEnvelope(env.CACHE, hotKey);
    if (hot) return { ...hot, stale: false };
  } catch (error) {
    console.warn(`[holdings] 热缓存读取失败 code=${code}`, error);
  }

  try {
    const data = Holdings.parse(await fetchHoldings(code));
    const envelope = { data, fetchedAt: new Date().toISOString() };
    const serialized = JSON.stringify(envelope);
    const writes = await Promise.allSettled([
      env.CACHE.put(hotKey, serialized, { expirationTtl: HOT_TTL_SECONDS }),
      env.CACHE.put(lastKnownKey, serialized, { expirationTtl: LAST_KNOWN_TTL_SECONDS }),
    ]);
    if (writes.some((result) => result.status === 'rejected')) {
      console.warn(`[holdings] 缓存写入不完整 code=${code}`);
    }
    return { ...envelope, stale: false };
  } catch (error) {
    try {
      const lastKnown = await readEnvelope(env.CACHE, lastKnownKey);
      if (lastKnown) {
        console.warn(`[holdings] 上游失败，返回 last-known-good code=${code}`, error);
        return { ...lastKnown, stale: true };
      }
      const archived = await readArchive(env, code);
      if (archived) {
        console.warn(`[holdings] 上游失败，返回 R2 归档 code=${code}`, error);
        return { ...archived, stale: true };
      }
    } catch (cacheError) {
      throw new AggregateError([error, cacheError], `持仓与 last-known-good 均不可用 code=${code}`);
    }
    throw new Error(`持仓上游失败且没有 last-known-good code=${code}`, { cause: error });
  }
}
