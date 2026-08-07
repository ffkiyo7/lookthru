/**
 * 新浪财经 场外基金净值 —— 极轻量且**支持批量**。
 *
 * 用途分工：
 *   · 晚间官方净值批量拉取 → 用本源（一次请求几十只，比 lsjz 逐只快一个数量级）
 *   · 单基金历史净值 / 分红明细 → 用东财 lsjz
 *
 * ⚠️ 响应是 GBK。Workers 的 TextDecoder 不保证支持 gbk，因此按 latin1 读取 ——
 * 数值与日期字段是 ASCII，不受影响；名称字段会是乱码，**不要使用**
 * （基金名称从我们自己的基金库取）。
 */

import { fetchText } from './http';

const REFERER_SINA = 'https://finance.sina.com.cn/';
const CHUNK = 50;

export interface SinaNav {
  code: string;
  unitNav: number;
  accNav: number | null;
  /** 前一交易日单位净值 —— 估值引擎的 prevNav 基准 */
  prevNav: number | null;
  date: string;
}

export function sinaUrl(codes: string[]): string {
  return `https://hq.sinajs.cn/list=${codes.map((c) => `f_${c}`).join(',')}`;
}

export async function fetchNavBatch(codes: string[]): Promise<Map<string, SinaNav>> {
  const out = new Map<string, SinaNav>();
  const uniq = [...new Set(codes)].filter((c) => /^\d{6}$/.test(c));

  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const { text } = await fetchText(sinaUrl(chunk), {
      source: 'sina:nav',
      referer: REFERER_SINA,
      decodeAs: 'latin1',
      timeoutMs: 12_000,
    });
    for (const [code, nav] of parseSinaNav(text)) out.set(code, nav);
  }
  return out;
}

export function parseSinaNav(text: string): Map<string, SinaNav> {
  const out = new Map<string, SinaNav>();
  const re = /var\s+hq_str_f_(\d{6})="([^"]*)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const code = m[1]!;
    const parts = m[2]!.split(',');
    // [名称(乱码), 单位净值, 累计净值, 昨日单位净值, 日期, 规模]
    if (parts.length < 5) continue;
    const unitNav = Number(parts[1]);
    const date = parts[4]?.trim() ?? '';
    if (!Number.isFinite(unitNav) || unitNav <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    out.set(code, {
      code,
      unitNav,
      accNav: Number.isFinite(Number(parts[2])) ? Number(parts[2]) : null,
      prevNav: Number.isFinite(Number(parts[3])) ? Number(parts[3]) : null,
      date,
    });
  }
  return out;
}
