import { useEffect, useState } from 'react';
import { relativeTime } from '../lib/format';

/**
 * P0 出口探针面板。判定 Cloudflare Workers 出口能否稳定抓取东财 ——
 * 这是整个架构成立与否的判定点（见方案「七、风险与退路」）。
 * 通过标准：三端点成功率均 > 95%，采样 ≥ 24h。
 *
 * 另外挂了交易日历指示灯。日历缺失时后端会让估值/预热/收盘快照 fail closed，
 * 那是对的，但唯一的痕迹是 Worker 日志里的一行 warn —— 没人会去看。
 * 没有指示灯的话，「引擎按设计停用」和「引擎写坏了」在界面上完全一样。
 */

type SourceStat = {
  source: string;
  label: string;
  endpoint: string;
  total: number;
  ok: number;
  rate: number;
  p50Latency: number | null;
  lastError: string | null;
  lastProbedAt: string | null;
};

type Stats = {
  windowHours: number;
  /** 滚动窗口内最早一行，只描述统计区间 */
  since: string | null;
  /** 全时段最早一次探测 —— 采样时长看这个 */
  firstProbedAt: string | null;
  sources: SourceStat[];
  colos: { colo: string; total: number; ok: number; rate: number }[];
};

type CalendarInfo = {
  available: boolean;
  generatedAt: string | null;
  days: number;
};

/**
 * 三态而不是两态。「线上 Worker 还没有这个字段」和「日历确实不存在」是两回事，
 * 混成一个会让人在部署前就以为日历丢了，或者部署后以为指示灯坏了。
 */
type CalendarState =
  { kind: 'loading' } | { kind: 'unreported' } | { kind: 'info'; info: CalendarInfo };

/** 日历按年生成、按月校验。生成太久远说明多半没覆盖到当前年度。 */
const CALENDAR_STALE_DAYS = 60;

const PASS = 0.95;

function tone(rate: number) {
  if (rate >= PASS) return { text: 'text-success', bar: 'var(--color-success)' };
  if (rate >= 0.8) return { text: 'text-warn', bar: 'var(--color-warn)' };
  return { text: 'text-danger', bar: 'var(--color-danger)' };
}

function CalendarPanel({ state }: { state: CalendarState }) {
  if (state.kind === 'loading') return null;

  // 语义色一律用 warn / success 这类固定色，不能用 up / down ——
  // 那两个会跟着用户的涨跌配色偏好翻转，指示灯的含义不能被偏好改变。
  const shell = 'mb-5 rounded-xl border px-4 py-3.5 text-sm leading-relaxed';

  if (state.kind === 'unreported') {
    return (
      <div className={`${shell} border-line bg-card text-ink-muted`}>
        <strong className="text-ink-dim">交易日历 · 未知</strong>
        <div className="mt-1 text-[12.5px]">
          线上 Worker 尚未上报日历状态（该版本没有这个字段），不代表日历缺失。部署后此处会给出结论。
        </div>
      </div>
    );
  }

  const { available, generatedAt, days } = state.info;

  if (!available) {
    return (
      <div className={`${shell} border-warn/40 bg-warn/10`}>
        <strong>估值链路已停用</strong> · 交易日历未就绪
        <div className="mt-1.5 text-[12.5px] text-ink-muted">
          R2 里缺 <code className="font-mono">calendar/trading_days.json</code>
          ，估值、预热与收盘快照会 fail closed 直接跳过。这是设计行为，不是故障 ——
          节假日的估值样本永远等不到官方净值对账，宁可不跑。日历由{' '}
          <code className="font-mono">pipelines/</code>
          生成，建好之前估值引擎不会产出任何数据。
        </div>
      </div>
    );
  }

  const staleMs = generatedAt ? Date.now() - new Date(generatedAt).getTime() : null;
  const stale = staleMs !== null && staleMs > CALENDAR_STALE_DAYS * 86_400_000;

  return (
    <div className={`${shell} ${stale ? 'border-warn/40 bg-warn/10' : 'border-line bg-card'}`}>
      <span className="inline-flex items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${stale ? 'bg-warn' : 'bg-success'}`} />
        <strong>交易日历就绪</strong>
      </span>
      <span className="text-ink-muted"> · {days} 个交易日</span>
      {generatedAt && <span className="text-ink-muted"> · 生成于 {relativeTime(generatedAt)}</span>}
      {stale && (
        <div className="mt-1.5 text-[12.5px] text-ink-muted">
          距上次生成已超过 {CALENDAR_STALE_DAYS} 天，可能未覆盖当前年度 ——
          日历一旦跑到末尾，之后每天都会被判成非交易日，估值静默停摆。
        </div>
      )}
    </div>
  );
}

export function Probe() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<CalendarState>({ kind: 'loading' });

  useEffect(() => {
    const loadStats = () =>
      fetch('/api/probe/stats')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: Stats) => {
          setStats(d);
          setErr(null);
        })
        .catch((e: Error) => setErr(e.message));

    // health 单独取。它挂了不该把探针数据一起打掉 —— 两者互不依赖，
    // 而探针结论才是这一页存在的理由。
    const loadCalendar = () =>
      fetch('/api/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: { tradingCalendar?: CalendarInfo }) => {
          setCalendar(
            d.tradingCalendar ? { kind: 'info', info: d.tradingCalendar } : { kind: 'unreported' },
          );
        })
        .catch(() => setCalendar({ kind: 'unreported' }));

    const load = () => {
      void loadStats();
      void loadCalendar();
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  // 必须用 firstProbedAt 而不是 since：since 是滚动窗口内的最早一行，
  // 跑满 24h 后它永远停在 now-24h，hours 会卡在 23.9x 永远达不到门槛
  const hours = stats?.firstProbedAt
    ? (Date.now() - new Date(stats.firstProbedAt).getTime()) / 3_600_000
    : 0;
  const allPass = !!stats && stats.sources.length > 0 && stats.sources.every((s) => s.rate >= PASS);
  const enough = hours >= 24;

  return (
    // safe-top 独占 padding-top，所以内层再套一个 div 放页面自己的上边距
    <div className="safe-top min-h-dvh">
      <div className="safe-x mx-auto max-w-[720px] pt-5 pb-12">
        <h1 className="text-xl font-bold">P0 · Cloudflare 出口探针</h1>
        <p className="mt-1 mb-6 text-[13px] leading-relaxed text-ink-muted">
          验证 Workers 从 CF 全球共享 IP 池出网时，能否稳定抓取东方财富数据源。
          <br />
          通过标准：三端点成功率均 &gt; 95%，采样 ≥ 24h。
        </p>

        {err && (
          <div className="mb-5 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3.5 text-sm">
            读取探针数据失败：{err}
          </div>
        )}

        {stats && (
          <div
            className={`mb-5 rounded-xl border px-4 py-3.5 text-sm leading-relaxed ${
              !enough
                ? 'border-warn/40 bg-warn/10'
                : allPass
                  ? 'border-success/40 bg-success/10'
                  : 'border-danger/40 bg-danger/10'
            }`}
          >
            {!enough ? (
              <>
                <strong>采样中</strong> · 已运行 {hours.toFixed(1)}h / 24h
                {allPass ? '，当前全部达标' : '，已有端点不达标'}
              </>
            ) : allPass ? (
              <>
                <strong>✓ P0 通过</strong> · 已运行 {hours.toFixed(1)}h，架构成立，可直接在 Workers
                侧做在线抓取。
                <div className="mt-1.5 text-[12.5px] text-ink-muted">
                  注意：成功率统计的是最近 {stats.windowHours}h 滚动窗口，不是全时段。下方 colo
                  分布同理 —— 窗口里只出现过的节点不代表其他节点也验证过，探针应继续运行。
                </div>
              </>
            ) : (
              <>
                <strong>✗ P0 未通过</strong> · 启用退路：将上游抓取全部迁至 GitHub Actions，Workers
                只读自己的 R2/KV。架构不用推倒。
                <div className="mt-1.5 text-[12.5px] text-ink-muted">
                  退路本身也未经验证 —— Actions 出口实测有间歇性传输层失败，见
                  docs/data-sources.md。
                </div>
              </>
            )}
          </div>
        )}

        {/* 放在 P0 结论之后：这一页的主语是出口探针，日历是另一条链路的状态，
            不能抢在结论前面把人带偏。 */}
        <CalendarPanel state={calendar} />

        {stats?.sources.map((s) => {
          const t = tone(s.rate);
          return (
            <div key={s.source} className="mb-3 rounded-xl border border-line bg-card px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{s.label}</div>
                  <div className="mt-0.5 font-mono text-[11px] break-all text-ink-muted">
                    {s.endpoint}
                  </div>
                </div>
                <div className={`shrink-0 text-[22px] font-bold ${t.text}`}>
                  {s.total === 0 ? '—' : `${(s.rate * 100).toFixed(1)}%`}
                </div>
              </div>
              <div className="mt-2.5 h-1 overflow-hidden rounded-sm bg-line-strong">
                <div
                  className="h-full rounded-sm"
                  style={{ width: `${s.rate * 100}%`, background: t.bar }}
                />
              </div>
              <div className="mt-2 text-xs text-ink-muted">
                {s.ok}/{s.total} 次成功
                {s.p50Latency !== null && ` · p50 ${s.p50Latency}ms`}
                {s.lastProbedAt && ` · 最近 ${new Date(s.lastProbedAt).toLocaleString('zh-CN')}`}
              </div>
              {s.lastError && (
                <div className="mt-1 text-xs text-danger">最近错误：{s.lastError}</div>
              )}
            </div>
          );
        })}

        {stats && stats.colos.length > 0 && (
          <div className="rounded-xl border border-line bg-card px-4 py-3.5">
            <div className="text-sm font-semibold">按 CF 边缘节点（colo）分布</div>
            <div className="mt-2 text-xs text-ink-muted">
              出口地域不可控是本架构的核心风险。若某些 colo 成功率显著偏低，说明存在地域性封禁。
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {stats.colos.map((c) => (
                <span
                  key={c.colo}
                  className={`rounded-full border border-line-strong px-2 py-[3px] text-[11px] ${tone(c.rate).text}`}
                >
                  {c.colo} {(c.rate * 100).toFixed(0)}% ({c.total})
                </span>
              ))}
            </div>
          </div>
        )}

        {!stats && !err && (
          <div className="rounded-xl border border-line bg-card px-4 py-3.5 text-sm">加载中…</div>
        )}
      </div>
    </div>
  );
}
