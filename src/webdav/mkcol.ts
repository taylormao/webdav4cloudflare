/**
 * MKCOL — 创建目录
 *
 * 规则：
 *   - 目标已存在 → 405 Method Not Allowed
 *   - 父目录不存在 → 409 Conflict
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { parentPath } from '../utils/path';

export async function handleMkcol(ctx: DavContext): Promise<Response> {
  const path = ctx.path;
  if (path === '/') {
    throw new DavError(405, 'Cannot create root', undefined);
  }

  const existing = await ctx.storage.stat(path);
  if (existing) {
    throw new DavError(405, 'Resource already exists', undefined);
  }

  // 父目录必须存在（根视为存在）
  const parent = parentPath(path);
  if (parent !== '/') {
    const parentStat = await ctx.storage.stat(parent);
    if (!parentStat) {
      throw new DavError(409, 'Parent collection does not exist', undefined);
    }
  }

  await ctx.storage.mkdir(path);
  return new Response(null, { status: 201 });
}
