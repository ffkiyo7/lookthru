import { fetchNavBatch, type SinaNav } from './sources/sina';

const CHANGE_TTL_SECONDS = 60;
const LAST_KNOWN_GOOD_TTL_SECONDS = 7 * 24 * 60 * 60;

interface CachedChange {
  chgPct: number;
  fetchedAt: string;
}

export interface FundSearchChange {
  chgPct: number | null;
  fetchedAt: string | null;
  stale: boolean;
  unavailable: boolean;
}

function changeCacheKey(code: string): string {
  return `search-change:${code}`;
}

function changeLastKnownGoodKey(code: string): string {
  return `search-change-lkg:${code}`;
}

function parseCachedChange(value: unknown): CachedChange | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('chgPct' in value) ||
    !('fetchedAt' in value) ||
    typeof value.chgPct !== 'number' ||
    !Number.isFinite(value.chgPct) ||
    typeof value.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.fetchedAt))
  ) {
    return null;
  }
  return { chgPct: value.chgPct, fetchedAt: value.fetchedAt };
}

async function readCachedChange(cache: KVNamespace, key: string): Promise<CachedChange | null> {
  try {
    const parsed = parseCachedChange(await cache.get<unknown>(key, 'json'));
    if (parsed !== null) return parsed;
  } catch (error) {
    console.warn(`[search-change] KV 读取失败 key=${key}`, error);
  }
  return null;
}

function calculateChange(nav: SinaNav): number | null {
  if (nav.prevNav === null || nav.prevNav <= 0) return null;
  return Number((((nav.unitNav - nav.prevNav) / nav.prevNav) * 100).toFixed(4));
}

export async function getFundSearchChanges(
  cache: KVNamespace,
  codes: string[],
  load: (codes: string[]) => Promise<Map<string, SinaNav>> = fetchNavBatch,
): Promise<Map<string, FundSearchChange>> {
  const uniqueCodes = [...new Set(codes)];
  const result = new Map<string, FundSearchChange>();
  const missing: string[] = [];

  await Promise.all(
    uniqueCodes.map(async (code) => {
      const value = await readCachedChange(cache, changeCacheKey(code));
      if (value === null) {
        missing.push(code);
        return;
      }
      result.set(code, { ...value, stale: false, unavailable: false });
    }),
  );
  if (missing.length === 0) return result;

  const lastKnownGood = new Map<string, CachedChange>();
  await Promise.all(
    missing.map(async (code) => {
      const value = await readCachedChange(cache, changeLastKnownGoodKey(code));
      if (value !== null) lastKnownGood.set(code, value);
    }),
  );

  let loaded: Map<string, SinaNav>;
  try {
    loaded = await load(missing);
  } catch (error) {
    console.warn('[search-change] 涨跌幅上游失败', error);
    for (const code of missing) {
      const value = lastKnownGood.get(code);
      result.set(
        code,
        value
          ? { ...value, stale: true, unavailable: false }
          : { chgPct: null, fetchedAt: null, stale: false, unavailable: true },
      );
    }
    return result;
  }

  if (loaded.size === 0) {
    console.warn(`[search-change] 涨跌幅上游返回 0/${missing.length} 条`);
  }
  const fetchedAt = new Date().toISOString();
  const writes: Promise<void>[] = [];
  for (const code of missing) {
    const nav = loaded.get(code);
    const chgPct = nav ? calculateChange(nav) : null;
    if (chgPct === null) {
      const fallback = lastKnownGood.get(code);
      if (fallback) {
        result.set(code, { ...fallback, stale: true, unavailable: false });
      } else {
        console.warn(`[search-change] 上游缺少可计算涨跌幅 code=${code}`);
        result.set(code, { chgPct: null, fetchedAt: null, stale: false, unavailable: true });
      }
      continue;
    }
    const value = { chgPct, fetchedAt };
    result.set(code, { ...value, stale: false, unavailable: false });
    const serialized = JSON.stringify(value);
    writes.push(
      cache.put(changeCacheKey(code), serialized, { expirationTtl: CHANGE_TTL_SECONDS }),
      cache.put(changeLastKnownGoodKey(code), serialized, {
        expirationTtl: LAST_KNOWN_GOOD_TTL_SECONDS,
      }),
    );
  }
  const writeResults = await Promise.allSettled(writes);
  const failedWrites = writeResults.filter((writeResult) => writeResult.status === 'rejected');
  if (failedWrites.length > 0) {
    console.warn(`[search-change] KV 写入失败 ${failedWrites.length}/${writeResults.length}`);
  }
  return result;
}
