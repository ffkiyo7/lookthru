import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Change, Money } from '../components/Money';
import { PrecisionBadge } from '../components/PrecisionBadge';
import { SubPage } from '../components/AppShell';
import { NavChart, genSeries } from '../components/charts';
import { Card, IconCircle, InfoBar } from '../components/ui';
import { formatNav, formatShares, formatYi } from '../lib/format';
import { MOCK_FUND_DETAIL, MOCK_HOLDINGS, MOCK_POSITIONS } from '../lib/mock';

const PERIODS = [
  { value: '1m', label: '近1月' },
  { value: '3m', label: '近3月' },
  { value: '1y', label: '近1年' },
  { value: '3y', label: '近3年' },
  { value: 'all', label: '成立以来' },
] as const;

type Period = (typeof PERIODS)[number]['value'];

const SERIES: Record<Period, number[]> = {
  '1m': genSeries(30, 0.552, 0.028, 0.0004, 17),
  '3m': genSeries(45, 0.6, 0.03, -0.0018, 23),
  '1y': genSeries(52, 0.71, 0.035, -0.0035, 41),
  '3y': genSeries(60, 0.42, 0.04, 0.0028, 59),
  all: genSeries(64, 1.0, 0.05, -0.0045, 73),
};

export function FundDetail() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>('1y');

  const d = MOCK_FUND_DETAIL;
  const position = useMemo(() => MOCK_POSITIONS.find((p) => p.fundCode === code), [code]);
  const valuation = position?.valuation ?? null;

  return (
    <SubPage bottomBar={<ActionBar />}>
      <div className="flex items-center gap-3 px-0.5 pt-[18px] pb-1.5">
        <IconCircle onClick={() => navigate(-1)}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </IconCircle>
        <div className="flex-1 text-[13px] text-ink-muted">基金详情</div>
      </div>

      {/* 1 · 头部 */}
      <div className="px-0.5 pt-2 pb-1">
        <h1 className="text-xl leading-tight font-bold">{d.name}</h1>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[12.5px] text-ink-dimmer">{d.code}</span>
          <span className="rounded-md bg-white/6 px-2 py-[3px] text-[11px] text-[#9aa0a8]">
            {d.typeLabel}
          </span>
        </div>
      </div>

      <div className="flex items-end gap-5 px-0.5 pt-4 pb-0.5">
        <div>
          <div className="text-xs text-ink-muted">最新净值</div>
          <div className="mt-1 text-[32px] leading-[1.1] font-bold tracking-tight">
            {formatNav(d.officialNav)}
          </div>
          <div className="mt-[3px] text-[11px] text-ink-faint">{d.officialDate} 官方</div>
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

      {/* 2 · 净值走势 */}
      <Card className="mt-[18px] px-3.5 pt-4 pb-3.5" padded={false}>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[13px] font-semibold">净值走势</div>
          <div className="text-[11px] text-ink-faint">仅官方净值 · 不含盘中估算</div>
        </div>
        <NavChart data={SERIES[period]} />
        <div className="mt-3.5 flex gap-1.5 rounded-[10px] bg-inset p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPeriod(p.value)}
              className={`flex-1 rounded-[7px] py-[7px] text-[11.5px] transition-colors ${
                period === p.value ? 'bg-chip font-semibold text-ink' : 'text-ink-dim'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Card>

      {/* 3 · 我的持有 */}
      {position && (
        <Card className="mt-3.5">
          <div className="mb-3.5 text-[13px] font-semibold">我的持有</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field label="持有份额">{formatShares(position.shares)}</Field>
            <Field label="持仓成本">{formatNav(position.costPerShare)}</Field>
            <Field label="参考市值">
              <Money value={position.marketValue} />
            </Field>
            <Field label="持有收益">
              <Money value={position.holdingReturn} sign colored className="font-bold" />
              <Change value={position.holdingReturnPct} className="ml-1 text-xs font-semibold" />
            </Field>
          </div>
          {/* 纯事实提示，不构成建议 —— 但可能是全站最实用的一条 */}
          <div className="mt-4">
            <InfoBar>
              持有 {d.heldDays} 天，7 日内赎回费 <b className="text-[#e6ecf7]">1.5%</b>，再持有{' '}
              {7 - d.heldDays} 天可降至 <b className="text-[#e6ecf7]">0.5%</b>
            </InfoBar>
          </div>
        </Card>
      )}

      {/* 4 · 前十大重仓股 */}
      <Card className="mt-3.5">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[13px] font-semibold">前十大重仓股</div>
          <span className="rounded-[7px] border border-warn/25 bg-warn/10 px-2 py-[3px] text-[10.5px] font-semibold text-warn">
            已过期 {MOCK_POSITIONS[1]!.valuation!.basis.staleDays} 天
          </span>
        </div>
        <div className="mb-3 text-[11px] text-ink-faint">报告期 {d.reportDate}</div>

        <div className="flex border-b border-line-soft pb-2 text-[10.5px] text-ink-faintest">
          <div className="flex-[1.5]">股票</div>
          <div className="w-[60px] text-right">占净值比</div>
          <div className="w-[60px] text-right">当日</div>
          <div className="w-14 text-right">较上期</div>
        </div>

        {MOCK_HOLDINGS.map((h, i) => (
          <div
            key={h.stockCode}
            className={`flex items-center py-[11px] ${
              i < MOCK_HOLDINGS.length - 1 ? 'border-b border-line-faint' : ''
            }`}
          >
            <div className="flex-[1.5]">
              <div className="text-[13px] font-medium">{h.stockName}</div>
              <div className="mt-0.5 text-[10.5px] text-ink-dimmer">{h.stockCode}</div>
            </div>
            <div className="w-[60px] text-right text-[13px] text-ink-soft">
              {h.weight.toFixed(2)}%
            </div>
            <Change value={h.chgPct} className="w-[60px] text-right text-[12.5px]" />
            <div className="w-14 text-right text-[11px] text-ink-muted">{h.delta}</div>
          </div>
        ))}

        <div className="mt-1.5 flex items-center justify-between border-t border-line-strong pt-3">
          <span className="text-xs text-ink-muted">合计占净值比</span>
          <span className="text-sm font-bold text-ink-soft">{d.coverageWeight.toFixed(2)}%</span>
        </div>
      </Card>

      {/* 5 · 资产配置 */}
      <Card className="mt-3.5">
        <div className="mb-3.5 text-[13px] font-semibold">资产配置</div>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-md">
          <div style={{ width: `${d.allocation.stock}%` }} className="bg-accent" />
          <div style={{ width: `${d.allocation.cash}%` }} className="bg-[#4a5568]" />
        </div>
        <div className="mt-3.5 flex justify-between">
          <Legend color="var(--color-accent)" label="股票" value={`${d.allocation.stock}%`} />
          <Legend color="#2c3038" label="债券" value={`${d.allocation.bond}%`} dim />
          <Legend color="#4a5568" label="现金" value={`${d.allocation.cash}%`} />
        </div>
      </Card>

      {/* 6 · 基金经理 */}
      <Card className="mt-3.5">
        <div className="mb-3.5 text-[13px] font-semibold">基金经理</div>
        <div className="flex items-center gap-3.5">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-line-strong bg-[linear-gradient(150deg,#2a2d36,#1a1c22)] text-lg font-semibold text-ink-body">
            {d.manager.name[0]}
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-semibold">{d.manager.name}</div>
            <div className="mt-[3px] text-[11.5px] text-ink-muted">
              从业 {d.manager.workTime} · 管理 {d.manager.fundCount} 只基金
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-ink-dimmer">管理规模</div>
            <div className="mt-[3px] text-[15px] font-semibold">{d.manager.fundSize}</div>
          </div>
        </div>
      </Card>

      {/* 7 · 费率 */}
      <Card className="mt-3.5">
        <div className="mb-3.5 text-[13px] font-semibold">费率</div>
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-ink-body">申购费</span>
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] text-ink-dimmer line-through">
              {d.rate.source.toFixed(2)}%
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5f636b"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span className="text-[15px] font-bold text-up">{d.rate.current.toFixed(2)}%</span>
            <span className="rounded-md bg-up/12 px-[7px] py-0.5 text-[10px] font-semibold text-up">
              {(d.rate.current / d.rate.source) * 10 < 1
                ? `${((d.rate.current / d.rate.source) * 10).toFixed(1)}折`
                : `${Math.round((d.rate.current / d.rate.source) * 10)}折`}
            </span>
          </div>
        </div>
      </Card>

      {/* 8 · 规模变化 */}
      <Card className="mt-3.5">
        <div className="mb-3.5 text-[13px] font-semibold">规模变化</div>
        <div className="flex items-end justify-between">
          <div>
            <div className="text-2xl font-bold">
              {formatYi(d.scale.value)}
              <span className="text-sm font-medium text-ink-muted">亿</span>
            </div>
            <div className="mt-1 text-[11px] text-ink-faint">截至 {d.scale.date}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-ink-dimmer">环比上季</div>
            <Change value={d.scale.momPct} className="mt-[3px] block text-base font-bold" />
          </div>
        </div>
      </Card>
    </SubPage>
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

function Legend({
  color,
  label,
  value,
  dim,
}: {
  color: string;
  label: string;
  value: string;
  dim?: boolean;
}) {
  return (
    <div className="flex items-center gap-[7px]">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      <div>
        <div className="text-[11px] text-ink-muted">{label}</div>
        <div className={`mt-0.5 text-sm font-semibold ${dim ? 'text-ink-dimmer' : ''}`}>{value}</div>
      </div>
    </div>
  );
}

function ActionBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[430px] gap-3 border-t border-line-soft bg-[rgba(12,13,17,.94)] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)] backdrop-blur-xl">
      <button
        type="button"
        className="flex-1 rounded-[13px] bg-up py-3.5 text-[15px] font-bold text-white"
      >
        记录买入
      </button>
      <button
        type="button"
        className="flex-1 rounded-[13px] border border-down/50 bg-down/10 py-3.5 text-[15px] font-bold text-down"
      >
        记录卖出
      </button>
    </div>
  );
}
