-- P1 数据层。流水是持仓的唯一真相源，positions_cache 只是可重建缓存。

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_code    TEXT NOT NULL CHECK (fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'),
  type         TEXT NOT NULL CHECK (type IN ('SNAPSHOT', 'BUY', 'SELL', 'DIVIDEND', 'CONVERT')),
  trade_date   TEXT NOT NULL CHECK (trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  confirm_date TEXT CHECK (confirm_date IS NULL OR confirm_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  shares       REAL CHECK (shares IS NULL OR shares >= 0),
  amount       REAL CHECK (amount IS NULL OR amount >= 0),
  price        REAL CHECK (price IS NULL OR price >= 0),
  fee          REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
  status       TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED')),
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (status = 'PENDING' OR confirm_date IS NOT NULL),
  CHECK (type <> 'SNAPSHOT' OR (shares IS NOT NULL AND amount IS NOT NULL AND status = 'CONFIRMED'))
);

CREATE INDEX idx_transactions_user_date
  ON transactions (user_id, trade_date DESC);
CREATE INDEX idx_transactions_user_fund_date
  ON transactions (user_id, fund_code, trade_date DESC);
CREATE INDEX idx_transactions_pending
  ON transactions (user_id, trade_date)
  WHERE status = 'PENDING';

CREATE TABLE positions_cache (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_code  TEXT NOT NULL CHECK (fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'),
  shares     REAL NOT NULL CHECK (shares >= 0),
  cost_total REAL NOT NULL CHECK (cost_total >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, fund_code)
);

-- 只存最新官方值；全量净值历史严格放 R2。
-- 货币基金的 DWJZ 是万份收益，不能静默写进 unit_nav。
CREATE TABLE latest_official_navs (
  fund_code             TEXT PRIMARY KEY CHECK (fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'),
  value_kind            TEXT NOT NULL CHECK (value_kind IN ('UNIT_NAV', 'TEN_THOUSAND_YIELD')),
  unit_nav              REAL,
  acc_nav               REAL,
  chg_pct               REAL,
  ten_thousand_yield    REAL,
  seven_day_yield_pct   REAL,
  nav_date              TEXT NOT NULL CHECK (nav_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source                TEXT NOT NULL,
  fetched_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (
    (value_kind = 'UNIT_NAV' AND unit_nav IS NOT NULL AND ten_thousand_yield IS NULL)
    OR
    (value_kind = 'TEN_THOUSAND_YIELD' AND unit_nav IS NULL AND ten_thousand_yield IS NOT NULL)
  )
);

CREATE INDEX idx_latest_official_navs_date
  ON latest_official_navs (nav_date DESC);

-- 有界的 14:55 估值验收样本，不是净值历史。
CREATE TABLE valuation_samples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code         TEXT NOT NULL CHECK (fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'),
  trade_date        TEXT NOT NULL CHECK (trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
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
  UNIQUE (fund_code, trade_date)
);

CREATE INDEX idx_valuation_samples_unreconciled
  ON valuation_samples (trade_date, fund_code)
  WHERE reconciled_at IS NULL;
