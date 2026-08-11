/**
 * 交易日历覆盖窗口的判定。
 *
 * 单独成文件是为了能被单测覆盖 —— 这段逻辑全是日期算术，而它守的是
 * 一个静默失败：日历一旦用尽，估值每天都会被判成非交易日直接跳过，
 * 不报错、不告警，只是什么都不发生。
 */

export type CalendarInfo = {
  available: boolean;
  generatedAt: string | null;
  days: number;
  /** 日历最后一天（YYYY-MM-DD）。后端补上这个字段之前为 undefined */
  coversUntil?: string | null;
};

/**
 * 覆盖窗口只剩这么多天就告警。日历按年生成，最危险的时刻是跨年 ——
 * 45 天保证 12 月中旬就亮起来，早于上交所可能拖延发布下一年公告的时点。
 */
export const COVERAGE_WARN_DAYS = 45;

/**
 * 退化指标，只在后端还没上报 coversUntil 时用。
 *
 * 不要把它当主判据：它测的是「生成了多久」，真正要紧的是「还能覆盖多久」。
 * 两者平时相关，恰恰在最危险的场景里反向 —— 每月重新生成会一直刷新
 * generatedAt，而覆盖窗口在一天天缩短，于是日历只剩最后一天时它最绿。
 */
export const CALENDAR_STALE_DAYS = 60;

export type Coverage =
  | { kind: 'exhausted'; until: string }
  | { kind: 'ending'; until: string; daysLeft: number }
  | { kind: 'ok'; until: string; daysLeft: number }
  | { kind: 'stale-fallback' }
  | { kind: 'unknown' };

export function coverage(info: CalendarInfo, now = new Date()): Coverage {
  if (info.coversUntil) {
    // 只比日期不比时刻：日历末日当天本身仍然是可用的交易日，daysLeft = 0 不算用尽。
    const until = info.coversUntil;
    const today = now.toISOString().slice(0, 10);
    const daysLeft = Math.round(
      (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    if (daysLeft < 0) return { kind: 'exhausted', until };
    if (daysLeft <= COVERAGE_WARN_DAYS) return { kind: 'ending', until, daysLeft };
    return { kind: 'ok', until, daysLeft };
  }
  if (!info.generatedAt) return { kind: 'unknown' };
  const age = now.getTime() - new Date(info.generatedAt).getTime();
  return age > CALENDAR_STALE_DAYS * 86_400_000 ? { kind: 'stale-fallback' } : { kind: 'unknown' };
}
