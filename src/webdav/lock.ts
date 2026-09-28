/**
 * LOCK / UNLOCK — 基于 KV 的写锁
 *
 * 为 Windows / macOS 客户端提供基础锁能力：
 *   - LOCK 无锁令牌 → 创建新锁（201 + Lock-Token 头）
 *   - LOCK 带 If 头（刷新）→ 刷新过期时间（200）
 *   - UNLOCK 携带 Lock-Token → 删除锁（204）
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { readBodyText } from './router';
import {
  KvLockStore,
  MemoryLockStore,
  extractLockToken,
  generateLockToken,
  type LockRecord,
  type LockStore,
} from '../locks';

interface LockEnv {
  DAV_LOCKS?: KVNamespace;
}

export async function handleLock(ctx: DavContext): Promise<Response> {
  const store = getLockStore(ctx);
  await store.prune();

  const existingToken = extractLockToken(ctx.request.header('if'));
  if (existingToken) {
    // 刷新已有锁
    const rec = await store.get(existingToken);
    if (!rec) {
      throw new DavError(412, 'Lock token not found or expired', undefined);
    }
    const refreshed: LockRecord = {
      ...rec,
      expires: Date.now() + rec.timeoutSec * 1000,
    };
    await store.create(refreshed);
    return new Response(buildLockDiscoveryBody(refreshed), {
      status: 200,
      headers: lockHeaders(refreshed),
    });
  }

  // 创建新锁
  const bodyText = await readBodyText(ctx);
  const timeout = parseTimeout(ctx.request.header('timeout'));
  const owner = extractOwner(bodyText);
  const depth: '0' | 'infinity' = (ctx.request.header('depth') ?? 'infinity') === '0' ? '0' : 'infinity';

  // 目标不存在时按 RFC 可返回 409；为兼容客户端，允许对已存在资源加锁
  const rec: LockRecord = {
    path: ctx.path,
    owner,
    timeoutSec: timeout,
    expires: Date.now() + timeout * 1000,
    depth,
    token: generateLockToken(),
  };
  await store.create(rec);

  return new Response(buildLockDiscoveryBody(rec), {
    status: 201,
    headers: {
      ...lockHeaders(rec),
      'Lock-Token': `<${rec.token}>`,
    },
  });
}

export async function handleUnlock(ctx: DavContext): Promise<Response> {
  const store = getLockStore(ctx);
  const token = extractLockToken(undefined, ctx.request.header('lock-token'));
  if (!token) {
    throw new DavError(400, 'Lock-Token header is required', undefined);
  }

  const rec = await store.get(token);
  if (!rec) {
    throw new DavError(409, 'Lock not found or expired', undefined);
  }

  await store.delete(token);
  return new Response(null, { status: 204 });
}

function getLockStore(ctx: DavContext): LockStore {
  const env = ctx.env as LockEnv;
  if (env.DAV_LOCKS) {
    return new KvLockStore(env.DAV_LOCKS);
  }
  // 无 KV 绑定时退化为进程内内存锁（不跨请求共享，仅本地开发可用）
  return new MemoryLockStore();
}

function parseTimeout(header: string | undefined): number {
  if (!header) return 3600;
  const m = header.match(/Second-(\d+)/);
  if (m) {
    const sec = parseInt(m[1], 10);
    return Math.min(Math.max(sec, 60), 604800); // 1min ~ 7days
  }
  return 3600;
}

function extractOwner(body: string): string {
  const m = body.match(/<D:owner[^>]*>([\s\S]*?)<\/D:owner>/i);
  return m ? m[1].trim() : 'webdav-client';
}

function buildLockDiscoveryBody(rec: LockRecord): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>${rec.depth}</D:depth>
      <D:owner>${rec.owner}</D:owner>
      <D:timeout>Second-${rec.timeoutSec}</D:timeout>
      <D:locktoken><D:href>${rec.token}</D:href></D:locktoken>
      <D:lockroot><D:href>${rec.path}</D:href></D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
}

function lockHeaders(rec: LockRecord): Record<string, string> {
  return {
    'Content-Type': 'application/xml; charset=utf-8',
    DAV: '1, 2',
  };
}
