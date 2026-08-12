import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  beijingDate,
  parseTradingCalendar,
  tradingCalendarInfo,
} from '../apps/api/src/trading-calendar';

describe('交易日历', () => {
  it('按北京时间判定业务日期', () => {
    expect(beijingDate(Date.parse('2026-08-10T16:30:00Z'))).toBe('2026-08-11');
  });

  it('校验、去重并排序交易日', () => {
    expect(
      parseTradingCalendar({
        generatedAt: '2026-08-01T00:00:00Z',
        tradingDays: ['2026-08-12', '2026-08-11', '2026-08-11'],
      }),
    ).toEqual({
      generatedAt: '2026-08-01T00:00:00Z',
      tradingDays: ['2026-08-11', '2026-08-12'],
    });
  });

  it('非法或缺失日历不降级成工作日猜测', () => {
    expect(parseTradingCalendar({ generatedAt: 'x', tradingDays: ['not-a-date'] })).toBeNull();
    expect(parseTradingCalendar(null)).toBeNull();
  });

  it('pipeline 从上交所年度休市正文生成 Worker 可接受的全年日历', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lookthru-calendar-'));
    const noticePath = join(tempDir, 'notice.html');
    const outputPath = join(tempDir, 'calendar', 'trading_days.json');
    writeFileSync(
      noticePath,
      `<html><body>
        <h1>关于上海证券交易所2026年部分节假日休市安排的通知</h1>
        <p>一、休市安排</p>
        <p>元旦：1月1日至1月3日休市，1月5日起照常开市。</p>
        <p>春节：2月15日至2月23日休市，2月24日起照常开市。</p>
        <p>清明节：4月4日至4月6日休市，4月7日起照常开市。</p>
        <p>劳动节：5月1日至5月5日休市，5月6日起照常开市。</p>
        <p>端午节：6月19日至6月21日休市，6月22日起照常开市。</p>
        <p>中秋节：9月25日至9月27日休市，9月28日起照常开市。</p>
        <p>国庆节：10月1日至10月7日休市，10月8日起照常开市。</p>
        <p>二、有关清算事宜另行安排。</p>
      </body></html>`,
      'utf8',
    );

    try {
      const result = spawnSync(
        'python3',
        [
          new URL('../pipelines/trading_calendar.py', import.meta.url).pathname,
          '--year',
          '2026',
          '--notice-file',
          `2026=${noticePath}`,
          '--output',
          outputPath,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const calendar = parseTradingCalendar(JSON.parse(readFileSync(outputPath, 'utf8')));
      expect(calendar).not.toBeNull();
      expect(calendar?.tradingDays).toContain('2026-01-05');
      expect(calendar?.tradingDays).not.toContain('2026-01-01');
      expect(calendar?.tradingDays).not.toContain('2026-01-02');
      expect(calendar?.tradingDays).not.toContain('2026-02-16');

      const missingNextYear = spawnSync(
        'python3',
        [
          new URL('../pipelines/trading_calendar.py', import.meta.url).pathname,
          '--year',
          '2026',
          '--require-next-year',
          '--notice-file',
          `2026=${noticePath}`,
          '--output',
          join(tempDir, 'calendar', 'must-not-replace.json'),
        ],
        { encoding: 'utf8' },
      );
      expect(missingNextYear.status).toBe(1);
      expect(missingNextYear.stderr).toContain('输入公告不含下一年 2027');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('暴露可观测的日历摘要', async () => {
    const values = new Map<string, string>();
    const info = await tradingCalendarInfo(
      {
        CACHE: {
          get: async (key: string) => {
            const value = values.get(key);
            return value === undefined ? null : JSON.parse(value);
          },
          put: async (key: string, value: string) => {
            values.set(key, value);
          },
        },
        ARCHIVE: {
          get: async () => ({
            json: async () => ({
              generatedAt: '2026-08-11T00:00:00Z',
              tradingDays: ['2026-08-11', '2026-08-12'],
            }),
          }),
        },
      } as never,
      Date.parse('2026-08-12T00:00:00Z'),
    );

    expect(info).toEqual({
      available: true,
      generatedAt: '2026-08-11T00:00:00Z',
      days: 2,
      coversUntil: '2026-08-12',
    });
  });

  it('R2 抖动按不可用负缓存，不把异常抛给 Cron', async () => {
    const values = new Map<string, string>();
    let r2Reads = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      CACHE: {
        get: async (key: string) => {
          const value = values.get(key);
          return value === undefined ? null : JSON.parse(value);
        },
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
      ARCHIVE: {
        get: async () => {
          r2Reads++;
          throw new Error('temporary R2 failure');
        },
      },
    } as never;

    await expect(tradingCalendarInfo(env, Date.parse('2026-08-12T00:00:00Z'))).resolves.toEqual({
      available: false,
      generatedAt: null,
      days: 0,
      coversUntil: null,
    });
    await expect(tradingCalendarInfo(env, Date.parse('2026-08-12T00:00:00Z'))).resolves.toEqual({
      available: false,
      generatedAt: null,
      days: 0,
      coversUntil: null,
    });
    expect(r2Reads).toBe(1);
    warn.mockRestore();
  });
});

describe('R2 数据归档 pipelines', () => {
  it('全量基金列表通过全量校验后才写文件', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lookthru-funds-'));
    const sourcePath = join(tempDir, 'fundcode_search.js');
    const outputPath = join(tempDir, 'meta', 'fundlist.json');
    const rows = Array.from({ length: 10_000 }, (_, index) => {
      const code = String(index).padStart(6, '0');
      return [code, `PY${index}`, `基金${index}`, '混合型', `PINYIN${index}`];
    });
    try {
      writeFileSync(sourcePath, `var r = ${JSON.stringify(rows)};`, 'utf8');
      const valid = spawnSync(
        'python3',
        [
          new URL('../pipelines/fund_list.py', import.meta.url).pathname,
          '--source-file',
          sourcePath,
          '--output',
          outputPath,
        ],
        { encoding: 'utf8' },
      );
      expect(valid.status, valid.stderr).toBe(0);
      expect(JSON.parse(readFileSync(outputPath, 'utf8')).funds).toHaveLength(10_000);

      const invalidOutput = join(tempDir, 'invalid', 'fundlist.json');
      writeFileSync(sourcePath, 'var r = [["000001","HX","华夏成长","混合型","HXCZ"]];', 'utf8');
      const invalid = spawnSync(
        'python3',
        [
          new URL('../pipelines/fund_list.py', import.meta.url).pathname,
          '--source-file',
          sourcePath,
          '--output',
          invalidOutput,
        ],
        { encoding: 'utf8' },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('低于下限');
      expect(existsSync(invalidOutput)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('净值历史缺页时整批失败且不产出压缩文件', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lookthru-nav-'));
    const sourcePath = join(tempDir, 'nav.json');
    const outputDir = join(tempDir, 'out');
    const row = { FSRQ: '2026-08-12', DWJZ: '1.2345', LJJZ: '2.3456', JZZZL: '0.12' };
    try {
      writeFileSync(sourcePath, JSON.stringify({ Data: { LSJZList: [row] }, TotalCount: 1 }), 'utf8');
      const valid = spawnSync(
        'python3',
        [
          new URL('../pipelines/nav_history.py', import.meta.url).pathname,
          '--codes',
          '000001',
          '--source-file',
          `000001=${sourcePath}`,
          '--output-dir',
          outputDir,
        ],
        { encoding: 'utf8' },
      );
      expect(valid.status, valid.stderr).toBe(0);
      const archivePath = join(outputDir, 'nav', '000001.json.gz');
      expect(JSON.parse(gunzipSync(readFileSync(archivePath)).toString('utf8'))).toMatchObject({
        fundCode: '000001',
        navHistory: [{ date: '2026-08-12', unitNav: 1.2345 }],
      });

      const invalidDir = join(tempDir, 'invalid');
      writeFileSync(sourcePath, JSON.stringify({ Data: { LSJZList: [row] }, TotalCount: 2 }), 'utf8');
      const invalid = spawnSync(
        'python3',
        [
          new URL('../pipelines/nav_history.py', import.meta.url).pathname,
          '--codes',
          '000001',
          '--source-file',
          `000001=${sourcePath}`,
          '--output-dir',
          invalidDir,
        ],
        { encoding: 'utf8' },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('与 TotalCount 2 不符');
      expect(existsSync(join(invalidDir, 'nav', '000001.json.gz'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('持仓明细为空时整批失败且不产出文件', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lookthru-holdings-'));
    const sourcePath = join(tempDir, 'holdings.json');
    const outputDir = join(tempDir, 'out');
    const stock = {
      GPDM: '600519',
      GPJC: '贵州茅台',
      JZBL: '12.34',
      NEWTEXCH: '1',
      INDEXCODE: 'BK0477',
      INDEXNAME: '食品饮料',
    };
    try {
      writeFileSync(
        sourcePath,
        JSON.stringify({ Datas: { fundStocks: [stock] }, Expansion: '2026-06-30' }),
        'utf8',
      );
      const valid = spawnSync(
        'python3',
        [
          new URL('../pipelines/fund_holdings.py', import.meta.url).pathname,
          '--codes',
          '000001',
          '--source-file',
          `000001=${sourcePath}`,
          '--output-dir',
          outputDir,
        ],
        { encoding: 'utf8' },
      );
      expect(valid.status, valid.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(outputDir, 'holdings', '000001', '2026-06-30.json'), 'utf8')),
      ).toMatchObject({ fundCode: '000001', coverageWeight: 12.34 });
      expect(
        JSON.parse(readFileSync(join(outputDir, 'holdings', '000001', 'latest.json'), 'utf8')),
      ).toMatchObject({ fundCode: '000001', reportDate: '2026-06-30' });

      const invalidDir = join(tempDir, 'invalid');
      writeFileSync(
        sourcePath,
        JSON.stringify({ Datas: { fundStocks: [] }, Expansion: '2026-06-30' }),
        'utf8',
      );
      const invalid = spawnSync(
        'python3',
        [
          new URL('../pipelines/fund_holdings.py', import.meta.url).pathname,
          '--codes',
          '000001',
          '--source-file',
          `000001=${sourcePath}`,
          '--output-dir',
          invalidDir,
        ],
        { encoding: 'utf8' },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('没有股票明细');
      expect(existsSync(join(invalidDir, 'holdings', '000001', 'latest.json'))).toBe(false);
      expect(existsSync(join(invalidDir, 'holdings', '000001', '2026-06-30.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
