import type { Transaction } from '@lookthru/shared';
import { derivePositions, listTransactions } from './data/transactions';

export type OfficialDailyValue =
  | { fundCode: string; date: string; kind: 'UNIT_NAV'; value: number }
  | { fundCode: string; date: string; kind: 'TEN_THOUSAND_YIELD'; value: number };

export interface DailyReturnPoint {
  date: string;
  valueBasis: 'OFFICIAL';
  dayReturn: number;
  startMarketValue: number;
  returnPct: number | null;
  activeFundCount: number;
  includedFundCount: number;
  missingFundCodes: string[];
  attribution: {
    fundCode: string;
    dayReturn: number;
    startMarketValue: number;
    returnPct: number;
    sourceKind: OfficialDailyValue['kind'];
  }[];
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function confirmedBefore(transactions: Transaction[], date: string): Transaction[] {
  return transactions.filter(
    (transaction) =>
      transaction.status === 'CONFIRMED' &&
      (transaction.confirmDate ?? transaction.tradeDate) < date,
  );
}

export function computeDailyReturns(
  transactions: Transaction[],
  values: OfficialDailyValue[],
  from: string,
  to: string,
): DailyReturnPoint[] {
  const byFund = new Map<string, OfficialDailyValue[]>();
  for (const value of values) {
    const rows = byFund.get(value.fundCode) ?? [];
    const existing = rows.findIndex((row) => row.date === value.date);
    if (existing >= 0) rows[existing] = value;
    else rows.push(value);
    byFund.set(value.fundCode, rows);
  }
  for (const rows of byFund.values()) rows.sort((left, right) => left.date.localeCompare(right.date));
  const dates = [
    ...new Set(
      values.filter((value) => value.date >= from && value.date <= to).map((value) => value.date),
    ),
  ].sort();

  return dates.flatMap((date) => {
    const positions = derivePositions(confirmedBefore(transactions, date));
    if (positions.length === 0) return [];
    const attribution: DailyReturnPoint['attribution'] = [];
    const missingFundCodes: string[] = [];
    for (const position of positions) {
      const rows = byFund.get(position.fundCode) ?? [];
      const currentIndex = rows.findIndex((row) => row.date === date);
      const current = currentIndex >= 0 ? rows[currentIndex] : undefined;
      if (!current) {
        missingFundCodes.push(position.fundCode);
        continue;
      }
      if (current.kind === 'TEN_THOUSAND_YIELD') {
        const startMarketValue = position.shares;
        const dayReturn = (position.shares / 10_000) * current.value;
        attribution.push({
          fundCode: position.fundCode,
          dayReturn: rounded(dayReturn),
          startMarketValue: rounded(startMarketValue, 2),
          returnPct: rounded((dayReturn / startMarketValue) * 100),
          sourceKind: current.kind,
        });
        continue;
      }
      const previous = rows
        .slice(0, currentIndex)
        .reverse()
        .find((row) => row.kind === 'UNIT_NAV');
      if (!previous) {
        missingFundCodes.push(position.fundCode);
        continue;
      }
      if (previous.value <= 0 || current.value <= 0) {
        throw new Error(
          `官方单位净值必须为正 code=${position.fundCode} date=${date}`,
        );
      }
      const startMarketValue = position.shares * previous.value;
      const dayReturn = position.shares * (current.value - previous.value);
      attribution.push({
        fundCode: position.fundCode,
        dayReturn: rounded(dayReturn),
        startMarketValue: rounded(startMarketValue, 2),
        returnPct: rounded(((current.value - previous.value) / previous.value) * 100),
        sourceKind: current.kind,
      });
    }
    const dayReturn = attribution.reduce((sum, row) => sum + row.dayReturn, 0);
    const startMarketValue = attribution.reduce((sum, row) => sum + row.startMarketValue, 0);
    return [
      {
        date,
        valueBasis: 'OFFICIAL' as const,
        dayReturn: rounded(dayReturn, 2),
        startMarketValue: rounded(startMarketValue, 2),
        returnPct:
          startMarketValue > 0 ? rounded((dayReturn / startMarketValue) * 100) : null,
        activeFundCount: positions.length,
        includedFundCount: attribution.length,
        missingFundCodes: missingFundCodes.sort(),
        attribution: attribution.sort((left, right) =>
          Math.abs(right.dayReturn) - Math.abs(left.dayReturn) ||
          left.fundCode.localeCompare(right.fundCode),
        ),
      },
    ];
  });
}

interface SampleRow {
  fund_code: string;
  trade_date: string;
  official_nav: number;
}

interface LatestRow {
  fund_code: string;
  nav_date: string;
  value_kind: 'UNIT_NAV' | 'TEN_THOUSAND_YIELD';
  unit_nav: number | null;
  ten_thousand_yield: number | null;
}

export async function getDailyReturns(
  db: D1Database,
  userId: string,
  from: string,
  to: string,
): Promise<{ from: string; to: string; series: DailyReturnPoint[] }> {
  const transactions = await listTransactions(db, userId);
  const codes = [...new Set(transactions.map((transaction) => transaction.fundCode))];
  if (codes.length === 0) return { from, to, series: [] };
  const placeholders = codes.map(() => '?').join(', ');
  const [samples, latest] = await Promise.all([
    db
      .prepare(
        `SELECT fund_code, trade_date, official_nav
         FROM valuation_samples
         WHERE sample_kind = 'CALIBRATION_1455'
           AND official_nav IS NOT NULL
           AND trade_date <= ?
           AND fund_code IN (${placeholders})
         ORDER BY trade_date, fund_code`,
      )
      .bind(to, ...codes)
      .all<SampleRow>(),
    db
      .prepare(
        `SELECT fund_code, nav_date, value_kind, unit_nav, ten_thousand_yield
         FROM latest_official_navs
         WHERE nav_date <= ? AND fund_code IN (${placeholders})`,
      )
      .bind(to, ...codes)
      .all<LatestRow>(),
  ]);
  const values: OfficialDailyValue[] = samples.results.map((row) => ({
    fundCode: row.fund_code,
    date: row.trade_date,
    kind: 'UNIT_NAV',
    value: row.official_nav,
  }));
  for (const row of latest.results) {
    const value = row.value_kind === 'UNIT_NAV' ? row.unit_nav : row.ten_thousand_yield;
    if (value === null) {
      throw new Error(`最新官方值分型与数值不一致 code=${row.fund_code}`);
    }
    values.push({ fundCode: row.fund_code, date: row.nav_date, kind: row.value_kind, value });
  }
  return { from, to, series: computeDailyReturns(transactions, values, from, to) };
}
