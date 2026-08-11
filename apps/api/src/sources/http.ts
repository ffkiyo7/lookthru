/**
 * 上游抓取的统一出口。
 *
 * 铁律（见 plan 3.3）：所有用户共享同一份上游数据，绝不 per-user 请求上游。
 * 100 个用户持有同一只基金 = 1 次上游请求。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly source: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface FetchOptions {
  referer?: string;
  timeoutMs?: number;
  /** 重试次数（不含首次） */
  retries?: number;
  /** 用于报错定位 */
  source: string;
  /** 部分东财端点返回 GBK，需按 latin1 读取后只取数值字段 */
  decodeAs?: 'utf-8' | 'latin1';
}

export interface FetchResult {
  text: string;
  status: number;
  latencyMs: number;
  bytes: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastRequestStartedAt = new Map<string, number>();
const originTails = new Map<string, Promise<void>>();

async function waitForOriginSlot(url: string): Promise<void> {
  const origin = new URL(url).origin;
  const previous = originTails.get(origin) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - (lastRequestStartedAt.get(origin) ?? 0);
    const remainingMs = Math.max(0, 1_000 - elapsed);
    const waitMs = remainingMs === 0 ? 0 : remainingMs + Math.random() * 150;
    if (waitMs > 0) await sleep(waitMs);
    lastRequestStartedAt.set(origin, Date.now());
  });
  originTails.set(origin, current);
  await current;
  if (originTails.get(origin) === current) originTails.delete(origin);
}

export async function fetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const { timeoutMs = 12_000, retries = 2, source, referer, decodeAs = 'utf-8' } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 指数退避 + 抖动，避免同时惊群打爆上游
      await sleep(300 * 2 ** (attempt - 1) + Math.random() * 200);
    }
    try {
      // 上游 ToS 是灰区。同一 origin 的并发请求也必须排队，否则 Promise.all
      // 会绕过“礼貌限流”，用户增长后静默变成高频抓取器。
      await waitForOriginSlot(url);
      const started = Date.now();
      const res = await fetch(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: '*/*',
          ...(referer ? { Referer: referer } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = await res.arrayBuffer();
      const text = new TextDecoder(decodeAs).decode(buf);
      const latencyMs = Date.now() - started;

      if (!res.ok) {
        lastErr = new UpstreamError(`HTTP ${res.status}`, res.status, source);
        // 4xx 通常不会因重试而变好（除 429）
        if (res.status !== 429 && res.status < 500) throw lastErr;
        continue;
      }
      // 东财对不存在/已下线的路径返回 200 或 404 的 HTML 错误页，
      // 必须内容嗅探，否则会把错误页当数据解析。fundgz 就是这样 404 的。
      if (looksLikeErrorPage(text)) {
        lastErr = new UpstreamError('上游返回 HTML 错误页（接口可能已下线）', res.status, source);
        throw lastErr;
      }
      return { text, status: res.status, latencyMs, bytes: buf.byteLength };
    } catch (e) {
      lastErr = e;
      if (e instanceof UpstreamError && e.status !== null && e.status < 500 && e.status !== 429) {
        break;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new UpstreamError(String(lastErr), null, source);
}

function looksLikeErrorPage(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  return (
    head.includes('<!doctype html') ||
    head.includes('<html') ||
    text.includes('页面未找到')
  );
}

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const { text } = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError('响应不是合法 JSON', null, opts.source);
  }
}

/** JSONP: `cb({...})` / `var x = {...}` 之类的包装剥离 */
export async function fetchJsonp<T>(url: string, opts: FetchOptions): Promise<T> {
  const { text } = await fetchText(url, opts);
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end <= start) {
    throw new UpstreamError('响应不是合法 JSONP', null, opts.source);
  }
  try {
    return JSON.parse(text.slice(start + 1, end)) as T;
  } catch {
    throw new UpstreamError('JSONP 内容不是合法 JSON', null, opts.source);
  }
}

/**
 * 从 `var NAME = <json>;` 形式的 JS 文件中提取变量值。
 * 不使用 eval —— Workers 禁用动态求值，且执行上游脚本本身不可接受。
 * 用括号配对扫描，正确处理字符串内的括号与转义。
 */
export function extractJsVar(src: string, name: string): unknown {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) return undefined;

  const start = m.index + m[0].length;
  const first = src[start];

  if (first === '[' || first === '{') {
    const close = first === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === first) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(src.slice(start, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  // 基本类型：读到分号为止
  const semi = src.indexOf(';', start);
  if (semi === -1) return undefined;
  const raw = src.slice(start, semi).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
