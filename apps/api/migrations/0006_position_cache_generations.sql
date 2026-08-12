-- D1 没有跨请求锁；世代号让并发流水写入显式冲突，并标出物化缓存是否追上真相源。
CREATE TABLE position_cache_generations (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_generation TEXT NOT NULL,
  cached_generation  TEXT
);

INSERT INTO position_cache_generations (user_id, current_generation, cached_generation)
SELECT id, 'migrated', 'migrated' FROM users;
