/**
 * Google Drive 存储驱动（OAuth2 + Drive API v3）
 *
 * 原理：
 *   - 使用 refresh_token 换取短期 access_token（Worker 内内存缓存）
 *   - WebDAV 路径 ↔ Drive 文件树：按路径分段逐级解析 fileId（实例级 Map 缓存）
 *   - 目录判定：mimeType === application/vnd.google-apps.folder
 *   - 目录递归复制需手动递归（Drive files.copy 对文件夹仅复制空目录）
 *
 * 前置准备（百度/Telegram 等国内驱动不需要，仅 gdrive 需要）：
 *   1. Google Cloud Console 创建项目，启用 Drive API
 *   2. 创建 OAuth Client（Desktop/Web 类型），获取 client_id / client_secret
 *   3. 完成 OAuth 授权流程获取 refresh_token
 *      scope: https://www.googleapis.com/auth/drive
 *   4. 将三项通过 wrangler secret 注入（见 README）
 *
 * 已知限制：
 *   - 同名文件/文件夹在 Drive 中允许存在，本驱动按名称解析时取第一个
 *   - 快捷方式（shortcut）在列表中跳过
 */
import type { GDriveConfig } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { parentPath, baseName } from '../utils/path';

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
}

/** 路径解析缓存（实例级；目录结构变更后靠失败重查兜底） */
interface ResolveCache {
  id: string;
  isDir: boolean;
}

export class GDriveDriver implements StorageDriver {
  readonly type = 'gdrive';
  private accessToken = '';
  private tokenExpiresAt = 0;
  private resolveCache = new Map<string, ResolveCache>();

  constructor(private cfg: GDriveConfig) {
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      throw new Error('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN are required for gdrive driver');
    }
  }

  // =====================================================================
  // OAuth2 令牌
  // =====================================================================
  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Google token refresh: missing access_token');
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  /** 带 401 自动刷新的 GET */
  private async api<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
    const token = await this.ensureToken();
    const res = await fetch(API_BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401 && !retried) {
      this.accessToken = '';
      this.tokenExpiresAt = 0;
      return this.api<T>(path, init, true);
    }
    if (!res.ok) {
      throw new Error(`Google Drive API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  // =====================================================================
  // 路径解析
  // =====================================================================
  private async resolveDirId(path: string): Promise<string> {
    if (path === '/') return 'root';
    return (await this.resolveNode(path)).id;
  }

  private async resolveNode(path: string): Promise<ResolveCache> {
    const cached = this.resolveCache.get(path);
    if (cached) return cached;

    // 根
    if (path === '/') return { id: 'root', isDir: true };

    const parent = parentPath(path);
    const name = baseName(path);
    const parentId = await this.resolveDirId(parent);
    const q = `name='${escapeQuery(name)}' and '${parentId}' in parents and trashed=false`;
    const files = await this.queryFiles(q, 'files(id,name,mimeType,trashed)', 1);
    if (files.length === 0) {
      throw new Error(`Not found: ${path}`);
    }
    const isDir = files[0].mimeType === FOLDER_MIME;
    const node: ResolveCache = { id: files[0].id, isDir };
    this.resolveCache.set(path, node);
    return node;
  }

  /** files.list 分页查询 */
  private async queryFiles(q: string, fields: string, pageSize = 1000): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({
        q,
        fields: `${fields},nextPageToken`,
        pageSize: String(pageSize),
        includeItemsFromAllDrives: 'false',
        supportsAllDrives: 'true',
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const data = await this.api<{ files?: DriveFile[]; nextPageToken?: string }>(
        `/files?${qs}`
      );
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async fileGet(fileId: string, fields: string): Promise<DriveFile> {
    const qs = new URLSearchParams({ fields, supportsAllDrives: 'true' });
    return this.api<DriveFile>(`/files/${fileId}?${qs}`);
  }

  // =====================================================================
  // StorageDriver 实现
  // =====================================================================
  async list(path: string): Promise<ListResult> {
    const parentId = await this.resolveDirId(path);
    const files = await this.queryFiles(
      `'${parentId}' in parents and trashed=false`,
      'files(id,name,mimeType,size,modifiedTime,md5Checksum,trashed)'
    );
    const entries: FileStat[] = [];
    for (const f of files) {
      if (f.mimeType === SHORTCUT_MIME) continue;
      const isDir = f.mimeType === FOLDER_MIME;
      const name = f.name ?? '';
      // 写入解析缓存（目录结构探测副作用，避免后续重复查询）
      if (name) {
        const p = joinPath(path, name);
        this.resolveCache.set(p, { id: f.id, isDir });
      }
      const isNative = !isDir && f.mimeType !== undefined && f.mimeType.startsWith('application/vnd.google-apps.');
      entries.push({
        name,
        path: joinPath(path, name) + (isDir ? '/' : ''),
        isDirectory: isDir,
        size: isDir ? 0 : isNative ? 0 : parseInt(f.size ?? '0', 10),
        mtime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now(),
        etag: f.md5Checksum ? `"${f.md5Checksum}"` : undefined,
        contentType: isNative ? f.mimeType : undefined,
      });
    }
    return { entries, truncated: false };
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const node = await this.resolveNode(path);
      if (node.isDir && path.endsWith('/')) {
        return {
          name: baseName(path),
          path,
          isDirectory: true,
          size: 0,
          mtime: Date.now(),
        };
      }
      const f = await this.fileGet(node.id, 'id,name,mimeType,size,modifiedTime,md5Checksum');
      const isDir = f.mimeType === FOLDER_MIME;
      const isNative =
        !isDir &&
        f.mimeType !== SHORTCUT_MIME &&
        f.mimeType !== undefined &&
        f.mimeType.startsWith('application/vnd.google-apps.');
      return {
        name: f.name ?? baseName(path),
        path: path + (isDir && !path.endsWith('/') ? '/' : ''),
        isDirectory: isDir,
        size: isDir ? 0 : isNative ? 0 : parseInt(f.size ?? '0', 10),
        mtime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now(),
        etag: f.md5Checksum ? `"${f.md5Checksum}"` : undefined,
        contentType: isNative ? f.mimeType : undefined,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('Not found')) return null;
      throw e;
    }
  }

  async read(path: string, range?: Range): Promise<ReadableStream | null> {
    const node = await this.resolveNode(path);
    if (node.isDir) return null;

    // Google 原生格式（doc/sheet/slide/drawing 等）不支持 media download，改用 files.export
    const f = await this.fileGet(node.id, 'id,name,mimeType');
    if (
      f.mimeType &&
      f.mimeType !== FOLDER_MIME &&
      f.mimeType !== SHORTCUT_MIME &&
      f.mimeType.startsWith('application/vnd.google-apps.')
    ) {
      return this.readNativeExport(node.id, f.mimeType, path);
    }

    const token = await this.ensureToken();

    const qs = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;

    const res = await fetch(`${API_BASE}/files/${node.id}?${qs}`, { headers });
    if (res.status === 401) {
      this.accessToken = '';
      this.tokenExpiresAt = 0;
      return this.read(path, range);
    }
    if (!res.ok) {
      throw new Error(`Drive download ${res.status}: ${await res.text()}`);
    }
    return res.body;
  }

  /** Google 原生格式文件：files.export 导出内容（export 不支持 Range，忽略 range 返回完整流） */
  private async readNativeExport(fileId: string, mimeType: string, path: string): Promise<ReadableStream | null> {
    const exportMime = nativeExportMime(mimeType, path);
    const token = await this.ensureToken();
    const qs = new URLSearchParams({ mimeType: exportMime, supportsAllDrives: 'true' });
    const res = await fetch(`${API_BASE}/files/${fileId}/export?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      this.accessToken = '';
      this.tokenExpiresAt = 0;
      return this.readNativeExport(fileId, mimeType, path);
    }
    if (!res.ok) {
      throw new Error(`Drive export ${res.status}: ${await res.text()}`);
    }
    return res.body;
  }

  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const parentId = await this.resolveDirId(parentPath(path));
    const name = baseName(path);
    const token = await this.ensureToken();

    const media = new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': opts?.contentType ?? 'application/octet-stream',
      'Content-Length': String(media.byteLength),
    };

    // 已存在同名文件 → 覆盖；否则新建
    const existing = await this.queryFiles(
      `name='${escapeQuery(name)}' and '${parentId}' in parents and trashed=false`,
      'files(id)',
      1
    );
    const url = existing.length > 0
      ? `${UPLOAD_BASE}/files/${existing[0].id}?uploadType=media&supportsAllDrives=true`
      : `${UPLOAD_BASE}/files?uploadType=media&supportsAllDrives=true`;

    const res = await fetch(url, { method: 'PATCH', headers, body: media });
    if (res.status === 401) {
      this.accessToken = '';
      this.tokenExpiresAt = 0;
      return this.write(path, body, opts);
    }
    if (!res.ok) {
      throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
    }
    // 失效路径缓存（mtime 已变化）
    this.resolveCache.delete(path);
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolveNode(path);
    const qs = new URLSearchParams({ supportsAllDrives: 'true' });
    const res = await fetch(`${API_BASE}/files/${node.id}?${qs}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await this.ensureToken()}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive delete ${res.status}: ${await res.text()}`);
    }
    // 清理该路径及其子路径缓存
    for (const k of [...this.resolveCache.keys()]) {
      if (k === path || k.startsWith(path.endsWith('/') ? path : path + '/')) {
        this.resolveCache.delete(k);
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    const parentId = await this.resolveDirId(parentPath(path));
    const body = {
      name: baseName(path),
      mimeType: FOLDER_MIME,
      parents: [parentId],
    };
    const res = await fetch(`${API_BASE}/files?supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.ensureToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Drive mkdir ${res.status}: ${await res.text()}`);
    }
    this.resolveCache.delete(path);
  }

  async move(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const dstParentId = await this.resolveDirId(parentPath(dst));

    const current = await this.fileGet(node.id, 'parents');
    const removeParents = (current.parents ?? []).join(',');

    const qs = new URLSearchParams({
      addParents: dstParentId,
      removeParents,
      enforceSingleParent: 'true',
      supportsAllDrives: 'true',
    });
    const res = await fetch(`${API_BASE}/files/${node.id}?${qs}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${await this.ensureToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: baseName(dst) }),
    });
    if (!res.ok) {
      throw new Error(`Drive move ${res.status}: ${await res.text()}`);
    }
    this.resolveCache.delete(src);
    this.resolveCache.delete(dst);
  }

  async copy(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    if (node.isDir) {
      await this.copyDirectory(src, node.id, dst);
      return;
    }
    const dstParentId = await this.resolveDirId(parentPath(dst));
    // 复制内容 + 改名
    const copyRes = await fetch(`${API_BASE}/files/${node.id}/copy?supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.ensureToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: baseName(dst) }),
    });
    if (!copyRes.ok) {
      throw new Error(`Drive copy ${copyRes.status}: ${await copyRes.text()}`);
    }
    const newFile = (await copyRes.json()) as DriveFile;
    // 移动到目标父目录（enforceSingleParent 只保留新父）
    const qs = new URLSearchParams({
      addParents: dstParentId,
      enforceSingleParent: 'true',
      supportsAllDrives: 'true',
    });
    const upd = await fetch(`${API_BASE}/files/${newFile.id}?${qs}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${await this.ensureToken()}` },
      body: '{}',
    });
    if (!upd.ok) {
      throw new Error(`Drive copy(relocate) ${upd.status}: ${await upd.text()}`);
    }
    this.resolveCache.delete(dst);
  }

  /** 目录递归复制（Drive copy 对文件夹不递归，需手动） */
  private async copyDirectory(srcPath: string, srcId: string, dstPath: string): Promise<void> {
    // 创建目标空目录
    await this.mkdir(dstPath);

    const children = await this.queryFiles(
      `'${srcId}' in parents and trashed=false`,
      'files(id,name,mimeType,size,modifiedTime,md5Checksum)'
    );
    for (const child of children) {
      if (child.mimeType === SHORTCUT_MIME) continue;
      const childDst = joinPath(dstPath, child.name ?? '');
      if (child.mimeType === FOLDER_MIME) {
        await this.copyDirectory(joinPath(srcPath, child.name ?? ''), child.id, childDst);
      } else {
        const dstParentId = await this.resolveDirId(parentPath(childDst));
        const copyRes = await fetch(`${API_BASE}/files/${child.id}/copy?supportsAllDrives=true`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await this.ensureToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: child.name }),
        });
        if (!copyRes.ok) {
          throw new Error(`Drive copy(child) ${copyRes.status}: ${await copyRes.text()}`);
        }
        const newFile = (await copyRes.json()) as DriveFile;
        const upd = await fetch(
          `${API_BASE}/files/${newFile.id}?addParents=${encodeURIComponent(dstParentId)}&enforceSingleParent=true&supportsAllDrives=true`,
          { method: 'PATCH', headers: { Authorization: `Bearer ${await this.ensureToken()}` }, body: '{}' }
        );
        if (!upd.ok) {
          throw new Error(`Drive copy(child relocate) ${upd.status}: ${await upd.text()}`);
        }
      }
    }
    this.resolveCache.delete(dstPath);
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** Google 原生格式 → files.export 导出 MIME；document 按扩展名选 markdown/plain（导出供 /api/preview 复用） */
export function nativeExportMime(mimeType: string, path: string): string {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      if (/\.md$/i.test(path)) return 'text/markdown';
      if (/\.txt$/i.test(path)) return 'text/plain';
      return 'text/markdown';
    case 'application/vnd.google-apps.spreadsheet':
      return 'text/csv';
    case 'application/vnd.google-apps.presentation':
      return 'text/plain';
    case 'application/vnd.google-apps.drawing':
      return 'image/png';
    default:
      return 'application/pdf';
  }
}

function joinPath(parent: string, name: string): string {
  const p = parent === '/' ? '/' : parent.replace(/\/+$/, '');
  if (p === '/') return '/' + name;
  return p + '/' + name;
}

/** Drive q 语法：单引号与反斜杠转义 */
function escapeQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
