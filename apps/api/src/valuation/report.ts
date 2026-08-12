import type { ValuationPrecision } from '@lookthru/shared';

type MeasuredPrecision = Exclude<ValuationPrecision, 'NONE'>;

interface ValuationErrorRow {
  precision: MeasuredPrecision;
  est_nav: number;
  official_nav: number;
}

export interface ValuationErrorGroup {
  precision: MeasuredPrecision;
  metric: 'ABS_NAV_ERROR_PCT' | 'PREMIUM_DISCOUNT_PCT';
  samples: number;
  averageAbsPct: number;
  p50AbsPct: number;
  p90AbsPct: number;
  thresholdPct: number | null;
  overThreshold: number | null;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) throw new Error('空数组没有百分位数');
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

export function summarizeValuationErrors(rows: ValuationErrorRow[]): ValuationErrorGroup[] {
  const order: MeasuredPrecision[] = ['EXACT', 'HIGH', 'MEDIUM', 'LOW'];
  return order.flatMap((precision) => {
    const values = rows
      .filter((row) => row.precision === precision)
      .map((row) => Math.abs(((row.est_nav - row.official_nav) / row.official_nav) * 100))
      .sort((left, right) => left - right);
    if (values.length === 0) return [];
    const thresholdPct = precision === 'HIGH' ? 0.15 : precision === 'MEDIUM' ? 0.6 : null;
    return [
      {
        precision,
        metric: precision === 'EXACT' ? 'PREMIUM_DISCOUNT_PCT' : 'ABS_NAV_ERROR_PCT',
        samples: values.length,
        averageAbsPct: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
        p50AbsPct: rounded(percentile(values, 0.5)),
        p90AbsPct: rounded(percentile(values, 0.9)),
        thresholdPct,
        overThreshold:
          thresholdPct === null
            ? null
            : values.filter((value) => value >= thresholdPct).length,
      },
    ];
  });
}

export async function getValuationErrorReport(
  db: D1Database,
  from: string | null,
  to: string | null,
): Promise<{
  sampleKind: 'CALIBRATION_1455';
  from: string | null;
  to: string | null;
  groups: ValuationErrorGroup[];
}> {
  const conditions = [
    "sample_kind = 'CALIBRATION_1455'",
    'reconciled_at IS NOT NULL',
    'est_nav IS NOT NULL',
    'official_nav IS NOT NULL',
    'official_nav > 0',
    "precision <> 'NONE'",
  ];
  const values: string[] = [];
  if (from !== null) {
    conditions.push('trade_date >= ?');
    values.push(from);
  }
  if (to !== null) {
    conditions.push('trade_date <= ?');
    values.push(to);
  }
  const { results } = await db
    .prepare(
      `SELECT precision, est_nav, official_nav
       FROM valuation_samples
       WHERE ${conditions.join(' AND ')}
       ORDER BY trade_date, fund_code`,
    )
    .bind(...values)
    .all<ValuationErrorRow>();
  return {
    sampleKind: 'CALIBRATION_1455',
    from,
    to,
    groups: summarizeValuationErrors(results),
  };
}
