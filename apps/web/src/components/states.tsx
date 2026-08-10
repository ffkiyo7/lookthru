import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatClock, relativeTime } from '../lib/format';

/**
 * 空态 / 加载态 / 陈旧态。
 *
 * 这三者是三件不同的事，别互相代替：
 *
 *   空态    请求成功了，结果就是空的。用户没做错任何事，需要给一个出口
 *   加载态  一份数据都还没有（冷启动）。**有缓存就不要用它**，见 UI 不变量 #7
 *   陈旧态  有数据，但是旧的。这是不变量 #7 的正面实现 ——
 *           宁可显示「14:23 的数据」，也不要显示空白或转圈
 *
 * 文案写在这里而不是散在页面里，是因为这几屏是产品语气最集中的地方：
 * 新用户看到的第一屏是空态，上游挂掉时看到的是陈旧态。
 */

/* ------------------------------------------------------------------ 空态 */

export function EmptyState({
  icon,
  title,
  description,
  action,
  footnote,
  tone = 'neutral',
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: { label: string; to?: string; onClick?: () => void };
  /** 补充说明，用于提前交代口径（如覆盖率、估算精度），不是营销文案 */
  footnote?: ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  const ring =
    tone === 'danger'
      ? 'border-danger/25 bg-danger/8 text-danger'
      : 'border-line-strong bg-raised text-ink-dim';

  // 在剩余视口里居中，不要贴着 header 顶。58dvh 是扣掉 header 与 tab bar 后
  // 让内容大致落在整屏 38% 高度的位置 —— 视觉重心略高于正中，比真正居中更稳。
  return (
    <div className="flex min-h-[58dvh] flex-col items-center justify-center px-6 pb-10 text-center">
      <div className={`flex size-14 items-center justify-center rounded-full border ${ring}`}>
        {icon}
      </div>
      <div className="mt-4 text-[15px] font-semibold">{title}</div>
      <p className="mt-2 max-w-[270px] text-[13px] leading-relaxed text-ink-muted">{description}</p>

      {action &&
        (action.to ? (
          <Link to={action.to} className={ACTION_CLS}>
            {action.label}
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} className={ACTION_CLS}>
            {action.label}
          </button>
        ))}

      {footnote && (
        <div className="mt-6 max-w-[270px] text-[11.5px] leading-relaxed text-ink-faintest">
          {footnote}
        </div>
      )}
    </div>
  );
}

const ACTION_CLS =
  'mt-5 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-semibold text-white active:opacity-80';

/**
 * 图标沿用对应 tab 的字形（持仓=柱状，穿透=同心圆）。
 * 空屏时没有别的线索告诉用户「你在哪一页」，字形呼应是最省成本的定位。
 */
const IconBars = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="13" width="3.4" height="7" rx="1" />
    <rect x="10.3" y="8" width="3.4" height="12" rx="1" />
    <rect x="16.6" y="4" width="3.4" height="16" rx="1" />
  </svg>
);

const IconRings = (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
  >
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
);

const IconAlert = (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="7.5" x2="12" y2="13" />
    <circle cx="12" cy="16.4" r=".5" fill="currentColor" />
  </svg>
);

export function EmptyPortfolio() {
  return (
    <EmptyState
      icon={IconBars}
      title="还没有持仓"
      description="添加你持有的基金，这里会显示实时估算的总资产与今日收益。"
      action={{ label: '去找基金', to: '/search' }}
      footnote="盘中估算是本地算出来的，每只基金都会标注精度等级；收盘后以官方净值为准。"
    />
  );
}

export function EmptyXRay() {
  return (
    <EmptyState
      icon={IconRings}
      title="还没有可穿透的持仓"
      description="穿透会把你每只基金的重仓股加权汇总，算出真实的股票级敞口和重复押注。"
      action={{ label: '去添加基金', to: '/search' }}
      footnote="前十大重仓股通常只覆盖基金净值的 40–70%，结果会标注实际覆盖率。"
    />
  );
}

/**
 * 冷启动 + 上游同时失败 —— 这是唯一「什么都给不出」的情况。
 * 只要有缓存就不该走到这里，走 FreshnessLine 的 failing 态。
 */
export function ErrorState({
  description = '上游数据源暂时不可用。已录入的持仓不受影响。',
  onRetry,
}: {
  description?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      tone="danger"
      icon={IconAlert}
      title="数据加载失败"
      description={description}
      action={onRetry ? { label: '重试', onClick: onRetry } : undefined}
    />
  );
}

/* ------------------------------------------------------------ 加载态（冷启动） */

/** 骨架块。用 Tailwind 类给尺寸，几何照抄真实卡片，避免数据到达时跳版。 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function PortfolioSkeleton() {
  return (
    <div aria-busy="true" aria-label="加载中">
      {/* 汇总卡：对齐 Portfolio.tsx 的 rounded-[22px] px-5 pt-[22px] pb-[18px] */}
      <div className="rounded-[22px] border border-line-card bg-[linear-gradient(158deg,#1c1f27_0%,#131519_78%)] px-5 pt-[22px] pb-[18px]">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-9 w-44" />
        <div className="mt-5 flex gap-3.5">
          <Skeleton className="h-[74px] flex-1 rounded-[14px]" />
          <Skeleton className="h-[74px] flex-1 rounded-[14px]" />
        </div>
        <Skeleton className="mt-4 h-3 w-52" />
      </div>

      <div className="px-0.5 pt-6 pb-3">
        <Skeleton className="h-4 w-20" />
      </div>

      <div className="flex flex-col gap-[13px]">
        {[0, 1, 2].map((i) => (
          <PositionCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

function PositionCardSkeleton() {
  // 真实 PositionCard 实测 213px（无 WarnBar）～260px（有 WarnBar），高度取决于数据，
  // 骨架屏对不齐是必然的。压到下限 213 而不是让它比任何真实卡片都矮，
  // 这样数据到达时版面只会收紧、不会整体下坠。
  return (
    <div className="min-h-[213px] rounded-[18px] border border-line bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-14" />
        </div>
        <Skeleton className="h-[19px] w-11 rounded-md" />
      </div>
      <Skeleton className="mt-[13px] h-6 w-36" />
      <Skeleton className="mt-[13px] h-3 w-52" />
      <div className="mt-3 flex gap-1.5 border-t border-line-soft pt-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex-1">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-1.5 h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function XRaySkeleton() {
  return (
    <div aria-busy="true" aria-label="加载中">
      {/* 覆盖率警示条 */}
      <Skeleton className="h-[74px] rounded-[14px]" />
      <div className="px-0.5 pt-6 pb-3.5">
        <Skeleton className="h-4 w-24" />
      </div>
      {/* 对齐 ExposureCard：rounded-2xl p-3.5，序号 + 名称/代码 + 占比/金额 + 进度条 + 展开按钮 */}
      <div className="flex flex-col gap-[11px]">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-2xl border border-line bg-card p-3.5">
            <div className="flex items-start gap-[11px]">
              <Skeleton className="mt-px size-[22px] shrink-0 rounded-[7px]" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-[15px] w-28" />
                <Skeleton className="mt-1.5 h-3 w-14" />
              </div>
              <div className="flex flex-col items-end">
                <Skeleton className="h-[18px] w-14" />
                <Skeleton className="mt-1.5 h-3 w-16" />
              </div>
            </div>
            <Skeleton className="my-3 h-1.5 rounded-[3px]" />
            <Skeleton className="h-[29px] w-[132px] rounded-[9px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 陈旧态 */

export type FreshnessProps = {
  /** 这份数据的抓取时刻。null = 还没有数据 */
  at: Date | string | number | null;
  /** 刷新正在失败（但手上还有旧数据）—— 必须说出来，不能假装还在实时 */
  failing?: boolean;
  /** 超过多久算陈旧。默认 2 分钟 = 默认刷新间隔 60s 的两倍 */
  staleAfterMs?: number;
  onRetry?: () => void;
  /** 实时态追加的口径说明，如「收盘后以官方净值为准」 */
  liveNote?: string;
};

/**
 * 数据新鲜度指示行。三态合一，替代原来写死的「估算 · 14:23 更新」。
 *
 * 圆点颜色用 success/warn 这类**固定语义色**，不能用 up/down ——
 * 那两个会跟着用户的涨跌配色偏好翻转，「数据是活的」跟涨跌毫无关系。
 */
export function FreshnessLine({
  at,
  failing = false,
  staleAfterMs = 120_000,
  onRetry,
  liveNote,
}: FreshnessProps) {
  if (at === null) return null;

  const age = Date.now() - new Date(at).getTime();
  const stale = age > staleAfterMs;
  const clock = formatClock(at);

  const dot = failing ? 'bg-warn' : stale ? 'bg-ink-dim' : 'bg-success animate-ecpulse';

  return (
    <div className="mt-4 flex items-center gap-[7px] text-[11.5px] text-ink-dimmer">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {failing ? (
        <>
          <span className="text-warn">上游暂时不可用</span>
          <span>· 数据停在 {clock}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto shrink-0 rounded-md bg-white/6 px-2 py-0.5 text-[11px] text-ink-body active:opacity-70"
            >
              重试
            </button>
          )}
        </>
      ) : stale ? (
        <span>
          数据停在 {clock}（{relativeTime(at)}）
        </span>
      ) : (
        <span>
          估算 · {clock} 更新
          {liveNote ? ` · ${liveNote}` : ''}
        </span>
      )}
    </div>
  );
}
