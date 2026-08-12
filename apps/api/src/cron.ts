import type { Env } from './env';
import { syncOfficialNavs } from './nav/sync';
import { runDailyBrief, sendSystemAlert } from './notify/jobs';
import { runProbe } from './probe';
import { beijingDate, tradingDayStatus } from './trading-calendar';
import { prewarmValuationInputs, runValuationCycle } from './valuation/service';

export const CRONS = {
  probe: '*/5 * * * *',
  // Cloudflare 与常见 crontab 不同：1=周日、2=周一、…、7=周六。
  prewarm: '25 1 * * 2-6',
  valuation: '* 1-3,5-7 * * 2-6',
  closeSnapshot: '5 7 * * 2-6',
  officialNavHalfPast: '30 11-14 * * 2-6',
  officialNavOnHour: '0 12-14 * * 2-6',
  dailyBrief: '0 13 * * 2-6',
  dailyBriefRetry: '0 14 * * 2-6',
} as const;

export type ScheduledTask =
  | 'PROBE'
  | 'PREWARM'
  | 'VALUATION'
  | 'CLOSE_SNAPSHOT'
  | 'OFFICIAL_NAV'
  | 'DAILY_BRIEF'
  | 'DAILY_BRIEF_RETRY'
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
  if (cron === CRONS.dailyBriefRetry) return 'DAILY_BRIEF_RETRY';
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
): Promise<boolean> {
  const message = `[cron] 交易日历不可用，跳过 ${task} date=${date}`;
  const key = `alert:trading-calendar-unavailable:${date}`;
  try {
    if ((await env.CACHE.get(key)) !== null) {
      console.log(message);
      return false;
    }
    await env.CACHE.put(key, '1', { expirationTtl: CALENDAR_WARNING_TTL_SECONDS });
    console.warn(message);
    return true;
  } catch (error) {
    // 告警去重失败时保留原始原因，并继续 warn；不能为了降噪把真正的 KV 故障藏掉。
    console.error(`[cron] 交易日历告警去重失败 key=${key}`, error);
    console.warn(message);
    return true;
  }
}

export async function logValuationIssueOncePerDay(
  env: Env,
  date: string,
  fundCode: string,
  category: string,
  message: string,
): Promise<boolean> {
  const key = `alert:valuation:${fundCode}:${category}:${date}`;
  const warning = `[valuation] code=${fundCode} category=${category} ${message}`;
  try {
    if ((await env.CACHE.get(key)) !== null) {
      console.log(warning);
      return false;
    }
    await env.CACHE.put(key, '1', { expirationTtl: CALENDAR_WARNING_TTL_SECONDS });
    console.warn(warning);
    return true;
  } catch (error) {
    console.error(`[valuation] 告警去重失败 key=${key}`, error);
    console.warn(warning);
    return true;
  }
}

async function logSystemIssueOncePerDay(
  env: Env,
  key: string,
  message: string,
): Promise<boolean> {
  try {
    if ((await env.CACHE.get(key)) !== null) {
      console.log(message);
      return false;
    }
    await env.CACHE.put(key, '1', { expirationTtl: CALENDAR_WARNING_TTL_SECONDS });
    console.warn(message);
    return true;
  } catch (error) {
    console.error(`[cron] 系统告警去重失败 key=${key}`, error);
    console.warn(message);
    return true;
  }
}

async function dispatchAlertOnce(
  env: Env,
  date: string,
  dedupKey: string,
  title: string,
  description: string,
): Promise<void> {
  const key = `notify:alert:${dedupKey}:${date}`;
  if ((await env.CACHE.get(key)) !== null) return;
  const result = await sendSystemAlert(env, { date, title, description });
  if (result.bindings > 0) {
    // 只有 Discord 明确成功后才记去重；失败时下一轮必须继续尝试，不能制造“已告警”假象。
    await env.CACHE.put(key, '1', { expirationTtl: CALENDAR_WARNING_TTL_SECONDS });
    console.log(`[notify] 告警已发送 ${result.sent}/${result.bindings} title=${title}`);
  }
}

export async function runScheduledTask(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const task = classifyScheduledTask(controller.cron, controller.scheduledTime);
  const taskDate = beijingDate(controller.scheduledTime);
  if (
    task === 'PREWARM' ||
    task === 'VALUATION' ||
    task === 'CLOSE_SNAPSHOT' ||
    task === 'DAILY_BRIEF' ||
    task === 'DAILY_BRIEF_RETRY'
  ) {
    const tradingDay = await tradingDayStatus(env, controller.scheduledTime);
    if (!tradingDay.available) {
      // 日历缺失时宁可停跑，也不能制造永远无法与官方净值对账的估值样本。
      await logUnavailableCalendarOncePerDay(env, task, tradingDay.date);
      await dispatchAlertOnce(
        env,
        tradingDay.date,
        'trading-calendar-unavailable',
        '交易日历不可用或覆盖已用尽',
        `任务 ${task} 已 fail closed；coversUntil=${tradingDay.coversUntil ?? 'missing'}`,
      );
      return;
    }
    if (tradingDay.remainingTradingDays <= 5) {
      await logSystemIssueOncePerDay(
        env,
        `alert:trading-calendar-ending:${tradingDay.date}`,
        `[cron] 交易日历即将用尽 remaining=${tradingDay.remainingTradingDays} coversUntil=${tradingDay.coversUntil}`,
      );
      await dispatchAlertOnce(
        env,
        tradingDay.date,
        'trading-calendar-ending',
        '交易日历即将用尽',
        `只剩 ${tradingDay.remainingTradingDays} 个交易日，覆盖到 ${tradingDay.coversUntil}`,
      );
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
      if (result.skipped.length > 0) {
        await logSystemIssueOncePerDay(
          env,
          `alert:official-nav:${taskDate}`,
          `[official-nav] 同步不完整 skipped=${result.skipped.join(',')}`,
        );
        await dispatchAlertOnce(
          env,
          taskDate,
          'official-nav-incomplete',
          '官方净值同步不完整',
          `${result.skipped.length}/${result.requested} 只未同步：${result.skipped.join(', ')}`,
        );
      }
      if (result.requested > 0 && result.stored === 0) {
        await logSystemIssueOncePerDay(
          env,
          `alert:official-nav-batch:${taskDate}`,
          `[official-nav] 整批未写入 requested=${result.requested}`,
        );
        await dispatchAlertOnce(
          env,
          taskDate,
          'official-nav-batch',
          '官方净值同步整批失败',
          `请求 ${result.requested} 只基金，但 D1 一条都没有写入`,
        );
        throw new Error(`官方净值整批未写入 requested=${result.requested}`);
      }
      return;
    }
    case 'PREWARM': {
      const result = await prewarmValuationInputs(env);
      console.log(
        `[valuation] 预热完成 funds=${result.funds} updated=${result.updated} failed=${result.failures.length}`,
      );
      for (const failure of result.failures) {
        await logValuationIssueOncePerDay(
          env,
          taskDate,
          failure.code,
          'PREWARM_FAILURE',
          failure.error.message,
        );
        await dispatchAlertOnce(
          env,
          taskDate,
          `valuation:${failure.code}:PREWARM_FAILURE`,
          '估值预热失败',
          `基金 ${failure.code}：${failure.error.message}`,
        );
      }
      if (result.funds > 0 && result.failures.length === result.funds) {
        throw new AggregateError(
          result.failures.map((failure) => failure.error),
          `估值预热整批失败: ${result.failures.map((failure) => failure.code).join(',')}`,
        );
      }
      return;
    }
    case 'VALUATION':
    case 'CLOSE_SNAPSHOT': {
      const result = await runValuationCycle(env, controller.scheduledTime);
      console.log(
        `[valuation] ${task} funds=${result.funds} valued=${result.valued} noneStructural=${result.structuralNone} noneMissing=${result.missingInputNone} sampled=${result.sampled} provider=${result.provider ?? 'none'} delayed=${result.delayed} failed=${result.failures.length}`,
      );
      for (const missing of result.missingInputs) {
        await logValuationIssueOncePerDay(
          env,
          taskDate,
          missing.code,
          missing.cause,
          missing.note,
        );
        await dispatchAlertOnce(
          env,
          taskDate,
          `valuation:${missing.code}:${missing.cause}`,
          '估值缺少输入',
          `基金 ${missing.code}，类别 ${missing.cause}：${missing.note}`,
        );
      }
      for (const failure of result.failures) {
        await logValuationIssueOncePerDay(
          env,
          taskDate,
          failure.code,
          'VALUATION_EXCEPTION',
          failure.error.message,
        );
        await dispatchAlertOnce(
          env,
          taskDate,
          `valuation:${failure.code}:VALUATION_EXCEPTION`,
          '估值计算异常',
          `基金 ${failure.code}：${failure.error.message}`,
        );
      }
      if (result.quoteChainFailure !== null) {
        await logValuationIssueOncePerDay(
          env,
          taskDate,
          'ALL',
          'QUOTE_CHAIN_FAILURE',
          result.quoteChainFailure,
        );
        await dispatchAlertOnce(
          env,
          taskDate,
          'valuation:ALL:QUOTE_CHAIN_FAILURE',
          '估值行情整链失败',
          result.quoteChainFailure,
        );
        throw new Error(result.quoteChainFailure);
      }
      if (
        result.valued === 0 &&
        result.missingInputNone + result.failures.length > 0
      ) {
        throw new AggregateError(
          [
            ...result.failures.map((failure) => failure.error),
            ...result.missingInputs.map(
              (missing) => new Error(`${missing.code}:${missing.cause}:${missing.note}`),
            ),
          ],
          `估值整批失败: ${[
            ...result.failures.map((failure) => failure.code),
            ...result.missingInputs.map((missing) => missing.code),
          ].join(',')}`,
        );
      }
      return;
    }
    case 'DAILY_BRIEF':
    case 'DAILY_BRIEF_RETRY': {
      const result = await runDailyBrief(
        env,
        controller.scheduledTime,
        task === 'DAILY_BRIEF_RETRY',
      );
      console.log(
        `[notify] ${task} bindings=${result.bindings} sent=${result.sent} skipped=${result.skippedAlreadySent}`,
      );
      return;
    }
    case 'IDLE':
      return;
    case 'UNKNOWN':
      console.warn(`[cron] 未识别的触发表达式：${controller.cron}`);
      return;
    default:
      task satisfies never;
  }
}
