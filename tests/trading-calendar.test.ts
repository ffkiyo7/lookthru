import { describe, expect, it, vi } from 'vitest';
import {
  beijingDate,
  parseTradingCalendar,
  tradingCalendarInfo,
} from '../apps/api/src/trading-calendar';

describe('交易日历', () => {
  it('按北京时间判定业务日期', () => {
    expect(beijingDate(Date.parse('2026-08-10T16:30:00Z'))).toBe('2026-08-11');
  });

  it('校验、去重并排序交易日', () => {
    expect(
      parseTradingCalendar({
        generatedAt: '2026-08-01T00:00:00Z',
        tradingDays: ['2026-08-12', '2026-08-11', '2026-08-11'],
      }),
    ).toEqual({
      generatedAt: '2026-08-01T00:00:00Z',
      tradingDays: ['2026-08-11', '2026-08-12'],
    });
  });

  it('非法或缺失日历不降级成工作日猜测', () => {
    expect(parseTradingCalendar({ generatedAt: 'x', tradingDays: ['not-a-date'] })).toBeNull();
    expect(parseTradingCalendar(null)).toBeNull();
  });

  it('暴露可观测的日历摘要', async () => {
    const values = new Map<string, string>();
    const info = await tradingCalendarInfo({
      CACHE: {
        get: async (key: string) => {
          const value = values.get(key);
          return value === undefined ? null : JSON.parse(value);
        },
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
      ARCHIVE: {
        get: async () => ({
          json: async () => ({
            generatedAt: '2026-08-11T00:00:00Z',
            tradingDays: ['2026-08-11', '2026-08-12'],
          }),
        }),
      },
    } as never);

    expect(info).toEqual({
      available: true,
      generatedAt: '2026-08-11T00:00:00Z',
      days: 2,
    });
  });

  it('R2 抖动按不可用负缓存，不把异常抛给 Cron', async () => {
    const values = new Map<string, string>();
    let r2Reads = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      CACHE: {
        get: async (key: string) => {
          const value = values.get(key);
          return value === undefined ? null : JSON.parse(value);
        },
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
      ARCHIVE: {
        get: async () => {
          r2Reads++;
          throw new Error('temporary R2 failure');
        },
      },
    } as never;

    await expect(tradingCalendarInfo(env)).resolves.toEqual({
      available: false,
      generatedAt: null,
      days: 0,
    });
    await expect(tradingCalendarInfo(env)).resolves.toEqual({
      available: false,
      generatedAt: null,
      days: 0,
    });
    expect(r2Reads).toBe(1);
    warn.mockRestore();
  });
});
