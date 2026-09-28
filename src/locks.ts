/**
 * 锁存储 — 基于 Cloudflare KV
 *
 * LOCK / UNLOCK 状态存储：
 *   key:  lock:<token>
 *   value: JSON { path, owner, timeoutSec, expires, depth }
 */
export interface LockRecord {
  path: string;
  owner: string;
  timeoutSec: number;
  expires: number; // epoch ms
  depth: '0' | 'infinity';
  token: string;
}

export interface LockStore {
  create(record: LockRecord): Promise<void>;
  get(token: string): Promise<LockRecord | null>;
  /** 查找锁定某路径的锁（遍历不可行时退化为 null；KV 无前缀枚举时由调用方维护） */
  delete(token: string): Promise<void>;
  /** 清理过期锁 */
  prune(): Promise<void>;
}

/** KV 实现（KV namespace 提供 list 以支持清理） */
export class KvLockStore implements LockStore {
  constructor(private kv: KVNamespace, private prefix = 'lock:') {}

  async create(record: LockRecord): Promise<void> {
    await this.kv.put(this.prefix + record.token, JSON.stringify(record), {
      expirationTtl: record.timeoutSec + 60,
    });
  }

  async get(token: string): Promise<LockRecord | null> {
    const raw = await this.kv.get(this.prefix + token);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as LockRecord;
      if (rec.expires < Date.now()) {
        await this.delete(token);
        return null;
      }
      return rec;
    } catch {
      return null;
    }
  }

  async delete(token: string): Promise<void> {
    await this.kv.delete(this.prefix + token);
  }

  async prune(): Promise<void> {
    // 简单清理：列举 prefix 下条目并删除过期项
    const listed = await this.kv.list({ prefix: this.prefix });
    const now = Date.now();
    await Promise.all(
      listed.keys.map(async (k) => {
        const raw = await this.kv.get(k.name);
        if (!raw) return;
        try {
          const rec = JSON.parse(raw) as LockRecord;
          if (rec.expires < now) await this.kv.delete(k.name);
        } catch {
          await this.kv.delete(k.name);
        }
      })
    );
  }
}

/** 内存实现（本地测试 / 无 KV 绑定时的兜底） */
export class MemoryLockStore implements LockStore {
  private map = new Map<string, LockRecord>();

  async create(record: LockRecord): Promise<void> {
    this.map.set(record.token, record);
  }

  async get(token: string): Promise<LockRecord | null> {
    const rec = this.map.get(token);
    if (!rec) return null;
    if (rec.expires < Date.now()) {
      this.map.delete(token);
      return null;
    }
    return rec;
  }

  async delete(token: string): Promise<void> {
    this.map.delete(token);
  }

  async prune(): Promise<void> {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expires < now) this.map.delete(k);
    }
  }
}

/** 从 If 头 / Lock-Token 头提取 lock token */
export function extractLockToken(ifHeader?: string, lockTokenHeader?: string): string | null {
  if (lockTokenHeader) {
    const m = lockTokenHeader.match(/<([^>]+)>/);
    if (m) return m[1];
  }
  if (ifHeader) {
    // If: (<urn:uuid:xxx>) 或 (Not <urn:uuid:xxx>)
    const m = ifHeader.match(/\([^)]*(?:<([^>]+)>)[^)]*\)/);
    if (m) return m[1];
  }
  return null;
}

export function generateLockToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
