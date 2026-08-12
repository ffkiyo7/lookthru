import { Position, type LatestOfficialNav, type Valuation } from '@lookthru/shared';
import { getLatestOfficialNav } from './data/navs';
import { derivePositions, listTransactions } from './data/transactions';
import type { Env } from './env';
import { getFundMeta } from './fund-meta';
import { getCachedValuations } from './valuation/service';

export class PositionDataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionDataUnavailableError';
  }
}

export interface PositionSnapshot {
  updatedAt: string | null;
  positions: Position[];
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

export async function loadPositionSnapshot(env: Env, userId: string): Promise<PositionSnapshot> {
  const transactions = await listTransactions(env.DB, userId);
  const derived = derivePositions(transactions);
  if (derived.length === 0) return { updatedAt: null, positions: [] };

  const codes = derived.map((position) => position.fundCode);
  const [metas, navs, valuationMap] = await Promise.all([
    Promise.all(codes.map((code) => getFundMeta(env, code))),
    Promise.all(codes.map((code) => getLatestOfficialNav(env, code))),
    getCachedValuations(env, codes),
  ]);

  const completeNavs: LatestOfficialNav[] = [];
  const positions = derived.map((derivedPosition, index) => {
    const meta = metas[index];
    const nav = navs[index];
    if (!meta) {
      throw new PositionDataUnavailableError(`基金资料尚未同步 code=${derivedPosition.fundCode}`);
    }
    if (!nav) {
      throw new PositionDataUnavailableError(`官方净值尚未同步 code=${derivedPosition.fundCode}`);
    }
    completeNavs.push(nav);
    const marketValue = officialMarketValue(derivedPosition.shares, nav);
    const holdingReturn = marketValue - derivedPosition.costTotal;
    const valuation = valuationMap.get(derivedPosition.fundCode) ?? null;
    return Position.parse({
      fundCode: derivedPosition.fundCode,
      fundName: meta.name,
      shares: derivedPosition.shares,
      costTotal: derivedPosition.costTotal,
      costPerShare: derivedPosition.costPerShare,
      marketValue,
      holdingReturn,
      holdingReturnPct:
        derivedPosition.costTotal > 0 ? (holdingReturn / derivedPosition.costTotal) * 100 : 0,
      dayReturn: positionDayReturn(derivedPosition.shares, nav),
      valuation,
    });
  });

  return {
    updatedAt: latestTimestamp(completeNavs, [...valuationMap.values()]),
    positions,
  };
}
