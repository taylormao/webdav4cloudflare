/**
 * PUT — 写入 / 覆盖文件
 *
 * 规则：
 *   - 父目录不存在 → 409 Conflict
 *   - 目标为目录 → 405 Method Not Allowed
 *   - 成功新建 201；覆盖成功 204
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { parentPath } from '../utils/path';

export async function handlePut(ctx: DavContext): Promise<Response> {
  if (ctx.path === '/') {
    throw new DavError(405, 'Cannot PUT root', undefined);
  }

  // 父目录必须存在
  const parent = parentPath(ctx.path);
  if (parent !== '/') {
    const parentStat = await ctx.storage.stat(parent);
    if (!parentStat) {
      throw new DavError(409, 'Parent collection does not exist', undefined);
    }
  }

  const existing = await ctx.storage.stat(ctx.path);
  if (existing && existing.isDirectory) {
    throw new DavError(405, 'Cannot overwrite a collection with PUT', undefined);
  }

  const contentType = ctx.request.header('content-type') ?? 'application/octet-stream';
  const contentLength = Number(ctx.request.header('content-length') ?? '0');

  await ctx.storage.write(ctx.path, ctx.request.raw.body ?? new ReadableStream(), {
    contentType,
    size: Number.isFinite(contentLength) ? contentLength : undefined,
  });

  return new Response(null, { status: existing ? 204 : 201 });
}
