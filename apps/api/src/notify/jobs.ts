import { z } from 'zod';
import { listNotifyBindings } from '../data/notify';
import { getLatestOfficialNav } from '../data/navs';
import { derivePositions, listTransactions } from '../data/transactions';
import type { Env } from '../env';
import { getFundMeta } from '../fund-meta';
import { officialMarketValue, positionDayReturn } from '../positions';
import { beijingDate } from '../trading-calendar';
import { DiscordNotifier } from './discord';
import type { AlertMessage, DailyBrief, NotifyBinding } from './types';

const DAILY_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;

const DailySuccess = z.object({
  ok: z.literal(true),
  sentAt: z.string().datetime(),
});

function statusKey(userId: string, date: string): string {
  return `notify:daily:${userId}:${date}`;
}

async function wasSent(env: Env, userId: string, date: string): Promise<boolean> {
  const raw = await env.CACHE.get<unknown>(statusKey(userId, date), 'json');
  return DailySuccess.safeParse(raw).success;
}

async function buildDailyBrief(
  env: Env,
  binding: NotifyBinding,
  date: string,
): Promise<DailyBrief> {
  const positions = derivePositions(await listTransactions(env.DB, binding.userId));
  const [navs, metas] = await Promise.all([
    Promise.all(positions.map((position) => getLatestOfficialNav(env, position.fundCode))),
    Promise.all(
      positions.map(async (position) => {
        try {
          return await getFundMeta(env, position.fundCode);
        } catch (error) {
          console.warn(`[notify] 基金名称读取失败 code=${position.fundCode}`, error);
          return null;
        }
      }),
    ),
  ]);
  const briefPositions = positions.map((position, index) => {
    const nav = navs[index];
    const marketValue = nav ? officialMarketValue(position.shares, nav) : null;
    return {
      fundCode: position.fundCode,
      fundName: metas[index]?.name ?? `基金 ${position.fundCode}`,
      marketValue,
      dayReturn: nav ? positionDayReturn(position.shares, nav) : null,
      navUpdated: nav?.navDate === date,
      costTotal: position.costTotal,
    };
  });
  const available = briefPositions.filter(
    (position): position is typeof position & { marketValue: number } =>
      position.marketValue !== null,
  );
  return {
    date,
    marketValue: available.reduce((sum, position) => sum + position.marketValue, 0),
    dayReturn: briefPositions.reduce((sum, position) => sum + (position.dayReturn ?? 0), 0),
    holdingReturn: available.reduce(
      (sum, position) => sum + position.marketValue - position.costTotal,
      0,
    ),
    unavailableValueCount: briefPositions.length - available.length,
    positions: briefPositions.map((position) => ({
      fundCode: position.fundCode,
      fundName: position.fundName,
      marketValue: position.marketValue,
      dayReturn: position.dayReturn,
      navUpdated: position.navUpdated,
    })),
  };
}

export interface DailyBriefRunResult {
  bindings: number;
  sent: number;
  skippedAlreadySent: number;
  failed: number;
  retry: boolean;
}

export async function runDailyBrief(
  env: Env,
  scheduledTime: number,
  retry: boolean,
  notifier = new DiscordNotifier(),
): Promise<DailyBriefRunResult> {
  const date = beijingDate(scheduledTime);
  const bindings = await listNotifyBindings(env, 'DAILY');
  let sent = 0;
  let skippedAlreadySent = 0;
  const failures: Error[] = [];

  for (const binding of bindings) {
    try {
      if (await wasSent(env, binding.userId, date)) {
        skippedAlreadySent++;
        continue;
      }
      const result = await notifier.send(binding, await buildDailyBrief(env, binding, date));
      if (!result.ok) {
        throw new Error(
          `日报发送失败 user=${binding.userId} status=${result.status ?? 'network'} ${result.error ?? ''}`,
        );
      }
      await env.CACHE.put(
        statusKey(binding.userId, date),
        JSON.stringify({ ok: true, sentAt: new Date().toISOString() }),
        { expirationTtl: DAILY_STATUS_TTL_SECONDS },
      );
      sent++;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(`[notify] 日报失败 user=${binding.userId} retry=${retry}`, failure);
      failures.push(failure);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `日报发送失败 ${failures.length}/${bindings.length}`);
  }
  return {
    bindings: bindings.length,
    sent,
    skippedAlreadySent,
    failed: 0,
    retry,
  };
}

function boundedDescription(value: string): string {
  if (value.length <= 4_096) return value;
  return `${value.slice(0, 4_080)}…（内容已截断）`;
}

export async function sendSystemAlert(
  env: Env,
  alert: AlertMessage,
  notifier = new DiscordNotifier(),
): Promise<{ bindings: number; sent: number }> {
  const bindings = await listNotifyBindings(env, 'ALERT');
  const failures: Error[] = [];
  let sent = 0;
  for (const binding of bindings) {
    try {
      const result = await notifier.sendAlert(binding, {
        ...alert,
        description: boundedDescription(alert.description),
      });
      if (!result.ok) {
        throw new Error(
          `告警发送失败 user=${binding.userId} status=${result.status ?? 'network'} ${result.error ?? ''}`,
        );
      }
      sent++;
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `告警发送失败 ${failures.length}/${bindings.length}`);
  }
  return { bindings: bindings.length, sent };
}
