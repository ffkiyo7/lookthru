-- 鉴权、通知绑定与估值双时点样本。
-- webhook 和所有可直接登录的 token 只存哈希或 AES-GCM 密文。

CREATE TABLE invite_codes (
  code_hash   TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  created_at  TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT REFERENCES users(id),
  CHECK (
    (redeemed_at IS NULL AND redeemed_by IS NULL)
    OR (redeemed_at IS NOT NULL AND redeemed_by IS NOT NULL)
  )
);

CREATE TABLE user_recovery_codes (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  recovery_hash TEXT NOT NULL UNIQUE CHECK (length(recovery_hash) = 64),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE notify_bindings (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('DAILY', 'ALERT')),
  provider           TEXT NOT NULL CHECK (provider = 'DISCORD'),
  encryption_version INTEGER NOT NULL CHECK (encryption_version = 1),
  webhook_iv         TEXT NOT NULL,
  webhook_ciphertext TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (user_id, kind)
);

CREATE INDEX idx_notify_bindings_kind ON notify_bindings (kind, user_id);

-- 15:05 收盘快照与 14:55 验收样本必须能在同一天并存；旧行全部是 14:55 口径。
CREATE TABLE valuation_samples_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code         TEXT NOT NULL CHECK (fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'),
  trade_date        TEXT NOT NULL CHECK (trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sample_kind       TEXT NOT NULL CHECK (sample_kind IN ('CALIBRATION_1455', 'CLOSE_1505')),
  sampled_at        TEXT NOT NULL,
  est_nav           REAL,
  est_chg_pct       REAL,
  precision         TEXT NOT NULL CHECK (precision IN ('EXACT', 'HIGH', 'MEDIUM', 'LOW', 'NONE')),
  prev_nav          REAL,
  delayed           INTEGER NOT NULL DEFAULT 0 CHECK (delayed IN (0, 1)),
  basis_json        TEXT NOT NULL CHECK (json_valid(basis_json)),
  official_nav      REAL,
  official_nav_date TEXT CHECK (official_nav_date IS NULL OR official_nav_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reconciled_at     TEXT,
  UNIQUE (fund_code, trade_date, sample_kind)
);

INSERT INTO valuation_samples_new (
  id, fund_code, trade_date, sample_kind, sampled_at, est_nav, est_chg_pct,
  precision, prev_nav, delayed, basis_json, official_nav, official_nav_date, reconciled_at
)
SELECT
  id, fund_code, trade_date, 'CALIBRATION_1455', sampled_at, est_nav, est_chg_pct,
  precision, prev_nav, delayed, basis_json, official_nav, official_nav_date, reconciled_at
FROM valuation_samples;

CREATE TABLE migration_guard_0003 (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_guard_0003 (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM valuation_samples_new) = (SELECT COUNT(*) FROM valuation_samples)
  THEN 1 ELSE 0 END;

DROP TABLE valuation_samples;
ALTER TABLE valuation_samples_new RENAME TO valuation_samples;

CREATE INDEX idx_valuation_samples_unreconciled
  ON valuation_samples (trade_date, fund_code)
  WHERE reconciled_at IS NULL;
CREATE INDEX idx_valuation_samples_report
  ON valuation_samples (sample_kind, precision, reconciled_at, trade_date);

-- 现金分红按本金返还处理；累计分红超过初始投入时，经济成本可以为负。
CREATE TABLE positions_cache_new (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_code  TEXT NOT NULL CHECK (fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'),
  shares     REAL NOT NULL CHECK (shares >= 0),
  cost_total REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, fund_code)
);

INSERT INTO positions_cache_new (user_id, fund_code, shares, cost_total, updated_at)
SELECT user_id, fund_code, shares, cost_total, updated_at FROM positions_cache;

INSERT INTO migration_guard_0003 (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM positions_cache_new) = (SELECT COUNT(*) FROM positions_cache)
  THEN 1 ELSE 0 END;

DROP TABLE positions_cache;
ALTER TABLE positions_cache_new RENAME TO positions_cache;
DROP TABLE migration_guard_0003;
