import { z } from 'zod';
import type { Env } from './env';
import { searchFunds } from './sources/eastmoney';

const FUND_META_TTL_SECONDS = 6 * 60 * 60;

const FundMeta = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string().min(1),
  type: z.string(),
  isMoneyFund: z.boolean(),
});

export type FundMeta = z.infer<typeof FundMeta>;

export async function getFundMeta(env: Env, code: string): Promise<FundMeta | null> {
  const key = `fundmeta:${code}`;
  const lastKnownKey = `fundmeta-lkg:${code}`;
  try {
    const parsed = FundMeta.safeParse(await env.CACHE.get<unknown>(key, 'json'));
    if (parsed.success) return parsed.data;
  } catch (error) {
    console.warn(`[fund-meta] KV 读取失败 code=${code}`, error);
  }

  let hit;
  try {
    hit = (await searchFunds(code)).find((candidate) => candidate.code === code);
  } catch (error) {
    try {
      const lastKnown = FundMeta.safeParse(await env.CACHE.get<unknown>(lastKnownKey, 'json'));
      if (lastKnown.success) {
        console.warn(`[fund-meta] 上游失败，返回 last-known-good code=${code}`, error);
        return lastKnown.data;
      }
    } catch (cacheError) {
      throw new AggregateError([error, cacheError], `基金资料与 last-known-good 均不可用 code=${code}`);
    }
    throw new Error(`基金资料上游失败且没有 last-known-good code=${code}`, { cause: error });
  }
  if (!hit) return null;
  const meta = FundMeta.parse({
    code: hit.code,
    name: hit.name,
    type: hit.type,
    isMoneyFund: hit.isMoneyFund,
  });
  try {
    const serialized = JSON.stringify(meta);
    const writes = await Promise.allSettled([
      env.CACHE.put(key, serialized, { expirationTtl: FUND_META_TTL_SECONDS }),
      // 基金代码、名称和类型属于低频元数据；last-known-good 不主动过期，避免上游故障时持仓失去名称。
      env.CACHE.put(lastKnownKey, serialized),
    ]);
    if (writes.some((result) => result.status === 'rejected')) {
      console.warn(`[fund-meta] KV 写入不完整 code=${code}`);
    }
  } catch (error) {
    console.warn(`[fund-meta] KV 写入失败 code=${code}`, error);
  }
  return meta;
}
