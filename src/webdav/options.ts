/**
 * OPTIONS — WebDAV 能力协商
 */
import type { DavContext } from '../types';

export async function handleOptions(ctx: DavContext): Promise<Response> {
  return buildOptionsResponse();
}

/** 构造 OPTIONS 能力协商响应（不依赖 storage，虚拟根也可复用） */
export function buildOptionsResponse(): Response {
  const allow = [
    'OPTIONS',
    'PROPFIND',
    'PROPPATCH',
    'MKCOL',
    'GET',
    'HEAD',
    'PUT',
    'DELETE',
    'MOVE',
    'COPY',
    'LOCK',
    'UNLOCK',
  ].join(', ');

  return new Response(null, {
    status: 200,
    headers: {
      Allow: allow,
      DAV: '1, 2',
      'MS-Author-Via': 'DAV', // 兼容 Windows 资源管理器
      Accept: '*/*',
      'Content-Length': '0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': allow,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, Lock-Token, If, Overwrite, Timeout',
    },
  });
}
