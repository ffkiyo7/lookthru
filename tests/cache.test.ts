import { describe, expect, it } from 'vitest';
import { cachedJson } from '../apps/api/src/cache';

class FakeKV {
  private values = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

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
