import { useState } from 'react';
import { Change, Money } from '../components/Money';
import { Donut } from '../components/charts';
import { Card } from '../components/ui';
import {
  MOCK_EXPOSURE,
  MOCK_SECTORS,
  MOCK_XRAY_META,
  type ExposureRow,
} from '../lib/mock';

/**
 * 持仓穿透 —— 本产品的杀手锏。
 * 把所有持仓基金的前十大重仓股加权汇总，看到股票级真实敞口与重复押注。
 * 「被 N 只基金持有」可展开，是全页信息核心。
 */
export function XRay() {
  const meta = MOCK_XRAY_META;
  const max = MOCK_EXPOSURE[0]?.pct ?? 1;

  return (
    <>
      <header className="flex items-center gap-2.5 px-0.5 pt-5 pb-3.5">
        <h1 className="text-xl font-bold tracking-wide">持仓穿透</h1>
        <span className="rounded-[7px] border border-accent/25 bg-accent/13 px-2.5 py-0.5 text-[11px] font-semibold text-accent-soft">
          看穿真实敞口
        </span>
      </header>

      <div className="flex items-start gap-2.5 rounded-[14px] border border-warn/20 bg-warn/8 px-3.5 py-3.5">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          className="mt-px shrink-0 text-warn"
        >
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16.5" strokeLinecap="round" />
          <circle cx="12" cy="7.6" r=".5" fill="currentColor" />
        </svg>
        <div className="text-xs leading-relaxed text-[#d8c9a8]">
          穿透你持有的 <b className="text-[#f0d5a8]">{meta.fundCount} 只基金</b>，合计覆盖{' '}
          <b className="text-[#f0d5a8]">{meta.coveragePct}%</b> 的净值。基于各基金{' '}
          {meta.reportQuarter} 季报，<b className="text-warn">数据已过期 {meta.staleDays} 天</b>。
        </div>
      </div>

      <div className="flex items-baseline justify-between px-0.5 pt-6 pb-1">
        <div className="text-[15px] font-semibold">真实股票敞口</div>
        <div className="text-[11px] text-ink-faint">占总资产比 · 降序</div>
      </div>
      <div className="px-0.5 pb-3.5 text-[11px] text-ink-faintest">
        点开「被 N 只基金持有」看重复押注明细
      </div>

      <div className="flex flex-col gap-[11px]">
        {MOCK_EXPOSURE.map((row, i) => (
          <ExposureCard key={row.stockCode} row={row} rank={i + 1} maxPct={max} />
        ))}
      </div>

      {/* 行业集中度 */}
      <Card className="mt-5 px-4 py-[18px]" padded={false}>
        <div className="mb-1.5 text-[15px] font-semibold">行业集中度</div>
        <div className="flex items-center gap-[18px]">
          <div className="relative size-[130px] shrink-0">
            <Donut segments={MOCK_SECTORS} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[11px] text-ink-muted">最大行业</div>
              <div className="mt-px text-[12.5px] font-semibold text-ink">
                {MOCK_SECTORS[0]!.name}
              </div>
              <div className="text-base font-bold text-accent">{MOCK_SECTORS[0]!.pct}%</div>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-[11px]">
            {MOCK_SECTORS.map((s) => (
              <div key={s.name} className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
                <span className="flex-1 text-[12.5px] text-ink-body">{s.name}</span>
                <span className="text-[12.5px] font-semibold">{s.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 集中度提示 —— 客观指标，不构成投资建议 */}
      <div className="mt-3.5 rounded-[18px] border border-line-card bg-[linear-gradient(158deg,#1c1f27,#131519)] p-4">
        <div className="mb-2.5 flex items-center gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent-soft"
          >
            <path d="M3 3v18h18" />
            <path d="M7 14l4-4 3 3 5-6" />
          </svg>
          <div className="text-[13.5px] font-semibold">集中度提示</div>
        </div>
        <div className="text-[13px] leading-relaxed text-[#c8ccd3]">
          前 5 大重仓股占总资产 <b className="text-ink">{meta.top5Pct}%</b>，单一行业（
          {MOCK_SECTORS[0]!.name}）占 <b className="text-ink">{MOCK_SECTORS[0]!.pct}%</b>。集中度
          <b className="text-ink">高于</b>你持仓基金的平均水平。
        </div>
        <div className="mt-3 border-t border-line-soft pt-[11px] text-[11px] text-ink-faintest">
          以上为客观指标，不构成投资建议
        </div>
      </div>
    </>
  );
}

function ExposureCard({ row, rank, maxPct }: { row: ExposureRow; rank: number; maxPct: number }) {
  const [open, setOpen] = useState(false);
  const multi = row.funds.length >= 2;

  return (
    <div
      className={`rounded-2xl border bg-card p-3.5 transition-colors ${
        open ? 'border-accent/35' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-[11px]">
        <div className="mt-px flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-chip text-xs font-bold text-[#9aa0a8]">
          {rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-tight font-semibold">{row.stockName}</div>
          <div className="mt-0.5 text-[11px] text-ink-dimmer">{row.stockCode}</div>
        </div>
        <div className="text-right">
          <div className="text-lg leading-none font-bold">{row.pct.toFixed(2)}%</div>
          <div className="mt-1 text-[11.5px] text-ink-muted">
            <Money value={row.value} />
          </div>
        </div>
      </div>

      <div className="my-3 h-1.5 overflow-hidden rounded-[3px] bg-inset">
        <div
          className="h-full rounded-[3px] bg-[linear-gradient(90deg,#8b7cf0,#a99bf5)]"
          style={{ width: `${(row.pct / maxPct) * 100}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`inline-flex items-center gap-[7px] rounded-[9px] border px-[11px] py-1.5 text-xs font-semibold ${
            multi
              ? 'border-accent/35 bg-accent/14 text-accent-soft'
              : 'border-line-strong bg-white/5 text-ink-muted'
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l9 5-9 5-9-5z" />
            <path d="M3 13l9 5 9-5" />
          </svg>
          被 {row.funds.length} 只基金持有
          <span
            className="inline-flex transition-transform duration-150"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </button>
        <div className="text-[12.5px] font-semibold">
          <span className="text-ink-muted">今日 </span>
          <Change value={row.chgPct} />
        </div>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-dashed border-white/10 pt-3">
          {row.funds.map((f) => (
            <div key={f.name} className="flex items-center gap-2.5">
              <span className="size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 text-[12.5px] text-ink-body">{f.name}</span>
              <span className="text-xs text-ink-muted">
                贡献 <b className="text-[#e6e7ea]">{f.contribPct.toFixed(2)}%</b>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
