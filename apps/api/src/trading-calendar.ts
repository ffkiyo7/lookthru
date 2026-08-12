import { cachedJson } from './cache';
import type { Env } from './env';

export const TRADING_CALENDAR_KEY = 'calendar/trading_days.json';
const CALENDAR_CACHE_KEY = 'calendar:trading-days:v1';
const CALENDAR_CACHE_TTL_SECONDS = 5 * 60;

export interface TradingCalendar {
  generatedAt: string;
  tradingDays: string[];
}

export interface TradingDayStatus {
  date: string;
  available: boolean;
  isTradingDay: boolean;
  coversUntil: string | null;
  remainingTradingDays: number;
}

export interface TradingCalendarInfo {
  available: boolean;
  generatedAt: string | null;
  days: number;
  coversUntil: string | null;
}

export function parseTradingCalendar(value: unknown): TradingCalendar | null {
  if (typeof value !== 'object' || value === null) return null;
  const generatedAt = 'generatedAt' in value ? value.generatedAt : undefined;
  const tradingDays = 'tradingDays' in value ? value.tradingDays : undefined;
  if (typeof generatedAt !== 'string' || !Array.isArray(tradingDays)) return null;
  if (!tradingDays.every((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))) {
    return null;
  }
  return { generatedAt, tradingDays: [...new Set(tradingDays)].sort() };
}

export function beijingDate(scheduledTime: number): string {
  return new Date(scheduledTime + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function getTradingCalendar(env: Env): Promise<TradingCalendar | null> {
  try {
    return await cachedJson<TradingCalendar | null>(
      env.CACHE,
      CALENDAR_CACHE_KEY,
      CALENDAR_CACHE_TTL_SECONDS,
      async () => {
        try {
          const object = await env.ARCHIVE.get(TRADING_CALENDAR_KEY);
          if (!object) return null;
          return parseTradingCalendar(await object.json<unknown>());
        } catch (error) {
          // 转成 null 交给 cachedJson 写负缓存，避免 R2 抖动时每个分钟任务都重打一次。
          console.warn(`[calendar] R2 日历读取或解析失败 key=${TRADING_CALENDAR_KEY}`, error);
          return null;
        }
      },
    );
  } catch (error) {
    // 健康检查和 Cron 都需要把“日历不可用”作为状态返回，不能让 R2 故障变成无信息的 500。
    console.warn(`[calendar] 日历读取失败 key=${TRADING_CALENDAR_KEY}`, error);
    return null;
  }
}

export async function tradingCalendarInfo(
  env: Env,
  now = Date.now(),
): Promise<TradingCalendarInfo> {
  const calendar = await getTradingCalendar(env);
  const coversUntil = calendar?.tradingDays.at(-1) ?? null;
  return {
    available: calendar !== null && coversUntil !== null && coversUntil >= beijingDate(now),
    generatedAt: calendar?.generatedAt ?? null,
    days: calendar?.tradingDays.length ?? 0,
    coversUntil,
  };
}

export async function tradingDayStatus(
  env: Env,
  scheduledTime: number,
): Promise<TradingDayStatus> {
  const date = beijingDate(scheduledTime);
  const calendar = await getTradingCalendar(env);
  const coversUntil = calendar?.tradingDays.at(-1) ?? null;
  const coversDate = coversUntil !== null && coversUntil >= date;
  return {
    date,
    available: calendar !== null && coversDate,
    isTradingDay: coversDate && (calendar?.tradingDays.includes(date) ?? false),
    coversUntil,
    remainingTradingDays: coversDate
      ? calendar!.tradingDays.filter((tradingDay) => tradingDay >= date).length
      : 0,
  };
}
