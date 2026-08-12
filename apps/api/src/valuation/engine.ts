import {
  isBondOrMoneyFund,
  isExchangeTradedCode,
  isPassiveIndexFund,
  isQdii,
  Valuation,
  type Quote,
  type ValuationPrecision,
} from '@lookthru/shared';

export const ACTIVE_FALLBACK_BENCHMARK = {
  secid: '1.000300',
  name: '沪深300指数',
  weight: null,
  source: 'FALLBACK' as const,
};

export interface ValuationBenchmark {
  secid: string;
  name: string;
  weight: number | null;
  source: 'FUND_BENCHMARK' | 'FALLBACK';
}

export interface ValuationFundInput {
  fundCode: string;
  fundName: string;
  fundType: string;
  exchangeSecid: string | null;
  stockPosition: number | null;
  reportDate: string | null;
  holdings: { secid: string | null; weight: number }[];
  benchmark: ValuationBenchmark | null;
}

export interface EstimateOptions {
  estTime: string;
  delayed: boolean;
}

export type ValuationNoneCause =
  | 'STRUCTURAL_POLICY'
  | 'EXCHANGE_QUOTE_MISSING'
  | 'PREVIOUS_NAV_MISSING'
  | 'BENCHMARK_MISSING'
  | 'BENCHMARK_WEIGHT_MISSING'
  | 'BENCHMARK_WEIGHT_INSUFFICIENT'
  | 'STOCK_POSITION_MISSING'
  | 'BENCHMARK_QUOTE_MISSING'
  | 'ALL_QUOTES_MISSING';

export interface ValuationEstimateResult {
  valuation: Valuation;
  noneCause: ValuationNoneCause | null;
}

function rounded(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function dateAge(reportDate: string | null, estTime: string): number | null {
  if (reportDate === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error(`非法持仓报告期: ${reportDate}`);
  }
  const report = Date.parse(`${reportDate}T00:00:00Z`);
  const estimate = Date.parse(estTime);
  if (!Number.isFinite(report) || !Number.isFinite(estimate)) {
    throw new Error(`无法计算持仓陈旧度: reportDate=${reportDate} estTime=${estTime}`);
  }
  return Math.max(0, Math.floor((estimate - report) / 86_400_000));
}

function quarterLabel(reportDate: string | null): string {
  if (reportDate === null) return '报告期未知的';
  const month = Number(reportDate.slice(5, 7));
  return `${reportDate.slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

function appendDelayed(note: string, delayed: boolean): string {
  return delayed ? `${note}；行情源为延时数据，精度已下调` : note;
}

export function requiredQuoteSecids(input: ValuationFundInput): string[] {
  if (isQdii(input.fundType, input.fundName) || isBondOrMoneyFund(input.fundType)) return [];
  if (input.exchangeSecid && isExchangeTradedCode(input.fundCode)) return [input.exchangeSecid];
  if (isPassiveIndexFund(input.fundType, input.fundName)) {
    if (!input.benchmark || input.benchmark.source !== 'FUND_BENCHMARK') return [];
    const linkedFund = /联接/.test(input.fundName);
    if (input.benchmark.weight === null) return [];
    if (!linkedFund && input.benchmark.weight < 90) return [];
    if (!linkedFund && input.stockPosition === null) return [];
    return [input.benchmark.secid];
  }
  return [
    ...input.holdings.flatMap((holding) => (holding.secid ? [holding.secid] : [])),
    ...(input.benchmark ? [input.benchmark.secid] : []),
  ];
}

export function estimateValuation(
  input: ValuationFundInput,
  prevNav: number | null,
  quotes: ReadonlyMap<string, Quote>,
  options: EstimateOptions,
): Valuation {
  return estimateValuationWithDiagnostics(input, prevNav, quotes, options).valuation;
}

export function estimateValuationWithDiagnostics(
  input: ValuationFundInput,
  prevNav: number | null,
  quotes: ReadonlyMap<string, Quote>,
  options: EstimateOptions,
): ValuationEstimateResult {
  const coverageWeight = rounded(
    input.holdings.reduce((sum, holding) => sum + holding.weight, 0),
    2,
  );
  const staleDays = dateAge(input.reportDate, options.estTime);
  const basis = (note: string) => ({
    reportDate: input.reportDate,
    staleDays,
    coverageWeight: input.holdings.length > 0 ? coverageWeight : null,
    note,
  });
  const result = (
    estNav: number | null,
    estChgPct: number | null,
    precision: ValuationPrecision,
    note: string,
    noneCause: ValuationNoneCause | null = null,
  ): ValuationEstimateResult => ({
    valuation: Valuation.parse({
      fundCode: input.fundCode,
      estNav,
      estChgPct,
      precision,
      prevNav,
      estTime: options.estTime,
      basis: basis(note),
    }),
    noneCause,
  });

  if (isQdii(input.fundType, input.fundName)) {
    return result(
      null,
      null,
      'NONE',
      'QDII 标的市场与 A 股交易时段错开，不提供盘中估算',
      'STRUCTURAL_POLICY',
    );
  }
  if (isBondOrMoneyFund(input.fundType)) {
    return result(
      null,
      null,
      'NONE',
      '债券型或货币型基金不提供盘中估算',
      'STRUCTURAL_POLICY',
    );
  }

  if (isExchangeTradedCode(input.fundCode)) {
    const quote = input.exchangeSecid ? quotes.get(input.exchangeSecid) : undefined;
    if (!quote) {
      return result(
        null,
        null,
        'NONE',
        '场内实时成交价暂不可用',
        'EXCHANGE_QUOTE_MISSING',
      );
    }
    return result(
      rounded(quote.price, 6),
      rounded(quote.chgPct, 4),
      options.delayed ? 'LOW' : 'EXACT',
      appendDelayed('场内实时成交价', options.delayed),
    );
  }

  if (isPassiveIndexFund(input.fundType, input.fundName)) {
    if (!input.benchmark || input.benchmark.source !== 'FUND_BENCHMARK') {
      return result(
        null,
        null,
        'NONE',
        '跟踪指数无法从业绩基准唯一确认，不猜测盘中估算',
        'BENCHMARK_MISSING',
      );
    }
    if (prevNav === null || prevNav <= 0) {
      return result(
        null,
        null,
        'NONE',
        '缺少前一交易日官方净值，暂不可估',
        'PREVIOUS_NAV_MISSING',
      );
    }
    const linkedFund = /联接/.test(input.fundName);
    if (input.benchmark.weight === null) {
      return result(
        null,
        null,
        'NONE',
        '业绩基准缺少目标指数权重，暂不可估',
        'BENCHMARK_WEIGHT_MISSING',
      );
    }
    if (!linkedFund && input.benchmark.weight < 90) {
      return result(
        null,
        null,
        'NONE',
        `目标指数仅占业绩基准 ${rounded(input.benchmark.weight, 1)}%，不足 90%，不生成高精度估算`,
        'BENCHMARK_WEIGHT_INSUFFICIENT',
      );
    }
    const exposure = linkedFund ? input.benchmark.weight : input.stockPosition;
    if (exposure === null) {
      return result(
        null,
        null,
        'NONE',
        '缺少最新股票仓位，暂不可估',
        'STOCK_POSITION_MISSING',
      );
    }
    const quote = quotes.get(input.benchmark.secid);
    if (!quote) {
      return result(
        null,
        null,
        'NONE',
        `${input.benchmark.name}行情暂不可用`,
        'BENCHMARK_QUOTE_MISSING',
      );
    }
    // ETF 联接的 Data_fundSharesPositions 只有直接股票，不含目标 ETF；继续使用会把
    // 95% 左右的指数敞口静默缩成几个百分点。只有联接基金改用业绩基准显式权重。
    const estChgPct = quote.chgPct * (exposure / 100);
    return result(
      rounded(prevNav * (1 + estChgPct / 100), 6),
      rounded(estChgPct, 4),
      options.delayed ? 'MEDIUM' : 'HIGH',
      appendDelayed(
        linkedFund
          ? `跟踪${input.benchmark.name}，按业绩基准权重 ${rounded(exposure, 1)}% 估算`
          : `跟踪${input.benchmark.name}，按最新股票仓位 ${rounded(exposure, 1)}% 估算`,
        options.delayed,
      ),
    );
  }

  if (prevNav === null || prevNav <= 0) {
    return result(
      null,
      null,
      'NONE',
      '缺少前一交易日官方净值，暂不可估',
      'PREVIOUS_NAV_MISSING',
    );
  }

  let disclosedContribution = 0;
  let quotedWeight = 0;
  let missingQuoteCount = 0;
  for (const holding of input.holdings) {
    const quote = holding.secid ? quotes.get(holding.secid) : undefined;
    if (!quote) {
      missingQuoteCount++;
      continue;
    }
    disclosedContribution += (holding.weight / 100) * quote.chgPct;
    quotedWeight += holding.weight;
  }

  const effectiveStockPosition = input.stockPosition ?? coverageWeight;
  const residualWeight = Math.max(0, effectiveStockPosition - quotedWeight);
  const benchmarkQuote = input.benchmark ? quotes.get(input.benchmark.secid) : undefined;
  let residualReturn: number | null = benchmarkQuote?.chgPct ?? null;
  let usedDisclosedProxy = false;
  if (residualReturn === null && quotedWeight > 0) {
    residualReturn = disclosedContribution / (quotedWeight / 100);
    usedDisclosedProxy = true;
  }
  if (quotedWeight === 0 && residualReturn === null) {
    return result(
      null,
      null,
      'NONE',
      '重仓股与基准行情均不可用，本轮不生成盘中估算',
      'ALL_QUOTES_MISSING',
    );
  }

  const estChgPct = disclosedContribution + (residualWeight / 100) * (residualReturn ?? 0);
  const medium = coverageWeight >= 50 && staleDays !== null && staleDays <= 45;
  const quotesIncomplete = missingQuoteCount > 0 || quotedWeight < coverageWeight * 0.8;
  const mustBeLow =
    !medium ||
    input.stockPosition === null ||
    quotesIncomplete ||
    usedDisclosedProxy ||
    options.delayed;
  const benchmarkName = usedDisclosedProxy
    ? '已披露重仓股走势'
    : (input.benchmark?.name ?? '可用市场基准');
  const notes = [
    `基于 ${quarterLabel(input.reportDate)} 前十大（占 ${coverageWeight}%），未披露部分按${benchmarkName}补足`,
  ];
  if (missingQuoteCount > 0) notes.push(`${missingQuoteCount} 只重仓股无行情`);
  if (input.stockPosition === null) notes.push('最新股票仓位缺失');

  return result(
    rounded(prevNav * (1 + estChgPct / 100), 6),
    rounded(estChgPct, 4),
    mustBeLow ? 'LOW' : 'MEDIUM',
    appendDelayed(notes.join('；'), options.delayed),
  );
}
