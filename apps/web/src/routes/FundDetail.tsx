import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Change, Money } from '../components/Money';
import { PrecisionBadge } from '../components/PrecisionBadge';
import { SubPage } from '../components/AppShell';
import { ErrorState, FreshnessLine } from '../components/states';
import { Card, IconCircle, InfoBar, WarnBar } from '../components/ui';
import {
  createTransaction,
  fetchFundQuotes,
  fetchHoldings,
  fetchPositions,
  searchFunds,
  shortType,
  type CreateTransactionInput,
} from '../lib/api';
import { formatNav, formatShares, staleDays } from '../lib/format';
import { positionPresentation } from '../lib/portfolio';
import { useSessionQuery } from './Auth';

function beijingToday(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function FundDetail() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const session = useSessionQuery();
  const [editingPosition, setEditingPosition] = useState(false);
  const validCode = code && /^\d{6}$/.test(code) ? code : null;
  const info = useQuery({
    queryKey: ['fund-search-exact', validCode],
    queryFn: async () => (await searchFunds(validCode!)).find((hit) => hit.code === validCode) ?? null,
    enabled: validCode !== null,
  });
  const holdings = useQuery({
    queryKey: ['fund-holdings', validCode],
    queryFn: () => fetchHoldings(validCode!),
    enabled: validCode !== null,
  });
  const quotes = useQuery({
    queryKey: ['fund-quotes', validCode],
    queryFn: () => fetchFundQuotes(validCode!),
    enabled: validCode !== null,
    refetchInterval: 60_000,
  });
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: fetchPositions,
    enabled: session.data !== undefined,
  });
  const fund = info.data;
  const position = positions.data?.positions.find((candidate) => candidate.fundCode === validCode);
  const loading = info.isPending || holdings.isPending || quotes.isPending;
  const coldError =
    validCode === null || info.isError || holdings.isError || quotes.isError || (!loading && !fund);

  const bottomBar = validCode ? (
    <ActionBar
      signedIn={session.data !== undefined}
      onLogin={() => navigate('/')}
      onEdit={() => setEditingPosition(true)}
      hasPosition={position !== undefined}
    />
  ) : undefined;

  if (loading) {
    return (
      <SubPage bottomBar={bottomBar}>
        <DetailHeader onBack={() => navigate(-1)} />
        <div className="py-16 text-center text-sm text-ink-muted">正在读取基金资料…</div>
      </SubPage>
    );
  }

  if (coldError || !fund || !holdings.data || !quotes.data) {
    return (
      <SubPage bottomBar={bottomBar}>
        <DetailHeader onBack={() => navigate(-1)} />
        <ErrorState
          description={validCode === null ? '基金代码格式非法。' : '基金资料或持仓披露暂时不可用。'}
          onRetry={() => {
            void info.refetch();
            void holdings.refetch();
            void quotes.refetch();
          }}
        />
      </SubPage>
    );
  }

  const valuation = position?.valuation ?? null;
  const presentedPosition = position ? positionPresentation(position) : null;
  const quoteBySecid = quotes.data.quotes;
  const reportAge = holdings.data.reportDate ? staleDays(holdings.data.reportDate) : null;

  return (
    <SubPage bottomBar={bottomBar}>
      <DetailHeader onBack={() => navigate(-1)} />

      <div className="px-0.5 pt-2 pb-1">
        <h1 className="text-xl leading-tight font-bold">{fund.name}</h1>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[12.5px] text-ink-dimmer">{fund.code}</span>
          <span className="rounded-md bg-white/6 px-2 py-[3px] text-[11px] text-[#9aa0a8]">
            {shortType(fund.type)}
          </span>
        </div>
      </div>

      <div className="flex items-end gap-5 px-0.5 pt-4 pb-0.5">
        <div>
          <div className="text-xs text-ink-muted">{fund.isMoneyFund ? '万份收益' : '最新净值'}</div>
          <div className="mt-1 text-[32px] leading-[1.1] font-bold tracking-tight">
            {fund.nav === null ? '——' : formatNav(fund.nav)}
          </div>
          <div className="mt-[3px] text-[11px] text-ink-faint">
            {fund.navDate ? `${fund.navDate} 官方` : '官方值待更新'}
          </div>
        </div>
        {valuation && valuation.estNav !== null && (
          <div className="flex-1 pb-0.5">
            <div className="flex items-center gap-[7px]">
              <span className="text-xs text-ink-faintest">盘中估算</span>
              <PrecisionBadge precision={valuation.precision} size="sm" />
            </div>
            <div className="mt-[5px] flex items-baseline gap-2">
              <span className="text-[19px] font-semibold italic text-[#aeb2ba]">
                {formatNav(valuation.estNav)}
              </span>
              <Change value={valuation.estChgPct} className="text-sm italic" />
            </div>
          </div>
        )}
      </div>

      {position && (
        <Card className="mt-[18px]">
          <div className="mb-3.5 text-[13px] font-semibold">我的持有</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field label="持有份额">{formatShares(position.shares)}</Field>
            <Field label="持仓成本">{formatNav(position.costPerShare)}</Field>
            <Field label="参考市值">
              {presentedPosition!.marketValue === null ? (
                '——'
              ) : (
                <Money value={presentedPosition!.marketValue} />
              )}
            </Field>
            <Field label="持有收益">
              {presentedPosition!.holdingReturn === null ? (
                '——'
              ) : (
                <>
                  <Money
                    value={presentedPosition!.holdingReturn}
                    sign
                    colored
                    className="font-bold"
                  />
                  <Change
                    value={presentedPosition!.holdingReturnPct}
                    className="ml-1 text-xs font-semibold"
                  />
                </>
              )}
            </Field>
          </div>
          {presentedPosition!.marketValue === null && (
            <div className="mt-3">
              <InfoBar>持仓已保存，官方净值正在后台同步；份额与累计成本不受影响。</InfoBar>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-3.5">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[13px] font-semibold">前十大重仓股</div>
          {reportAge !== null && reportAge > 30 && (
            <span className="rounded-[7px] border border-warn/25 bg-warn/10 px-2 py-[3px] text-[10.5px] font-semibold text-warn">
              已过 {reportAge} 天
            </span>
          )}
        </div>
        <div className="mb-3 text-[11px] text-ink-faint">
          报告期 {holdings.data.reportDate ?? '未知'} · 覆盖基金净值 {holdings.data.coverageWeight.toFixed(2)}%
        </div>
        {(holdings.data.stale || quotes.data.holdingsStale || quotes.data.delayed) && (
          <div className="mb-3">
            <WarnBar>
              {holdings.data.stale || quotes.data.holdingsStale ? '当前使用陈旧持仓披露；' : ''}
              {quotes.data.delayed ? '股票行情来自延时源' : ''}
            </WarnBar>
          </div>
        )}
        <div className="flex border-b border-line-soft pb-2 text-[10.5px] text-ink-faintest">
          <div className="flex-[1.5]">股票</div>
          <div className="w-[70px] text-right">占净值比</div>
          <div className="w-[60px] text-right">当日</div>
        </div>
        {holdings.data.holdings.map((holding, index) => (
          <div
            key={holding.stockCode}
            className={`flex items-center py-[11px] ${
              index < holdings.data.holdings.length - 1 ? 'border-b border-line-faint' : ''
            }`}
          >
            <div className="flex-[1.5]">
              <div className="text-[13px] font-medium">{holding.stockName}</div>
              <div className="mt-0.5 text-[10.5px] text-ink-dimmer">{holding.stockCode}</div>
            </div>
            <div className="w-[70px] text-right text-[13px] text-ink-soft">
              {holding.weight.toFixed(2)}%
            </div>
            <Change
              value={holding.secid ? (quoteBySecid[holding.secid]?.chgPct ?? null) : null}
              className="w-[60px] text-right text-[12.5px]"
            />
          </div>
        ))}
        <FreshnessLine
          at={quotes.data.fetchedAt}
          onRetry={() => void quotes.refetch()}
          liveNote={`行情源 ${quotes.data.provider ?? '不可用'}`}
        />
      </Card>

      <div className="mt-3.5">
        <InfoBar>
          前十大持仓只覆盖基金净值的 {holdings.data.coverageWeight.toFixed(2)}%，未披露部分不纳入股票敞口。
        </InfoBar>
      </div>

      {editingPosition && validCode && (
        <PositionSheet
          fundCode={validCode}
          current={position ? { shares: position.shares, costTotal: position.costTotal } : null}
          onClose={() => setEditingPosition(false)}
        />
      )}
    </SubPage>
  );
}

function PositionSheet({
  fundCode,
  current,
  onClose,
}: {
  fundCode: string;
  current: { shares: number; costTotal: number } | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [tradeDate, setTradeDate] = useState(beijingToday());
  const [shares, setShares] = useState(current ? String(current.shares) : '');
  const [amount, setAmount] = useState(current ? String(current.costTotal) : '');
  const [note, setNote] = useState('');
  const mutation = useMutation({
    mutationFn: (input: CreateTransactionInput) => createTransaction(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['positions'] }),
        queryClient.invalidateQueries({ queryKey: ['xray'] }),
      ]);
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedShares = Number(shares);
    const parsedAmount = Number(amount);
    if (
      !Number.isFinite(parsedShares) ||
      parsedShares <= 0 ||
      !Number.isFinite(parsedAmount) ||
      parsedAmount < 0
    ) {
      return;
    }
    mutation.mutate({
      fundCode,
      type: 'SNAPSHOT',
      tradeDate,
      confirmDate: tradeDate,
      shares: parsedShares,
      amount: parsedAmount,
      price: null,
      fee: 0,
      status: 'CONFIRMED',
      note: note.trim() || null,
    });
  };

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" onClick={onClose} aria-label="关闭" className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <form
        onSubmit={submit}
        className="absolute inset-x-0 bottom-0 mx-auto max-w-[430px] rounded-t-3xl border-t border-white/10 bg-sheet px-[18px] pt-5 pb-[max(env(safe-area-inset-bottom),30px)]"
      >
        <div className="mx-auto mb-[18px] h-1 w-[38px] rounded-sm bg-white/15" />
        <div className="text-[17px] font-bold">{current ? '更新' : '录入'}当前持仓</div>
        <div className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          填当前确认份额与累计成本；保存后以这组数为准。
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <FieldInput label="记录日期" type="date" value={tradeDate} onChange={setTradeDate} />
          <FieldInput label="份额" type="number" value={shares} onChange={setShares} step="0.01" />
          <FieldInput label="累计成本" type="number" value={amount} onChange={setAmount} step="0.01" />
        </div>
        <label className="mt-4 block text-xs text-ink-muted">
          备注（可选）
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            className="mt-2 w-full rounded-xl border border-line-strong bg-inset px-3 py-2.5 text-sm text-ink outline-none"
          />
        </label>
        {mutation.isError && <div className="mt-2 text-xs text-danger">保存失败：{mutation.error.message}</div>}
        <button
          type="submit"
          disabled={mutation.isPending || !shares || !amount}
          className="mt-4 w-full rounded-[13px] bg-accent py-3.5 text-[15px] font-bold text-white disabled:opacity-40"
        >
          {mutation.isPending ? '正在保存…' : '保存持仓'}
        </button>
      </form>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type: 'date' | 'number';
  step?: string;
}) {
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <input
        type={type}
        inputMode={type === 'number' ? 'decimal' : undefined}
        step={step}
        min={type === 'number' ? '0' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-xl border border-line-strong bg-inset px-3 py-2.5 text-sm text-ink outline-none"
      />
    </label>
  );
}

function DetailHeader({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-3 px-0.5 pt-[18px] pb-1.5">
      <IconCircle onClick={onBack}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </IconCircle>
      <div className="flex-1 text-[13px] text-ink-muted">基金详情</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-ink-dimmer">{label}</div>
      <div className="mt-1 text-[15px] font-medium text-ink-soft">{children}</div>
    </div>
  );
}

function ActionBar({
  signedIn,
  hasPosition,
  onLogin,
  onEdit,
}: {
  signedIn: boolean;
  hasPosition: boolean;
  onLogin: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[430px] gap-3 border-t border-line-soft bg-[rgba(12,13,17,.94)] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)] backdrop-blur-xl">
      {signedIn ? (
        <button type="button" onClick={onEdit} className="w-full rounded-[13px] bg-accent py-3.5 text-[15px] font-bold text-white">
          {hasPosition ? '更新当前持仓' : '录入当前持仓'}
        </button>
      ) : (
        <button type="button" onClick={onLogin} className="w-full rounded-[13px] bg-accent py-3.5 text-[15px] font-bold text-white">登录后记录持仓</button>
      )}
    </div>
  );
}
