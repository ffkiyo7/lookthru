import { FundBrief } from '@lookthru/shared';
import type { Env } from './env';

/** 与 pipelines/fund_list.py / data-archives.yml 写入的对象一致 */
export const FUND_LIST_R2_KEY = 'meta/fundlist.json';

/**
 * isolate 内存里的索引最多用半小时。pipeline 每天才刷一次，半小时内
 * 多打几次 R2.head 也没有新内容；但完全不重检的话，新 isolate 之外的
 * 旧 isolate 会一直用冷启动那天的列表。
 */
const MEMORY_TTL_MS = 30 * 60 * 1000;

export interface SearchableFund {
  code: string;
  name: string;
  type: string;
  pinyinShort: string;
  pinyinShortLower: string;
  pinyinFullLower: string;
  isMoneyFund: boolean;
}

export interface FundListIndex {
  generatedAt: string;
  etag: string | null;
  funds: SearchableFund[];
  byCode: Map<string, SearchableFund>;
}

export interface FundListMemory {
  index: FundListIndex | null;
  expiresAt: number;
}

export function createFundListMemory(): FundListMemory {
  return { index: null, expiresAt: 0 };
}

/** Worker isolate 级缓存：解析 3.1MB JSON 只做一次，不要放到每次 /api/funds/search 上。 */
const isolateMemory = createFundListMemory();

export function resetFundListMemory(memory: FundListMemory = isolateMemory): void {
  memory.index = null;
  memory.expiresAt = 0;
}

function toSearchable(brief: FundBrief): SearchableFund {
  return {
    code: brief.code,
    name: brief.name,
    type: brief.type,
    pinyinShort: brief.pinyinShort,
    pinyinShortLower: brief.pinyinShort.toLowerCase(),
    pinyinFullLower: brief.pinyinFull.toLowerCase(),
    // 与东财 suggest 解析同一口径：类型里带「货币」才把 DWJZ 当万份收益。
    isMoneyFund: /货币/.test(brief.type),
  };
}

export function parseFundListPayload(
  value: unknown,
): { generatedAt: string; funds: SearchableFund[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const generatedAt = 'generatedAt' in value ? value.generatedAt : undefined;
  const rows = 'funds' in value ? value.funds : undefined;
  if (typeof generatedAt !== 'string' || !Array.isArray(rows)) return null;

  const funds: SearchableFund[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = FundBrief.safeParse(row);
    if (!parsed.success) return null;
    if (seen.has(parsed.data.code)) return null;
    seen.add(parsed.data.code);
    funds.push(toSearchable(parsed.data));
  }
  return { generatedAt, funds };
}

function buildIndex(
  generatedAt: string,
  funds: SearchableFund[],
  etag: string | null,
): FundListIndex {
  return {
    generatedAt,
    etag,
    funds,
    byCode: new Map(funds.map((fund) => [fund.code, fund])),
  };
}

async function readR2List(env: Env): Promise<{ etag: string | null; index: FundListIndex } | null> {
  const object = await env.ARCHIVE.get(FUND_LIST_R2_KEY);
  if (!object) return null;
  const parsed = parseFundListPayload(await object.json<unknown>());
  if (!parsed) {
    console.warn(`[fund-list] R2 对象格式非法 key=${FUND_LIST_R2_KEY}`);
    return null;
  }
  if (parsed.funds.length < 10_000) {
    // pipeline 下限是 1 万只；低于此数多半是写坏了，但测试夹具和过渡对象仍应可搜。
    console.warn(`[fund-list] R2 列表只有 ${parsed.funds.length} 只，低于 pipeline 下限 10000`);
  }
  return {
    etag: object.etag ?? null,
    index: buildIndex(parsed.generatedAt, parsed.funds, object.etag ?? null),
  };
}

/**
 * 从 R2 拉全量列表并缓存在 isolate 内存。
 * 不要把整份 JSON 再写入 KV：3.1MB 的 parse 成本正是搜索变慢的原因，
 * 换个存储再 parse 一遍没有意义。
 */
export async function loadFundSearchIndex(
  env: Env,
  now = Date.now(),
  memory: FundListMemory = isolateMemory,
): Promise<FundListIndex | null> {
  if (memory.index && memory.expiresAt > now) return memory.index;

  try {
    if (memory.index) {
      const head = await env.ARCHIVE.head(FUND_LIST_R2_KEY);
      const etag = head?.etag ?? null;
      if (etag !== null && etag === memory.index.etag) {
        memory.expiresAt = now + MEMORY_TTL_MS;
        return memory.index;
      }
    }
  } catch (error) {
    console.warn(`[fund-list] R2 head 失败，沿用内存中的旧列表 key=${FUND_LIST_R2_KEY}`, error);
    if (memory.index) return memory.index;
  }

  try {
    const loaded = await readR2List(env);
    if (!loaded) {
      if (memory.index) {
        console.warn(`[fund-list] R2 无对象或解析失败，沿用内存中的旧列表 key=${FUND_LIST_R2_KEY}`);
        return memory.index;
      }
      console.warn(`[fund-list] R2 全量列表不可用 key=${FUND_LIST_R2_KEY}`);
      return null;
    }
    memory.index = loaded.index;
    memory.expiresAt = now + MEMORY_TTL_MS;
    return loaded.index;
  } catch (error) {
    console.warn(`[fund-list] R2 读取失败 key=${FUND_LIST_R2_KEY}`, error);
    return memory.index;
  }
}

export async function getFundSearchIndex(env: Env, now = Date.now()): Promise<FundListIndex | null> {
  return loadFundSearchIndex(env, now, isolateMemory);
}
