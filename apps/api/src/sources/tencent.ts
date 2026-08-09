/**
 * 腾讯行情 —— 与东财、新浪完全独立的第三方实时行情源。
 *
 * 存在理由：实测东财 push2 从 Cloudflare 出口不稳定（主域 502、编号分片健康度约一半），
 * 而估值引擎依赖实时股票行情。单一上游不能决定功能存亡（见 plan 七、风险与退路）。
 *
 * ⚠️ 响应是 GBK，按 latin1 读取：数值字段是 ASCII 不受影响，
 * **名称字段是乱码，不可使用** —— 股票名称从我们自己的基金/股票库取。
 */

import type { Quote } from '@lookthru/shared';
import { fetchText } from './http';

const CHUNK = 60;

/** secid `1.600519` → `sh600519`；`0.159915` → `sz159915` */
export function secidToTencent(secid: string): string | null {
  const [market, code] = secid.split('.');
  if (!code) return null;
  if (market === '1') return `sh${code}`;
  if (market === '0') return `sz${code}`;
  return null;
}

export function tencentUrl(codes: string[]): string {
  return `https://qt.gtimg.cn/q=${codes.join(',')}`;
}

export async function fetchQuotesTencent(secids: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();

  // 保留 secid ↔ 腾讯代码的双向映射，回填时要还原成调用方给的 secid
  const pairs = [...new Set(secids)]
    .map((s) => [s, secidToTencent(s)] as const)
    .filter((p): p is readonly [string, string] => p[1] !== null);

  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const { text } = await fetchText(tencentUrl(chunk.map((p) => p[1])), {
      source: 'tencent:quotes',
      decodeAs: 'latin1',
      timeoutMs: 10_000,
      retries: 1,
    });
    const parsed = parseTencentQuotes(text);
    for (const [secid, tcode] of chunk) {
      const q = parsed.get(tcode);
      if (q) out.set(secid, { ...q, secid });
    }
  }
  return out;
}

/**
 * `v_sh600519="1~贵州茅台~600519~1309.22~1308.55~1308.66~..."`
 *
 * 只取下标 3(现价) 和 4(昨收)，涨跌幅由两者算出而非读固定下标 ——
 * 腾讯字段表很长且尾部字段增删过，靠下标读涨跌幅容易随上游变更而错位且不报错。
 */
export function parseTencentQuotes(text: string): Map<string, Omit<Quote, 'secid'>> {
  const out = new Map<string, Omit<Quote, 'secid'>>();
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const tcode = m[1]!;
    const parts = m[2]!.split('~');
    const price = Number(parts[3]);
    const prevClose = Number(parts[4]);
    if (!Number.isFinite(price) || price <= 0) continue;

    const hasPrev = Number.isFinite(prevClose) && prevClose > 0;
    out.set(tcode, {
      code: tcode.slice(2),
      name: '', // GBK 乱码，不可用
      price,
      chgPct: hasPrev ? Number((((price - prevClose) / prevClose) * 100).toFixed(4)) : 0,
      prevClose: hasPrev ? prevClose : null,
    });
  }
  return out;
}
