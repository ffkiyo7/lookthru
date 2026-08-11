export async function cachedJson<T>(
  cache: KVNamespace,
  key: string,
  expirationTtl: number,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await cache.get<unknown>(key, 'json');
    if (isEnvelope<T>(hit)) return hit.value;
    // 兼容本次改动前已经写入 KV 的裸 JSON 值。
    if (hit !== null) return hit as T;
  } catch (error) {
    // 缓存是加速层，故障时不能把本来可用的上游接口一起打挂。
    console.warn(`[cache] read failed key=${key}`, error);
  }

  const value = await load();
  try {
    // 包一层后，缓存命中的 null 与“key 不存在”不再使用同一个哨兵值。
    await cache.put(key, JSON.stringify({ __lookthruCache: 1, value }), { expirationTtl });
  } catch (error) {
    console.warn(`[cache] write failed key=${key}`, error);
  }
  return value;
}

function isEnvelope<T>(value: unknown): value is { __lookthruCache: 1; value: T } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__lookthruCache' in value &&
    value.__lookthruCache === 1 &&
    'value' in value
  );
}

export function searchCacheKey(keyword: string): string {
  return `search:${keyword.trim().toLocaleLowerCase('zh-CN')}`;
}
