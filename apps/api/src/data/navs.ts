import { LatestOfficialNav, type Valuation } from '@lookthru/shared';
import type { Env } from '../env';

interface LatestOfficialNavRow {
  fund_code: string;
  value_kind: 'UNIT_NAV' | 'TEN_THOUSAND_YIELD';
  unit_nav: number | null;
  acc_nav: number | null;
  chg_pct: number | null;
  ten_thousand_yield: number | null;
  seven_day_yield_pct: number | null;
  nav_date: string;
  source: string;
  fetched_at: string;
}

export async function getLatestOfficialNav(
  env: Env,
  fundCode: string,
): Promise<LatestOfficialNav | null> {
  const key = `navlatest:${fundCode}`;
  try {
    const cached = await env.CACHE.get<unknown>(key, 'json');
    const parsed = LatestOfficialNav.safeParse(cached);
    if (parsed.success) return parsed.data;
  } catch (error) {
    console.warn(`[official-nav] KV read failed code=${fundCode}`, error);
  }

  const row = await env.DB.prepare(
    `SELECT fund_code, value_kind, unit_nav, acc_nav, chg_pct,
            ten_thousand_yield, seven_day_yield_pct, nav_date, source, fetched_at
     FROM latest_official_navs
     WHERE fund_code = ?`,
  )
    .bind(fundCode)
    .first<LatestOfficialNavRow>();
  if (!row) return null;

  const value = LatestOfficialNav.parse({
    fundCode: row.fund_code,
    valueKind: row.value_kind,
    unitNav: row.unit_nav,
    accNav: row.acc_nav,
    chgPct: row.chg_pct,
    tenThousandYield: row.ten_thousand_yield,
    sevenDayYieldPct: row.seven_day_yield_pct,
    navDate: row.nav_date,
    source: row.source,
    fetchedAt: row.fetched_at,
  });
  try {
    await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: 60 * 60 });
  } catch (error) {
    console.warn(`[official-nav] KV backfill failed code=${fundCode}`, error);
  }
  return value;
}

export type ValuationSampleKind = 'CALIBRATION_1455' | 'CLOSE_1505';

/** 每种采样口径每天只保留一条；Cron 至少一次投递不会制造重复记录。 */
export async function recordValuationSample(
  db: D1Database,
  valuation: Valuation,
  tradeDate: string,
  sampleKind: ValuationSampleKind,
  delayed: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO valuation_samples (
        fund_code, trade_date, sample_kind, sampled_at, est_nav, est_chg_pct,
        precision, prev_nav, delayed, basis_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (fund_code, trade_date, sample_kind) DO UPDATE SET
        sampled_at = excluded.sampled_at,
        est_nav = excluded.est_nav,
        est_chg_pct = excluded.est_chg_pct,
        precision = excluded.precision,
        prev_nav = excluded.prev_nav,
        delayed = excluded.delayed,
        basis_json = excluded.basis_json
      WHERE excluded.sampled_at >= valuation_samples.sampled_at`,
    )
    .bind(
      valuation.fundCode,
      tradeDate,
      sampleKind,
      valuation.estTime,
      valuation.estNav,
      valuation.estChgPct,
      valuation.precision,
      valuation.prevNav,
      delayed ? 1 : 0,
      JSON.stringify(valuation.basis),
    )
    .run();
}
