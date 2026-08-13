import { z } from 'zod';
import type { Env } from './env';
import { searchFunds, type FundSearchHit } from './sources/eastmoney';

const FUND_META_TTL_SECONDS = 6 * 60 * 60;

const FundMeta = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string().min(1),
  type: z.string(),
  isMoneyFund: z.boolean(),
});

export type FundMeta = z.infer<typeof FundMeta>;

async function readCachedFundMeta(env: Env, key: string): Promise<FundMeta | null> {
  const parsed = FundMeta.safeParse(await env.CACHE.get<unknown>(key, 'json'));
  return parsed.success ? parsed.data : null;
}

export async function getCachedFundMeta(env: Env, code: string): Promise<FundMeta | null> {
  for (const key of [`fundmeta:${code}`, `fundmeta-lkg:${code}`]) {
    const cached = await readCachedFundMeta(env, key);
    if (cached) return cached;
  }
  return null;
}

export async function cacheFundMetaFromSearchHit(
  env: Env,
  hit: FundSearchHit,
): Promise<FundMeta> {
  const meta = FundMeta.parse({
    code: hit.code,
    name: hit.name,
    type: hit.type,
    isMoneyFund: hit.isMoneyFund,
  });
  const serialized = JSON.stringify(meta);
  const writes = await Promise.allSettled([
    env.CACHE.put(`fundmeta:${hit.code}`, serialized, { expirationTtl: FUND_META_TTL_SECONDS }),
    // 基金代码、名称和类型属于低频元数据；last-known-good 不主动过期，避免上游故障时持仓失去名称。
    env.CACHE.put(`fundmeta-lkg:${hit.code}`, serialized),
  ]);
  if (writes.some((result) => result.status === 'rejected')) {
    console.warn(`[fund-meta] KV 写入不完整 code=${hit.code}`);
  }
  return meta;
}

export async function getFundMeta(env: Env, code: string): Promise<FundMeta | null> {
  const lastKnownKey = `fundmeta-lkg:${code}`;
  try {
    // 正常读取只接受有时效的缓存；last-known-good 仅在上游失败时使用，
    // 否则基金更名或分类变化会永远无法刷新。
    const cached = await readCachedFundMeta(env, `fundmeta:${code}`);
    if (cached) return cached;
  } catch (error) {
    console.warn(`[fund-meta] KV 读取失败 code=${code}`, error);
  }

  let hit;
  try {
    hit = (await searchFunds(code)).find((candidate) => candidate.code === code);
  } catch (error) {
    try {
      const lastKnown = await readCachedFundMeta(env, lastKnownKey);
      if (lastKnown) {
        console.warn(`[fund-meta] 上游失败，返回 last-known-good code=${code}`, error);
        return lastKnown;
      }
    } catch (cacheError) {
      throw new AggregateError([error, cacheError], `基金资料与 last-known-good 均不可用 code=${code}`);
    }
    throw new Error(`基金资料上游失败且没有 last-known-good code=${code}`, { cause: error });
  }
  if (!hit) return null;
  try {
    return await cacheFundMetaFromSearchHit(env, hit);
  } catch (error) {
    console.warn(`[fund-meta] KV 写入失败 code=${code}`, error);
    return FundMeta.parse({
      code: hit.code,
      name: hit.name,
      type: hit.type,
      isMoneyFund: hit.isMoneyFund,
    });
  }
}
