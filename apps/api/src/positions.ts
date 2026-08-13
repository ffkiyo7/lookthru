import { Position, type LatestOfficialNav, type Valuation } from '@lookthru/shared';
import { getLatestOfficialNav } from './data/navs';
import {
  derivePositions,
  listTransactions,
  type DerivedPosition,
} from './data/transactions';
import type { Env } from './env';
import { getCachedFundMeta, type FundMeta } from './fund-meta';
import { getCachedValuations } from './valuation/service';

export interface PositionSnapshot {
  updatedAt: string | null;
  positions: Array<Position & { officialValue: LatestOfficialNav | null }>;
}

function regularDayReturn(shares: number, nav: LatestOfficialNav): number | null {
  if (nav.valueKind !== 'UNIT_NAV' || nav.chgPct === null) return null;
  const denominator = 1 + nav.chgPct / 100;
  if (denominator <= 0) {
    console.warn(
      `[positions] 官方涨跌幅无法反推昨收 code=${nav.fundCode} chgPct=${nav.chgPct}`,
    );
    return null;
  }
  return shares * (nav.unitNav - nav.unitNav / denominator);
}

export function officialMarketValue(shares: number, nav: LatestOfficialNav): number {
  // 货币基金的官方字段是万份收益而不是净值；其份额面值按 1 元计，
  // 当日收益则用「份额 / 10000 × 万份收益」单独计算，绝不混入 unitNav。
  return nav.valueKind === 'UNIT_NAV' ? shares * nav.unitNav : shares;
}

export function positionDayReturn(shares: number, nav: LatestOfficialNav): number | null {
  return nav.valueKind === 'TEN_THOUSAND_YIELD'
    ? (shares / 10_000) * nav.tenThousandYield
    : regularDayReturn(shares, nav);
}

function latestTimestamp(navs: LatestOfficialNav[], valuations: Valuation[]): string | null {
  const timestamps = [
    ...navs.map((nav) => nav.fetchedAt),
    ...valuations.map((valuation) => valuation.estTime),
  ].filter((timestamp) => Number.isFinite(Date.parse(timestamp)));
  return timestamps.sort().at(-1) ?? null;
}

export function assemblePositionSnapshot(
  derived: DerivedPosition[],
  metas: Array<FundMeta | null>,
  navs: Array<LatestOfficialNav | null>,
  valuationMap: ReadonlyMap<string, Valuation>,
): PositionSnapshot {
  if (derived.length !== metas.length || derived.length !== navs.length) {
    throw new Error('持仓、基金资料与官方净值数量不一致');
  }
  const completeNavs: LatestOfficialNav[] = [];
  const positions = derived.map((derivedPosition, index) => {
    const meta = metas[index] ?? null;
    const nav = navs[index] ?? null;
    if (nav) completeNavs.push(nav);
    const marketValue = nav ? officialMarketValue(derivedPosition.shares, nav) : null;
    const holdingReturn = marketValue === null ? null : marketValue - derivedPosition.costTotal;
    const valuation = valuationMap.get(derivedPosition.fundCode) ?? null;
    const position = Position.parse({
      fundCode: derivedPosition.fundCode,
      fundName: meta?.name ?? `基金 ${derivedPosition.fundCode}`,
      shares: derivedPosition.shares,
      costTotal: derivedPosition.costTotal,
      costPerShare: derivedPosition.costPerShare,
      marketValue,
      holdingReturn,
      holdingReturnPct:
        holdingReturn !== null && derivedPosition.costTotal > 0
          ? (holdingReturn / derivedPosition.costTotal) * 100
          : null,
      dayReturn: nav ? positionDayReturn(derivedPosition.shares, nav) : null,
      valuation,
    });
    return { ...position, officialValue: nav };
  });
  return {
    updatedAt: latestTimestamp(completeNavs, [...valuationMap.values()]),
    positions,
  };
}

export async function loadPositionSnapshot(env: Env, userId: string): Promise<PositionSnapshot> {
  const transactions = await listTransactions(env.DB, userId);
  const derived = derivePositions(transactions);
  if (derived.length === 0) return { updatedAt: null, positions: [] };

  const codes = derived.map((position) => position.fundCode);
  const [metas, navs, valuationMap] = await Promise.all([
    Promise.all(
      codes.map(async (code) => {
        try {
          return await getCachedFundMeta(env, code);
        } catch (error) {
          // 用户自己的份额与成本不能被基金名称上游挡住；代码仍可作为明确占位。
          console.warn(`[positions] 基金资料暂不可用 code=${code}`, error);
          return null;
        }
      }),
    ),
    Promise.all(codes.map((code) => getLatestOfficialNav(env, code))),
    getCachedValuations(env, codes),
  ]);

  return assemblePositionSnapshot(derived, metas, navs, valuationMap);
}
