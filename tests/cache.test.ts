import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchQuotesResilientMock = vi.hoisted(() => vi.fn());
vi.mock('../apps/api/src/sources/quotes', () => ({
  fetchQuotesResilient: fetchQuotesResilientMock,
}));

import { cachedJson } from '../apps/api/src/cache';
import {
  expiredSessionCookie,
  generateSecretToken,
  hashSecret,
  readSessionToken,
  sessionCookie,
} from '../apps/api/src/auth';
import { consumeRateLimit } from '../apps/api/src/rate-limit';
import { cacheQuoteResult, getCachedQuotes } from '../apps/api/src/quote-cache';
import { isPublicApiRequest } from '../apps/api/src/index';

class FakeKV {
  private values = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  read<T>(key: string): T | null {
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }
}

class FakeRateLimiter {
  private counts = new Map<string, number>();

  constructor(private readonly limitValue: number) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const count = this.counts.get(key) ?? 0;
    if (count >= this.limitValue) return { success: false };
    this.counts.set(key, count + 1);
    return { success: true };
  }
}

describe('邀请登录凭据', () => {
  it('生成 32 字节 base64url token，持久化时只使用稳定 SHA-256 哈希', async () => {
    const token = generateSecretToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hashSecret(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashSecret(token)).toBe(await hashSecret(token));
    expect(generateSecretToken()).not.toBe(token);
  });

  it('会话 cookie 带齐安全属性，并能从多 cookie 请求中读取', () => {
    const token = 'a'.repeat(43);
    expect(sessionCookie(token)).toBe(
      `lookthru_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000`,
    );
    expect(
      readSessionToken(
        new Request('https://example.test', {
          headers: { Cookie: `theme=dark; lookthru_session=${token}; another=value` },
        }),
      ),
    ).toBe(token);
    expect(expiredSessionCookie()).toContain('Max-Age=0');
  });
});

describe('cachedJson', () => {
  it('可以负缓存 null', async () => {
    const cache = new FakeKV();
    let loads = 0;
    const load = async () => {
      loads++;
      return null;
    };

    expect(await cachedJson(cache as never, 'missing', 60, load)).toBeNull();
    expect(await cachedJson(cache as never, 'missing', 60, load)).toBeNull();
    expect(loads).toBe(1);
  });

  it('兼容旧版裸 JSON 缓存', async () => {
    const cache = new FakeKV();
    await cache.put('legacy', JSON.stringify({ ok: true }));
    const value = await cachedJson(
      cache as never,
      'legacy',
      60,
      async () => ({ ok: false }),
    );
    expect(value).toEqual({ ok: true });
  });
});

describe('公开基金接口限流', () => {
  it('鉴权边界使用公开白名单，触发型和用户数据接口默认受保护', () => {
    expect(isPublicApiRequest('GET', '/api/health')).toBe(true);
    expect(isPublicApiRequest('GET', '/api/probe/stats')).toBe(true);
    expect(isPublicApiRequest('GET', '/api/funds/050002/quotes')).toBe(true);
    expect(isPublicApiRequest('POST', '/api/auth/redeem')).toBe(true);
    expect(isPublicApiRequest('POST', '/api/probe/run')).toBe(false);
    expect(isPublicApiRequest('GET', '/api/quotes')).toBe(false);
    expect(isPublicApiRequest('GET', '/api/positions')).toBe(false);
    expect(isPublicApiRequest('GET', '/api/new-route-added-later')).toBe(false);
  });

  it('同一匿名来源第 31 次返回超限，不同来源使用独立确定性键', async () => {
    const limiter = new FakeRateLimiter(30);
    for (let request = 1; request <= 30; request++) {
      await expect(
        consumeRateLimit(limiter as never, '203.0.113.1'),
      ).resolves.toBe(true);
    }
    await expect(
      consumeRateLimit(limiter as never, '203.0.113.1'),
    ).resolves.toBe(false);
    await expect(
      consumeRateLimit(limiter as never, '203.0.113.2'),
    ).resolves.toBe(true);
  });
});

describe('行情 stale-while-revalidate 缓存', () => {
  beforeEach(() => {
    fetchQuotesResilientMock.mockReset();
  });

  it('Cron 抓到的行情同时写入热缓存和 last-known-good', async () => {
    const cache = new FakeKV();
    await cacheQuoteResult(
      { CACHE: cache } as never,
      {
        provider: 'tencent',
        delayed: false,
        attempts: [],
        quotes: new Map([
          [
            '1.600519',
            {
              secid: '1.600519',
              code: '600519',
              name: '',
              price: 1_500,
              chgPct: 1,
              prevClose: 1_485,
            },
          ],
        ]),
      },
    );

    expect(cache.read('quote:1.600519')).toMatchObject({ provider: 'tencent' });
    expect(cache.read('quote-lkg:1.600519')).toMatchObject({ provider: 'tencent' });
  });

  it('热缓存过期时立即返回旧行情，并在后台刷新下一次请求', async () => {
    const cache = new FakeKV();
    const env = {
      CACHE: cache,
      SHARED_REFRESH_RATE_LIMITER: new FakeRateLimiter(1),
    };
    const oldQuote = {
      secid: '1.600519',
      code: '600519',
      name: '',
      price: 1_400,
      chgPct: -1,
      prevClose: 1_414,
    };
    await cache.put(
      'quote-lkg:1.600519',
      JSON.stringify({
        quote: oldQuote,
        provider: 'sina',
        delayed: false,
        fetchedAt: '2026-08-13T00:00:00.000Z',
      }),
    );
    fetchQuotesResilientMock.mockResolvedValueOnce({
      provider: 'tencent',
      delayed: false,
      attempts: [],
      quotes: new Map([['1.600519', { ...oldQuote, price: 1_500, chgPct: 1 }]]),
    });
    const deferred: Promise<unknown>[] = [];

    const first = await getCachedQuotes(
      env as never,
      ['1.600519'],
      (task) => deferred.push(task),
    );
    expect(first.quotes.get('1.600519')?.price).toBe(1_400);
    expect(first.staleSecids).toEqual(['1.600519']);

    await Promise.all(deferred);
    const second = await getCachedQuotes(
      env as never,
      ['1.600519'],
      (task) => deferred.push(task),
    );
    expect(second.quotes.get('1.600519')?.price).toBe(1_500);
    expect(second.staleSecids).toEqual([]);
    expect(fetchQuotesResilientMock).toHaveBeenCalledTimes(1);
  });
});
