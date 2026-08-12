-- 邀请码一经兑换就必须永久失效；删除用户不能级联抹掉兑换事实。
CREATE TABLE invite_redemptions_new (
  code_hash   TEXT PRIMARY KEY REFERENCES invite_codes(code_hash),
  user_id     TEXT NOT NULL UNIQUE REFERENCES users(id),
  redeemed_at TEXT NOT NULL
);

INSERT INTO invite_redemptions_new (code_hash, user_id, redeemed_at)
SELECT code_hash, user_id, redeemed_at FROM invite_redemptions;

CREATE TABLE migration_guard_0005 (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_guard_0005 (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM invite_redemptions_new)
       = (SELECT COUNT(*) FROM invite_redemptions)
  THEN 1 ELSE 0 END;

DROP TABLE invite_redemptions;
ALTER TABLE invite_redemptions_new RENAME TO invite_redemptions;
DROP TABLE migration_guard_0005;
