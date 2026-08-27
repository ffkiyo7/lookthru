import { describe, expect, it } from 'vitest';
import { parseSearchResponse } from '../apps/api/src/sources/eastmoney';
import { parseFundBenchmark } from '../apps/api/src/sources/danjuan';
import {
  searchFundsForQuery,
  searchLocalFunds,
  shouldUseEastMoneyFallback,
} from '../apps/api/src/fund-search';
import type { FundListIndex, SearchableFund } from '../apps/api/src/fund-list';
import { fundMatchesTypeFilter } from '../packages/shared/src';
import type { FundSearchHit } from '../apps/api/src/sources/eastmoney';


describe('基金搜索解析', () => {
  it('排除同为六位代码但没有 FundBaseInfo 的股票', () => {
    const rows = parseSearchResponse({
      Datas: [
        { CODE: '600519', NAME: '贵州茅台', FundBaseInfo: null },
        {
          CODE: '000001',
          NAME: '华夏成长混合',
          JP: 'HXCC',
          FundBaseInfo: { FTYPE: '混合型-偏股', DWJZ: 1.2345, FSRQ: '2026-08-11' },
        },
      ],
    });

    expect(rows.map((row) => row.code)).toEqual(['000001']);
  });

  it('标记货币基金，防止把 DWJZ 当单位净值', () => {
    const [row] = parseSearchResponse({
      Datas: [
        {
          CODE: '000009',
          NAME: '货币基金',
          FundBaseInfo: { FTYPE: '货币型-普通货币', DWJZ: 0.4567, FSRQ: '2026-08-11' },
        },
      ],
    });

    expect(row).toMatchObject({ code: '000009', nav: 0.4567, isMoneyFund: true });
  });
});

describe('基金业绩基准解析', () => {
  it('只接受业绩基准正文里唯一出现的境内指数', () => {
    expect(
      parseFundBenchmark({
        result_code: 0,
        data: {
          performance_bench_mark: '中证白酒指数收益率×95%＋活期存款利率×5%',
          benchmark_index: [
            { symbol: 'SZ399997', symbol_name: '中证白酒' },
            { symbol: 'SH000300', symbol_name: '沪深300指数' },
          ],
        },
      }),
    ).toEqual({ secid: '0.399997', name: '中证白酒', weight: 95 });
  });

  it('多个指数同时出现时拒绝猜一个跟踪指数', () => {
    expect(
      parseFundBenchmark({
        result_code: 0,
        data: {
          performance_bench_mark: '沪深300指数收益率×50%＋中证500指数收益率×50%',
          benchmark_index: [
            { symbol: 'SH000300', symbol_name: '沪深300指数' },
            { symbol: 'SH000905', symbol_name: '中证500指数' },
          ],
        },
      }),
    ).toBeNull();
  });

  it('兼容权重写在指数名称前面的业绩基准', () => {
    expect(
      parseFundBenchmark({
        result_code: 0,
        data: {
          performance_bench_mark: '95%*沪深300指数+5%*银行同业存款利率',
          benchmark_index: [{ symbol: 'SH000300', symbol_name: '沪深300指数' }],
        },
      }),
    ).toEqual({ secid: '1.000300', name: '沪深300指数', weight: 95 });
  });
});

function sampleFund(opts: {
  code: string;
  name: string;
  type: string;
  pinyinShort?: string;
  pinyinFull?: string;
}): SearchableFund {
  const pinyinShort = opts.pinyinShort ?? '';
  const pinyinFull = opts.pinyinFull ?? '';
  return {
    code: opts.code,
    name: opts.name,
    type: opts.type,
    pinyinShort,
    pinyinShortLower: pinyinShort.toLowerCase(),
    pinyinFullLower: pinyinFull.toLowerCase(),
    isMoneyFund: /货币/.test(opts.type),
  };
}

function sampleIndex(funds: SearchableFund[]): FundListIndex {
  return {
    generatedAt: '2026-08-27T00:00:00.000Z',
    etag: '"etag"',
    funds,
    byCode: new Map(funds.map((fund) => [fund.code, fund])),
  };
}

const hybrid = sampleFund({
  code: '000001',
  name: '华夏成长混合',
  type: '混合型-偏股',
  pinyinShort: 'HXCC',
  pinyinFull: 'huaxiachengzhanghunhe',
});
const bond = sampleFund({
  code: '000191',
  name: '中银美元债债券',
  type: '债券型-混合债',
  pinyinShort: 'ZYMYZ',
  pinyinFull: 'zhongyinmeiyuanzhaiquan',
});
const stock = sampleFund({
  code: '110022',
  name: '易方达消费行业股票',
  type: '股票型',
  pinyinShort: 'YFDFXHY',
  pinyinFull: 'yifangdaxiaofeihangyegupiao',
});
const indexFund = sampleFund({
  code: '510300',
  name: '沪深300ETF',
  type: '股票型-指数',
  pinyinShort: 'HS300ETF',
  pinyinFull: 'hushen300etf',
});
const money = sampleFund({
  code: '000009',
  name: '易方达天天理财货币',
  type: '货币型-普通货币',
  pinyinShort: 'YFDTTLCHB',
  pinyinFull: 'yifangdatiantianlicaihuobi',
});
const qdii = sampleFund({
  code: '000041',
  name: '华夏全球精选股票',
  type: 'QDII-股票型',
  pinyinShort: 'HXQQJXGP',
  pinyinFull: 'huaxiaquanqiujingxuangu',
});
const bondIndex = sampleFund({
  code: '511010',
  name: '国债ETF',
  type: '债券型-指数',
  pinyinShort: 'GZETF',
  pinyinFull: 'guozhaietf',
});

const FUNDS = [hybrid, bond, stock, indexFund, money, qdii, bondIndex];

function hit(fund: SearchableFund): Pick<FundSearchHit, 'code' | 'name' | 'type'> {
  return { code: fund.code, name: fund.name, type: fund.type };
}

describe('fundMatchesTypeFilter', () => {
  it('全部不过滤', () => {
    expect(FUNDS.every((fund) => fundMatchesTypeFilter(fund.type, 'all'))).toBe(true);
  });

  it('股票不含股票指数或 ETF', () => {
    expect(fundMatchesTypeFilter(stock.type, 'stock')).toBe(true);
    expect(fundMatchesTypeFilter(indexFund.type, 'stock')).toBe(false);
    expect(fundMatchesTypeFilter('股票型-ETF', 'stock')).toBe(false);
    expect(fundMatchesTypeFilter(hybrid.type, 'stock')).toBe(false);
  });

  it('债券不含债券指数', () => {
    expect(fundMatchesTypeFilter(bond.type, 'bond')).toBe(true);
    expect(fundMatchesTypeFilter(bondIndex.type, 'bond')).toBe(false);
    expect(fundMatchesTypeFilter(bondIndex.type, 'index')).toBe(true);
  });

  it('指数覆盖 ETF 与带指数的类型', () => {
    expect(fundMatchesTypeFilter(indexFund.type, 'index')).toBe(true);
    expect(fundMatchesTypeFilter('ETF-场内', 'index')).toBe(true);
    expect(fundMatchesTypeFilter(stock.type, 'index')).toBe(false);
  });

  it('混合 / 货币 / QDII 按类型关键字匹配', () => {
    expect(fundMatchesTypeFilter(hybrid.type, 'hybrid')).toBe(true);
    expect(fundMatchesTypeFilter(money.type, 'money')).toBe(true);
    expect(fundMatchesTypeFilter('理财型', 'money')).toBe(true);
    expect(fundMatchesTypeFilter(qdii.type, 'qdii')).toBe(true);
    expect(fundMatchesTypeFilter(stock.type, 'qdii')).toBe(false);
  });
});

describe('searchLocalFunds 类型筛选', () => {
  it('代码命中不受类型筛选影响', () => {
    const rows = searchLocalFunds(FUNDS, '000001', 'bond');
    expect(rows.map(hit)).toEqual([hit(hybrid)]);
  });

  it('拼音命中不受类型筛选影响', () => {
    const shortHits = searchLocalFunds(FUNDS, 'HXCC', 'bond');
    expect(shortHits.map(hit)).toEqual([hit(hybrid)]);
    const fullHits = searchLocalFunds(FUNDS, 'huaxiachengzhang', 'stock');
    expect(fullHits.map(hit)).toEqual([hit(hybrid)]);
  });

  it('名称命中按类型筛选', () => {
    const allNameHits = searchLocalFunds(FUNDS, '华夏', 'all');
    expect(allNameHits.map((row) => row.code).sort()).toEqual(['000001', '000041']);
    const bondNameHits = searchLocalFunds(FUNDS, '华夏', 'bond');
    expect(bondNameHits).toEqual([]);
    const hybridNameHits = searchLocalFunds(FUNDS, '华夏', 'hybrid');
    expect(hybridNameHits.map(hit)).toEqual([hit(hybrid)]);
  });

  it('名称命中股票时不把股票指数吞进去', () => {
    const rows = searchLocalFunds([stock, indexFund], '易方达', 'stock');
    expect(rows.map(hit)).toEqual([hit(stock)]);
    const etfRows = searchLocalFunds([stock, indexFund], '沪深300', 'index');
    expect(etfRows.map(hit)).toEqual([hit(indexFund)]);
  });
});

describe('shouldUseEastMoneyFallback', () => {
  const index = sampleIndex(FUNDS);

  it('仅当完整 6 位代码不在本地列表时才回源', () => {
    expect(shouldUseEastMoneyFallback('999999', index)).toBe(true);
    expect(shouldUseEastMoneyFallback('000001', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('999999', null)).toBe(true);
  });

  it('名称、拼音、短数字绝不打东财', () => {
    expect(shouldUseEastMoneyFallback('华夏', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('HXCC', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('huaxia', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('00000', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('0000011', index)).toBe(false);
    expect(shouldUseEastMoneyFallback('白酒', null)).toBe(false);
  });
});

describe('searchFundsForQuery', () => {
  const index = sampleIndex(FUNDS);

  it('本地有结果时不打东财', async () => {
    let called = 0;
    const rows = await searchFundsForQuery('华夏', 'all', index, async () => {
      called += 1;
      return [];
    });
    expect(called).toBe(0);
    expect(rows.map((row) => row.code).sort()).toEqual(['000001', '000041']);
  });

  it('缺席的精确 6 位代码才回源，且只保留该代码', async () => {
    const rows = await searchFundsForQuery('888888', 'all', index, async (keyword) => {
      expect(keyword).toBe('888888');
      return [
        {
          code: '888888',
          name: '新发基金',
          pinyin: 'XJ',
          type: '混合型',
          nav: 1,
          navDate: '2026-08-27',
          company: null,
          isMoneyFund: false,
        },
        {
          code: '000001',
          name: '不应带回',
          pinyin: 'X',
          type: '混合型',
          nav: 1,
          navDate: '2026-08-27',
          company: null,
          isMoneyFund: false,
        },
      ];
    });
    expect(rows.map((row) => row.code)).toEqual(['888888']);
  });

  it('名称或拼音搜空不回源', async () => {
    let called = 0;
    const nameRows = await searchFundsForQuery('不存在的基金名', 'all', index, async () => {
      called += 1;
      return [];
    });
    const pinyinRows = await searchFundsForQuery('zzzzzz', 'all', index, async () => {
      called += 1;
      return [];
    });
    expect(called).toBe(0);
    expect(nameRows).toEqual([]);
    expect(pinyinRows).toEqual([]);
  });
});
