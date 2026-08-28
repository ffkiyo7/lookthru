import { describe, expect, it } from 'vitest';
import { parseSearchResponse } from '../apps/api/src/sources/eastmoney';
import { parseFundBenchmark } from '../apps/api/src/sources/danjuan';

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
