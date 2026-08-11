import { describe, expect, it } from 'vitest';
import { LatestOfficialNav } from '../packages/shared/src';
import { persistOfficialNavs } from '../apps/api/src/nav/sync';

const base = {
  fundCode: '000001',
  navDate: '2026-08-11',
  source: 'test',
  fetchedAt: '2026-08-11T13:00:00.000Z',
};

describe('最新官方值分型', () => {
  it('接受普通基金单位净值', () => {
    expect(
      LatestOfficialNav.safeParse({
        ...base,
        valueKind: 'UNIT_NAV',
        unitNav: 1.2345,
        accNav: 2.3456,
        chgPct: 0.5,
        tenThousandYield: null,
        sevenDayYieldPct: null,
      }).success,
    ).toBe(true);
  });

  it('拒绝把货币基金万份收益同时写进 unitNav', () => {
    expect(
      LatestOfficialNav.safeParse({
        ...base,
        valueKind: 'TEN_THOUSAND_YIELD',
        unitNav: 1.2345,
        accNav: null,
        chgPct: null,
        tenThousandYield: 0.4567,
        sevenDayYieldPct: 1.23,
      }).success,
    ).toBe(false);
  });

  it('stored 只统计 D1 实际变更并只回填实写行的 KV', async () => {
    const cacheWrites: string[] = [];
    const env = {
      DB: {
        prepare: (query: string) => ({
          bind: (...values: unknown[]) => ({
            query,
            values,
            all: async () => ({ results: [] }),
          }),
        }),
        batch: async (statements: unknown[]) =>
          statements.map((_, index) => ({
            meta: { changes: index === 0 ? 1 : 0 },
          })),
      },
      CACHE: {
        put: async (key: string) => {
          cacheWrites.push(key);
        },
      },
    } as never;
    const rows = ['000001', '000002'].map((fundCode) => ({
      ...base,
      fundCode,
      valueKind: 'TEN_THOUSAND_YIELD' as const,
      unitNav: null,
      accNav: null,
      chgPct: null,
      tenThousandYield: 0.4567,
      sevenDayYieldPct: null,
    }));

    await expect(persistOfficialNavs(env, rows)).resolves.toBe(1);
    expect(cacheWrites).toEqual(['navlatest:000001']);
  });
});
