/**
 * PROPFIND — 属性查询
 *
 * 支持 Depth: 0 / 1（Depth: infinity 按 1 处理并附加 403 提示段可省略）。
 * 响应为 multistatus XML。
 */
import type { DavContext } from '../types';
import { DavError } from '../types';
import { readBodyText } from './router';
import { parsePropFindProps, buildMultistatus } from '../utils/xml';
import { buildResponse, defaultEtag, buildNotFoundResponse } from './responses';
import { isDirPath, baseName, joinPath, childName } from '../utils/path';
import type { FileStat } from '../storage/types';

export async function handlePropfind(ctx: DavContext): Promise<Response> {
  const depthHeader = ctx.request.header('depth') ?? 'infinity';
  let depth = 0;
  if (depthHeader === '1') depth = 1;
  else if (depthHeader === 'infinity') depth = 1; // 安全降级：infinity 按 1 处理

  // 解析请求体：propfind 请求体通常携带要查询的属性
  let requestedProps: string[] | 'all' | 'none' = 'all';
  try {
    const bodyText = await readBodyText(ctx);
    if (bodyText.trim()) {
      if (/<allprop\b/i.test(bodyText)) {
        requestedProps = 'all';
      } else if (/<propname\b/i.test(bodyText)) {
        requestedProps = 'none';
      } else {
        const props = parsePropFindProps(bodyText);
        requestedProps = props.length > 0 ? props : 'all';
      }
    }
  } catch (e) {
    if (e instanceof DavError && e.status === 413) throw e;
    // 请求体解析失败时退化为 allprop
    requestedProps = 'all';
  }

  const target = await ctx.storage.stat(ctx.path);
  if (!target) {
    return new Response(buildMultistatus(buildNotFoundResponse(hrefOf(ctx))), {
      status: 207,
      headers: xmlHeaders,
    });
  }

  const responses: string[] = [];
  const targetEtag = defaultEtag(target);
  responses.push(buildResponse(hrefOf(ctx), target, requestedProps, targetEtag));

  if (depth === 1 && target.isDirectory) {
    const listed = await ctx.storage.list(ctx.path);
    for (const child of listed.entries) {
      const childPath = joinPath(ctx.path, child.name) + (child.isDirectory ? '/' : '');
      responses.push(buildResponse(hrefOfChild(ctx, child), child, requestedProps, defaultEtag(child)));
      // 注意：child 的 path 可能已经由驱动填充完整路径；若驱动未填充则用拼接路径重建 stat
      if (!child.path) {
        child.path = childPath;
        void childPath;
      }
    }
  }

  return new Response(buildMultistatus(responses.join('')), {
    status: 207,
    headers: xmlHeaders,
  });
}

function hrefOf(ctx: DavContext): string {
  return encodeHref(prefixOf(ctx) + ctx.path);
}

function hrefOfChild(ctx: DavContext, child: FileStat): string {
  // 子项 href 拼接：父路径 + 子名（目录补 /）；分区内自动带 /<driver> 前缀
  const parent = ctx.path === '/' ? '/' : ctx.path.endsWith('/') ? ctx.path : ctx.path + '/';
  const name = child.name || childName(child.path, ctx.path) || baseName(child.path);
  return encodeHref(prefixOf(ctx) + parent + name + (child.isDirectory ? '/' : ''));
}

/** 多存储分区前缀：虚拟根/单驱动根为 ''，分区内为 /<driver> */
function prefixOf(ctx: DavContext): string {
  return ctx.storageType && ctx.storageType !== 'root' ? '/' + ctx.storageType : '';
}

/** URL 编码 href（保留 /） */
function encodeHref(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

const xmlHeaders = {
  'Content-Type': 'application/xml; charset=utf-8',
  'DAV': '1, 2',
};
