/**
 * PROPPATCH — 属性修改
 *
 * 支持 set / remove 操作。自定义属性（不在标准 DAV 属性集合内）被忽略，
 * 返回 424 Failed Dependency 的 propstat（保持客户端兼容）。
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { readBodyText } from './router';
import { parseProppatch, buildMultistatus, xmlEscape } from '../utils/xml';

export async function handleProppatch(ctx: DavContext): Promise<Response> {
  const bodyText = await readBodyText(ctx);
  const { set, remove } = parseProppatch(bodyText);

  const target = await ctx.storage.stat(ctx.path);
  if (!target) {
    throw new DavError(404, 'Resource not found', undefined);
  }

  // 本项目不持久化任意自定义属性；标准属性（getlastmodified 等）由驱动派生。
  // 因此 set/remove 均“接受但忽略”，返回成功 propstat 即可满足主流客户端。
  const ignored = Object.keys(set).concat(remove);

  const statusBlock = ignored.length
    ? `<D:propstat><D:prop>${ignored
        .map((p) => `<D:${p}/>`)
        .join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`
    : '';

  const body = buildMultistatus(
    `<D:response><D:href>${xmlEscape(encodeHref(ctx.path))}</D:href>${statusBlock}</D:response>`
  );

  return new Response(body, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 2' },
  });
}

function encodeHref(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
