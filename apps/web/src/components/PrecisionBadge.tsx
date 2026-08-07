import type { ValuationPrecision } from '@qd2/shared';

/**
 * 估值精度徽章。官方盘中估值已下线，我们的估值全部自建，
 * 因此必须向用户明示精度 —— 这是产品的诚实性底线，不要为了美观弱化它。
 *
 * ⚠️ 设计稿只给了 精确 / 中 / 低 / 不可估 四档，没有画「高」（被动指数基金）。
 * 这里按 精确(实心) → 高(28%) → 中(13%) 的梯度补齐，待设计确认。
 */

const STYLES: Record<
  ValuationPrecision,
  { label: string; className: string; dot: string | null }
> = {
  EXACT: {
    label: '精确',
    className: 'bg-accent text-[#0b0c0f] font-bold',
    dot: 'bg-[#0b0c0f]',
  },
  HIGH: {
    label: '高',
    className: 'bg-accent/25 text-[#c5bbfa] border border-accent/45 font-bold',
    dot: 'bg-[#c5bbfa]',
  },
  MEDIUM: {
    label: '中',
    className: 'bg-accent/15 text-accent-dim border border-accent/20 font-semibold',
    dot: 'bg-accent-dim',
  },
  LOW: {
    label: '低',
    className: 'bg-white/5 text-[#7c8089] border border-white/10 font-semibold',
    dot: 'bg-[#7c8089]',
  },
  NONE: {
    label: '不可估',
    className: 'bg-transparent text-ink-dimmer border border-dashed border-white/20 font-semibold',
    dot: null,
  },
};

export function PrecisionBadge({
  precision,
  size = 'md',
}: {
  precision: ValuationPrecision;
  size?: 'sm' | 'md';
}) {
  const s = STYLES[precision];
  const dims = size === 'sm' ? 'text-[10px] px-2 py-[3px] rounded-[7px]' : 'text-[11px] px-2.5 py-1 rounded-lg';
  const dotSize = size === 'sm' ? 'size-1' : 'size-[5px]';

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap ${dims} ${s.className}`}
    >
      {s.dot && <span className={`${dotSize} rounded-full ${s.dot}`} />}
      {s.label}
    </span>
  );
}

/** 精度图例，列表页头部用 */
export function PrecisionLegend() {
  return <span className="text-[11.5px] text-ink-faint">精度：精确 › 高 › 中 › 低 › 不可估</span>;
}
