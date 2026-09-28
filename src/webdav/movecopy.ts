/**
 * MOVE / COPY — 移动 / 复制
 *
 * 规则：
 *   - Destination 头必须存在且可解析（同源）
 *   - 目标已存在且 Overwrite: F → 412 Precondition Failed
 *   - Overwrite: T（默认）→ 先删除目标再执行
 *   - 禁止把目录移动/复制到自身内部
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { normalizePath, trimSlashes, isUnder } from '../utils/path';

export async function handleMove(ctx: DavContext): Promise<Response> {
  return moveCopy(ctx, false);
}

export async function handleCopy(ctx: DavContext): Promise<Response> {
  return moveCopy(ctx, true);
}

async function moveCopy(ctx: DavContext, isCopy: boolean): Promise<Response> {
  const destHeader = ctx.request.header('destination');
  if (!destHeader) {
    throw new DavError(400, 'Destination header is required', undefined);
  }

  const dest = ctx.resolveInnerPath(normalizePath(parseDestination(destHeader)));
  if (dest === null || dest === '/' || ctx.path === '/') {
    throw new DavError(400, 'Invalid destination', undefined);
  }

  const source = ctx.path;
  if (source === dest) {
    throw new DavError(403, 'Source and destination are the same', undefined);
  }

  // 目录不能移到自身内部
  if (!isCopy && isUnder(dest, source)) {
    throw new DavError(409, 'Cannot move a collection into itself', undefined);
  }

  const sourceStat = await ctx.storage.stat(source);
  if (!sourceStat) {
    throw new DavError(404, 'Source not found', undefined);
  }

  const destStat = await ctx.storage.stat(dest);
  const overwrite = (ctx.request.header('overwrite') ?? 'T').toUpperCase() !== 'F';

  if (destStat && !overwrite) {
    throw new DavError(412, 'Destination exists and Overwrite is F', undefined);
  }

  // 目标存在且非目录自拷贝 → 先删除
  if (destStat && !(isCopy && destStat.isDirectory && sourceStat.isDirectory)) {
    // 覆盖目录时需先删目标；复制到自身子目录场景已在上面拦截
    if (!(sourceStat.isDirectory && isUnder(source, dest) && isCopy)) {
      await ctx.storage.remove(dest);
    }
  }

  if (isCopy) {
    await ctx.storage.copy(source, dest);
  } else {
    await ctx.storage.move(source, dest);
  }

  return new Response(null, { status: 201 });
}

/** 从 Destination 头中提取路径部分（同源校验：只取 pathname） */
function parseDestination(header: string): string {
  try {
    const u = new URL(header);
    return u.pathname;
  } catch {
    // 兼容仅路径形式
    return header.split('?')[0];
  }
}
