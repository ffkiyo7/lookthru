import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyScheduledTask,
  CRONS,
  logValuationIssueOncePerDay,
  runScheduledTask,
} from '../apps/api/src/cron';
import { isExchangeTradedCode, type Quote } from '../packages/shared/src';
import {
  estimateValuation,
  estimateValuationWithDiagnostics,
  requiredQuoteSecids,
  type ValuationFundInput,
} from '../apps/api/src/valuation/engine';
import {
  shouldRecordValuationSample,
  valuationSampleKind,
} from '../apps/api/src/valuation/service';
import { VALUATION_CALIBRATION_CODES } from '../apps/api/src/valuation/universe';
import { summarizeValuationErrors } from '../apps/api/src/valuation/report';
import {
  decryptWebhookUrl,
  encryptWebhookUrl,
  generateNotifyKey,
} from '../apps/api/src/notify/crypto';
import { buildDiscordDailyPayload, DiscordNotifier } from '../apps/api/src/notify/discord';
import type { DailyBrief, NotifyBinding } from '../apps/api/src/notify/types';

function utc(value: string): number {
  return Date.parse(value);
}

describe('Cron 分派', () => {
  it('wrangler.toml 与代码注册表保持完全同步', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const block = /\[triggers\]\s*crons\s*=\s*\[([\s\S]*?)\]/.exec(toml)?.[1] ?? '';
    const configured = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(configured.sort()).toEqual(Object.values(CRONS).sort());
    expect(toml).not.toContain('ENVIRONMENT');
  });

  it('保留独立的出口探针', () => {
    expect(classifyScheduledTask(CRONS.probe, utc('2026-08-11T01:25:00Z'))).toBe('PROBE');
  });

  it('官方净值从北京时间 19:30 开始，不注册 19:00', () => {
    expect(CRONS.officialNavHalfPast).toBe('30 11-14 * * 2-6');
    expect(CRONS.officialNavOnHour).toBe('0 12-14 * * 2-6');
    expect(classifyScheduledTask(CRONS.officialNavHalfPast, utc('2026-08-11T11:30:00Z'))).toBe(
      'OFFICIAL_NAV',
    );
    expect(classifyScheduledTask(CRONS.officialNavOnHour, utc('2026-08-11T12:00:00Z'))).toBe(
      'OFFICIAL_NAV',
    );
  });

  it('分钟级估值只在真实交易时段分派', () => {
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T01:29:00Z'))).toBe('IDLE');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T01:30:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T03:30:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T03:31:00Z'))).toBe('IDLE');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T05:00:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T07:00:00Z'))).toBe('VALUATION');
    expect(classifyScheduledTask(CRONS.valuation, utc('2026-08-11T07:01:00Z'))).toBe('IDLE');
  });

  it('未知表达式明确告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runScheduledTask(
      {
        cron: '0 0 * * *',
        scheduledTime: utc('2026-08-11T00:00:00Z'),
        type: 'scheduled',
        noRetry: () => undefined,
      },
      {} as never,
    );
    expect(warn).toHaveBeenCalledWith('[cron] 未识别的触发表达式：0 0 * * *');
    warn.mockRestore();
  });

  it('交易日历缺失时 fail closed，同一天只首次 warn', async () => {
    const values = new Map<string, string>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
      ARCHIVE: { get: async () => null },
      DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({ results: [] }) }),
        }),
      },
    } as never;
    try {
      for (let minute = 30; minute <= 31; minute++) {
        await runScheduledTask(
          {
            cron: CRONS.valuation,
            scheduledTime: utc(`2026-08-11T01:${minute}:00Z`),
            type: 'scheduled',
            noRetry: () => undefined,
          },
          env,
        );
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[cron] 交易日历不可用，跳过 VALUATION date=2026-08-11');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('[cron] 交易日历不可用，跳过 VALUATION date=2026-08-11');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('估值告警按日期、基金代码和错误类别分别去重', async () => {
    const values = new Map<string, string>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = {
      CACHE: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
    } as never;
    try {
      await logValuationIssueOncePerDay(env, '2026-08-12', '005827', 'PREVIOUS_NAV_MISSING', '缺净值');
      await logValuationIssueOncePerDay(env, '2026-08-12', '005827', 'PREVIOUS_NAV_MISSING', '缺净值');
      await logValuationIssueOncePerDay(env, '2026-08-12', '000001', 'PREVIOUS_NAV_MISSING', '缺净值');
      await logValuationIssueOncePerDay(env, '2026-08-12', '005827', 'BENCHMARK_MISSING', '缺基准');

      expect(warn).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledTimes(1);
      expect([...values.keys()]).toEqual([
        'alert:valuation:005827:PREVIOUS_NAV_MISSING:2026-08-12',
        'alert:valuation:000001:PREVIOUS_NAV_MISSING:2026-08-12',
        'alert:valuation:005827:BENCHMARK_MISSING:2026-08-12',
      ]);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

function quote(secid: string, chgPct: number, price = 1): Quote {
  return { secid, code: secid.split('.')[1]!, name: '', price, chgPct, prevClose: null };
}

const ACTIVE_INPUT: ValuationFundInput = {
  fundCode: '005827',
  fundName: '易方达蓝筹精选混合',
  fundType: '混合型-偏股',
  exchangeSecid: null,
  stockPosition: 80,
  reportDate: '2026-06-30',
  holdings: [
    { secid: '1.600001', weight: 30 },
    { secid: '0.000001', weight: 25 },
  ],
  benchmark: { secid: '1.000300', name: '沪深300指数', weight: null, source: 'FALLBACK' },
};

describe('盘中估值引擎', () => {
  const estTime = '2026-08-11T06:55:00.000Z';

  it('QDII 与债基即使代码像场内基金也必须 NONE', () => {
    const disabled = estimateValuation(
      {
        ...ACTIVE_INPUT,
        fundCode: '160416',
        fundName: '华安标普全球石油指数',
        fundType: 'QDII-指数',
        exchangeSecid: '0.160416',
      },
      1,
      new Map([['0.160416', quote('0.160416', 2, 1.02)]]),
      { estTime, delayed: false },
    );
    expect(disabled.precision).toBe('NONE');
    expect(disabled.estNav).toBeNull();
    expect(
      estimateValuationWithDiagnostics(
        {
          ...ACTIVE_INPUT,
          fundCode: '160416',
          fundName: '华安标普全球石油指数',
          fundType: 'QDII-指数',
          exchangeSecid: '0.160416',
        },
        1,
        new Map(),
        { estTime, delayed: false },
      ).noneCause,
    ).toBe('STRUCTURAL_POLICY');

    expect(
      estimateValuation(
        { ...ACTIVE_INPUT, fundType: '债券型-混合债', fundName: '测试债基' },
        1,
        new Map(),
        { estTime, delayed: false },
      ).precision,
    ).toBe('NONE');
  });

  it('场内 ETF/LOF 直接使用成交价，延时行情强制降级', () => {
    const input = {
      ...ACTIVE_INPUT,
      fundCode: '161725',
      fundName: '招商中证白酒指数',
      fundType: '指数型',
      exchangeSecid: '0.161725',
    };
    const quotes = new Map([['0.161725', quote('0.161725', 0.5, 0.5634)]]);
    expect(estimateValuation(input, 0.5606, quotes, { estTime, delayed: false })).toMatchObject({
      estNav: 0.5634,
      estChgPct: 0.5,
      precision: 'EXACT',
    });
    const delayed = estimateValuation(input, 0.5606, quotes, { estTime, delayed: true });
    expect(delayed.precision).toBe('LOW');
    expect(delayed.basis.note).toContain('延时数据');
  });

  it('被动指数按明确跟踪指数涨跌乘股票仓位，延时降一级', () => {
    const input: ValuationFundInput = {
      ...ACTIVE_INPUT,
      fundCode: '000961',
      fundName: '天弘沪深300ETF联接A',
      fundType: '指数型-股票',
      // ETF 联接只直接持有少量股票；这里必须用业绩基准的 95%，不能用 2.3%。
      stockPosition: 2.3,
      benchmark: {
        secid: '1.000300',
        name: '沪深300指数',
        weight: 95,
        source: 'FUND_BENCHMARK',
      },
    };
    const quotes = new Map([['1.000300', quote('1.000300', 2)]]);
    const realtime = estimateValuation(input, 1.2, quotes, { estTime, delayed: false });
    expect(realtime).toMatchObject({
      estNav: 1.2228,
      estChgPct: 1.9,
      precision: 'HIGH',
      basis: { reportDate: '2026-06-30', staleDays: 42, coverageWeight: 55 },
    });
    expect(realtime.basis.note).toContain('业绩基准权重 95%');
    expect(estimateValuation(input, 1.2, quotes, { estTime, delayed: true }).precision).toBe(
      'MEDIUM',
    );
  });

  it('跟踪指数不明确时 fail closed，不把通用候选猜成 HIGH', () => {
    const result = estimateValuation(
      {
        ...ACTIVE_INPUT,
        fundCode: '000961',
        fundName: '测试指数基金',
        fundType: '指数型-股票',
        benchmark: null,
      },
      1,
      new Map(),
      { estTime, delayed: false },
    );
    expect(result.precision).toBe('NONE');
    expect(result.basis.note).toContain('不猜测');
    expect(
      estimateValuationWithDiagnostics(
        {
          ...ACTIVE_INPUT,
          fundCode: '000961',
          fundName: '测试指数基金',
          fundType: '指数型-股票',
          benchmark: null,
        },
        1,
        new Map(),
        { estTime, delayed: false },
      ).noneCause,
    ).toBe('BENCHMARK_MISSING');
  });

  it('非联接被动基金的目标指数权重不足 90% 时 fail closed', () => {
    const input: ValuationFundInput = {
      ...ACTIVE_INPUT,
      fundCode: '050002',
      fundName: '测试沪深300指数A',
      fundType: '指数型-股票',
      stockPosition: 95,
      benchmark: {
        secid: '1.000300',
        name: '沪深300指数',
        weight: 50,
        source: 'FUND_BENCHMARK',
      },
    };
    const result = estimateValuation(
      input,
      1,
      new Map([['1.000300', quote('1.000300', 2)]]),
      { estTime, delayed: false },
    );
    expect(result.precision).toBe('NONE');
    expect(result.basis.note).toContain('不足 90%');
    expect(requiredQuoteSecids(input)).toEqual([]);
  });

  it('主动基金按重仓贡献加残余仓位基准计算，并填满 UI 所需 basis', () => {
    const quotes = new Map([
      ['1.600001', quote('1.600001', 2)],
      ['0.000001', quote('0.000001', -1)],
      ['1.000300', quote('1.000300', 1)],
    ]);
    expect(estimateValuation(ACTIVE_INPUT, 1, quotes, { estTime, delayed: false })).toMatchObject({
      estNav: 1.006,
      estChgPct: 0.6,
      precision: 'MEDIUM',
      basis: { reportDate: '2026-06-30', staleDays: 42, coverageWeight: 55 },
    });
  });

  it('覆盖不足、报价不全或延时行情不会留在 MEDIUM', () => {
    const result = estimateValuation(
      { ...ACTIVE_INPUT, holdings: [{ secid: '1.600001', weight: 40 }] },
      1,
      new Map([
        ['1.600001', quote('1.600001', 2)],
        ['1.000300', quote('1.000300', 1)],
      ]),
      { estTime, delayed: true },
    );
    expect(result.precision).toBe('LOW');
    expect(result.basis.coverageWeight).toBe(40);
    expect(result.basis.note).toContain('精度已下调');
  });

  it('只在交易日 14:55 记验收样本', () => {
    expect(shouldRecordValuationSample(utc('2026-08-11T06:55:00Z'))).toBe(true);
    expect(shouldRecordValuationSample(utc('2026-08-11T06:54:00Z'))).toBe(false);
    expect(shouldRecordValuationSample(utc('2026-08-11T07:05:00Z'))).toBe(true);
    expect(valuationSampleKind(utc('2026-08-11T06:55:00Z'))).toBe('CALIBRATION_1455');
    expect(valuationSampleKind(utc('2026-08-11T07:05:00Z'))).toBe('CLOSE_1505');
  });

  it('按基金类型只请求计算真正需要的行情', () => {
    expect(requiredQuoteSecids(ACTIVE_INPUT)).toEqual(['1.600001', '0.000001', '1.000300']);
    expect(
      requiredQuoteSecids({
        ...ACTIVE_INPUT,
        fundCode: '000961',
        fundName: '天弘沪深300ETF联接A',
        fundType: '指数型-股票',
        benchmark: {
          secid: '1.000300',
          name: '沪深300指数',
          weight: 95,
          source: 'FUND_BENCHMARK',
        },
      }),
    ).toEqual(['1.000300']);
    expect(
      requiredQuoteSecids({ ...ACTIVE_INPUT, fundType: 'QDII-指数', fundName: '全球基金' }),
    ).toEqual([]);
  });

  it('空仓期也保留固定的 10 只原样本并追加 1 只场外非联接被动样本', () => {
    expect(VALUATION_CALIBRATION_CODES).toHaveLength(11);
    expect(VALUATION_CALIBRATION_CODES.filter(isExchangeTradedCode)).toEqual(['510300', '159919']);
    expect(VALUATION_CALIBRATION_CODES.slice(2, 5)).toEqual(['000961', '001051', '005918']);
    expect(VALUATION_CALIBRATION_CODES[5]).toBe('050002');
    expect(VALUATION_CALIBRATION_CODES.slice(6)).toHaveLength(5);
  });
});

describe('估值误差报表', () => {
  it('EXACT 单列折溢价，HIGH/MEDIUM 按各自阈值统计超标样本', () => {
    const groups = summarizeValuationErrors([
      { precision: 'EXACT', est_nav: 1.01, official_nav: 1 },
      { precision: 'HIGH', est_nav: 1.001, official_nav: 1 },
      { precision: 'HIGH', est_nav: 1.002, official_nav: 1 },
      { precision: 'MEDIUM', est_nav: 1.005, official_nav: 1 },
      { precision: 'MEDIUM', est_nav: 1.007, official_nav: 1 },
    ]);
    expect(groups).toEqual([
      expect.objectContaining({
        precision: 'EXACT',
        metric: 'PREMIUM_DISCOUNT_PCT',
        samples: 1,
        overThreshold: null,
      }),
      expect.objectContaining({
        precision: 'HIGH',
        metric: 'ABS_NAV_ERROR_PCT',
        samples: 2,
        thresholdPct: 0.15,
        overThreshold: 1,
      }),
      expect.objectContaining({
        precision: 'MEDIUM',
        samples: 2,
        thresholdPct: 0.6,
        overThreshold: 1,
      }),
    ]);
  });
});

const DAILY_BRIEF: DailyBrief = {
  date: '2026-08-12',
  marketValue: 10_000,
  dayReturn: 12.34,
  holdingReturn: 456.78,
  unavailableValueCount: 0,
  positions: [
    {
      fundCode: '000001',
      fundName: '华夏成长混合',
      marketValue: 10_000,
      dayReturn: 12.34,
      navUpdated: false,
    },
  ],
};

const DISCORD_BINDING: NotifyBinding = {
  id: 'binding-1',
  userId: 'user-1',
  kind: 'DAILY',
  provider: 'DISCORD',
  webhookUrl: 'https://discord.com/api/webhooks/1234567890/test_token',
};

describe('Discord Notifier', () => {
  it('AES-GCM 加解密往返，并把用户与用途绑定进认证数据', async () => {
    const key = generateNotifyKey();
    const context = { userId: 'user-1', kind: 'DAILY' as const, provider: 'DISCORD' as const };
    const encrypted = await encryptWebhookUrl(key, DISCORD_BINDING.webhookUrl, context);
    expect(encrypted.ciphertext).not.toContain('discord.com');
    await expect(decryptWebhookUrl(key, encrypted, context)).resolves.toBe(
      DISCORD_BINDING.webhookUrl,
    );
    await expect(
      decryptWebhookUrl(key, encrypted, { ...context, kind: 'ALERT' }),
    ).rejects.toThrow('用户或用途不匹配');
    await expect(encryptWebhookUrl(undefined, DISCORD_BINDING.webhookUrl, context)).rejects.toThrow(
      'NOTIFY_KEY 未配置',
    );
  });

  it('持仓过多时显式写出未显示数量，并遵守 Discord embed 限制', () => {
    const payload = buildDiscordDailyPayload({
      ...DAILY_BRIEF,
      positions: Array.from({ length: 100 }, (_, index) => ({
        ...DAILY_BRIEF.positions[0]!,
        fundCode: String(index).padStart(6, '0'),
        fundName: `很长的基金名称${index}`.repeat(8),
      })),
    });
    const embed = payload.embeds[0]!;
    expect(embed.description).toMatch(/另有 \d+ 只未显示/);
    expect(embed.description.length).toBeLessThanOrEqual(4_096);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    expect(embed.footer.text).toContain('100 只基金净值尚未更新');
  });

  it('从未取得官方净值时仍发送，并明确标出未计入汇总', () => {
    const payload = buildDiscordDailyPayload({
      ...DAILY_BRIEF,
      unavailableValueCount: 1,
      positions: [{ ...DAILY_BRIEF.positions[0]!, marketValue: null, dayReturn: null }],
    });
    const embed = payload.embeds[0]!;
    expect(embed.fields[0]?.name).toBe('总资产（1只未计）');
    expect(embed.description).toContain('市值待更新');
    expect(embed.footer.text).toContain('1 只基金净值尚未更新');
  });

  it('204 判成功，404 判失败且不把 webhook URL 写进错误', async () => {
    const success = new DiscordNotifier(async () => new Response(null, { status: 204 }));
    await expect(success.send(DISCORD_BINDING, DAILY_BRIEF)).resolves.toEqual({
      ok: true,
      status: 204,
      retried: false,
      error: null,
    });

    const failed = new DiscordNotifier(async () => new Response(null, { status: 404 }));
    const result = await failed.send(DISCORD_BINDING, DAILY_BRIEF);
    expect(result).toEqual({
      ok: false,
      status: 404,
      retried: false,
      error: 'Discord webhook 返回 HTTP 404',
    });
    expect(JSON.stringify(result)).not.toContain('test_token');
  });

  it('429 读取 retry_after 后只重试一次', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const notifier = new DiscordNotifier(
      async () => {
        calls++;
        return calls === 1
          ? Response.json({ retry_after: 0.25, global: false }, { status: 429 })
          : new Response(null, { status: 204 });
      },
      async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    );
    await expect(notifier.send(DISCORD_BINDING, DAILY_BRIEF)).resolves.toEqual({
      ok: true,
      status: 204,
      retried: true,
      error: null,
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([250]);
  });
});
