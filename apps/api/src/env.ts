export interface Env {
  /** Workers Static Assets：前端与 API 同源同 Worker，无 CORS */
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  /** R2 尚未在账号上启用，wrangler.toml 里的 binding 是注释掉的 → 运行时为 undefined */
  ARCHIVE?: R2Bucket;
  ENVIRONMENT: string;
}
