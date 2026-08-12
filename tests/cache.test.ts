import { describe, expect, it, vi } from 'vitest';
import { cachedJson } from '../apps/api/src/cache';
import {
  expiredSessionCookie,
  generateSecretToken,
  hashSecret,
  readSessionToken,
  sessionCookie,
} from '../apps/api/src/auth';
import { getFundSearchChanges } from '../apps/api/src/search-changes';
import { consumeKvRateLimit } from '../apps/api/src/rate-limit';
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
    const value = await cachedJson(cache as never, 'legacy', 60, async () => ({ ok: false }));
    expect(value).toEqual({ ok: true });
  });
});

describe('搜索涨跌幅缓存', () => {
  it('基金信息缓存之外按代码共享 60 秒行情，并保留 last-known-good', async () => {
    const cache = new FakeKV();
    let loads = 0;
    const load = async () => {
      loads++;
      return new Map([
        [
          '000001',
          {
            code: '000001',
            unitNav: 1.01,
            accNav: 1.01,
            prevNav: 1,
            date: '2026-08-12',
          },
        ],
      ]);
    };

    const first = await getFundSearchChanges(cache as never, ['000001'], load);
    expect(first.get('000001')).toMatchObject({ chgPct: 1, stale: false, unavailable: false });
    await getFundSearchChanges(cache as never, ['000001'], load);
    expect(loads).toBe(1);

    cache.delete('search-change:000001');
    const stale = await getFundSearchChanges(cache as never, ['000001'], async () => {
      throw new Error('sina unavailable');
    });
    expect(stale.get('000001')).toMatchObject({ chgPct: 1, stale: true, unavailable: false });
  });

  it('上游失败且没有 last-known-good 时保留搜索结果并明确标成不可用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        getFundSearchChanges(new FakeKV() as never, ['000001'], async () => {
          throw new Error('sina unavailable');
        }),
      ).resolves.toEqual(
        new Map([
          [
            '000001',
            { chgPct: null, fetchedAt: null, stale: false, unavailable: true },
          ],
        ]),
      );
    } finally {
      warn.mockRestore();
    }
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

  it('同一 IP 每分钟第 31 次返回超限，不同 IP 与下一分钟独立计数', async () => {
    const cache = new FakeKV();
    const now = Date.parse('2026-08-12T00:00:30Z');
    for (let request = 1; request <= 30; request++) {
      await expect(
        consumeKvRateLimit(cache as never, '203.0.113.1', 'public-funds', now, 30),
      ).resolves.toBe(true);
    }
    await expect(
      consumeKvRateLimit(cache as never, '203.0.113.1', 'public-funds', now, 30),
    ).resolves.toBe(false);
    await expect(
      consumeKvRateLimit(cache as never, '203.0.113.2', 'public-funds', now, 30),
    ).resolves.toBe(true);
    await expect(
      consumeKvRateLimit(cache as never, '203.0.113.1', 'public-funds', now + 60_000, 30),
    ).resolves.toBe(true);
  });
});
