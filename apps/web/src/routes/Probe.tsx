import { useEffect, useState } from 'react';

/**
 * P0 出口探针面板。判定 Cloudflare Workers 出口能否稳定抓取东财 ——
 * 这是整个架构成立与否的判定点（见方案「七、风险与退路」）。
 * 通过标准：三端点成功率均 > 95%，采样 ≥ 24h。
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
  since: string | null;
  sources: SourceStat[];
  colos: { colo: string; total: number; ok: number; rate: number }[];
};

const PASS = 0.95;

function tone(rate: number) {
  if (rate >= PASS) return { text: 'text-success', bar: 'var(--color-success)' };
  if (rate >= 0.8) return { text: 'text-warn', bar: 'var(--color-warn)' };
  return { text: 'text-danger', bar: 'var(--color-danger)' };
}

export function Probe() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/probe/stats')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: Stats) => {
          setStats(d);
          setErr(null);
        })
        .catch((e: Error) => setErr(e.message));
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);

  const hours = stats?.since ? (Date.now() - new Date(stats.since).getTime()) / 3_600_000 : 0;
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
                <strong>✓ P0 通过</strong> · 架构成立，可直接在 Workers 侧做在线抓取，进入 P1。
              </>
            ) : (
              <>
                <strong>✗ P0 未通过</strong> · 启用退路：将上游抓取全部迁至 GitHub Actions，Workers
                只读自己的 R2/KV。架构不用推倒。
              </>
            )}
          </div>
        )}

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
