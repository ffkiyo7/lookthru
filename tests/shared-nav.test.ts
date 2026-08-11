import { describe, expect, it } from 'vitest';
import { LatestOfficialNav } from '../packages/shared/src';

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
});
