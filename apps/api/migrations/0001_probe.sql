-- P0 出口探针结果。判定 Cloudflare Workers 能否稳定抓取东财。
-- P1 起本表只保留作历史参考，不再写入。

CREATE TABLE IF NOT EXISTS probe_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  probed_at  TEXT    NOT NULL,          -- ISO8601 UTC
  source     TEXT    NOT NULL,          -- fundlist | pingzhong | quotes
  ok         INTEGER NOT NULL,          -- 0 / 1
  latency_ms INTEGER,
  detail     TEXT,                      -- 字节数或返回条数
  error      TEXT,
  colo       TEXT                       -- CF 边缘节点，用于识别地域性封禁
);

CREATE INDEX IF NOT EXISTS idx_probe_at ON probe_results (probed_at);
CREATE INDEX IF NOT EXISTS idx_probe_source_at ON probe_results (source, probed_at);
