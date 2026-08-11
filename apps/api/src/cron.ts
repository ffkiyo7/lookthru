import type { Env } from './env';
import { syncOfficialNavs } from './nav/sync';
import { runProbe } from './probe';
import { tradingDayStatus } from './trading-calendar';

export const CRONS = {
  probe: '*/5 * * * *',
  // Cloudflare 与常见 crontab 不同：1=周日、2=周一、…、7=周六。
  prewarm: '25 1 * * 2-6',
  valuation: '* 1-3,5-7 * * 2-6',
  closeSnapshot: '5 7 * * 2-6',
  officialNavHalfPast: '30 11-14 * * 2-6',
  officialNavOnHour: '0 12-14 * * 2-6',
  dailyBrief: '0 13 * * 2-6',
} as const;

export type ScheduledTask =
  | 'PROBE'
  | 'PREWARM'
  | 'VALUATION'
  | 'CLOSE_SNAPSHOT'
  | 'OFFICIAL_NAV'
  | 'DAILY_BRIEF'
  | 'IDLE'
  | 'UNKNOWN';

const CALENDAR_WARNING_TTL_SECONDS = 3 * 24 * 60 * 60;

function beijingParts(scheduledTime: number): { hour: number; minute: number } {
  const date = new Date(scheduledTime + 8 * 60 * 60 * 1000);
  return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
}

export function classifyScheduledTask(cron: string, scheduledTime: number): ScheduledTask {
  if (cron === CRONS.probe) return 'PROBE';
  if (cron === CRONS.prewarm) return 'PREWARM';
  if (cron === CRONS.closeSnapshot) return 'CLOSE_SNAPSHOT';
  if (cron === CRONS.officialNavHalfPast || cron === CRONS.officialNavOnHour) return 'OFFICIAL_NAV';
  if (cron === CRONS.dailyBrief) return 'DAILY_BRIEF';
  if (cron !== CRONS.valuation) return 'UNKNOWN';

  // cron 只能粗略框住小时；这里收紧到真实 A 股连续交易时段，避免 09:00、11:59、15:59 空跑。
  const { hour, minute } = beijingParts(scheduledTime);
  const morning = (hour === 9 && minute >= 30) || hour === 10 || (hour === 11 && minute <= 30);
  const afternoon = hour === 13 || hour === 14 || (hour === 15 && minute === 0);
  return morning || afternoon ? 'VALUATION' : 'IDLE';
}

async function logUnavailableCalendarOncePerDay(
  env: Env,
  task: ScheduledTask,
  date: string,
): Promise<void> {
  const message = `[cron] 交易日历不可用，跳过 ${task} date=${date}`;
  const key = `alert:trading-calendar-unavailable:${date}`;
  try {
    if ((await env.CACHE.get(key)) !== null) {
      console.log(message);
      return;
    }
    await env.CACHE.put(key, '1', { expirationTtl: CALENDAR_WARNING_TTL_SECONDS });
    console.warn(message);
  } catch (error) {
    // 告警去重失败时保留原始原因，并继续 warn；不能为了降噪把真正的 KV 故障藏掉。
    console.error(`[cron] 交易日历告警去重失败 key=${key}`, error);
    console.warn(message);
  }
}

export async function runScheduledTask(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const task = classifyScheduledTask(controller.cron, controller.scheduledTime);
  if (
    task === 'PREWARM' ||
    task === 'VALUATION' ||
    task === 'CLOSE_SNAPSHOT'
  ) {
    const tradingDay = await tradingDayStatus(env, controller.scheduledTime);
    if (!tradingDay.available) {
      // 日历缺失时宁可停跑，也不能制造永远无法与官方净值对账的估值样本。
      await logUnavailableCalendarOncePerDay(env, task, tradingDay.date);
      return;
    }
    if (!tradingDay.isTradingDay) {
      console.log(`[cron] 非交易日，跳过 ${task} date=${tradingDay.date}`);
      return;
    }
  }
  switch (task) {
    case 'PROBE': {
      const run = await runProbe(env);
      const failed = run.results.filter((result) => !result.ok);
      if (failed.length > 0) {
        console.warn(
          `[probe] colo=${run.colo} 失败 ${failed.length}/${run.results.length}:`,
          failed.map((result) => `${result.source}=${result.error}`).join(' | '),
        );
      }
      return;
    }
    case 'OFFICIAL_NAV': {
      const result = await syncOfficialNavs(env);
      console.log('[official-nav]', result);
      return;
    }
    case 'IDLE':
      return;
    case 'UNKNOWN':
      console.warn(`[cron] 未识别的触发表达式：${controller.cron}`);
      return;
    default:
      // 第 0 步先把时刻表与精确分派固定下来；后续模块接到对应 case，不再改 cron 口径。
      console.log(`[cron] ${task} 尚未接入`);
  }
}
