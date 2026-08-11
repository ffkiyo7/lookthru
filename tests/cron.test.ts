import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { classifyScheduledTask, CRONS, runScheduledTask } from '../apps/api/src/cron';

function utc(value: string): number {
  return Date.parse(value);
}

describe('Cron 分派', () => {
  it('wrangler.toml 与代码注册表保持完全同步', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const block = /\[triggers\]\s*crons\s*=\s*\[([\s\S]*?)\]/.exec(toml)?.[1] ?? '';
    const configured = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(configured.sort()).toEqual(Object.values(CRONS).sort());
  });

  it('保留独立的出口探针', () => {
    expect(classifyScheduledTask(CRONS.probe, utc('2026-08-11T01:25:00Z'))).toBe('PROBE');
  });

  it('官方净值从北京时间 19:30 开始，不注册 19:00', () => {
    expect(CRONS.officialNavHalfPast).toBe('30 11-14 * * 2-6');
    expect(CRONS.officialNavOnHour).toBe('0 12-14 * * 2-6');
    expect(classifyScheduledTask(CRONS.officialNavHalfPast, utc('2026-08-11T11:30:00Z'))).toBe(
      'OFFICIAL_NAV',
    );
    expect(classifyScheduledTask(CRONS.officialNavOnHour, utc('2026-08-11T12:00:00Z'))).toBe(
      'OFFICIAL_NAV',
    );
  });

  it('分钟级估值只在真实交易时段分派', () => {
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T01:29:00Z'))).toBe('IDLE');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T01:30:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T03:30:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T03:31:00Z'))).toBe('IDLE');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T05:00:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T07:00:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T07:01:00Z'))).toBe('IDLE');
  });

  it('未知表达式明确告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runScheduledTask(
      {
        cron: '0 0 * * *',
        scheduledTime: utc('2026-08-11T00:00:00Z'),
        type: 'scheduled',
        noRetry: () => undefined,
      },
      {} as never,
    );
    expect(warn).toHaveBeenCalledWith('[cron] 未识别的触发表达式：0 0 * * *');
    warn.mockRestore();
  });

  it('交易日历缺失时估值任务 fail closed', async () => {
    const values = new Map<string, string>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runScheduledTask(
      {
        cron: CRONS.valuation,
        scheduledTime: utc('2026-08-11T01:30:00Z'),
        type: 'scheduled',
        noRetry: () => undefined,
      },
      {
        CACHE: {
          get: async (key: string) => {
            const value = values.get(key);
            return value === undefined ? null : JSON.parse(value);
          },
          put: async (key: string, value: string) => {
            values.set(key, value);
          },
        },
        ARCHIVE: { get: async () => null },
      } as never,
    );
    expect(warn).toHaveBeenCalledWith('[cron] 交易日历不可用，跳过 VALUATION date=2026-08-11');
    warn.mockRestore();
  });
});
