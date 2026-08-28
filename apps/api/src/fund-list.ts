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

/** pipeline 下限是 1 万只。测试夹具必须显式传入更低的 minFunds / allowUndersized。 */
export const PRODUCTION_MIN_FUNDS = 10_000;

/** R2 失败后短暂停火，沿用 last-known-good，避免每个请求都打挂掉的对象存储。 */
export const INDEX_BACKOFF_MS = 20_000;

/** 有效行 / (有效+跳过) 达到此比例时，即使不足 1 万只也可以替换（前提是总行数也达生产下限）。 */
export const INDEX_VALID_RATIO_MIN = 0.8;

export const FUND_LIST_INDEX_HEADER = 'X-Lookthru-Index';

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
  failUntil: number;
  inFlight: Promise<FundListIndex | null> | null;
  stale: boolean;
}

export interface LoadFundSearchIndexOptions {
  /** 覆盖生产下限。测试夹具传 1；不要把生产 10000 改小来迁就测试。 */
  minFunds?: number;
  /** 允许用明显偏小的对象替换已有健康索引。仅测试。 */
  allowUndersized?: boolean;
}

export function createFundListMemory(): FundListMemory {
  return { index: null, expiresAt: 0, failUntil: 0, inFlight: null, stale: false };
}

/** Worker isolate 级缓存：解析 3.1MB JSON 只做一次，不要放到每次 /api/funds/search 上。 */
const isolateMemory = createFundListMemory();

export function resetFundListMemory(memory: FundListMemory = isolateMemory): void {
  memory.index = null;
  memory.expiresAt = 0;
  memory.failUntil = 0;
  memory.inFlight = null;
  memory.stale = false;
}

/** 测试用：保留 last-known-good，但让下一次 load 走 R2。 */
export function expireFundListMemory(memory: FundListMemory = isolateMemory, now = Date.now()): void {
  memory.expiresAt = now - 1;
  memory.failUntil = 0;
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
): { generatedAt: string; funds: SearchableFund[]; skipped: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const generatedAt = 'generatedAt' in value ? value.generatedAt : undefined;
  const rows = 'funds' in value ? value.funds : undefined;
  if (typeof generatedAt !== 'string' || !Array.isArray(rows)) return null;

  const funds: SearchableFund[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    const parsed = FundBrief.safeParse(row);
    if (!parsed.success || seen.has(parsed.data.code)) {
      skipped += 1;
      continue;
    }
    seen.add(parsed.data.code);
    funds.push(toSearchable(parsed.data));
  }
  // 一条脏记录不该让整份 3 万只列表作废；但有效行为 0 时仍返回 null，
  // 避免把 isolate 里还能用的旧索引换成空列表。
  if (funds.length === 0) return null;
  if (skipped > 0) {
    console.warn(
      `[fund-list] 跳过 ${skipped} 条非法或重复记录，保留 ${funds.length} 只 key=${FUND_LIST_R2_KEY}`,
    );
  }
  return { generatedAt, funds, skipped };
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

function meetsReplacementThreshold(
  parsed: { funds: SearchableFund[]; skipped: number },
  options: LoadFundSearchIndexOptions,
): boolean {
  if (options.allowUndersized) return true;
  const minFunds = options.minFunds ?? PRODUCTION_MIN_FUNDS;
  if (parsed.funds.length >= minFunds) return true;
  const total = parsed.funds.length + parsed.skipped;
  // 比例只在「看起来像一份生产列表」时生效：5 条全合法的夹具不能挤掉 3 万只索引。
  return total >= minFunds && parsed.funds.length / total >= INDEX_VALID_RATIO_MIN;
}

async function readR2List(
  env: Env,
): Promise<{ etag: string | null; index: FundListIndex; skipped: number } | null> {
  const object = await env.ARCHIVE.get(FUND_LIST_R2_KEY);
  if (!object) return null;
  const parsed = parseFundListPayload(await object.json<unknown>());
  if (!parsed) {
    console.warn(`[fund-list] R2 对象格式非法 key=${FUND_LIST_R2_KEY}`);
    return null;
  }
  if (parsed.funds.length < PRODUCTION_MIN_FUNDS) {
    // pipeline 下限是 1 万只；低于此数多半是写坏了，但冷启动仍应可搜。
    console.warn(`[fund-list] R2 列表只有 ${parsed.funds.length} 只，低于 pipeline 下限 10000`);
  }
  return {
    etag: object.etag ?? null,
    index: buildIndex(parsed.generatedAt, parsed.funds, object.etag ?? null),
    skipped: parsed.skipped,
  };
}

function markBackoff(memory: FundListMemory, now: number, stale: boolean): void {
  memory.failUntil = now + INDEX_BACKOFF_MS;
  memory.expiresAt = memory.failUntil;
  memory.stale = stale;
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
  options: LoadFundSearchIndexOptions = {},
): Promise<FundListIndex | null> {
  if (memory.index && memory.expiresAt > now) return memory.index;
  if (memory.failUntil > now) return memory.index;
  if (memory.inFlight) return memory.inFlight;

  const pending = (async (): Promise<FundListIndex | null> => {
    try {
      try {
        if (memory.index) {
          const head = await env.ARCHIVE.head(FUND_LIST_R2_KEY);
          const etag = head?.etag ?? null;
          if (etag !== null && etag === memory.index.etag) {
            memory.expiresAt = now + MEMORY_TTL_MS;
            memory.failUntil = 0;
            memory.stale = false;
            return memory.index;
          }
        }
      } catch (error) {
        console.warn(`[fund-list] R2 head 失败，沿用内存中的旧列表 key=${FUND_LIST_R2_KEY}`, error);
        if (memory.index) {
          markBackoff(memory, now, true);
          return memory.index;
        }
      }

      try {
        const loaded = await readR2List(env);
        if (!loaded) {
          if (memory.index) {
            console.warn(
              `[fund-list] R2 无对象或解析失败，沿用内存中的旧列表 key=${FUND_LIST_R2_KEY}`,
            );
            markBackoff(memory, now, true);
            return memory.index;
          }
          console.warn(`[fund-list] R2 全量列表不可用 key=${FUND_LIST_R2_KEY}`);
          markBackoff(memory, now, false);
          return null;
        }
        const parsed = {
          funds: loaded.index.funds,
          skipped: loaded.skipped,
        };
        if (memory.index && !meetsReplacementThreshold(parsed, options)) {
          console.warn(
            `[fund-list] 新列表未达替换阈值 valid=${parsed.funds.length} skipped=${parsed.skipped}，沿用旧索引`,
          );
          markBackoff(memory, now, true);
          return memory.index;
        }
        memory.index = loaded.index;
        memory.expiresAt = now + MEMORY_TTL_MS;
        memory.failUntil = 0;
        memory.stale = false;
        return loaded.index;
      } catch (error) {
        console.warn(`[fund-list] R2 读取失败 key=${FUND_LIST_R2_KEY}`, error);
        if (memory.index) {
          markBackoff(memory, now, true);
          return memory.index;
        }
        markBackoff(memory, now, false);
        return null;
      }
    } finally {
      memory.inFlight = null;
    }
  })();

  memory.inFlight = pending;
  return pending;
}

export async function getFundSearchIndex(
  env: Env,
  now = Date.now(),
): Promise<{ index: FundListIndex | null; stale: boolean }> {
  const index = await loadFundSearchIndex(env, now, isolateMemory);
  return { index, stale: index !== null && isolateMemory.stale };
}
