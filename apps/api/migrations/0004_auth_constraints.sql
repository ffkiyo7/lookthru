-- 邀请兑换要靠数据库唯一约束保证一次性，不能依赖「先查再写」的竞态窗口。
-- 同时移除鉴权表里没有实际消费方的更新时间字段，避免产生第二套状态语义。

CREATE TABLE invite_codes_new (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  created_at TEXT NOT NULL
);

INSERT INTO invite_codes_new (code_hash, created_at)
SELECT code_hash, created_at FROM invite_codes;

CREATE TABLE invite_redemptions_staging (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL UNIQUE,
  redeemed_at TEXT NOT NULL
);

INSERT INTO invite_redemptions_staging (code_hash, user_id, redeemed_at)
SELECT code_hash, redeemed_by, redeemed_at
FROM invite_codes
WHERE redeemed_by IS NOT NULL;

CREATE TABLE migration_guard_0004 (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_guard_0004 (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM invite_codes_new) = (SELECT COUNT(*) FROM invite_codes)
   AND (SELECT COUNT(*) FROM invite_redemptions_staging)
       = (SELECT COUNT(*) FROM invite_codes WHERE redeemed_by IS NOT NULL)
  THEN 1 ELSE 0 END;

DROP TABLE invite_codes;
ALTER TABLE invite_codes_new RENAME TO invite_codes;

CREATE TABLE invite_redemptions (
  code_hash   TEXT PRIMARY KEY REFERENCES invite_codes(code_hash),
  user_id     TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TEXT NOT NULL
);

INSERT INTO invite_redemptions (code_hash, user_id, redeemed_at)
SELECT code_hash, user_id, redeemed_at FROM invite_redemptions_staging;
DROP TABLE invite_redemptions_staging;

CREATE TABLE user_recovery_codes_new (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  recovery_hash TEXT NOT NULL UNIQUE CHECK (length(recovery_hash) = 64),
  created_at    TEXT NOT NULL
);

INSERT INTO user_recovery_codes_new (user_id, recovery_hash, created_at)
SELECT user_id, recovery_hash, created_at FROM user_recovery_codes;

INSERT INTO migration_guard_0004 (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM user_recovery_codes_new)
       = (SELECT COUNT(*) FROM user_recovery_codes)
  THEN 1 ELSE 0 END;

DROP TABLE user_recovery_codes;
ALTER TABLE user_recovery_codes_new RENAME TO user_recovery_codes;

CREATE TABLE sessions_new (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT INTO sessions_new (token_hash, user_id, created_at, expires_at)
SELECT token_hash, user_id, created_at, expires_at FROM sessions;

INSERT INTO migration_guard_0004 (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM sessions_new) = (SELECT COUNT(*) FROM sessions)
  THEN 1 ELSE 0 END;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

DROP TABLE migration_guard_0004;
