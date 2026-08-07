import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`rounded-[18px] border border-line bg-card ${padded ? 'p-4' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-0.5 pt-6 pb-3">
      <div className="text-[15px] font-semibold">{children}</div>
      {right}
    </div>
  );
}

/** 设置页的分组标题 */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-0.5 pt-[26px] pb-2.5 text-xs font-semibold tracking-wide text-ink-dim">
      {children}
    </div>
  );
}

export function Stat({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[11px] text-ink-dimmer">{label}</div>
      <div className="mt-1 text-sm font-semibold">{children}</div>
    </div>
  );
}

/** 警示条（琥珀）—— 用于「持仓数据已过期 N 天」这类必须被看到的事实 */
export function WarnBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-warn/25 bg-warn/10 px-3 py-2">
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        className="shrink-0 text-warn"
      >
        <path d="M12 3l9 16H3z" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <circle cx="12" cy="16.6" r=".4" fill="currentColor" />
      </svg>
      <span className="text-xs font-semibold text-warn">{children}</span>
    </div>
  );
}

/** 信息条（蓝）—— 用于赎回费档位这类纯事实提示 */
export function InfoBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[11px] border border-info/20 bg-info/10 px-3 py-2.5">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        className="mt-px shrink-0 text-info"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="16.5" strokeLinecap="round" />
        <circle cx="12" cy="7.6" r=".5" fill="currentColor" />
      </svg>
      <div className="text-xs leading-relaxed text-[#c3ccdd]">{children}</div>
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-[27px] w-[46px] shrink-0 rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-[#2c3038]'
      }`}
    >
      <span
        className="absolute top-[3px] size-[21px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.4)] transition-[left]"
        style={{ left: on ? '22px' : '3px' }}
      />
    </button>
  );
}

/** 分段控件（净值周期切换、涨跌配色切换） */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  activeClassName,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** 覆盖选中项的文字色，如涨跌配色切换要用红/绿 */
  activeClassName?: (v: T) => string;
}) {
  return (
    <div className="flex gap-1.5 rounded-[11px] bg-inset p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-lg py-[9px] text-[12.5px] transition-colors ${
              active
                ? `bg-chip font-semibold ${activeClassName?.(o.value) ?? 'text-ink'}`
                : 'text-ink-dim'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function IconCircle({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const cls =
    'flex size-[34px] items-center justify-center rounded-full border border-line-soft bg-circle text-ink-body';
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  ) : (
    <div className={cls}>{children}</div>
  );
}
