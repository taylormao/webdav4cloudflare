/**
 * GET / HEAD — 读取文件（支持 Range）
 *
 * 依赖驱动 read() 返回流；Range 头透传给驱动（R2/S3 原生支持）。
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { defaultEtag } from './responses';

export async function handleGet(ctx: DavContext): Promise<Response> {
  return readImpl(ctx, false);
}

export async function handleHead(ctx: DavContext): Promise<Response> {
  return readImpl(ctx, true);
}

async function readImpl(ctx: DavContext, headOnly: boolean): Promise<Response> {
  const stat = await ctx.storage.stat(ctx.path);
  if (!stat) {
    throw new DavError(404, 'Not found', undefined);
  }
  if (stat.isDirectory) {
    // 目录返回 200（兼容部分客户端列目录行为）；也可返回 405，这里返回空 200
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'httpd/unix-directory' },
    });
  }

  const rangeHeader = ctx.request.header('range');
  const range = parseRange(rangeHeader, stat.size);

  const stream = await ctx.storage.read(ctx.path, range ?? undefined);
  if (!stream) {
    throw new DavError(404, 'Not found', undefined);
  }

  const headers = new Headers();
  headers.set('Content-Type', stat.contentType ?? 'application/octet-stream');
  headers.set('ETag', stat.etag ?? defaultEtag(stat));
  headers.set('Last-Modified', new Date(stat.mtime).toUTCString());
  headers.set('Accept-Ranges', 'bytes');

  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(headOnly ? null : stream, {
      status: 206,
      headers,
    });
  }

  // Google 原生格式文件 size=0 但 body 非空（export 导出），此时不设 Content-Length 避免截断
  if (stat.size > 0) {
    headers.set('Content-Length', String(stat.size));
  }
  return new Response(headOnly ? null : stream, {
    status: 200,
    headers,
  });
}

/** 解析 Range: bytes=start-end（导出供 /api/download、/api/preview 复用） */
export function parseRange(header: string | undefined, size: number): { offset: number; length: number } | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];

  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;

  if (startStr === '') {
    // 后缀范围：bytes=-N 表示最后 N 字节
    const suffix = parseInt(endStr, 10);
    if (Number.isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    if (Number.isNaN(start) || start < 0 || start >= size) return null;
    end = Math.min(end, size - 1);
  }

  if (start > end) return null;
  return { offset: start, length: end - start + 1 };
}
