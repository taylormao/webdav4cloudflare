/**
 * Dropbox 存储驱动（Dropbox API v2）
 *
 * 原理：
 *   - 使用长期 access_token 或 refresh_token（OAuth2）完成鉴权
 *   - WebDAV 路径 ↔ Dropbox 路径直接映射（Dropbox 路径以 / 开头，根为 ""）
 *   - 目录语义由 Dropbox 原生提供（.tag = folder / file）
 *
 * 前置准备（仅 dropbox 驱动需要）：
 *   1. https://www.dropbox.com/developers/apps 创建 App（Full Dropbox / App folder 均可）
 *   2. 获取 access_token（或 appKey + appSecret + refreshToken）
 *   3. 通过 wrangler secret 注入（见 README）
 *
 * 已知限制：
 *   - 部分 API 对 App folder 模式仅限自身目录（此时 WebDAV 根对应 App 根）
 */
import type { DropboxConfig } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { parentPath, baseName } from '../utils/path';

const API_BASE = 'https://api.dropboxapi.com/2';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  name: string;
  path_display?: string;
  id?: string;
  size?: number;
  client_modified?: string;
  content_hash?: string;
}

export class DropboxDriver implements StorageDriver {
  readonly type = 'dropbox';
  private accessToken: string;
  private tokenExpiresAt = 0;

  constructor(private cfg: DropboxConfig) {
    if (!cfg.accessToken && !(cfg.refreshToken && cfg.appKey && cfg.appSecret)) {
      throw new Error('DROPBOX_ACCESS_TOKEN (or refresh token + app key/secret) is required for dropbox driver');
    }
    this.accessToken = cfg.accessToken ?? '';
  }

  // =====================================================================
  // 令牌
  // =====================================================================
  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    if (this.cfg.refreshToken && this.cfg.appKey && this.cfg.appSecret) {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.cfg.refreshToken,
          client_id: this.cfg.appKey,
          client_secret: this.cfg.appSecret,
        }),
      });
      if (!res.ok) {
        throw new Error(`Dropbox token refresh failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new Error('Dropbox token refresh: missing access_token');
      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + ((data.expires_in ?? 14400) - 120) * 1000;
    }
    return this.accessToken;
  }

  private async rpc<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await fetch(API_BASE + endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.ensureToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Dropbox ${endpoint} ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  // =====================================================================
  // 路径映射
  // =====================================================================
  /** WebDAV 路径 → Dropbox 路径（根为 ""） */
  private toDbx(path: string): string {
    return path === '/' ? '' : path.replace(/\/+$/, '');
  }

  private toDavPath(p: string): string {
    return p === '' ? '/' : p;
  }

  // =====================================================================
  // StorageDriver 实现
  // =====================================================================
  async list(path: string): Promise<ListResult> {
    const dbxPath = this.toDbx(path);
    const entries: FileStat[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = cursor
        ? { cursor }
        : { path: dbxPath, recursive: false, include_deleted: false, limit: 2000 };
      const data = cursor
        ? await this.rpc<{ entries: DropboxEntry[]; has_more: boolean; cursor?: string }>(
            '/files/list_folder/continue',
            body
          )
        : await this.rpc<{ entries: DropboxEntry[]; has_more: boolean; cursor?: string }>(
            '/files/list_folder',
            body
          );
      for (const e of data.entries) {
        if (e['.tag'] === 'deleted') continue;
        const isDir = e['.tag'] === 'folder';
        entries.push({
          name: e.name,
          path: this.toDavPath(e.path_display ?? '') + (isDir ? '/' : ''),
          isDirectory: isDir,
          size: isDir ? 0 : (e.size ?? 0),
          mtime: e.client_modified ? new Date(e.client_modified).getTime() : Date.now(),
          etag: e.content_hash ? `"${e.content_hash}"` : undefined,
        });
      }
      cursor = data.has_more ? data.cursor : undefined;
    } while (cursor);
    return { entries, truncated: false };
  }

  async stat(path: string): Promise<FileStat | null> {
    if (path === '/') {
      return { name: '/', path: '/', isDirectory: true, size: 0, mtime: Date.now() };
    }
    try {
      const data = await this.rpc<{ '.tag': string } & DropboxEntry>(
        '/files/get_metadata',
        { path: this.toDbx(path), include_deleted: false }
      );
      if (data['.tag'] === 'deleted') return null;
      const isDir = data['.tag'] === 'folder';
      return {
        name: data.name,
        path: path + (isDir && !path.endsWith('/') ? '/' : ''),
        isDirectory: isDir,
        size: isDir ? 0 : (data.size ?? 0),
        mtime: data.client_modified ? new Date(data.client_modified).getTime() : Date.now(),
        etag: data.content_hash ? `"${data.content_hash}"` : undefined,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not_found') || msg.includes('path/not_found')) return null;
      // Dropbox 409 错误体中包含 path/not_found
      if (msg.includes('409')) {
        // 尝试解析错误体
        const m = /path\/not_found|not_found/.exec(msg);
        if (m) return null;
      }
      throw e;
    }
  }

  async read(path: string, range?: Range): Promise<ReadableStream | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.ensureToken()}`,
      'Dropbox-API-Arg': JSON.stringify({ path: this.toDbx(path) }),
    };
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;

    const res = await fetch(`${API_BASE}/files/download`, { method: 'POST', headers });
    if (res.status === 404 || res.status === 409) {
      // 409 可能是 not_found 或 read_only，交由上层处理
      const text = await res.text();
      if (text.includes('not_found')) return null;
      throw new Error(`Dropbox download ${res.status}: ${text}`);
    }
    if (!res.ok) {
      throw new Error(`Dropbox download ${res.status}: ${await res.text()}`);
    }
    return res.body;
  }

  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.ensureToken()}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: this.toDbx(path),
        mode: { '.tag': 'overwrite' },
        autorename: false,
        mute: true,
      }),
    };
    const res = await fetch(`${API_BASE}/files/upload`, { method: 'POST', headers, body: buf });
    if (!res.ok) {
      throw new Error(`Dropbox upload ${res.status}: ${await res.text()}`);
    }
  }

  async remove(path: string): Promise<void> {
    await this.rpc('/files/delete_v2', { path: this.toDbx(path) });
  }

  async mkdir(path: string): Promise<void> {
    await this.rpc('/files/create_folder_v2', {
      path: this.toDbx(path),
      autorename: false,
    });
  }

  async move(src: string, dst: string): Promise<void> {
    await this.rpc('/files/move_v2', {
      from_path: this.toDbx(src),
      to_path: this.toDbx(dst),
      autorename: false,
      allow_shared_folder: true,
      allow_ownership_transfer: false,
    });
  }

  async copy(src: string, dst: string): Promise<void> {
    await this.rpc('/files/copy_v2', {
      from_path: this.toDbx(src),
      to_path: this.toDbx(dst),
      autorename: false,
      allow_shared_folder: true,
    });
  }
}
