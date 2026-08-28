function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function bindingKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  // 来源 IP 不应暴露；共享刷新输入可能是很长的 secid 列表。固定长度确定性键同时解决这两点。
  return bytesToHex(new Uint8Array(digest).slice(0, 16));
}

/** 专用 binding 的计数器在 Worker 节点本地，不再为每个请求读写普通 KV。 */
export async function consumeRateLimit(limiter: RateLimit, clientId: string): Promise<boolean> {
  return (await limiter.limit({ key: await bindingKey(clientId) })).success;
}
