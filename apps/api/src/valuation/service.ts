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
import {
  getLatestOfficialNav,
  recordValuationSample,
  type ValuationSampleKind,
} from '../data/navs';
import type { Env } from '../env';
import { getFundMeta } from '../fund-meta';
import { getFreshHoldings } from '../fund-holdings';
import { cacheQuoteResult } from '../quote-cache';
import {
  fetchFundBenchmark,
  fetchPingzhongData,
  fetchQuotesResilient,
} from '../sources';
import { beijingDate } from '../trading-calendar';
import {
  ACTIVE_FALLBACK_BENCHMARK,
  estimateValuationWithDiagnostics,
  requiredQuoteSecids,
  type ValuationFundInput,
  type ValuationNoneCause,
} from './engine';
import { listValuationFundCodes } from './universe';

const VALUATION_INPUT_TTL_SECONDS = 6 * 60 * 60;
const VALUATION_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  const hit = await getFundMeta(env, code);
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
    const [profile, holdingsSnapshot] = await Promise.all([
      fetchPingzhongData(code),
      getFreshHoldings(env, code),
    ]);
    const holdings = holdingsSnapshot.data;
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
  return valuationSampleKind(scheduledTime) !== null;
}

export function valuationSampleKind(scheduledTime: number): ValuationSampleKind | null {
  const date = new Date(scheduledTime + 8 * 60 * 60 * 1000);
  if (date.getUTCHours() === 14 && date.getUTCMinutes() === 55) return 'CALIBRATION_1455';
  if (date.getUTCHours() === 15 && date.getUTCMinutes() === 5) return 'CLOSE_1505';
  return null;
}

export interface ValuationCycleResult {
  funds: number;
  valued: number;
  precisionCounts: Record<ValuationValue['precision'], number>;
  structuralNone: number;
  missingInputNone: number;
  missingInputs: { code: string; cause: Exclude<ValuationNoneCause, 'STRUCTURAL_POLICY'>; note: string }[];
  sampled: number;
  provider: string | null;
  delayed: boolean;
  quoteChainFailure: string | null;
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
  await cacheQuoteResult(env, quoteResult);
  const quoteChainFailure =
    quoteSecids.length > 0 && quoteResult.quotes.size === 0
      ? `估值行情全链失败: ${quoteResult.attempts
        .map((attempt) => `${attempt.provider}=${attempt.error}`)
        .join(' | ')}`
      : null;

  const estTime = new Date().toISOString();
  const valuations: ValuationValue[] = [];
  const missingInputs: ValuationCycleResult['missingInputs'] = [];
  const precisionCounts: ValuationCycleResult['precisionCounts'] = {
    EXACT: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    NONE: 0,
  };
  let structuralNone = 0;
  for (const input of inputs) {
    try {
      const official = await getLatestOfficialNav(env, input.fundCode);
      const prevNav = official && official.valueKind === 'UNIT_NAV' ? official.unitNav : null;
      const estimate = estimateValuationWithDiagnostics(input, prevNav, quoteResult.quotes, {
        estTime,
        delayed: quoteResult.delayed,
      });
      valuations.push(estimate.valuation);
      precisionCounts[estimate.valuation.precision]++;
      if (estimate.noneCause === 'STRUCTURAL_POLICY') {
        structuralNone++;
      } else if (estimate.noneCause !== null) {
        missingInputs.push({
          code: input.fundCode,
          cause: estimate.noneCause,
          note: estimate.valuation.basis.note,
        });
      }
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
  const sampleKind = valuationSampleKind(scheduledTime);
  if (sampleKind !== null) {
    const tradeDate = beijingDate(scheduledTime);
    for (const valuation of valuations) {
      await recordValuationSample(env.DB, valuation, tradeDate, sampleKind, quoteResult.delayed);
      sampled++;
    }
  }

  return {
    funds: codes.length,
    valued: valuations.length - precisionCounts.NONE,
    precisionCounts,
    structuralNone,
    missingInputNone: missingInputs.length,
    missingInputs,
    sampled,
    provider: quoteResult.provider,
    delayed: quoteResult.delayed,
    quoteChainFailure,
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
