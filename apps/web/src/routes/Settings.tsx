import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, GroupLabel, Segmented, Toggle } from '../components/ui';
import {
  fetchNotifyBindings,
  logout,
  removeNotifyBinding,
  saveNotifyBinding,
  testNotifyBinding,
  type NotifyKind,
} from '../lib/api';
import { usePrefs, type RefreshFreq, type UpDownScheme } from '../lib/prefs';
import { SESSION_QUERY_KEY, useSessionQuery } from './Auth';

const FREQS: { value: RefreshFreq; label: string }[] = [
  { value: '1m', label: '交易时段每分钟' },
  { value: '5m', label: '每 5 分钟' },
  { value: 'manual', label: '手动刷新' },
];

const NOTIFY_META: Record<NotifyKind, { title: string; description: string }> = {
  DAILY: {
    title: 'Discord 日报',
    description: '每个交易日 21:00；22:00 只补发失败的日报',
  },
  ALERT: {
    title: 'Discord 告警',
    description: '仅发送日历、净值、估值与缺输入故障',
  },
};

export function Settings() {
  const prefs = usePrefs();
  const queryClient = useQueryClient();
  const session = useSessionQuery();
  const bindings = useQuery({ queryKey: ['notify-bindings'], queryFn: fetchNotifyBindings });
  const [editingKind, setEditingKind] = useState<NotifyKind | null>(null);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);
  const removeBinding = useMutation({
    mutationFn: removeNotifyBinding,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notify-bindings'] }),
  });
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      await queryClient.resetQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
  const testBinding = useMutation({
    mutationFn: testNotifyBinding,
    onMutate: (kind) => setNotifyMessage(`正在发送${kind === 'DAILY' ? '日报' : '告警'}测试…`),
    onSuccess: (result) =>
      setNotifyMessage(`${result.kind === 'DAILY' ? '日报' : '告警'}测试已送达 Discord`),
    onError: (error) => setNotifyMessage(`测试失败：${error.message}`),
  });

  return (
    <>
      <h1 className="px-0.5 pt-[22px] pb-1.5 text-[22px] font-bold tracking-wide">设置</h1>

      <GroupLabel>账户</GroupLabel>
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-[15px]">
          <span className="text-[13.5px] text-ink-muted">用户 ID</span>
          <span className="max-w-[220px] truncate font-mono text-xs text-ink-strong">
            {session.data?.userId}
          </span>
        </div>
        <button
          type="button"
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          className="w-full px-4 py-[15px] text-left text-[13.5px] font-semibold text-danger disabled:opacity-40"
        >
          {logoutMutation.isPending ? '正在退出…' : '退出当前设备'}
        </button>
        {logoutMutation.isError && (
          <div className="border-t border-line-soft px-4 py-2 text-xs text-danger">
            退出失败：{logoutMutation.error.message}
          </div>
        )}
      </div>

      <div className="px-0.5 pt-[26px] pb-1 text-xs font-semibold tracking-wide text-ink-dim">
        Discord 推送
      </div>
      <div className="px-0.5 pb-3 text-xs leading-relaxed text-ink-muted">
        日报与告警必须使用两个专用频道。地址只加密写入 D1，页面不会回显。
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        {(['DAILY', 'ALERT'] as const).map((kind, index) => {
          const configured = bindings.data?.bindings.find((binding) => binding.kind === kind)?.configured;
          return (
            <NotifyRow
              key={kind}
              kind={kind}
              configured={configured === true}
              loading={bindings.isPending}
              divider={index === 0}
              onBind={() => setEditingKind(kind)}
              onRemove={() => removeBinding.mutate(kind)}
              onTest={() => testBinding.mutate(kind)}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 px-1 pt-2.5 text-[11px] text-ink-faintest">
        <LockIcon /> Webhook 地址使用 AES-GCM 加密存储
      </div>
      {(bindings.isError || removeBinding.isError) && (
        <div className="mt-2 text-xs text-danger">
          通知设置读取或写入失败：
          {(bindings.error ?? removeBinding.error)?.message ?? '未知错误'}
        </div>
      )}
      {notifyMessage && (
        <div className={`mt-2 text-xs ${testBinding.isError ? 'text-danger' : 'text-ink-muted'}`}>
          {notifyMessage}
        </div>
      )}

      <GroupLabel>显示</GroupLabel>
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="border-b border-line-soft px-4 py-[15px]">
          <div className="mb-3 text-[13.5px] text-ink-strong">涨跌颜色</div>
          <Segmented<UpDownScheme>
            value={prefs.updown}
            onChange={(value) => prefs.set('updown', value)}
            options={[
              { value: 'red-up', label: '红涨绿跌' },
              { value: 'green-up', label: '绿涨红跌' },
            ]}
            activeClassName={(value) => (value === 'red-up' ? 'text-danger' : 'text-success')}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-[15px]">
          <div className="flex-1 pr-3">
            <div className="text-[13.5px] text-ink-strong">金额隐私模式</div>
            <div className="mt-[3px] text-[11.5px] text-ink-faint">
              开启后金额显示为 ****，适合截图分享
            </div>
          </div>
          <Toggle on={prefs.privacy} onChange={(value) => prefs.set('privacy', value)} />
        </div>
      </div>

      <GroupLabel>数据</GroupLabel>
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="border-b border-line-soft px-4 py-[15px]">
          <div className="mb-3 text-[13.5px] text-ink-strong">
            刷新频率
            <span className="text-[11px] font-normal text-ink-faint">（仅交易时段）</span>
          </div>
          <div className="flex flex-col">
            {FREQS.map((frequency) => (
              <button
                key={frequency.value}
                type="button"
                onClick={() => prefs.set('freq', frequency.value)}
                className="flex w-full items-center justify-between px-0.5 py-[11px]"
              >
                <span
                  className={`text-[13.5px] ${
                    prefs.freq === frequency.value ? 'text-ink' : 'text-ink-muted'
                  }`}
                >
                  {frequency.label}
                </span>
                {prefs.freq === frequency.value && <CheckIcon />}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={async () => {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.map((key) => caches.delete(key)));
              setCacheMessage(`已清除 ${keys.length} 个离线缓存`);
            } catch (error) {
              setCacheMessage(`清除失败：${error instanceof Error ? error.message : '未知错误'}`);
            }
          }}
          className="flex w-full items-center justify-between px-4 py-[15px]"
        >
          <span className="text-[13.5px] text-ink-strong">清除本地缓存</span>
          <span className="text-xs text-ink-faint">{cacheMessage ?? '›'}</span>
        </button>
      </div>

      <GroupLabel>关于</GroupLabel>
      <Card>
        <div className="mb-2.5 text-[13px] font-semibold text-ink-strong">免责声明</div>
        <div className="text-[13px] leading-relaxed text-[#c8ccd3]">
          本工具展示的估算净值由持仓数据推算，与实际净值存在误差，仅供参考。所有内容不构成投资建议。
        </div>
      </Card>

      {editingKind && (
        <BindSheet kind={editingKind} onClose={() => setEditingKind(null)} />
      )}
    </>
  );
}

function NotifyRow({
  kind,
  configured,
  loading,
  divider,
  onBind,
  onRemove,
  onTest,
}: {
  kind: NotifyKind;
  configured: boolean;
  loading: boolean;
  divider: boolean;
  onBind: () => void;
  onRemove: () => void;
  onTest: () => void;
}) {
  const meta = NOTIFY_META[kind];
  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 ${divider ? 'border-b border-line-soft' : ''}`}>
      <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-discord text-sm font-bold text-white">
        D
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium">{meta.title}</div>
          {configured && (
            <span className="rounded-md bg-success/13 px-[7px] py-0.5 text-[10px] font-semibold text-success">
              已绑定
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-ink-dimmer">{meta.description}</div>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        {configured && (
          <button
            type="button"
            disabled={loading}
            onClick={onTest}
            className="rounded-[9px] border border-white/15 px-3 py-[6px] text-[11px] font-semibold text-ink-body disabled:opacity-40"
          >
            测试
          </button>
        )}
        <button
          type="button"
          disabled={loading}
          onClick={configured ? onRemove : onBind}
          className={`rounded-[9px] border px-3 py-[6px] text-[11px] font-semibold disabled:opacity-40 ${
            configured ? 'border-danger/25 text-danger' : 'border-white/15 text-ink-body'
          }`}
        >
          {configured ? '解绑' : '绑定'}
        </button>
      </div>
    </div>
  );
}

function BindSheet({ kind, onClose }: { kind: NotifyKind; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = useState('');
  const mutation = useMutation({
    mutationFn: () => saveNotifyBinding(kind, webhookUrl.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notify-bindings'] });
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!webhookUrl.trim()) return;
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <form
        onSubmit={submit}
        className="absolute inset-x-0 bottom-0 mx-auto max-w-[430px] rounded-t-3xl border-t border-white/10 bg-sheet px-[18px] pt-5 pb-[max(env(safe-area-inset-bottom),30px)]"
      >
        <div className="mx-auto mb-[18px] h-1 w-[38px] rounded-sm bg-white/15" />
        <div className="text-[17px] font-bold">绑定 {NOTIFY_META[kind].title}</div>
        <div className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          在专用 Discord 频道中新建 webhook，把完整 URL 粘贴到这里。保存后只显示绑定状态，不回显地址。
        </div>
        <input
          type="url"
          inputMode="url"
          value={webhookUrl}
          onChange={(event) => setWebhookUrl(event.target.value)}
          placeholder="https://discord.com/api/webhooks/…"
          className="mt-[18px] w-full rounded-xl border border-white/10 bg-inset px-3.5 py-[13px] text-[12.5px] text-ink outline-none placeholder:text-ink-faintest"
        />
        {mutation.isError && (
          <div className="mt-2 text-xs text-danger">保存失败：{mutation.error.message}</div>
        )}
        <button
          type="submit"
          disabled={!webhookUrl.trim() || mutation.isPending}
          className="mt-3 w-full rounded-[13px] bg-discord py-3.5 text-[15px] font-bold text-white disabled:opacity-40"
        >
          {mutation.isPending ? '正在加密保存…' : '加密保存'}
        </button>
        <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-ink-faintest">
          <LockIcon /> Webhook URL 是凭据，不会写入日志
        </div>
      </form>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
      <path d="M5 12l5 5L20 6" />
    </svg>
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
