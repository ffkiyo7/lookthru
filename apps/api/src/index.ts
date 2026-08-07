import { Hono } from 'hono';
import type { Env } from './env';
import { PASS_THRESHOLD, probeStats, runProbe } from './probe';
import { fetchHoldings, fetchQuotes, searchFunds } from './sources';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    env: c.env.ENVIRONMENT,
    colo: (c.req.raw as { cf?: { colo?: string } }).cf?.colo ?? null,
    time: new Date().toISOString(),
  }),
);

// ── P0 探针 ──────────────────────────────────────────────────
app.get('/api/probe/stats', async (c) => {
  const hours = Number(c.req.query('hours') ?? 24);
  const stats = await probeStats(c.env, Number.isFinite(hours) ? hours : 24);
  return c.json({
    ...stats,
    passThreshold: PASS_THRESHOLD,
    pass: stats.sources.every((s) => s.total > 0 && s.rate >= PASS_THRESHOLD),
  });
});

/** 手动触发一次探测，用于部署后立即验证，不必等 Cron */
app.post('/api/probe/run', async (c) => {
  const colo = (c.req.raw as { cf?: { colo?: string } }).cf?.colo ?? null;
  return c.json(await runProbe(c.env, colo));
});

// ── 数据源冒烟接口：部署后可直接在浏览器验证上游可达性 ────────
app.get('/api/funds/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'missing q' }, 400);
  return c.json(await searchFunds(q));
});

app.get('/api/funds/:code/holdings', async (c) => {
  const code = c.req.param('code');
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'bad code' }, 400);
  return c.json(await fetchHoldings(code));
});

app.get('/api/quotes', async (c) => {
  const secids = (c.req.query('secids') ?? '').split(',').filter(Boolean);
  if (secids.length === 0) return c.json({ error: 'missing secids' }, 400);
  return c.json(Object.fromEntries(await fetchQuotes(secids)));
});

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: err.message }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    // 其余交给 Static Assets（SPA fallback 由 wrangler.toml 的
    // not_found_handling = "single-page-application" 处理）
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runProbe(env).then((run) => {
        const failed = run.results.filter((r) => !r.ok);
        if (failed.length > 0) {
          console.warn(
            `[probe] colo=${run.colo} 失败 ${failed.length}/${run.results.length}:`,
            failed.map((f) => `${f.source}=${f.error}`).join(' | '),
          );
        }
      }),
    );
  },
};
