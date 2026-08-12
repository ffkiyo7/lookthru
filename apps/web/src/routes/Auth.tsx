import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';
import { Card, Segmented } from '../components/ui';
import {
  ApiError,
  fetchSession,
  recoverSession,
  redeemInvite,
  type SessionResponse,
} from '../lib/api';

export const SESSION_QUERY_KEY = ['session'] as const;

export function useSessionQuery() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function RequireSession() {
  const session = useSessionQuery();

  if (session.isPending) return <AuthFrame>正在检查会话…</AuthFrame>;
  if (session.data) return <Outlet />;
  if (session.error instanceof ApiError && session.error.status === 401) return <AuthScreen />;

  return (
    <AuthFrame>
      <div className="text-danger">会话检查失败</div>
      <div className="mt-2 text-xs text-ink-muted">
        {session.error instanceof Error ? session.error.message : '未知错误'}
      </div>
      <button type="button" onClick={() => void session.refetch()} className={PRIMARY_BUTTON}>
        重试
      </button>
    </AuthFrame>
  );
}

function AuthScreen() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'invite' | 'recovery'>('invite');
  const [code, setCode] = useState('');
  const [redeemed, setRedeemed] = useState<SessionResponse & { recoveryCode: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      mode === 'invite' ? redeemInvite(code.trim()) : recoverSession(code.trim()),
    onSuccess: (result) => {
      if ('recoveryCode' in result && typeof result.recoveryCode === 'string') {
        setRedeemed({ userId: result.userId, recoveryCode: result.recoveryCode });
        return;
      }
      queryClient.setQueryData(SESSION_QUERY_KEY, result);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    mutation.reset();
    mutation.mutate();
  };

  if (redeemed) {
    const enter = () => {
      queryClient.setQueryData<SessionResponse>(SESSION_QUERY_KEY, { userId: redeemed.userId });
    };
    return (
      <AuthFrame>
        <Card className="w-full max-w-[390px] text-left">
          <div className="text-lg font-bold">保存恢复码</div>
          <div className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            它只显示这一次。换设备或浏览器数据丢失时，需要用它恢复登录。
          </div>
          <div className="mt-4 break-all rounded-xl border border-warn/25 bg-warn/8 px-3.5 py-3 font-mono text-sm leading-relaxed text-ink">
            {redeemed.recoveryCode}
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(redeemed.recoveryCode);
                setCopied(true);
                setCopyError(null);
              } catch (error) {
                setCopyError(error instanceof Error ? error.message : '复制失败');
              }
            }}
            className="mt-3 w-full rounded-xl border border-accent/35 bg-accent/12 py-2.5 text-sm font-semibold text-accent-soft"
          >
            {copied ? '已复制' : '复制恢复码'}
          </button>
          {copyError && <div className="mt-2 text-xs text-danger">复制失败：{copyError}</div>}
          <button type="button" onClick={enter} className={PRIMARY_BUTTON}>
            我已妥善保存，进入
          </button>
        </Card>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <Card className="w-full max-w-[390px] text-left">
        <div className="text-xl font-bold tracking-wide">lookthru</div>
        <div className="mt-1.5 text-[13px] text-ink-muted">邀请码制基金持仓追踪</div>
        <div className="mt-5">
          <Segmented
            value={mode}
            onChange={(next) => {
              setMode(next);
              setCode('');
              mutation.reset();
            }}
            options={[
              { value: 'invite', label: '邀请码' },
              { value: 'recovery', label: '恢复码' },
            ]}
          />
        </div>
        <form onSubmit={submit} className="mt-4">
          <label htmlFor="auth-code" className="text-xs text-ink-muted">
            {mode === 'invite' ? '兑换邀请码' : '使用恢复码换设备登录'}
          </label>
          <input
            id="auth-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mt-2 w-full rounded-xl border border-line-strong bg-inset px-3.5 py-3 text-sm text-ink outline-none focus:border-accent/60"
          />
          {mutation.isError && (
            <div className="mt-2 text-xs text-danger">
              {mutation.error instanceof Error ? mutation.error.message : '登录失败'}
            </div>
          )}
          <button
            type="submit"
            disabled={!code.trim() || mutation.isPending}
            className={`${PRIMARY_BUTTON} disabled:opacity-40`}
          >
            {mutation.isPending ? '正在验证…' : mode === 'invite' ? '兑换并登录' : '恢复登录'}
          </button>
        </form>
      </Card>
    </AuthFrame>
  );
}

const PRIMARY_BUTTON =
  'mt-4 w-full rounded-[13px] bg-accent py-3 text-sm font-bold text-white active:opacity-80';

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="safe-x safe-top mx-auto flex min-h-dvh max-w-[430px] items-center justify-center pb-[max(env(safe-area-inset-bottom),24px)] text-center">
      {typeof children === 'string' ? (
        <div className="text-sm text-ink-muted">{children}</div>
      ) : (
        children
      )}
    </main>
  );
}
