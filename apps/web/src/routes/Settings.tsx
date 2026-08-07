import { useState } from 'react';
import { Card, GroupLabel, Segmented, Toggle } from '../components/ui';
import { usePrefs, type RefreshFreq, type UpDownScheme } from '../lib/prefs';

const INVITE_CODE = 'QD2-8F3K-2M9P';

const FREQS: { value: RefreshFreq; label: string }[] = [
  { value: '1m', label: '交易时段每分钟' },
  { value: '5m', label: '每 5 分钟' },
  { value: 'manual', label: '手动刷新' },
];

export function Settings() {
  const prefs = usePrefs();
  const [copied, setCopied] = useState(false);
  const [modal, setModal] = useState<null | 'feishu' | 'telegram' | 'discord'>(null);
  const [feishuOn, setFeishuOn] = useState(true);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INVITE_CODE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 非安全上下文下 clipboard 不可用，静默失败即可
    }
  };

  return (
    <>
      <h1 className="px-0.5 pt-[22px] pb-1.5 text-[22px] font-bold tracking-wide">设置</h1>

      {/* 1 · 账户 */}
      <GroupLabel>账户</GroupLabel>
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-[15px]">
          <span className="text-[13.5px] text-ink-muted">邮箱</span>
          <span className="text-[13.5px] text-ink-strong">ffkiyo7@gmail.com</span>
        </div>
        <div className="px-4 py-[15px]">
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] text-ink-muted">我的邀请码</span>
            <div className="flex items-center gap-2.5">
              <span className="text-[14.5px] font-bold tracking-wider text-ink">{INVITE_CODE}</span>
              <button
                type="button"
                onClick={copy}
                className={`rounded-lg border px-2.5 py-[5px] text-[11.5px] font-semibold transition-colors ${
                  copied
                    ? 'border-success/40 bg-success/12 text-success'
                    : 'border-accent/35 bg-accent/13 text-accent-soft'
                }`}
              >
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          </div>
          <div className="mt-2.5 text-[11.5px] text-ink-faint">
            已使用 <b className="text-ink-muted">2/5</b> · 邀请码制，暂不开放公开注册
          </div>
        </div>
      </div>

      {/* 2 · 每日持仓简报 */}
      <div className="px-0.5 pt-[26px] pb-1 text-xs font-semibold tracking-wide text-ink-dim">
        每日持仓简报
      </div>
      <div className="px-0.5 pb-3 text-xs leading-relaxed text-ink-muted">
        每个交易日 <b className="text-ink-body">21:00</b>，官方净值出齐后推送当日持仓变动
      </div>

      {/* 飞书是主推渠道：大陆可直连，卡片消息最好 */}
      <div className="rounded-2xl border border-feishu/30 bg-[linear-gradient(158deg,#1b2333,#141519)] p-4 shadow-[0_6px_22px_rgba(51,112,255,.08)]">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-feishu text-[17px] font-bold text-white">
            飞
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold">飞书</span>
              <span className="inline-flex items-center gap-1 rounded-md bg-success/13 px-[7px] py-0.5 text-[10.5px] font-semibold text-success">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l5 5L20 6" />
                </svg>
                已绑定
              </span>
              <span className="rounded-md bg-feishu/15 px-[7px] py-0.5 text-[10.5px] font-semibold text-feishu">
                主推渠道
              </span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-dimmer">webhook 尾号 ...a3f2</div>
          </div>
          <Toggle on={feishuOn} onChange={setFeishuOn} />
        </div>
        <div className="mt-3.5 flex gap-2.5">
          <button
            type="button"
            className="flex-1 rounded-[10px] border border-feishu/40 bg-feishu/12 py-[9px] text-[12.5px] font-semibold text-info"
          >
            测试推送
          </button>
          <button
            type="button"
            className="flex-1 rounded-[10px] border border-white/10 py-[9px] text-[12.5px] font-semibold text-ink-muted"
          >
            解绑
          </button>
        </div>
      </div>

      <div className="mt-[11px] overflow-hidden rounded-2xl border border-line bg-card">
        <ChannelRow
          brand="bg-telegram"
          initial="T"
          name="Telegram"
          onBind={() => setModal('telegram')}
          divider
        />
        <ChannelRow
          brand="bg-discord"
          initial="D"
          name="Discord"
          onBind={() => setModal('discord')}
        />
      </div>
      <div className="flex items-center gap-1.5 px-1 pt-2.5 text-[11px] text-ink-faintest">
        <LockIcon /> Webhook 地址加密存储
      </div>

      {/* 3 · 显示 */}
      <GroupLabel>显示</GroupLabel>
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="border-b border-line-soft px-4 py-[15px]">
          <div className="mb-3 text-[13.5px] text-ink-strong">涨跌颜色</div>
          <Segmented<UpDownScheme>
            value={prefs.updown}
            onChange={(v) => prefs.set('updown', v)}
            options={[
              { value: 'red-up', label: '红涨绿跌' },
              { value: 'green-up', label: '绿涨红跌' },
            ]}
            activeClassName={(v) => (v === 'red-up' ? 'text-danger' : 'text-success')}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-[15px]">
          <div className="flex-1 pr-3">
            <div className="text-[13.5px] text-ink-strong">金额隐私模式</div>
            <div className="mt-[3px] text-[11.5px] text-ink-faint">
              开启后金额显示为 ****，适合截图分享
            </div>
          </div>
          <Toggle on={prefs.privacy} onChange={(v) => prefs.set('privacy', v)} />
        </div>
      </div>

      {/* 4 · 数据 */}
      <GroupLabel>数据</GroupLabel>
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="border-b border-line-soft px-4 py-[15px]">
          <div className="mb-3 text-[13.5px] text-ink-strong">
            刷新频率
            <span className="text-[11px] font-normal text-ink-faint">（仅交易时段）</span>
          </div>
          <div className="flex flex-col">
            {FREQS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => prefs.set('freq', f.value)}
                className="flex w-full items-center justify-between py-[11px] px-0.5"
              >
                <span
                  className={`text-[13.5px] ${
                    prefs.freq === f.value ? 'text-ink' : 'text-ink-muted'
                  }`}
                >
                  {f.label}
                </span>
                {prefs.freq === f.value && (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                    <path d="M5 12l5 5L20 6" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void caches?.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
          }}
          className="flex w-full items-center justify-between px-4 py-[15px]"
        >
          <span className="text-[13.5px] text-ink-strong">清除本地缓存</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f636b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </div>

      {/* 5 · 关于 */}
      <GroupLabel>关于</GroupLabel>
      <Card>
        <div className="mb-2.5 flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="text-warn">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16.5" strokeLinecap="round" />
            <circle cx="12" cy="7.6" r=".5" fill="currentColor" />
          </svg>
          <span className="text-[13px] font-semibold text-ink-strong">免责声明</span>
        </div>
        {/* 必须真的能被读到 —— 不要做成灰到看不见的小字 */}
        <div className="text-[13px] leading-relaxed text-[#c8ccd3]">
          本工具展示的估算净值由持仓数据推算，与实际净值存在误差，仅供参考。所有内容不构成投资建议。
        </div>
        <div className="mt-3.5 flex flex-col gap-2 border-t border-line-soft pt-[13px]">
          <div className="flex justify-between">
            <span className="text-xs text-ink-muted">数据来源</span>
            <span className="text-xs text-ink-body">基金公司季报 · 交易所行情</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-ink-muted">版本</span>
            <span className="text-xs text-ink-body">v0.1.0 (P1)</span>
          </div>
        </div>
      </Card>

      {modal && <BindSheet channel={modal} onClose={() => setModal(null)} />}
    </>
  );
}

function ChannelRow({
  brand,
  initial,
  name,
  onBind,
  divider,
}: {
  brand: string;
  initial: string;
  name: string;
  onBind: () => void;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3.5 ${divider ? 'border-b border-line-soft' : ''}`}
    >
      <div
        className={`flex size-[34px] shrink-0 items-center justify-center rounded-[10px] text-sm font-bold text-white ${brand}`}
      >
        {initial}
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium">{name}</div>
        <div className="mt-0.5 text-[11px] text-ink-dimmer">未绑定</div>
      </div>
      <button
        type="button"
        onClick={onBind}
        className="rounded-[9px] border border-white/15 px-4 py-[7px] text-[12.5px] font-semibold text-ink-body"
      >
        绑定
      </button>
    </div>
  );
}

const CHANNEL_META = {
  feishu: {
    title: '绑定飞书机器人',
    initial: '飞',
    brand: 'bg-feishu',
    btn: 'bg-feishu',
    placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
    steps: [
      <>打开目标<b className="text-ink">飞书群</b> → 右上角设置 → 群机器人</>,
      <>添加<b className="text-ink">自定义机器人</b>，命名「持仓助手」</>,
      <><b className="text-ink">复制 Webhook 地址</b>，粘贴到下方</>,
    ],
  },
  telegram: {
    title: '绑定 Telegram',
    initial: 'T',
    brand: 'bg-telegram',
    btn: 'bg-telegram',
    placeholder: '粘贴 Bot Token 或 Chat ID',
    steps: [
      <>在 Telegram 里找 <b className="text-ink">@BotFather</b> 创建机器人</>,
      <>把机器人拉进目标群，或直接私聊它发一条消息</>,
      <><b className="text-ink">复制 Bot Token</b>，粘贴到下方</>,
    ],
  },
  discord: {
    title: '绑定 Discord',
    initial: 'D',
    brand: 'bg-discord',
    btn: 'bg-discord',
    placeholder: 'https://discord.com/api/webhooks/…',
    steps: [
      <>打开目标频道 → 设置 → <b className="text-ink">整合</b> → Webhook</>,
      <>新建 Webhook，命名「持仓助手」</>,
      <><b className="text-ink">复制 Webhook URL</b>，粘贴到下方</>,
    ],
  },
} as const;

function BindSheet({
  channel,
  onClose,
}: {
  channel: 'feishu' | 'telegram' | 'discord';
  onClose: () => void;
}) {
  const m = CHANNEL_META[channel];
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-[430px] rounded-t-3xl border-t border-white/10 bg-sheet px-[18px] pt-5 pb-[max(env(safe-area-inset-bottom),30px)]">
        <div className="mx-auto mb-[18px] h-1 w-[38px] rounded-sm bg-white/15" />
        <div className="mb-1.5 flex items-center gap-[11px]">
          <div
            className={`flex size-[34px] items-center justify-center rounded-[10px] text-[15px] font-bold text-white ${m.brand}`}
          >
            {m.initial}
          </div>
          <div className="text-[17px] font-bold">{m.title}</div>
        </div>
        <div className="mb-[18px] text-xs text-ink-muted">
          在目标会话里添加机器人，把它的 Webhook 地址粘贴过来
        </div>

        <div className="flex flex-col gap-3.5">
          {m.steps.map((step, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-feishu/16 text-xs font-bold text-info">
                {i + 1}
              </div>
              <div className="text-[13px] leading-snug text-ink-soft">{step}</div>
            </div>
          ))}
        </div>

        <input
          type="url"
          inputMode="url"
          placeholder={m.placeholder}
          className="mt-[18px] w-full rounded-xl border border-white/10 bg-inset px-3.5 py-[13px] text-[12.5px] text-ink outline-none placeholder:text-ink-faintest"
        />
        <button
          type="button"
          onClick={onClose}
          className={`mt-3 w-full rounded-[13px] py-3.5 text-[15px] font-bold text-white ${m.btn}`}
        >
          验证并保存
        </button>
        <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-ink-faintest">
          <LockIcon /> Webhook 地址加密存储，仅用于推送
        </div>
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" strokeLinecap="round" />
    </svg>
  );
}
