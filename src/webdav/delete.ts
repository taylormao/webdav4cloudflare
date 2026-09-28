/**
 * DELETE — 删除文件或目录（递归）
 */
import type { DavContext } from '../types';
import { DavError } from '../types';

export async function handleDelete(ctx: DavContext): Promise<Response> {
  if (ctx.path === '/') {
    throw new DavError(403, 'Cannot delete root', undefined);
  }

  const target = await ctx.storage.stat(ctx.path);
  if (!target) {
    throw new DavError(404, 'Not found', undefined);
  }

  await ctx.storage.remove(ctx.path);
  return new Response(null, { status: 204 });
}
