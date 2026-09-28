/**
 * 百度网盘开放平台驱动（兼容百度网盘青春版账号体系）
 *
 * 使用百度开放平台 xpan REST API（百度网盘开放接口，青春版同账号体系）。
 *
 * ⚠️ 使用前请在百度开放平台（https://pan.baidu.com/union/）创建应用并获取 access_token：
 *   1. 登录百度开放平台 → 创建应用（选择"网盘"服务）
 *   2. 走 OAuth 授权流程获取 access_token
 *   3. 将 access_token / app_id 通过 wrangler secret 注入
 *
 * 接口说明（需以官方最新文档为准）：
 *   - 列目录: GET /rest/2.0/xpan/file?method=list&dir=...
 *   - 下载:   GET /rest/2.0/xpan/file?method=download&path=... → dlink
 *   - 上传:   POST https://d.pan.baidu.com/rest/2.0/xpan/file?method=upload&path=...
 *   - 管理:   POST /rest/2.0/xpan/file?method=filemanager（op=create/delete/move/copy/rename）
 *
 * 限制：Workers 请求体上限 100MB，上传需整文件缓冲，建议单文件 ≤ 50MB。
 */
import type { BaiduConfig } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { parentPath, baseName } from '../utils/path';

const API_BASE = 'https://pan.baidu.com/rest/2.0/xpan/file';
const UPLOAD_BASE = 'https://d.pan.baidu.com/rest/2.0/xpan/file';

interface BaiduListItem {
  path: string;
  isdir: number;
  size: number;
  server_mtime: number;
  md5?: string;
  server_filename?: string;
}

export class BaiduDriver implements StorageDriver {
  readonly type = 'baidu';

  constructor(private cfg: BaiduConfig) {
    if (!cfg.accessToken) throw new Error('BAIDU_ACCESS_TOKEN is required for baidu driver');
  }

  private authQs(method: string): URLSearchParams {
    const qs = new URLSearchParams({ method, access_token: this.cfg.accessToken });
    return qs;
  }

  private async callApi<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`Baidu API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as T & { errno?: number; errmsg?: string };
    if (typeof data.errno === 'number' && data.errno !== 0) {
      throw new Error(`Baidu API errno=${data.errno} ${data.errmsg ?? ''}`);
    }
    return data;
  }

  /** 百度路径 → WebDAV 路径 */
  private toDavPath(p: string): string {
    return p === '/' ? '/' : p;
  }

  // ---------- list ----------
  async list(path: string): Promise<ListResult> {
    const qs = this.authQs('list');
    qs.set('dir', path === '/' ? '/' : path);
    qs.set('limit', '1000');
    qs.set('order', 'time');
    qs.set('desc', '0');
    qs.set('web', '1');

    const data = await this.callApi<{ list?: BaiduListItem[] }>(`${API_BASE}?${qs}`);
    const entries: FileStat[] = (data.list ?? [])
      .filter((it) => it.path !== path)
      .map((it) => ({
        name: it.server_filename || baseName(it.path),
        path: this.toDavPath(it.path) + (it.isdir === 1 ? '/' : ''),
        isDirectory: it.isdir === 1,
        size: it.size,
        mtime: it.server_mtime * 1000,
        etag: it.md5 ? `"${it.md5}"` : undefined,
      }));
    return { entries, truncated: false };
  }

  // ---------- stat ----------
  async stat(path: string): Promise<FileStat | null> {
    if (path === '/') {
      return { name: '/', path: '/', isDirectory: true, size: 0, mtime: Date.now() };
    }
    const parent = parentPath(path);
    const listed = await this.list(parent);
    const name = baseName(path);
    const match = listed.entries.find((e) => e.name === name);
    if (match) {
      return { ...match, path };
    }
    return null;
  }

  // ---------- read ----------
  async read(path: string, range?: Range): Promise<ReadableStream | null> {
    const qs = this.authQs('download');
    qs.set('path', path);
    const data = await this.callApi<{ dlink?: string }>(`${API_BASE}?${qs}`);
    if (!data.dlink) return null;

    const res = await fetch(data.dlink, {
      headers: {
        'User-Agent': this.cfg.userAgent,
        Referer: 'https://pan.baidu.com/',
      },
    });
    if (!res.ok || !res.body) return null;

    // 百度 dlink 不支持 Range；有 Range 时缓冲截取
    if (range) {
      const buf = await res.arrayBuffer();
      return new Response(buf.slice(range.offset, range.offset + range.length)).body;
    }
    return res.body;
  }

  // ---------- write ----------
  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();

    // 先确保父目录存在（百度 upload 不会自动建父目录）
    const parent = parentPath(path);
    if (parent !== '/') {
      const parentStat = await this.stat(parent);
      if (!parentStat) await this.mkdir(parent);
    }

    const qs = this.authQs('upload');
    qs.set('path', path);
    qs.set('rtype', '2'); // 覆盖
    qs.set('app_id', this.cfg.appId);

    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: opts?.contentType ?? 'application/octet-stream' }), baseName(path));

    await this.callApi<unknown>(`${UPLOAD_BASE}?${qs}`, { method: 'POST', body: fd });
  }

  // ---------- remove ----------
  async remove(path: string): Promise<void> {
    await this.fileManager('delete', [path]);
  }

  // ---------- mkdir ----------
  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    if (parent !== '/' && !(await this.stat(parent))) {
      await this.mkdir(parent);
    }
    await this.fileManager('create', [path]);
  }

  // ---------- move / copy ----------
  async move(src: string, dst: string): Promise<void> {
    await this.fileManager('move', [src], dst);
  }

  async copy(src: string, dst: string): Promise<void> {
    await this.fileManager('copy', [src], dst);
  }

  /** filemanager 统一入口 */
  private async fileManager(op: string, filelist: string[], destPath?: string): Promise<void> {
    const qs = this.authQs('filemanager');
    qs.set('op', op);
    qs.set('async', '0');

    const body: Record<string, unknown> = { async: 0, filelist: JSON.stringify(filelist) };
    if (op === 'move' || op === 'copy') {
      body.dest = destPath ?? '/';
      qs.set('dest', destPath ?? '/');
    }

    await this.callApi<unknown>(`${API_BASE}?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
