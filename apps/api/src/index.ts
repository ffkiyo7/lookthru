import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { parseFundTypeFilter } from '@lookthru/shared';
import {
  authenticateSession,
  expiredSessionCookie,
  InvalidCredentialError,
  readSessionToken,
  recoverSession,
  redeemInvite,
  revokeSession,
  sessionCookie,
} from './auth';
import { cachedJson, searchCacheKey } from './cache';
import { getFundSearchIndex } from './fund-list';
import { searchFundsForQuery } from './fund-search';
import { runScheduledTask } from './cron';
import {
  confirmTransaction,
  createTransaction,
  deleteTransaction,
  listTransactions,
  TransactionConflictError,
  TransactionDomainError,
  TransactionNotFoundError,
} from './data/transactions';
import {
  deleteNotifyBinding,
  getNotifyBinding,
  listNotifyBindingKinds,
  upsertNotifyBinding,
} from './data/notify';
import type { Env } from './env';
import { getCachedHoldings } from './fund-holdings';
import { cacheFundMetaFromSearchHit, getFundMeta } from './fund-meta';
import { syncOfficialNavForFund, syncOfficialNavFromSearchHit } from './nav/sync';
import { DiscordNotifier, validateDiscordWebhookUrl } from './notify/discord';
import { buildDailyBrief } from './notify/jobs';
import { PASS_THRESHOLD, probeStats, runProbe } from './probe';
import { loadPositionSnapshot } from './positions';
import { getCachedQuotes, type CachedQuoteResult } from './quote-cache';
import { getDailyReturns } from './returns';
import { consumeKvRateLimit } from './rate-limit';
import { getFundSearchChanges } from './search-changes';
import { searchFunds } from './sources';
import { beijingDate, tradingCalendarInfo } from './trading-calendar';
import { getCachedValuations } from './valuation/service';
import { getValuationErrorReport } from './valuation/report';
import { loadXRaySnapshot } from './xray/loader';

type AppContext = { Bindings: Env; Variables: { userId: string } };

const app = new Hono<AppContext>();

const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const userId = await authenticateSession(c.env.DB, readSessionToken(c.req.raw));
  if (!userId) return c.json({ error: 'authentication required' }, 401);
  c.set('userId', userId);
  await next();
};

export function isPublicApiRequest(method: string, path: string): boolean {
  if (method === 'POST' && (path === '/api/auth/redeem' || path === '/api/auth/recover')) {
    return true;
  }
  if (method !== 'GET') return false;
  return (
    path === '/api/health' ||
    path === '/api/probe/stats' ||
    path.startsWith('/api/funds/')
  );
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
  }, 'invalid date');

const TransactionBody = z
  .object({
    fundCode: z.string().regex(/^\d{6}$/),
    type: z.enum(['SNAPSHOT', 'BUY', 'SELL', 'DIVIDEND', 'CONVERT']),
    tradeDate: dateSchema,
    confirmDate: dateSchema.nullable().default(null),
    shares: z.number().finite().nonnegative().nullable().default(null),
    amount: z.number().finite().nonnegative().nullable().default(null),
    price: z.number().finite().nonnegative().nullable().default(null),
    fee: z.number().finite().nonnegative().default(0),
    status: z.enum(['PENDING', 'CONFIRMED']),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.status === 'CONFIRMED' && value.confirmDate === null) {
      context.addIssue({ code: 'custom', path: ['confirmDate'], message: 'confirmed requires date' });
    }
    if (value.status === 'PENDING' && value.confirmDate !== null) {
      context.addIssue({ code: 'custom', path: ['confirmDate'], message: 'pending forbids date' });
    }
    if (value.confirmDate !== null && value.confirmDate < value.tradeDate) {
      context.addIssue({
        code: 'custom',
        path: ['confirmDate'],
        message: 'confirm date must not be before trade date',
      });
    }
    if (value.type === 'SNAPSHOT') {
      if (value.shares === null || value.amount === null || value.status !== 'CONFIRMED') {
        context.addIssue({ code: 'custom', message: 'snapshot requires confirmed shares and amount' });
      }
    } else if (value.type === 'BUY') {
      if (value.shares === null || value.shares <= 0 || value.amount === null) {
        context.addIssue({ code: 'custom', message: 'buy requires positive shares and amount' });
      }
    } else if (value.type === 'SELL') {
      if (value.shares === null || value.shares <= 0) {
        context.addIssue({ code: 'custom', message: 'sell requires positive shares' });
      }
    } else if (value.type === 'DIVIDEND') {
      const reinvest = value.shares !== null && value.shares > 0 && value.amount === null;
      const cash = value.shares === null && value.amount !== null && value.amount > 0;
      if (!reinvest && !cash) {
        context.addIssue({ code: 'custom', message: 'dividend requires either shares or cash amount' });
      }
    } else if (value.shares === null || value.shares <= 0) {
      context.addIssue({ code: 'custom', message: 'convert requires positive shares' });
    }

    const feeAffectsCost =
      value.type === 'BUY' || (value.type === 'CONVERT' && value.amount !== null);
    if (!feeAffectsCost && value.fee !== 0) {
      context.addIssue({ code: 'custom', path: ['fee'], message: 'fee is not used for this type' });
    }
  });

async function parsedJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    throw new TransactionDomainError('请求体不是有效 JSON', { cause: error });
  }
}

function quoteResponse(result: CachedQuoteResult) {
  return {
    provider: result.provider,
    delayed: result.delayed,
    fetchedAt: result.fetchedAt,
    staleSecids: result.staleSecids,
    unavailableSecids: result.unavailableSecids,
    quotes: Object.fromEntries(result.quotes),
  };
}

app.use('/api/funds/*', async (c, next) => {
  const clientId = c.req.header('CF-Connecting-IP') ?? 'local-development';
  try {
    const allowed = await consumeKvRateLimit(c.env.CACHE, clientId, 'public-funds', Date.now(), 30);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
  } catch (error) {
    console.error('[rate-limit] KV 限流不可用', error);
    return c.json({ error: 'rate limiter unavailable' }, 503);
  }
  await next();
});

app.use('/api/auth/*', async (c, next) => {
  if (c.req.method !== 'POST' || !['/api/auth/redeem', '/api/auth/recover'].includes(c.req.path)) {
    await next();
    return;
  }
  const clientId = c.req.header('CF-Connecting-IP') ?? 'local-development';
  try {
    const allowed = await consumeKvRateLimit(c.env.CACHE, clientId, 'public-auth', Date.now(), 10);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
  } catch (error) {
    console.error('[rate-limit] 鉴权限流不可用', error);
    return c.json({ error: 'rate limiter unavailable' }, 503);
  }
  await next();
});

app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' || !['/api/health', '/api/probe/stats'].includes(c.req.path)) {
    await next();
    return;
  }
  const clientId = c.req.header('CF-Connecting-IP') ?? 'local-development';
  try {
    const allowed = await consumeKvRateLimit(c.env.CACHE, clientId, 'public-status', Date.now(), 60);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
  } catch (error) {
    console.error('[rate-limit] 状态接口限流不可用', error);
    return c.json({ error: 'rate limiter unavailable' }, 503);
  }
  await next();
});

// 公开路由采用方法+路径白名单；其余 /api/* 默认保护，新增接口不会因忘记挂中间件而裸奔。
app.use('/api/*', async (c, next) => {
  if (isPublicApiRequest(c.req.method, c.req.path)) {
    await next();
    return;
  }
  return requireAuth(c, next);
});

app.post('/api/auth/redeem', async (c) => {
  const body = z.object({ inviteCode: z.string().min(1).max(256) }).safeParse(
    await parsedJson(c.req.raw),
  );
  if (!body.success) return c.json({ error: 'invalid request' }, 400);
  const result = await redeemInvite(c.env.DB, body.data.inviteCode);
  c.header('Set-Cookie', sessionCookie(result.sessionToken));
  return c.json({ userId: result.userId, recoveryCode: result.recoveryCode }, 201);
});

app.post('/api/auth/recover', async (c) => {
  const body = z.object({ recoveryCode: z.string().min(1).max(256) }).safeParse(
    await parsedJson(c.req.raw),
  );
  if (!body.success) return c.json({ error: 'invalid request' }, 400);
  const result = await recoverSession(c.env.DB, body.data.recoveryCode);
  c.header('Set-Cookie', sessionCookie(result.sessionToken));
  return c.json({ userId: result.userId });
});

app.get('/api/auth/session', (c) => c.json({ userId: c.get('userId') }));

app.post('/api/auth/logout', async (c) => {
  await revokeSession(c.env.DB, readSessionToken(c.req.raw));
  c.header('Set-Cookie', expiredSessionCookie());
  return c.body(null, 204);
});

app.get('/api/health', async (c) =>
  c.json({
    ok: true,
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
  const typeFilter = parseFundTypeFilter(c.req.query('type'));
  if (typeFilter === null) return c.json({ error: 'invalid type' }, 400);
  // 全量列表在 isolate 内存里搜；东财 suggest 只留给本地没有的精确 6 位代码。
  const index = await getFundSearchIndex(c.env);
  const hits = await searchFundsForQuery(q, typeFilter, index, (keyword) =>
    cachedJson(c.env.CACHE, searchCacheKey(keyword), 60 * 60, () => searchFunds(keyword)),
  );
  const exactHit = /^\d{6}$/.test(q)
    ? hits.find((candidate) => candidate.code === q)
    : undefined;
  if (exactHit) {
    c.executionCtx.waitUntil(
      (async () => {
        await cacheFundMetaFromSearchHit(c.env, exactHit);
        // 本地列表没有 DWJZ。没有净值时不要写 nav-initial-miss，否则会挡住真正的官方净值同步。
        if (exactHit.nav !== null && exactHit.navDate !== null) {
          await syncOfficialNavFromSearchHit(c.env, exactHit);
        }
      })().catch((error) => {
        console.warn(`[fund-search] 共享基金资料预热失败 code=${exactHit.code}`, error);
      }),
    );
  }
  const regularCodes = hits.filter((hit) => !hit.isMoneyFund).map((hit) => hit.code);
  const changes = await getFundSearchChanges(c.env.CACHE, regularCodes);
  return c.json(
    hits.map((hit) => {
      const change = changes.get(hit.code);
      return {
        ...hit,
        chgPct: change?.chgPct ?? null,
        changeTime: change?.fetchedAt ?? null,
        changeStale: change?.stale ?? false,
        changeUnavailable: change?.unavailable ?? false,
      };
    }),
  );
});

app.get('/api/funds/:code/holdings', async (c) => {
  const code = c.req.param('code');
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'bad code' }, 400);
  const snapshot = await getCachedHoldings(c.env, code);
  return c.json({ ...snapshot.data, fetchedAt: snapshot.fetchedAt, stale: snapshot.stale });
});

app.get('/api/funds/:code/quotes', async (c) => {
  const code = c.req.param('code');
  if (!/^\d{6}$/.test(code)) return c.json({ error: 'bad code' }, 400);
  const holdings = await getCachedHoldings(c.env, code);
  const secids = holdings.data.holdings
    .map((holding) => holding.secid)
    .filter((secid): secid is string => secid !== null);
  return c.json({
    ...quoteResponse(await getCachedQuotes(c.env, secids)),
    holdingsReportDate: holdings.data.reportDate,
    holdingsStale: holdings.stale,
  });
});

app.get('/api/quotes', async (c) => {
  const secids = [...new Set((c.req.query('secids') ?? '').split(',').filter(Boolean))];
  if (secids.length === 0) return c.json({ error: 'missing secids' }, 400);
  if (secids.length > 100) return c.json({ error: 'too many secids' }, 400);
  if (secids.some((secid) => !/^\d+\.[A-Za-z0-9]+$/.test(secid))) {
    return c.json({ error: 'bad secid' }, 400);
  }
  // provider / delayed / stale 必须回给前端：延时或旧行情不能当实时展示。
  return c.json(quoteResponse(await getCachedQuotes(c.env, secids)));
});

app.get('/api/valuations', async (c) => {
  const codes = [...new Set((c.req.query('codes') ?? '').split(',').filter(Boolean))];
  if (codes.length === 0) return c.json({ error: 'missing codes' }, 400);
  if (codes.length > 100) return c.json({ error: 'too many codes' }, 400);
  if (codes.some((code) => !/^\d{6}$/.test(code))) return c.json({ error: 'bad code' }, 400);
  const valuations = await getCachedValuations(c.env, codes);
  const updatedAt = [...valuations.values()]
    .map((valuation) => valuation.estTime)
    .sort()
    .at(-1) ?? null;
  return c.json({ updatedAt, valuations: Object.fromEntries(valuations) });
});

app.get('/api/valuation-report', async (c) => {
  const range = z
    .object({ from: dateSchema.nullable(), to: dateSchema.nullable() })
    .safeParse({ from: c.req.query('from') ?? null, to: c.req.query('to') ?? null });
  if (!range.success) return c.json({ error: 'invalid date range' }, 400);
  if (range.data.from !== null && range.data.to !== null && range.data.from > range.data.to) {
    return c.json({ error: 'from must not be after to' }, 400);
  }
  return c.json(await getValuationErrorReport(c.env.DB, range.data.from, range.data.to));
});

app.get('/api/transactions', async (c) =>
  c.json({ transactions: await listTransactions(c.env.DB, c.get('userId')) }),
);

app.post('/api/transactions', async (c) => {
  const body = TransactionBody.safeParse(await parsedJson(c.req.raw));
  if (!body.success) {
    return c.json(
      { error: 'invalid transaction', issues: body.error.issues.map((issue) => issue.message) },
      400,
    );
  }
  const transaction = await createTransaction(c.env.DB, {
    userId: c.get('userId'),
    ...body.data,
  });
  return c.json({ transaction }, 201);
});

app.patch('/api/transactions/:id/confirm', async (c) => {
  const body = z.object({ confirmDate: dateSchema }).safeParse(await parsedJson(c.req.raw));
  if (!body.success) return c.json({ error: 'invalid confirm date' }, 400);
  const transaction = await confirmTransaction(
    c.env.DB,
    c.get('userId'),
    c.req.param('id'),
    body.data.confirmDate,
  );
  return c.json({ transaction });
});

app.delete('/api/transactions/:id', async (c) => {
  await deleteTransaction(c.env.DB, c.get('userId'), c.req.param('id'));
  return c.body(null, 204);
});

app.get('/api/positions', async (c) => {
  const snapshot = await loadPositionSnapshot(c.env, c.get('userId'));
  for (const position of snapshot.positions) {
    if (position.officialValue === null) {
      c.executionCtx.waitUntil(
        syncOfficialNavForFund(c.env, position.fundCode).catch((error) => {
          console.warn(`[positions] 官方净值后台补齐失败 code=${position.fundCode}`, error);
        }),
      );
    } else if (position.fundName === `基金 ${position.fundCode}`) {
      c.executionCtx.waitUntil(
        getFundMeta(c.env, position.fundCode).catch((error) => {
          console.warn(`[positions] 基金资料后台补齐失败 code=${position.fundCode}`, error);
        }),
      );
    }
  }
  return c.json(snapshot);
});

app.get('/api/xray', async (c) => c.json(await loadXRaySnapshot(c.env, c.get('userId'))));

app.get('/api/returns', async (c) => {
  const to = dateSchema.safeParse(c.req.query('to') ?? beijingDate(Date.now()));
  if (!to.success) return c.json({ error: 'invalid date range' }, 400);
  const defaultFrom = new Date(Date.parse(`${to.data}T00:00:00Z`) - 89 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const range = z.object({ from: dateSchema, to: dateSchema }).safeParse({
    from: c.req.query('from') ?? defaultFrom,
    to: to.data,
  });
  if (!range.success) return c.json({ error: 'invalid date range' }, 400);
  if (range.data.from > range.data.to) return c.json({ error: 'from must not be after to' }, 400);
  return c.json(
    await getDailyReturns(c.env.DB, c.get('userId'), range.data.from, range.data.to),
  );
});

const NotifyKindSchema = z.enum(['DAILY', 'ALERT']);

app.get('/api/notify-bindings', async (c) => {
  const configured = await listNotifyBindingKinds(c.env.DB, c.get('userId'));
  return c.json({
    bindings: (['DAILY', 'ALERT'] as const).map((kind) => ({
      kind,
      provider: 'DISCORD' as const,
      configured: configured.includes(kind),
    })),
  });
});

app.put('/api/notify-bindings/:kind', async (c) => {
  const kind = NotifyKindSchema.safeParse(c.req.param('kind'));
  const body = z.object({ webhookUrl: z.string().min(1).max(2_048) }).safeParse(
    await parsedJson(c.req.raw),
  );
  if (!kind.success || !body.success) return c.json({ error: 'invalid binding' }, 400);
  try {
    validateDiscordWebhookUrl(body.data.webhookUrl);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Discord webhook URL 格式非法' },
      400,
    );
  }
  await upsertNotifyBinding(c.env, c.get('userId'), kind.data, body.data.webhookUrl);
  return c.json({ kind: kind.data, provider: 'DISCORD', configured: true });
});

app.delete('/api/notify-bindings/:kind', async (c) => {
  const kind = NotifyKindSchema.safeParse(c.req.param('kind'));
  if (!kind.success) return c.json({ error: 'invalid binding kind' }, 400);
  const deleted = await deleteNotifyBinding(c.env.DB, c.get('userId'), kind.data);
  if (!deleted) return c.json({ error: 'binding not found' }, 404);
  return c.body(null, 204);
});

app.post('/api/notify-bindings/:kind/test', async (c) => {
  const kind = NotifyKindSchema.safeParse(c.req.param('kind'));
  if (!kind.success) return c.json({ error: 'invalid binding kind' }, 400);
  const binding = await getNotifyBinding(c.env, c.get('userId'), kind.data);
  if (!binding) return c.json({ error: 'binding not found' }, 404);

  const notifier = new DiscordNotifier();
  const date = beijingDate(Date.now());
  const result =
    kind.data === 'DAILY'
      ? await notifier.send(binding, await buildDailyBrief(c.env, binding, date))
      : await notifier.sendAlert(binding, {
          date,
          title: '通知链路测试',
          description: '设置页测试成功：加密读取、Worker 出口与 Discord webhook 均可用。',
        });
  if (!result.ok) {
    console.error(
      `[notify] 设置页测试失败 user=${c.get('userId')} kind=${kind.data} status=${result.status ?? 'network'} error=${result.error ?? 'unknown'}`,
    );
    return c.json({ error: `Discord 发送失败：${result.error ?? '未知错误'}` }, 502);
  }
  return c.json({ kind: kind.data, delivered: true, status: result.status });
});

app.onError((err, c) => {
  if (err instanceof InvalidCredentialError) return c.json({ error: err.message }, 401);
  if (err instanceof TransactionNotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof TransactionConflictError) return c.json({ error: err.message }, 409);
  if (err instanceof TransactionDomainError) return c.json({ error: err.message }, 400);
  console.error('[api]', err);
  return c.json({ error: 'internal error' }, 500);
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
} satisfies ExportedHandler<Env>;
