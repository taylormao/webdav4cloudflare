/**
 * WebDAV 路由分发器
 *
 * 将 HTTP 方法映射到对应处理器模块。
 * 每个处理器接收 DavContext，返回 Response。
 */
import { DavError, type DavContext } from '../types';
import { handleOptions } from './options';
import { handlePropfind } from './propfind';
import { handleProppatch } from './proppatch';
import { handleMkcol } from './mkcol';
import { handleGet, handleHead } from './get';
import { handlePut } from './put';
import { handleDelete } from './delete';
import { handleMove, handleCopy } from './movecopy';
import { handleLock, handleUnlock } from './lock';
import { buildErrorBody } from '../utils/xml';

export type Handler = (ctx: DavContext) => Promise<Response>;

const handlers: Record<string, Handler> = {
  OPTIONS: handleOptions,
  PROPFIND: handlePropfind,
  PROPPATCH: handleProppatch,
  MKCOL: handleMkcol,
  GET: handleGet,
  HEAD: handleHead,
  PUT: handlePut,
  DELETE: handleDelete,
  MOVE: handleMove,
  COPY: handleCopy,
  LOCK: handleLock,
  UNLOCK: handleUnlock,
};

export async function dispatch(ctx: DavContext): Promise<Response> {
  const method = ctx.request.method.toUpperCase();
  const handler = handlers[method];
  if (!handler) {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: Object.keys(handlers).join(', ') },
    });
  }

  try {
    return await handler(ctx);
  } catch (e) {
    return handleError(e);
  }
}

/** 统一错误处理：DavError → 带 DAV 错误体的响应；其他 → 500 */
export function handleError(e: unknown): Response {
  if (e instanceof DavError) {
    const body = buildErrorBody(e.davCode, e.message);
    return new Response(body, {
      status: e.status,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ...(e.headers ?? {}),
      },
    });
  }
  console.error('[webdav] unhandled error:', e);
  const message = e instanceof Error ? e.message : String(e);
  return new Response(buildErrorBody(undefined, `Internal error: ${message}`), {
    status: 500,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

export { buildErrorBody };

/** 读取请求体文本（限制大小防止滥用）；兼容 Hono Context 与 DavContext */
export async function readBodyText(
  c: { request: { arrayBuffer(): Promise<ArrayBuffer> } },
  maxBytes = 4 * 1024 * 1024
): Promise<string> {
  const buf = await c.request.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new DavError(413, 'Request body too large', undefined);
  }
  return new TextDecoder().decode(buf);
}
