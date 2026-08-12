export interface Env {
  /** Workers Static Assets：前端与 API 同源同 Worker，无 CORS */
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  ARCHIVE: R2Bucket;
  /** AES-GCM 32 字节 base64url 密钥；只允许通过 Worker secret / .dev.vars 注入。 */
  NOTIFY_KEY?: string;
}
