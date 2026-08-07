/**
 * 数据源注册表与降级链。
 *
 * 设计原则（见 plan「七、风险与退路」）：
 *   1. 单一上游变更不能让功能整体失效 → 多源 fallback
 *   2. 上游故障不能让 UI 空白 → 调用方永远拿 last-known-good + 陈旧度
 */

import type { NavPoint } from '@qd2/shared';
import * as em from './eastmoney';
import * as sina from './sina';
import { fetchText } from './http';

export * from './eastmoney';
export * from './sina';
export * from './http';

/** P0 探针要测的三个端点 —— 决定 Workers 出口是否可用 */
export const PROBE_TARGETS = [
  {
    source: 'fundlist',
    label: '全量基金列表',
    endpoint: em.FUND_LIST_URL,
    /** 3.1MB，只验证开头特征，不整体解析（解析在 GitHub Actions 侧做） */
    check: async () => {
      const { text, bytes } = await fetchText(em.FUND_LIST_URL, {
        source: 'probe:fundlist',
        referer: 'https://fund.eastmoney.com/',
        timeoutMs: 30_000,
        retries: 0,
      });
      // 只看开头 32 字符，不要对 3.1MB 整串做 replace/slice —— 那会整份拷贝，
      // 白白吃掉 CPU 预算（免费版每请求仅 10ms）
      const head = text.charCodeAt(0) === 0xfeff ? text.substring(1, 32) : text.substring(0, 32);
      if (!head.startsWith('var r = [[')) throw new Error('内容不符合预期');
      return bytes;
    },
  },
  {
    source: 'pingzhong',
    label: '单基金全量档案',
    endpoint: em.pingzhongUrl('161725'),
    check: async () => {
      const { text, bytes } = await fetchText(em.pingzhongUrl('161725'), {
        source: 'probe:pingzhong',
        referer: 'https://fund.eastmoney.com/',
        timeoutMs: 20_000,
        retries: 0,
      });
      if (!text.includes('Data_netWorthTrend')) throw new Error('缺少 Data_netWorthTrend');
      return bytes;
    },
  },
  {
    source: 'quotes',
    label: '批量实时行情',
    endpoint: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
    check: async () => {
      const q = await em.fetchQuotes(['1.600519', '1.510300']);
      if (q.size === 0) throw new Error('未返回任何行情');
      return q.size;
    },
  },
] as const;

/**
 * 最新净值：新浪批量为主（一次几十只），东财 lsjz 为备。
 * 返回 Map<code, NavPoint>，失败的基金直接不在 Map 里，由调用方按 last-known-good 兜底。
 */
export async function fetchLatestNav(codes: string[]): Promise<Map<string, NavPoint>> {
  const out = new Map<string, NavPoint>();

  try {
    for (const [code, n] of await sina.fetchNavBatch(codes)) {
      out.set(code, {
        date: n.date,
        unitNav: n.unitNav,
        accNav: n.accNav,
        chgPct:
          n.prevNav && n.prevNav > 0
            ? Number((((n.unitNav - n.prevNav) / n.prevNav) * 100).toFixed(4))
            : null,
      });
    }
  } catch {
    // 新浪整体失败 → 全部走东财逐只
  }

  const missing = codes.filter((c) => !out.has(c));
  for (const code of missing) {
    try {
      const rows = await em.fetchNavHistory(code, 1, 1);
      const first = rows[0];
      if (first) out.set(code, first);
    } catch {
      // 单只失败不影响其余，调用方用 last-known-good
    }
  }
  return out;
}
