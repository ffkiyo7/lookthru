import { it } from 'vitest';
import { UpstreamError } from '../apps/api/src/sources/http';

/**
 * 契约测试的失败分类。
 *
 * 这套测试存在的唯一理由是「上游改结构了要立刻知道」（fundgz 就是这么悄悄没的）。
 * 但它跑在 GitHub Actions 的 Azure 出口上，而东财的 GSLB 会按客户端地域派发不同源站 ——
 * 境外出口拿到的是华为云/火山引擎那批 IP，会间歇性 ETIMEDOUT 或握手后直接关连接。
 * 本机与 Cloudflare 出口同一时刻全部 200。
 *
 * 所以必须分开两种红：
 *
 *   连不上（传输层 / 5xx / 429）  → skip + ::warning::，因为它不携带任何契约信息
 *   连上了但不对（4xx / HTML 错误页 / 非法 JSON / 断言失败） → fail
 *
 * 混在一起的代价不是漏报，是**告警疲劳**：每周红三次的日报没人看，
 * 等真的解析器挂了，那条红和前面十条长得一模一样。
 */

/** Node/undici 的传输层错误码 —— 一个字节都没拿到 */
const TRANSPORT_CODES = new Set([
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** 沿 cause / AggregateError.errors 展开整条错误链 */
function* walk(e: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || e === null || typeof e !== 'object') return;
  const obj = e as Record<string, unknown>;
  yield obj;
  yield* walk(obj.cause, depth + 1);
  if (Array.isArray(obj.errors)) {
    for (const sub of obj.errors) yield* walk(sub, depth + 1);
  }
}

/**
 * 返回「不可达」的原因，若属于契约问题则返回 null（交给调用方抛出）。
 */
export function unreachableReason(e: unknown): string | null {
  // UpstreamError 意味着我们**收到了响应**，只有 5xx / 429 算基础设施问题；
  // 4xx、HTML 错误页、非法 JSON 都是契约信号，必须红。
  if (e instanceof UpstreamError) {
    if (e.status !== null && (e.status >= 500 || e.status === 429)) {
      return `${e.source} 返回 HTTP ${e.status}`;
    }
    return null;
  }

  // 先找具体原因。undici 把传输层失败统一包成 TypeError: fetch failed，
  // 真因在 cause / AggregateError.errors 里 —— 必须先下潜，否则告警只会写「fetch failed」，
  // 而「ETIMEDOUT 123.249.33.119」才看得出是被哪个源站丢包。
  let generic: string | null = null;
  for (const node of walk(e)) {
    const code = typeof node.code === 'string' ? node.code : null;
    if (code && TRANSPORT_CODES.has(code)) {
      const addr = typeof node.address === 'string' ? ` ${node.address}` : '';
      return `${code}${addr}`;
    }
    const name = typeof node.name === 'string' ? node.name : null;
    if (name === 'TimeoutError' || name === 'AbortError') return '请求超时';
    // 兜底：cause 结构变了也不能把网络抖动报成契约破坏
    if (node.message === 'fetch failed') generic = 'fetch failed（传输层，无具体错误码）';
  }
  return generic;
}

let reached = 0;
let unreachable = 0;

/**
 * 打真实端点的契约测试用这个，不要直接用 `it`。
 * 纯函数测试仍然用 `it` —— 它们不该有 skip 的余地。
 */
export function liveIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    try {
      await fn();
    } catch (e) {
      const why = unreachableReason(e);
      if (why === null) throw e;
      unreachable++;
      // GitHub Actions 会把 ::warning:: 提成 job 摘要里的黄条
      console.warn(`::warning title=上游不可达::「${name}」跳过：${why}`);
      ctx.skip(`上游不可达：${why}`);
      return;
    }
    reached++;
  });
}

/**
 * 在测试文件里 `afterAll(assertNotAllUnreachable)`。
 *
 * 全跳过时套件会「空绿」—— 那不是通过，是整条出口不通。这种情况必须红，
 * 否则日报会在数据源全挂的那天显示绿色。
 */
export function assertNotAllUnreachable(): void {
  if (unreachable === 0) return;
  console.warn(
    `::warning title=契约测试降级::${unreachable} 项因上游不可达跳过，${reached} 项完成校验`,
  );
  if (reached === 0) {
    throw new Error(
      `全部 ${unreachable} 项契约测试都因上游不可达跳过 —— 这是出口整体不通，不是抖动，必须查`,
    );
  }
}
