/**
 * WebDAV 响应构造工具
 *
 * 提供 multistatus 响应中 <response> 节点的构建能力，
 * 供 PROPFIND / PROPPATCH 等需要 multistatus 的方法共用。
 */
import { xmlEscape } from '../utils/xml';
import type { FileStat } from '../storage/types';

/** 时间格式：HTTP date（RFC 1123） */
export function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

/** 时间格式：ISO 8601（getcreationdate 用） */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

/** 计算默认 etag：基于 size 与 mtime */
export function defaultEtag(stat: Pick<FileStat, 'size' | 'mtime' | 'path'>): string {
  const h = new Uint8Array(16);
  const seed = `${stat.path}:${stat.size}:${stat.mtime}`;
  const buf = new TextEncoder().encode(seed);
  // 简单确定性哈希（非加密，仅用于 etag）
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of buf) {
    h1 = (h1 ^ b) * 16777619;
    h2 = (h2 * 31 + b) | 0;
  }
  return `"${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}"`;
}

/** 生成单个 <response> 节点（含 propstat） */
export function buildResponse(
  href: string,
  stat: FileStat,
  requestedProps: string[] | 'all' | 'none',
  etag: string
): string {
  const hrefEsc = xmlEscape(href);
  const props: string[] = [];

  if (requestedProps === 'all' || requestedProps === 'none' || requestedProps.includes('resourcetype')) {
    props.push(
      `<D:resourcetype>${stat.isDirectory ? '<D:collection/>' : ''}</D:resourcetype>`
    );
  }
  if (requestedProps === 'all' || requestedProps.includes('getcontentlength')) {
    if (!stat.isDirectory) {
      props.push(`<D:getcontentlength>${stat.size}</D:getcontentlength>`);
    }
  }
  if (requestedProps === 'all' || requestedProps.includes('getlastmodified')) {
    props.push(`<D:getlastmodified>${httpDate(stat.mtime)}</D:getlastmodified>`);
  }
  if (requestedProps === 'all' || requestedProps.includes('creationdate')) {
    props.push(`<D:creationdate>${isoDate(stat.mtime)}</D:creationdate>`);
  }
  if (requestedProps === 'all' || requestedProps.includes('getetag')) {
    props.push(`<D:getetag>${xmlEscape(etag)}</D:getetag>`);
  }
  if (requestedProps === 'all' || requestedProps.includes('displayname')) {
    props.push(`<D:displayname>${xmlEscape(stat.name)}</D:displayname>`);
  }
  if (requestedProps === 'all' || requestedProps.includes('getcontenttype')) {
    if (!stat.isDirectory && stat.contentType) {
      props.push(`<D:getcontenttype>${xmlEscape(stat.contentType)}</D:getcontenttype>`);
    }
  }

  const propstat = `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
  return `<D:response><D:href>${hrefEsc}</D:href>${propstat}</D:response>`;
}

/** 生成“无属性响应”（PROPFIND 404 时等场景可复用） */
export function buildNotFoundResponse(href: string): string {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
}
