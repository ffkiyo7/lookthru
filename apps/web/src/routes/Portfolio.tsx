import { Link } from 'react-router-dom';
import type { Position } from '@qd2/shared';
import { Change, Money } from '../components/Money';
import { PrecisionBadge, PrecisionLegend } from '../components/PrecisionBadge';
import { Card, IconCircle, WarnBar } from '../components/ui';
import { formatNav, formatShares } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { MOCK_POSITIONS, summarize } from '../lib/mock';

export function Portfolio() {
  const positions = MOCK_POSITIONS;
  const s = summarize(positions);
  const { updown } = usePrefs();

  return (
    <>
      <header className="flex items-center justify-between px-0.5 pt-[22px] pb-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-xl font-bold tracking-wide">我的持仓</h1>
          <div className="text-xs text-ink-faint">
            {positions.length} 只基金 · {updown === 'red-up' ? '红涨绿跌' : '绿涨红跌'}
          </div>
        </div>
        <Link to="/settings">
          <IconCircle>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
            </svg>
          </IconCircle>
        </Link>
      </header>

      {/* 汇总 */}
      <div className="rounded-[22px] border border-line-card bg-[linear-gradient(158deg,#1c1f27_0%,#131519_78%)] px-5 pt-[22px] pb-[18px] shadow-[0_8px_30px_rgba(0,0,0,.35)]">
        <div className="text-[12.5px] tracking-wide text-ink-muted">总资产（估算）</div>
        <div className="mt-1.5 text-4xl leading-none font-bold tracking-tight">
          <Money value={s.marketValue} />
        </div>

        <div className="mt-5 flex gap-3.5">
          <SummaryTile label="今日收益" amount={s.dayReturn} pct={s.dayReturnPct} />
          <SummaryTile label="持有收益" amount={s.holdingReturn} pct={s.holdingReturnPct} />
        </div>

        <div className="mt-4 flex items-center gap-[7px] text-[11.5px] text-ink-dimmer">
          <span className="size-1.5 shrink-0 animate-ecpulse rounded-full bg-up" />
          <span>估算 · 14:23 更新 · 收盘后以官方净值为准</span>
        </div>

        {s.unestimatedCount > 0 && (
          <div className="mt-2 text-[11px] text-ink-faintest">
            其中 {s.unestimatedCount} 只不提供盘中估算，未计入今日收益
          </div>
        )}
      </div>

      <div className="flex items-baseline justify-between px-0.5 pt-6 pb-3">
        <div className="text-[15px] font-semibold">持仓明细</div>
        <PrecisionLegend />
      </div>

      <div className="flex flex-col gap-[13px]">
        {positions.map((p) => (
          <PositionCard key={p.fundCode} position={p} />
        ))}
      </div>
    </>
  );
}

function SummaryTile({ label, amount, pct }: { label: string; amount: number; pct: number }) {
  const tone = amount >= 0 ? 'border-up/15 bg-up/8' : 'border-down/15 bg-down/8';
  return (
    <div className={`flex-1 rounded-[14px] border px-3.5 py-3 ${tone}`}>
      <div className="text-[11.5px] text-ink-muted">{label}</div>
      <div className="mt-[5px] text-lg font-bold">
        <Money value={amount} sign colored />
      </div>
      <Change value={pct} className="mt-0.5 block text-xs opacity-85" />
    </div>
  );
}

function PositionCard({ position: p }: { position: Position }) {
  const v = p.valuation;
  const estimable = v !== null && v.precision !== 'NONE' && v.estNav !== null;

  return (
    <Link to={`/fund/${p.fundCode}`} className="block">
      <Card className="flex flex-col gap-[13px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] leading-tight font-semibold">{p.fundName}</div>
            <div className="mt-[3px] text-xs text-ink-dimmer">{p.fundCode}</div>
          </div>
          {v && <PrecisionBadge precision={v.precision} />}
        </div>

        {/* 估算值用斜体+灰，官方净值用正常字重 —— 两个「真相」必须视觉可分 */}
        {estimable ? (
          <div className="flex items-baseline gap-2.5">
            <span className="text-xs text-ink-faintest">估算净值</span>
            <span className="text-[21px] font-semibold italic text-[#aeb2ba]">
              {formatNav(v.estNav!)}
            </span>
            <Change value={v.estChgPct} className="text-sm italic" />
          </div>
        ) : (
          <div className="flex items-baseline gap-2.5">
            <span className="text-xs text-ink-faintest">官方净值</span>
            <span className="text-[21px] font-semibold text-[#eceef1]">
              {formatNav(v?.prevNav ?? 0)}
            </span>
            <span className="rounded-md bg-white/5 px-[7px] py-0.5 text-[11px] text-ink-faint">
              昨日确认
            </span>
          </div>
        )}

        <div className="text-[11.5px] text-ink-dim">{v?.basis.note}</div>

        {v?.basis.staleDays !== null && v?.basis.staleDays !== undefined && v.basis.staleDays > 30 && (
          <WarnBar>持仓数据已过期 {v.basis.staleDays} 天</WarnBar>
        )}

        <div className="flex gap-1.5 border-t border-line-soft pt-3">
          <Cell label="持有份额">
            <span className="font-medium text-ink-soft">{formatShares(p.shares)}</span>
          </Cell>
          <Cell label="今日收益">
            {p.dayReturn === null ? (
              <span className="text-ink-faintest">——</span>
            ) : (
              <Money value={p.dayReturn} sign colored />
            )}
          </Cell>
          <Cell label="持有收益">
            <Money value={p.holdingReturn} sign colored />
          </Cell>
        </div>
      </Card>
    </Link>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1">
      <div className="text-[11px] text-ink-dimmer">{label}</div>
      <div className="mt-1 text-sm font-semibold">{children}</div>
    </div>
  );
}
