/**
 * D1 持久化请求日志模块
 *
 * 表结构（db/schema.sql 提供建表语句）：
 *   CREATE TABLE IF NOT EXISTS webdav_logs (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     ts INTEGER NOT NULL,            -- 请求时间（Unix ms）
 *     method TEXT NOT NULL,           -- HTTP 方法
 *     path TEXT NOT NULL,             -- 规范化请求路径
 *     status INTEGER NOT NULL,        -- 响应状态码
 *     duration_ms INTEGER NOT NULL,   -- 耗时（ms）
 *     storage TEXT NOT NULL DEFAULT ''-- 存储后端类型
 *   );
 *
 * 使用方式：
 *   const logger = new D1Logger(env.LOGS_DB, config.log);
 *   await logger.log({ method, path, status, durationMs, storage });
 *   const page = await logger.query({ limit, offset, method, status });
 */
import type { LogConfig } from '../config';

export interface LogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  storage: string;
}

export interface LogPage {
  total: number;
  entries: (LogEntry & { id: number; ts: number })[];
}

export class D1Logger {
  constructor(
    private db: D1Database | undefined,
    private cfg: LogConfig
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled && !!this.db;
  }

  /** 写入一条请求日志（失败静默，不阻塞主流程） */
  async log(entry: LogEntry): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.db!
        .prepare(
          `INSERT INTO ${this.cfg.table} (ts, method, path, status, duration_ms, storage)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(Date.now(), entry.method, entry.path, entry.status, entry.durationMs, entry.storage)
        .run();
    } catch (e) {
      console.error('[d1-log] write failed:', e);
    }
  }

  /** 分页查询日志，支持按方法 / 状态码过滤 */
  async query(opts: { limit: number; offset: number; method?: string; status?: number }): Promise<LogPage | null> {
    if (!this.enabled) return null;
    const { limit, offset, method, status } = opts;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (method) {
      where.push('method = ?');
      params.push(method);
    }
    if (status !== undefined && !Number.isNaN(status)) {
      where.push('status = ?');
      params.push(status);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const totalRes = await this.db!
      .prepare(`SELECT COUNT(*) AS n FROM ${this.cfg.table}${whereSql}`)
      .bind(...params)
      .first<{ n: number }>();
    const rows = await this.db!
      .prepare(
        `SELECT id, ts, method, path, status, duration_ms, storage
         FROM ${this.cfg.table}${whereSql}
         ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<LogEntry & { id: number; ts: number }>();

    return {
      total: totalRes?.n ?? 0,
      entries: rows.results ?? [],
    };
  }
}