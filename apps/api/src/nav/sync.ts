import type { LatestOfficialNav } from '@lookthru/shared';
import { getFundMeta, type FundMeta } from '../fund-meta';
import { searchFunds, type FundSearchHit } from '../sources/eastmoney';
import { fetchNavBatch, type SinaNav } from '../sources/sina';
import type { Env } from '../env';
import { listValuationFundCodes } from '../valuation/universe';

const DB_BATCH_ROWS = 400;
const LATEST_NAV_TTL_SECONDS = 60 * 60;

export interface OfficialNavSyncResult {
  requested: number;
  stored: number;
  skipped: string[];
}

export async function syncOfficialNavs(env: Env): Promise<OfficialNavSyncResult> {
  const codes = await listValuationFundCodes(env.DB);
  if (codes.length === 0) return { requested: 0, stored: 0, skipped: [] };

  // search 源自身有礼貌限流；这里按基金串行分类，避免瞬时并发绕过 ≤1 req/s 约束。
  const metas: FundMeta[] = [];
  const skipped: string[] = [];
  for (const code of codes) {
    try {
      const meta = await getFundMeta(env, code);
      if (meta) metas.push(meta);
      else skipped.push(code);
    } catch (error) {
      console.warn(`[official-nav] 基金分类失败 code=${code}`, error);
      skipped.push(code);
    }
  }

  const regularCodes = metas.filter((meta) => !meta.isMoneyFund).map((meta) => meta.code);
  let sina = new Map<string, SinaNav>();
  try {
    sina = await fetchNavBatch(regularCodes);
  } catch (error) {
    // 部分基金失败不能覆盖已有 last-known-good；下一轮半小时任务会继续补。
    console.warn('[official-nav] 新浪批量净值抓取失败', error);
    skipped.push(...regularCodes);
  }
  const fetchedAt = new Date().toISOString();
  const rows: LatestOfficialNav[] = [];

  for (const meta of metas) {
    if (meta.isMoneyFund) {
      // fundmeta 可缓存数小时，但万份收益必须是本轮新鲜值，不能复用分类缓存中的 DWJZ。
      let fresh: FundSearchHit | undefined;
      try {
        fresh = (await searchFunds(meta.code)).find((item) => item.code === meta.code);
      } catch (error) {
        console.warn(`[official-nav] 货币基金万份收益抓取失败 code=${meta.code}`, error);
      }
      if (!fresh || fresh.nav === null || fresh.navDate === null) {
        skipped.push(meta.code);
        continue;
      }
      rows.push({
        fundCode: meta.code,
        valueKind: 'TEN_THOUSAND_YIELD',
        unitNav: null,
        accNav: null,
        chgPct: null,
        tenThousandYield: fresh.nav,
        sevenDayYieldPct: null,
        navDate: fresh.navDate,
        source: 'eastmoney:suggest',
        fetchedAt,
      });
      continue;
    }

    const nav = sina.get(meta.code);
    if (!nav) {
      skipped.push(meta.code);
      continue;
    }
    const chgPct =
      nav.prevNav !== null && nav.prevNav > 0
        ? Number((((nav.unitNav - nav.prevNav) / nav.prevNav) * 100).toFixed(4))
        : null;
    rows.push({
      fundCode: meta.code,
      valueKind: 'UNIT_NAV',
      unitNav: nav.unitNav,
      accNav: nav.accNav,
      chgPct,
      tenThousandYield: null,
      sevenDayYieldPct: null,
      navDate: nav.date,
      source: 'sina:nav',
      fetchedAt,
    });
  }

  const stored = await persistOfficialNavs(env, rows);
  return { requested: codes.length, stored, skipped: [...new Set(skipped)] };
}

export async function persistOfficialNavs(env: Env, rows: LatestOfficialNav[]): Promise<number> {
  const cacheRows: LatestOfficialNav[] = [];
  let stored = 0;
  for (let offset = 0; offset < rows.length; offset += DB_BATCH_ROWS) {
    const chunk = rows.slice(offset, offset + DB_BATCH_ROWS);
    const placeholders = chunk.map(() => '?').join(', ');
    const currentDates = new Map<string, string>();
    if (chunk.length > 0) {
      const { results } = await env.DB
        .prepare(
          `SELECT fund_code, nav_date
           FROM latest_official_navs
           WHERE fund_code IN (${placeholders})`,
        )
        .bind(...chunk.map((row) => row.fundCode))
        .all<{ fund_code: string; nav_date: string }>();
      for (const result of results) currentDates.set(result.fund_code, result.nav_date);
    }
    const accepted = chunk.filter((row) => {
      const current = currentDates.get(row.fundCode);
      return current === undefined || row.navDate >= current;
    });
    const statements: D1PreparedStatement[] = [];
    const navRowsByStatementIndex = new Map<number, LatestOfficialNav>();
    for (const row of accepted) {
      navRowsByStatementIndex.set(statements.length, row);
      statements.push(
        env.DB.prepare(
          `INSERT INTO latest_official_navs (
            fund_code, value_kind, unit_nav, acc_nav, chg_pct,
            ten_thousand_yield, seven_day_yield_pct, nav_date,
            source, fetched_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (fund_code) DO UPDATE SET
            value_kind = excluded.value_kind,
            unit_nav = excluded.unit_nav,
            acc_nav = excluded.acc_nav,
            chg_pct = excluded.chg_pct,
            ten_thousand_yield = excluded.ten_thousand_yield,
            seven_day_yield_pct = excluded.seven_day_yield_pct,
            nav_date = excluded.nav_date,
            source = excluded.source,
            fetched_at = excluded.fetched_at,
            updated_at = excluded.updated_at
          WHERE excluded.nav_date >= latest_official_navs.nav_date`,
        ).bind(
          row.fundCode,
          row.valueKind,
          row.unitNav,
          row.accNav,
          row.chgPct,
          row.tenThousandYield,
          row.sevenDayYieldPct,
          row.navDate,
          row.source,
          row.fetchedAt,
          row.fetchedAt,
        ),
      );

      if (row.valueKind === 'UNIT_NAV') {
        statements.push(
          env.DB.prepare(
            `UPDATE valuation_samples
             SET official_nav = ?, official_nav_date = ?, reconciled_at = ?
             WHERE fund_code = ? AND trade_date = ? AND reconciled_at IS NULL`,
          ).bind(row.unitNav, row.navDate, row.fetchedAt, row.fundCode, row.navDate),
        );
      }
    }
    if (statements.length > 0) {
      const results = await env.DB.batch(statements);
      for (const [statementIndex, row] of navRowsByStatementIndex) {
        const result = results[statementIndex];
        if (result === undefined) {
          throw new Error(`D1 batch 缺少净值写入结果 index=${statementIndex}`);
        }
        if (result.meta.changes < 0 || result.meta.changes > 1) {
          throw new Error(
            `D1 净值写入变更数异常 code=${row.fundCode} changes=${result.meta.changes}`,
          );
        }
        stored += result.meta.changes;
        if (result.meta.changes === 1) cacheRows.push(row);
      }
    }
  }

  // D1 是 last-known-good；KV 只是读缓存。即使 KV 写失败，官方值也不会丢。
  const cacheWrites = await Promise.allSettled(
    cacheRows.map((row) =>
      env.CACHE.put(`navlatest:${row.fundCode}`, JSON.stringify(row), {
        expirationTtl: LATEST_NAV_TTL_SECONDS,
      }),
    ),
  );
  const failedWrites = cacheWrites.filter((result) => result.status === 'rejected');
  if (failedWrites.length > 0) {
    console.warn(`[official-nav] KV 回填失败 ${failedWrites.length}/${cacheRows.length}`);
  }
  return stored;
}
