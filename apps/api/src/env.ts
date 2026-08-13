export interface Env {
  /** Workers Static Assets：前端与 API 同源同 Worker，无 CORS */
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  ARCHIVE: R2Bucket;
  PUBLIC_FUNDS_RATE_LIMITER: RateLimit;
  PUBLIC_AUTH_RATE_LIMITER: RateLimit;
  PUBLIC_STATUS_RATE_LIMITER: RateLimit;
  SHARED_REFRESH_RATE_LIMITER: RateLimit;
  /** AES-GCM 32 字节 base64url 密钥；只允许通过 Worker secret / .dev.vars 注入。 */
  NOTIFY_KEY?: string;
}

/** 把不影响当前响应的刷新或缓存维护交给 Worker 生命周期继续执行。 */
export type Defer = (task: Promise<unknown>) => void;
