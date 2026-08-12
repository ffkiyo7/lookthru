const RATE_LIMIT_TTL_SECONDS = 2 * 60;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function clientKey(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId));
  // 原始 IP 可能是很长的 IPv6，且不应直接出现在可观测的 KV key 中；截取 128 bit
  // 已足够避免不同访客共享计数器。这是确定性限流键，不是实体唯一 ID。
  return bytesToHex(new Uint8Array(digest).slice(0, 16));
}

export async function consumeKvRateLimit(
  cache: KVNamespace,
  clientId: string,
  scope: string,
  now: number,
  limit: number,
): Promise<boolean> {
  const minute = Math.floor(now / 60_000);
  const key = `rate:${scope}:${minute}:${await clientKey(clientId)}`;
  const raw = await cache.get(key);
  const count = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`限流计数器格式非法 key=${key}`);
  }
  if (count >= limit) return false;
  // KV 没有原子自增；这是按 IP 的边缘滥用挡板，不把它伪装成精确配额系统。
  // 同一毫秒的竞争请求最多短暂超出少量，仍会共享同一时间窗和确定性 key。
  await cache.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL_SECONDS });
  return true;
}
