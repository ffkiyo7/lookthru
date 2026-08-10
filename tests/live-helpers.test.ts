import { describe, expect, it } from 'vitest';
import { unreachableReason } from './live-helpers';
import { UpstreamError } from '../apps/api/src/sources/http';

const undiciTimeout = () => {
  const inner: any = new Error('connect ETIMEDOUT 123.249.33.119:443');
  inner.code = 'ETIMEDOUT';
  inner.address = '123.249.33.119';
  const agg: any = new AggregateError([inner]);
  agg.code = 'ETIMEDOUT';
  const t: any = new TypeError('fetch failed');
  t.cause = agg;
  return t;
};
const undiciSocket = () => {
  const inner: any = new Error('other side closed');
  inner.code = 'UND_ERR_SOCKET';
  const t: any = new TypeError('fetch failed');
  t.cause = inner;
  return t;
};

describe('应跳过（不可达）', () => {
  it('CI 里的 ETIMEDOUT', () => expect(unreachableReason(undiciTimeout())).toMatch(/ETIMEDOUT/));
  it('CI 里的 socket 关闭', () =>
    expect(unreachableReason(undiciSocket())).toMatch(/UND_ERR_SOCKET/));
  it('HTTP 502', () =>
    expect(unreachableReason(new UpstreamError('HTTP 502', 502, 'push2'))).toMatch(/502/));
  it('HTTP 429', () =>
    expect(unreachableReason(new UpstreamError('HTTP 429', 429, 'em'))).toMatch(/429/));
  it('超时', () => {
    const e: any = new Error('t');
    e.name = 'TimeoutError';
    expect(unreachableReason(e)).toBe('请求超时');
  });
});

describe('应失败（契约破坏）', () => {
  it('404 端点下线 —— fundgz 的签名', () =>
    expect(unreachableReason(new UpstreamError('HTTP 404', 404, 'fundgz'))).toBeNull());
  it('403', () => expect(unreachableReason(new UpstreamError('HTTP 403', 403, 'em'))).toBeNull());
  it('HTML 错误页', () =>
    expect(unreachableReason(new UpstreamError('上游返回 HTML 错误页', 200, 'em'))).toBeNull());
  it('非法 JSON', () =>
    expect(unreachableReason(new UpstreamError('响应不是合法 JSON', null, 'em'))).toBeNull());
  it('断言失败', () => expect(unreachableReason(new Error('expected 3 to be 2'))).toBeNull());
});
