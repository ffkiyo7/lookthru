import {
  isBondOrMoneyFund,
  isExchangeTradedCode,
  isPassiveIndexFund,
  isQdii,
  toSecid,
  Valuation,
  type Valuation as ValuationValue,
} from '@lookthru/shared';
import { z } from 'zod';
import { getLatestOfficialNav, recordValuationSample } from '../data/navs';
import type { Env } from '../env';
import {
  fetchFundBenchmark,
  fetchHoldings,
  fetchPingzhongData,
  fetchQuotesResilient,
  searchFunds,
} from '../sources';
import { beijingDate } from '../trading-calendar';
import {
  ACTIVE_FALLBACK_BENCHMARK,
  estimateValuation,
  requiredQuoteSecids,
  type ValuationFundInput,
} from './engine';
import { listValuationFundCodes } from './universe';

const VALUATION_INPUT_TTL_SECONDS = 6 * 60 * 60;
const VALUATION_TTL_SECONDS = 60;

const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });

const ValuationFundInputSchema = z
  .object({
    fundCode: z.string().regex(/^\d{6}$/),
    fundName: z.string().min(1),
    fundType: z.string(),
    exchangeSecid: z
      .string()
      .regex(/^\d+\.[A-Z0-9]+$/)
      .nullable(),
    stockPosition: z.number().finite().min(0).max(150).nullable(),
    reportDate: CalendarDate.nullable(),
    holdings: z.array(
      z.object({
        secid: z
          .string()
          .regex(/^\d+\.[A-Z0-9]+$/)
          .nullable(),
        weight: z.number().finite().min(0).max(100),
      }),
    ),
    benchmark: z
      .object({
        secid: z.string().regex(/^[01]\.\d{6}$/),
        name: z.string().min(1),
        weight: z.number().finite().min(0).max(100).nullable(),
        source: z.enum(['FUND_BENCHMARK', 'FALLBACK']),
      })
      .nullable(),
  })
  .strict();

function inputCacheKey(code: string): string {
  return `valuation-input:${code}`;
}

function valuationCacheKey(code: string): string {
  return `est:${code}`;
}

async function cachedInput(env: Env, code: string): Promise<ValuationFundInput | null> {
  try {
    const raw = await env.CACHE.get<unknown>(inputCacheKey(code), 'json');
    if (raw === null) return null;
    const parsed = ValuationFundInputSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    console.warn(`[valuation] 输入缓存格式非法，重新预热 code=${code}`, parsed.error.message);
    return null;
  } catch (error) {
    console.warn(`[valuation] 输入缓存读取失败，重新预热 code=${code}`, error);
    return null;
  }
}

export async function refreshValuationInput(env: Env, code: string): Promise<ValuationFundInput> {
  const hit = (await searchFunds(code)).find((candidate) => candidate.code === code);
  if (!hit) throw new Error(`基金搜索未返回精确代码 ${code}`);

  const disabled = isQdii(hit.type, hit.name) || isBondOrMoneyFund(hit.type);
  const exchange = isExchangeTradedCode(code);
  let input: ValuationFundInput;

  if (disabled || exchange) {
    const exchangeSecid = exchange ? toSecid(code) : null;
    if (exchange && exchangeSecid === null) throw new Error(`场内基金无法转换 secid code=${code}`);
    input = {
      fundCode: code,
      fundName: hit.name,
      fundType: hit.type,
      exchangeSecid,
      stockPosition: null,
      reportDate: null,
      holdings: [],
      benchmark: null,
    };
  } else {
    const [profile, holdings] = await Promise.all([fetchPingzhongData(code), fetchHoldings(code)]);
    let matchedBenchmark = null;
    try {
      matchedBenchmark = await fetchFundBenchmark(code);
    } catch (error) {
      // 蛋卷只补“业绩基准”这一项；失败时主动基金可明确降到沪深300基准，
      // 被动基金则由引擎 fail closed 为 NONE，不能把来源故障伪装成 HIGH。
      console.warn(`[valuation] 业绩基准读取失败 code=${code}`, error);
    }
    const passive = isPassiveIndexFund(hit.type, hit.name);
    input = {
      fundCode: code,
      fundName: hit.name,
      fundType: hit.type,
      exchangeSecid: null,
      stockPosition: profile.latestStockPosition,
      reportDate: holdings.reportDate,
      holdings: holdings.holdings.map((holding) => ({
        secid: holding.secid,
        weight: holding.weight,
      })),
      benchmark: matchedBenchmark
        ? { ...matchedBenchmark, source: 'FUND_BENCHMARK' }
        : passive
          ? null
          : ACTIVE_FALLBACK_BENCHMARK,
    };
  }

  const parsed = ValuationFundInputSchema.parse(input);
  await env.CACHE.put(inputCacheKey(code), JSON.stringify(parsed), {
    expirationTtl: VALUATION_INPUT_TTL_SECONDS,
  });
  return parsed;
}

async function getValuationInput(env: Env, code: string): Promise<ValuationFundInput> {
  return (await cachedInput(env, code)) ?? refreshValuationInput(env, code);
}

export interface PrewarmResult {
  funds: number;
  updated: number;
  failures: { code: string; error: Error }[];
}

export async function prewarmValuationInputs(env: Env): Promise<PrewarmResult> {
  const codes = await listValuationFundCodes(env.DB);
  const failures: PrewarmResult['failures'] = [];
  let updated = 0;
  for (const code of codes) {
    try {
      await refreshValuationInput(env, code);
      updated++;
    } catch (error) {
      failures.push({ code, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return { funds: codes.length, updated, failures };
}

export function shouldRecordValuationSample(scheduledTime: number): boolean {
  const date = new Date(scheduledTime + 8 * 60 * 60 * 1000);
  return date.getUTCHours() === 14 && date.getUTCMinutes() === 55;
}

export interface ValuationCycleResult {
  funds: number;
  valued: number;
  sampled: number;
  provider: string | null;
  delayed: boolean;
  failures: { code: string; error: Error }[];
}

export async function runValuationCycle(
  env: Env,
  scheduledTime: number,
): Promise<ValuationCycleResult> {
  const codes = await listValuationFundCodes(env.DB);
  const inputs: ValuationFundInput[] = [];
  const failures: ValuationCycleResult['failures'] = [];
  for (const code of codes) {
    try {
      inputs.push(await getValuationInput(env, code));
    } catch (error) {
      failures.push({ code, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  const quoteSecids = [...new Set(inputs.flatMap(requiredQuoteSecids))];
  const quoteResult = await fetchQuotesResilient(quoteSecids);
  if (quoteSecids.length > 0 && quoteResult.quotes.size === 0) {
    throw new Error(
      `估值行情全链失败: ${quoteResult.attempts
        .map((attempt) => `${attempt.provider}=${attempt.error}`)
        .join(' | ')}`,
    );
  }

  const estTime = new Date().toISOString();
  const valuations: ValuationValue[] = [];
  for (const input of inputs) {
    try {
      const required = requiredQuoteSecids(input);
      if (required.length > 0 && required.every((secid) => !quoteResult.quotes.has(secid))) {
        throw new Error(`本基金所需行情全部缺失 secids=${required.join(',')}`);
      }
      const official = await getLatestOfficialNav(env, input.fundCode);
      const prevNav = official && official.valueKind === 'UNIT_NAV' ? official.unitNav : null;
      valuations.push(
        estimateValuation(input, prevNav, quoteResult.quotes, {
          estTime,
          delayed: quoteResult.delayed,
        }),
      );
    } catch (error) {
      failures.push({
        code: input.fundCode,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  for (const valuation of valuations) {
    await env.CACHE.put(valuationCacheKey(valuation.fundCode), JSON.stringify(valuation), {
      expirationTtl: VALUATION_TTL_SECONDS,
    });
  }

  let sampled = 0;
  if (shouldRecordValuationSample(scheduledTime)) {
    const tradeDate = beijingDate(scheduledTime);
    for (const valuation of valuations) {
      await recordValuationSample(env.DB, valuation, tradeDate, quoteResult.delayed);
      sampled++;
    }
  }

  return {
    funds: codes.length,
    valued: valuations.length,
    sampled,
    provider: quoteResult.provider,
    delayed: quoteResult.delayed,
    failures,
  };
}

export async function getCachedValuations(
  env: Env,
  codes: string[],
): Promise<Map<string, ValuationValue>> {
  const values = new Map<string, ValuationValue>();
  await Promise.all(
    codes.map(async (code) => {
      try {
        const raw = await env.CACHE.get<unknown>(valuationCacheKey(code), 'json');
        if (raw === null) return;
        const parsed = Valuation.safeParse(raw);
        if (parsed.success) values.set(code, parsed.data);
        else console.warn(`[valuation] 估值缓存格式非法 code=${code}`, parsed.error.message);
      } catch (error) {
        console.warn(`[valuation] 估值缓存读取失败 code=${code}`, error);
      }
    }),
  );
  return values;
}
