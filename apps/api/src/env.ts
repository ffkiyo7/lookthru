export interface Env {
  /** Workers Static Assets：前端与 API 同源同 Worker，无 CORS */
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  ARCHIVE: R2Bucket;
}
