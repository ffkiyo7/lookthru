import type {
  AlertMessage,
  DailyBrief,
  Notifier,
  NotifyBinding,
  NotifyResult,
} from './types';

const EMBED_DESCRIPTION_LIMIT = 4_096;
const EMBED_TOTAL_LIMIT = 6_000;
const EMBED_FIELD_LIMIT = 25;

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string };
}

export interface DiscordPayload {
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: [] };
}

function money(value: number): string {
  return `¥${value.toFixed(2)}`;
}

function signedMoney(value: number): string {
  return `${value >= 0 ? '+' : '-'}¥${Math.abs(value).toFixed(2)}`;
}

function limitedName(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 79)}…`;
}

export function buildDiscordDailyPayload(brief: DailyBrief): DiscordPayload {
  const fields = [
    {
      name:
        brief.unavailableValueCount > 0
          ? `总资产（${brief.unavailableValueCount}只未计）`
          : '总资产',
      value: money(brief.marketValue),
      inline: true,
    },
    { name: '今日收益', value: signedMoney(brief.dayReturn), inline: true },
    { name: '持有收益', value: signedMoney(brief.holdingReturn), inline: true },
  ];
  if (fields.length > EMBED_FIELD_LIMIT) throw new Error('Discord embed fields 超过 25');

  const missingNavCount = brief.positions.filter((position) => !position.navUpdated).length;
  const lines: string[] = [];
  let displayed = 0;
  for (const position of brief.positions) {
    const line = `• ${limitedName(position.fundName)} ${
      position.marketValue === null ? '市值待更新' : money(position.marketValue)
    } ${
      position.dayReturn === null ? '今日收益待更新' : signedMoney(position.dayReturn)
    }`;
    const remaining = brief.positions.length - displayed - 1;
    const omission = remaining > 0 ? `\n另有 ${remaining} 只未显示` : '';
    const candidate = [...lines, line].join('\n') + omission;
    if (candidate.length > EMBED_DESCRIPTION_LIMIT) break;
    lines.push(line);
    displayed++;
  }
  const omitted = brief.positions.length - displayed;
  const description =
    lines.join('\n') + (omitted > 0 ? `\n另有 ${omitted} 只未显示` : '') || '当前没有持仓';
  const footerText =
    missingNavCount > 0
      ? `${missingNavCount} 只基金净值尚未更新；日报仍按已有官方值生成`
      : '全部持仓已取得当日官方净值';
  const totalCharacters =
    `lookthru 日报 · ${brief.date}`.length +
    description.length +
    footerText.length +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (totalCharacters > EMBED_TOTAL_LIMIT) {
    throw new Error(`Discord embed 总字符数超过 ${EMBED_TOTAL_LIMIT}`);
  }
  return {
    embeds: [
      {
        title: `lookthru 日报 · ${brief.date}`,
        description,
        color: brief.dayReturn >= 0 ? 0xd45b47 : 0x4e8b75,
        fields,
        footer: { text: footerText },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function buildDiscordAlertPayload(alert: AlertMessage): DiscordPayload {
  const title = `lookthru 告警 · ${alert.title}`;
  if (title.length > 256) throw new Error('Discord alert title 超过 256 字符');
  if (alert.description.length > EMBED_DESCRIPTION_LIMIT) {
    throw new Error(`Discord alert description 超过 ${EMBED_DESCRIPTION_LIMIT} 字符`);
  }
  if (title.length + alert.description.length + alert.date.length > EMBED_TOTAL_LIMIT) {
    throw new Error(`Discord alert embed 总字符数超过 ${EMBED_TOTAL_LIMIT}`);
  }
  return {
    embeds: [
      {
        title,
        description: alert.description,
        color: 0xd45b47,
        fields: [],
        footer: { text: alert.date },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function validateDiscordWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('Discord webhook URL 格式非法', { cause: error });
  }
  if (
    url.protocol !== 'https:' ||
    !['discord.com', 'discordapp.com'].includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)
  ) {
    throw new Error('Discord webhook URL 必须是官方 HTTPS /api/webhooks/{id}/{token} 地址');
  }
}

async function retryDelaySeconds(response: Response): Promise<number> {
  const header = response.headers.get('Retry-After');
  const headerValue = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(headerValue) && headerValue >= 0) return headerValue;
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'retry_after' in body &&
      typeof body.retry_after === 'number' &&
      Number.isFinite(body.retry_after) &&
      body.retry_after >= 0
    ) {
      return body.retry_after;
    }
  } catch (error) {
    throw new Error('Discord 429 未提供合法 Retry-After 或 retry_after', { cause: error });
  }
  throw new Error('Discord 429 未提供合法 Retry-After 或 retry_after');
}

function safeNetworkError(error: unknown, webhookUrl: string): string {
  if (!(error instanceof Error)) return 'Discord 网络请求失败 (unknown)';
  const message = error.message.replaceAll(webhookUrl, '<redacted>').slice(0, 300);
  const cause = error.cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? ` code=${cause.code}`
      : '';
  return `Discord 网络请求失败 (${error.name}: ${message}${code})`;
}

export class DiscordNotifier implements Notifier {
  constructor(
    // Workers 原生 fetch 带宿主调用上下文；直接存成成员后 this.fetcher(...) 会变成非法调用。
    // 包一层普通函数既保留生产上下文，也不影响测试注入。
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async send(binding: NotifyBinding, brief: DailyBrief): Promise<NotifyResult> {
    return this.post(binding, buildDiscordDailyPayload(brief));
  }

  async sendAlert(binding: NotifyBinding, alert: AlertMessage): Promise<NotifyResult> {
    if (binding.kind !== 'ALERT') throw new Error('告警消息只能发送到 ALERT binding');
    return this.post(binding, buildDiscordAlertPayload(alert));
  }

  private async post(binding: NotifyBinding, payload: DiscordPayload): Promise<NotifyResult> {
    if (binding.provider !== 'DISCORD') {
      throw new Error(`DiscordNotifier 不支持 provider=${binding.provider}`);
    }
    validateDiscordWebhookUrl(binding.webhookUrl);
    const body = JSON.stringify(payload);
    let retried = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(binding.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch (error) {
        return {
          ok: false,
          status: null,
          retried,
          error: safeNetworkError(error, binding.webhookUrl),
        };
      }
      // Execute Webhook 在 wait=false 时成功返回 204；res.ok 同时正确接受未来的其他 2xx。
      if (response.ok) return { ok: true, status: response.status, retried, error: null };
      if (response.status !== 429 || attempt === 1) {
        return {
          ok: false,
          status: response.status,
          retried,
          error: `Discord webhook 返回 HTTP ${response.status}`,
        };
      }
      const delaySeconds = await retryDelaySeconds(response);
      await this.sleep(delaySeconds * 1_000);
      retried = true;
    }
    throw new Error('Discord 发送循环到达不可达分支');
  }
}
