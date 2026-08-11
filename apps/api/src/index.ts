import { Hono } from 'hono';
import { cachedJson, searchCacheKey } from './cache';
import { runScheduledTask } from './cron';
import type { Env } from './env';
import { PASS_THRESHOLD, probeStats, runProbe } from './probe';
import { fetchHoldings, fetchQuotesResilient, searchFunds } from './sources';
import { tradingCalendarInfo } from './trading-calendar';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', async (c) =>
  c.json({
    ok: true,
    env: c.env.ENVIRONMENT,
    colo: (c.req.raw as { cf?: { colo?: string } }).cf?.colo ?? null,
    time: new Date().toISOString(),
    tradingCalendar: await tradingCalendarInfo(c.env),
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
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'missing q' }, 400);
  if (q.length > 64) return c.json({ error: 'query too long' }, 400);
  return c.json(
    await cachedJson(c.env.CACHE, searchCacheKey(q), 60 * 60, () => searchFunds(q)),
  );
});

app.get('/api/funds/:code/holdings', async (c) => {
  const code = c.req.param('code');
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'bad code' }, 400);
  return c.json(await fetchHoldings(code));
});

app.get('/api/quotes', async (c) => {
  const secids = (c.req.query('secids') ?? '').split(',').filter(Boolean);
  if (secids.length === 0) return c.json({ error: 'missing secids' }, 400);
  const r = await fetchQuotesResilient(secids);
  // provider / delayed 必须回给前端：延时行情不能当实时展示
  return c.json({
    provider: r.provider,
    delayed: r.delayed,
    quotes: Object.fromEntries(r.quotes),
  });
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

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledTask(event, env));
  },
};
