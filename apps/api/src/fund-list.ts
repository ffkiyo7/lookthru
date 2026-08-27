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
      `[资金-list] 跳过 ${skipped} 条非法或重复记录，保留 ${funds.length} 只 key=${FUND_LIST_R2_KEY}`,
    );
  }
  return { generatedAt, funds };
}
