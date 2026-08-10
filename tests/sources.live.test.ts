import { afterAll, describe, expect, it } from 'vitest';
import { assertNotAllUnreachable, liveIt } from './live-helpers';
import {
  fetchFundList,
  fetchHoldings,
  fetchLatestNav,
  fetchNavHistory,
  fetchPingzhongData,
  fetchQuotes,
  msToDate,
  searchFunds,
  stockCodeToSecid,
} from '../apps/api/src/sources';
import { fetchNavBatch } from '../apps/api/src/sources/sina';

/** 招商中证白酒指数(LOF)A —— 场内 LOF，重仓集中，适合当基准样本 */
const SAMPLE = '161725';
/** 华夏成长混合 —— 最老的主动基金之一 */
const SAMPLE_ACTIVE = '000001';

// 打真实端点的用例一律用 liveIt：连不上要跳过，连上了不对才算契约破坏。理由见 live-helpers.ts
afterAll(assertNotAllUnreachable);

describe('纯函数', () => {
  it('msToDate 按 UTC+8 转换，不偏移一天', () => {
    // 东财时间戳是北京时间当日零点 = UTC 前一日 16:00
    expect(msToDate(Date.UTC(2026, 7, 6, 16, 0, 0))).toBe('2026-08-07');
    expect(msToDate(Date.UTC(2026, 0, 0, 16, 0, 0))).toBe('2026-01-01');
  });

  it('stockCodeToSecid 解析 7 位带市场位的代码', () => {
    expect(stockCodeToSecid('6005191')).toBe('1.600519'); // 贵州茅台 沪
    expect(stockCodeToSecid('0005680')).toBe('0.000568'); // 泸州老窖 深
    expect(stockCodeToSecid('600519')).toBeNull(); // 缺市场位
    expect(stockCodeToSecid('6005199')).toBeNull(); // 非法市场位
  });
});

describe('东财 pingzhongdata', () => {
  liveIt('解析出净值历史、仓位、重仓股 secid', async () => {
    const d = await fetchPingzhongData(SAMPLE);

    expect(d.code).toBe(SAMPLE);
    expect(d.name).toContain('白酒');

    expect(d.navHistory.length).toBeGreaterThan(1000);
    const last = d.navHistory.at(-1)!;
    expect(last.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last.unitNav).toBeGreaterThan(0);
    expect(last.accNav).toBeGreaterThan(0); // 累计净值已回填

    // 每日股票仓位 —— 估值引擎的关键输入
    expect(d.stockPositionHistory.length).toBeGreaterThan(10);
    expect(d.latestStockPosition).toBeGreaterThan(50);
    expect(d.latestStockPosition).toBeLessThanOrEqual(100);

    // 重仓股 secid 必须是 push2 能直接用的格式
    expect(d.topStockSecids.length).toBeGreaterThan(0);
    for (const s of d.topStockSecids) expect(s).toMatch(/^[01]\.\d{6}$/);

    expect(d.assetAllocation.length).toBeGreaterThan(0);
    expect(d.managers.length).toBeGreaterThan(0);
    expect(d.currentRate).not.toBeNull();
  });
});

describe('东财 持仓明细（估值引擎的 w_i）', () => {
  liveIt('返回报告期、权重、行业分类', async () => {
    const h = await fetchHoldings(SAMPLE);

    expect(h.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(h.holdings.length).toBeGreaterThan(0);
    expect(h.holdings.length).toBeLessThanOrEqual(10);

    for (const x of h.holdings) {
      expect(x.stockCode).toMatch(/^\d{6}$/);
      expect(x.stockName.length).toBeGreaterThan(0);
      expect(x.weight).toBeGreaterThan(0);
      expect(x.secid).toMatch(/^[01]\.\d{6}$/);
    }

    // 覆盖度决定估值精度分级
    expect(h.coverageWeight).toBeGreaterThan(0);
    expect(h.coverageWeight).toBeLessThanOrEqual(100);

    // 行业分类白送，用于「行业重叠度」
    expect(h.industries.length).toBeGreaterThan(0);
    const industrySum = h.industries.reduce((a, i) => a + i.weight, 0);
    expect(industrySum).toBeCloseTo(h.coverageWeight, 1);
  });
});

describe('东财 历史净值 lsjz', () => {
  liveIt('返回带日期与涨跌幅的净值行', async () => {
    const rows = await fetchNavHistory(SAMPLE_ACTIVE, 1, 5);
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.unitNav).toBeGreaterThan(0);
    }
    // 按日期倒序
    expect(rows[0]!.date >= rows[1]!.date).toBe(true);
  });
});

describe('跨源一致性（最强的正确性检验）', () => {
  liveIt('pingzhongdata 与 lsjz 的最新净值日期/数值一致 —— 验证时区换算', async () => {
    const [pz, lsjz] = await Promise.all([
      fetchPingzhongData(SAMPLE),
      fetchNavHistory(SAMPLE, 1, 1),
    ]);
    const pzLast = pz.navHistory.at(-1)!;
    const emLast = lsjz[0]!;

    // 若 msToDate 的 UTC+8 偏移写错，这里会差一天
    expect(pzLast.date).toBe(emLast.date);
    expect(pzLast.unitNav).toBeCloseTo(emLast.unitNav, 4);
  });

  liveIt('新浪与东财的净值一致', async () => {
    const [sinaMap, emRows] = await Promise.all([
      fetchNavBatch([SAMPLE, SAMPLE_ACTIVE]),
      fetchNavHistory(SAMPLE, 1, 1),
    ]);
    const s = sinaMap.get(SAMPLE)!;
    expect(s).toBeDefined();
    expect(s.date).toBe(emRows[0]!.date);
    expect(s.unitNav).toBeCloseTo(emRows[0]!.unitNav, 4);
    expect(sinaMap.get(SAMPLE_ACTIVE)).toBeDefined();
  });

  liveIt('fetchLatestNav 批量返回并算出涨跌幅', async () => {
    const m = await fetchLatestNav([SAMPLE, SAMPLE_ACTIVE]);
    expect(m.size).toBe(2);
    const v = m.get(SAMPLE)!;
    expect(v.unitNav).toBeGreaterThan(0);
    expect(v.chgPct).not.toBeNull();
  });
});

describe('东财 批量实时行情', () => {
  liveIt('股票与 ETF 混合批量返回', async () => {
    const q = await fetchQuotes(['1.600519', '1.510300', '0.159915']);
    expect(q.size).toBe(3);
    const mt = q.get('1.600519')!;
    expect(mt.name).toContain('茅台');
    expect(mt.price).toBeGreaterThan(0);
    expect(typeof mt.chgPct).toBe('number');
  });
});

describe('东财 搜索建议', () => {
  liveIt('中文关键词返回基金代码', async () => {
    const r = await searchFunds('易方达');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.code).toMatch(/^\d{6}$/);
    expect(r[0]!.name.length).toBeGreaterThan(0);
  });
});

describe('东财 全量基金列表', () => {
  liveIt('解析出万级基金且包含样本基金', async () => {
    const list = await fetchFundList();
    expect(list.length).toBeGreaterThan(10_000);
    const sample = list.find((f) => f.code === SAMPLE);
    expect(sample).toBeDefined();
    expect(sample!.name).toContain('白酒');
    expect(sample!.pinyinShort.length).toBeGreaterThan(0);
    expect(sample!.type.length).toBeGreaterThan(0);
  });
});
