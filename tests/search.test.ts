import { describe, expect, it } from 'vitest';
import { parseSearchResponse } from '../apps/api/src/sources/eastmoney';

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
