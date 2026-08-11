/**
 * P0 出口探针。
 *
 * 唯一目的：判定 Cloudflare Workers 从 CF 全球共享 IP 池出网时，
 * 能否稳定抓取东方财富 —— 这是整个架构成立与否的判定点。
 *
 * 通过 → 在线抓取留在 Workers，进入 P1。
 * 不通过 → 启用退路：上游抓取全迁 GitHub Actions，Workers 只读 R2/KV。
 */

import { PROBE_TARGETS } from './sources';
import type { Env } from './env';

export const PASS_THRESHOLD = 0.95;

/** scheduled 事件里拿不到 request.cf，用 CF 自己的 trace 端点反查边缘节点 */
async function currentColo(): Promise<string | null> {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(5_000),
    });
    const m = /^colo=(.+)$/m.exec(await res.text());
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export interface ProbeRun {
  probedAt: string;
  colo: string | null;
  results: {
    source: string;
    ok: boolean;
    latencyMs: number;
    detail: string | null;
    error: string | null;
  }[];
}

interface ProbeTarget {
  source: string;
  check(): Promise<{ detail: unknown; latencyMs: number }>;
}

export async function checkProbeTargets(
  targets: readonly ProbeTarget[],
): Promise<ProbeRun['results']> {
  const results: ProbeRun['results'] = [];

  // 串行执行：探针本身不能成为压垮上游的原因
  for (const target of targets) {
    const started = Date.now();
    try {
      const result = await target.check();
      results.push({
        source: target.source,
        ok: true,
        // fetchText 在限流排队之后才开始计时；使用源内耗时才能保持 P0 基线可比。
        latencyMs: result.latencyMs,
        detail: String(result.detail),
        error: null,
      });
    } catch (e) {
      results.push({
        source: target.source,
        ok: false,
        latencyMs: Date.now() - started,
        detail: null,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      });
    }
  }
  return results;
}

export async function runProbe(env: Env, colo?: string | null): Promise<ProbeRun> {
  const probedAt = new Date().toISOString();
  const resolvedColo = colo ?? (await currentColo());
  const results = await checkProbeTargets(PROBE_TARGETS);

  const stmt = env.DB.prepare(
    `INSERT INTO probe_results (probed_at, source, ok, latency_ms, detail, error, colo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    results.map((r) =>
      stmt.bind(probedAt, r.source, r.ok ? 1 : 0, r.latencyMs, r.detail, r.error, resolvedColo),
    ),
  );

  return { probedAt, colo: resolvedColo, results };
}

interface Row {
  source: string;
  ok: number;
  latency_ms: number | null;
  error: string | null;
  colo: string | null;
  probed_at: string;
}

export async function probeStats(env: Env, windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT source, ok, latency_ms, error, colo, probed_at
       FROM probe_results
      WHERE probed_at >= ?
      ORDER BY probed_at ASC`,
  )
    .bind(since)
    .all<Row>();

  const rows = results ?? [];

  // 全时段最早一次探测。判定「采样是否满 24h」必须用它，不能用下面的 since ——
  // since 是**滚动窗口内**的最早一行，运行超过 24h 后会永远停在 now-24h 附近，
  // 前端的 hours >= 24 就永远不成立，面板卡在「采样中」。
  const first = await env.DB.prepare(
    `SELECT MIN(probed_at) AS first_probed_at FROM probe_results`,
  ).first<{ first_probed_at: string | null }>();

  const sources = PROBE_TARGETS.map((t) => {
    const mine = rows.filter((r) => r.source === t.source);
    const ok = mine.filter((r) => r.ok === 1);
    const latencies = ok
      .map((r) => r.latency_ms)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    const lastFail = [...mine].reverse().find((r) => r.ok === 0);
    return {
      source: t.source,
      label: t.label,
      endpoint: t.endpoint,
      total: mine.length,
      ok: ok.length,
      rate: mine.length === 0 ? 0 : ok.length / mine.length,
      p50Latency: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
      lastError: lastFail?.error ?? null,
      lastProbedAt: mine.at(-1)?.probed_at ?? null,
    };
  });

  // 按边缘节点聚合 —— 出口地域不可控是本架构的核心风险，
  // 若某些 colo 成功率显著偏低，说明存在地域性封禁而非整体不可用
  const byColo = new Map<string, { total: number; ok: number }>();
  for (const r of rows) {
    const key = r.colo ?? 'unknown';
    const c = byColo.get(key) ?? { total: 0, ok: 0 };
    c.total++;
    if (r.ok === 1) c.ok++;
    byColo.set(key, c);
  }

  return {
    windowHours,
    /** 滚动窗口内最早一行 —— 只用来描述这批统计覆盖的区间，不要拿它算采样时长 */
    since: rows[0]?.probed_at ?? null,
    /** 全时段最早一次探测 —— 判定采样是否满 24h 用这个 */
    firstProbedAt: first?.first_probed_at ?? null,
    sources,
    colos: [...byColo.entries()]
      .map(([colo, c]) => ({ colo, total: c.total, ok: c.ok, rate: c.ok / c.total }))
      .sort((a, b) => b.total - a.total),
  };
}
