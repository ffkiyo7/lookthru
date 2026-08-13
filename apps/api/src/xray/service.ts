import type { HoldingsResult } from '../sources/eastmoney';

export interface XRayFundInput {
  fundCode: string;
  fundName: string;
  officialMarketValue: number | null;
  estimatedMarketValue: number | null;
  heldDays: number | null;
  holdings: HoldingsResult;
}

export interface XRayExposureRow {
  stockCode: string;
  stockName: string;
  pct: number;
  value: number;
  chgPct: number | null;
  funds: { name: string; contribPct: number }[];
}

export interface XRayResult {
  exposures: XRayExposureRow[];
  sectors: { name: string; pct: number; value: number; fundCount: number }[];
  meta: {
    fundCount: number;
    coveragePct: number;
    reportDate: string | null;
    reportQuarter: string | null;
    staleDays: number | null;
    top5Pct: number;
    valueBasis: 'ESTIMATED' | 'OFFICIAL' | 'MIXED' | 'EMPTY';
    estimatedFundCount: number;
    officialFundCount: number;
  };
  facts: {
    redemptionPenalty: {
      ratePct: 1.5;
      funds: { fundCode: string; fundName: string; heldDays: number }[];
    };
    concentration: { top5Pct: number };
    industryOverlap: { overlapPct: number; overlappingIndustryCount: number };
  };
}

interface ExposureAccumulator {
  stockCode: string;
  stockName: string;
  secid: string | null;
  value: number;
  funds: { name: string; value: number }[];
}

interface SectorAccumulator {
  name: string;
  value: number;
  fundCodes: Set<string>;
}

function rounded(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function reportQuarter(date: string): string {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

function staleDays(reportDate: string, asOf: string): number {
  const report = Date.parse(`${reportDate}T00:00:00Z`);
  const current = Date.parse(asOf);
  if (!Number.isFinite(report) || !Number.isFinite(current)) {
    throw new Error(`无法计算穿透报告期陈旧度 reportDate=${reportDate} asOf=${asOf}`);
  }
  return Math.max(0, Math.floor((current - report) / 86_400_000));
}

export function aggregateXRay(
  funds: XRayFundInput[],
  quoteChanges: ReadonlyMap<string, number>,
  asOf: string,
): XRayResult {
  const totalMarketValue = funds.reduce((sum, fund) => {
    const marketValue = fund.estimatedMarketValue ?? fund.officialMarketValue;
    if (marketValue === null || !Number.isFinite(marketValue) || marketValue < 0) {
      throw new Error(`基金 ${fund.fundCode} 的穿透市值非法: ${marketValue}`);
    }
    return sum + marketValue;
  }, 0);
  const estimatedFundCount = funds.filter((fund) => fund.estimatedMarketValue !== null).length;
  const officialFundCount = funds.length - estimatedFundCount;
  const exposures = new Map<string, ExposureAccumulator>();
  const sectors = new Map<string, SectorAccumulator>();
  const reportDates: string[] = [];
  let coveredValue = 0;

  for (const fund of funds) {
    const marketValue = fund.estimatedMarketValue ?? fund.officialMarketValue;
    if (marketValue === null) {
      throw new Error(`基金 ${fund.fundCode} 缺少穿透市值`);
    }
    if (fund.holdings.reportDate !== null) reportDates.push(fund.holdings.reportDate);
    if (
      !Number.isFinite(fund.holdings.coverageWeight) ||
      fund.holdings.coverageWeight < 0 ||
      fund.holdings.coverageWeight > 100
    ) {
      throw new Error(
        `基金 ${fund.fundCode} 的穿透覆盖率非法: ${fund.holdings.coverageWeight}`,
      );
    }
    coveredValue += marketValue * (fund.holdings.coverageWeight / 100);

    for (const holding of fund.holdings.holdings) {
      const value = marketValue * (holding.weight / 100);
      const key = holding.secid ?? `code:${holding.stockCode}`;
      const current = exposures.get(key) ?? {
        stockCode: holding.stockCode,
        stockName: holding.stockName,
        secid: holding.secid,
        value: 0,
        funds: [],
      };
      current.value += value;
      current.funds.push({ name: fund.fundName, value });
      exposures.set(key, current);
    }

    for (const industry of fund.holdings.industries) {
      const value = marketValue * (industry.weight / 100);
      const current = sectors.get(industry.code) ?? {
        name: industry.name,
        value: 0,
        fundCodes: new Set<string>(),
      };
      current.value += value;
      current.fundCodes.add(fund.fundCode);
      sectors.set(industry.code, current);
    }
  }

  const exposureRows = [...exposures.values()]
    .map((exposure): XRayExposureRow => ({
      stockCode: exposure.stockCode,
      stockName: exposure.stockName,
      pct: totalMarketValue > 0 ? rounded((exposure.value / totalMarketValue) * 100) : 0,
      value: rounded(exposure.value),
      chgPct: exposure.secid === null ? null : (quoteChanges.get(exposure.secid) ?? null),
      funds: exposure.funds
        .map((fund) => ({
          name: fund.name,
          contribPct: totalMarketValue > 0 ? rounded((fund.value / totalMarketValue) * 100) : 0,
        }))
        .sort((left, right) => right.contribPct - left.contribPct),
    }))
    .sort((left, right) => right.value - left.value);
  const industryCoveredValue = [...sectors.values()].reduce(
    (sum, sector) => sum + sector.value,
    0,
  );
  const sectorRows = [...sectors.values()]
    .map((sector) => ({
      name: sector.name,
      pct: industryCoveredValue > 0 ? rounded((sector.value / industryCoveredValue) * 100) : 0,
      value: rounded(sector.value),
      fundCount: sector.fundCodes.size,
    }))
    .sort((left, right) => right.value - left.value);
  const overlapValue = [...sectors.values()]
    .filter((sector) => sector.fundCodes.size > 1)
    .reduce((sum, sector) => sum + sector.value, 0);
  const oldestReportDate = reportDates.length > 0 ? reportDates.sort()[0]! : null;
  const top5Pct = rounded(exposureRows.slice(0, 5).reduce((sum, row) => sum + row.pct, 0));
  const valueBasis =
    funds.length === 0
      ? 'EMPTY'
      : estimatedFundCount === funds.length
        ? 'ESTIMATED'
        : officialFundCount === funds.length
          ? 'OFFICIAL'
          : 'MIXED';

  return {
    exposures: exposureRows,
    sectors: sectorRows,
    meta: {
      fundCount: funds.length,
      coveragePct: totalMarketValue > 0 ? rounded((coveredValue / totalMarketValue) * 100) : 0,
      reportDate: oldestReportDate,
      reportQuarter: oldestReportDate === null ? null : reportQuarter(oldestReportDate),
      staleDays: oldestReportDate === null ? null : staleDays(oldestReportDate, asOf),
      top5Pct,
      valueBasis,
      estimatedFundCount,
      officialFundCount,
    },
    facts: {
      redemptionPenalty: {
        ratePct: 1.5,
        funds: funds
          .filter((fund) => fund.heldDays !== null && fund.heldDays < 7)
          .map((fund) => ({
            fundCode: fund.fundCode,
            fundName: fund.fundName,
            heldDays: fund.heldDays!,
          })),
      },
      concentration: { top5Pct },
      industryOverlap: {
        overlapPct:
          industryCoveredValue > 0 ? rounded((overlapValue / industryCoveredValue) * 100) : 0,
        overlappingIndustryCount: [...sectors.values()].filter(
          (sector) => sector.fundCodes.size > 1,
        ).length,
      },
    },
  };
}
