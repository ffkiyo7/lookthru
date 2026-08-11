import { describe, expect, it } from 'vitest';
import { CALENDAR_STALE_DAYS, COVERAGE_WARN_DAYS, coverage } from '../apps/web/src/lib/calendar';

const NOW = new Date('2026-08-12T04:00:00Z');
const base = { available: true, generatedAt: '2026-08-11T15:32:39.520Z', days: 242 };

describe('交易日历覆盖窗口', () => {
  it('日历末日当天仍然可用 —— 边界不能差一天', () => {
    expect(coverage({ ...base, coversUntil: '2026-08-12' }, NOW)).toEqual({
      kind: 'ending',
      until: '2026-08-12',
      daysLeft: 0,
    });
  });

  it('末日已过 = 估值此刻就是死的', () => {
    expect(coverage({ ...base, coversUntil: '2026-08-11' }, NOW)).toEqual({
      kind: 'exhausted',
      until: '2026-08-11',
    });
  });

  it('剩余天数落在阈值两侧', () => {
    const at = (offsetDays: number) =>
      new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    expect(coverage({ ...base, coversUntil: at(COVERAGE_WARN_DAYS) }, NOW).kind).toBe('ending');
    expect(coverage({ ...base, coversUntil: at(COVERAGE_WARN_DAYS + 1) }, NOW).kind).toBe('ok');
  });

  /**
   * 这条是这个文件存在的理由。每月重新生成会把 generatedAt 一直刷新，
   * 靠生成时间判断的话，日历只剩最后一天时指示灯反而最绿 —— 全绿的死系统。
   */
  it('刚生成但即将用尽 —— 必须告警，不能因为 generatedAt 新鲜就放行', () => {
    expect(
      coverage(
        { available: true, generatedAt: NOW.toISOString(), days: 242, coversUntil: '2026-12-31' },
        new Date('2026-12-30T04:00:00Z'),
      ),
    ).toMatchObject({ kind: 'ending', daysLeft: 1 });
  });

  it('后端还没上报 coversUntil 时退化到生成时间', () => {
    const old = new Date(NOW.getTime() - (CALENDAR_STALE_DAYS + 1) * 86_400_000).toISOString();
    expect(coverage({ available: true, generatedAt: old, days: 242 }, NOW).kind).toBe(
      'stale-fallback',
    );
    expect(coverage({ available: true, generatedAt: NOW.toISOString(), days: 242 }, NOW).kind).toBe(
      'unknown',
    );
  });
});
