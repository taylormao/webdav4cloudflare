-- WebDAV Cloud Drive — D1 数据库 Schema
-- 初始化命令：
--   wrangler d1 create webdav-logs            # 创建数据库（记下 database_id 填入 wrangler.toml）
--   wrangler d1 execute webdav-logs --remote --file=db/schema.sql   # 远程建表
--   wrangler d1 execute webdav-logs --local --file=db/schema.sql    # 本地开发建表

CREATE TABLE IF NOT EXISTS webdav_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- 请求时间（Unix 毫秒）
  method TEXT NOT NULL,           -- HTTP 方法（GET/PROPFIND/PUT/...）
  path TEXT NOT NULL,             -- 规范化请求路径
  status INTEGER NOT NULL,        -- 响应状态码
  duration_ms INTEGER NOT NULL,   -- 请求耗时（毫秒）
  storage TEXT NOT NULL DEFAULT '' -- 存储后端类型（s3/telegram/baidu/gdrive/dropbox）
);

CREATE INDEX IF NOT EXISTS idx_webdav_logs_ts ON webdav_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_webdav_logs_method ON webdav_logs(method);
CREATE INDEX IF NOT EXISTS idx_webdav_logs_status ON webdav_logs(status);
