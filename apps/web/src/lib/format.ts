/** 金额、百分比、净值的统一格式化。金融数字的呈现规则集中在这里，不要在组件里各写各的。 */

export function formatMoney(v: number, opts: { sign?: boolean } = {}): string {
  const sign = opts.sign ? (v > 0 ? '+' : v < 0 ? '-' : '') : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}¥${abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPct(v: number, opts: { sign?: boolean; digits?: number } = {}): string {
  const { sign = true, digits = 2 } = opts;
  const s = sign && v > 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

/** 净值一律 4 位小数 —— 基金行业惯例，不要用 toLocaleString 省略尾随零 */
export function formatNav(v: number): string {
  return v.toFixed(4);
}

export function formatShares(v: number): string {
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 规模等大数：亿元 */
export function formatYi(v: number): string {
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 报告期陈旧天数 —— 估值精度分级与「已过期 N 天」提示都依赖它 */
export function staleDays(reportDate: string, now = new Date()): number {
  const d = new Date(`${reportDate}T00:00:00+08:00`);
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
}

/** 涨跌方向。0 视为持平，用中性色。 */
export type Direction = 'up' | 'down' | 'flat';

export function direction(v: number | null | undefined): Direction {
  if (v === null || v === undefined || Number.isNaN(v)) return 'flat';
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

export const dirClass: Record<Direction, string> = {
  up: 'text-up',
  down: 'text-down',
  flat: 'text-ink-faintest',
};
