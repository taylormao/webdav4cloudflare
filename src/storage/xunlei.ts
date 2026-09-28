/**
 * 迅雷网盘存储驱动（thunder_browser 方案）
 *
 * 移植自 AList thunder_browser 驱动（com.xunlei.browser 客户端）：
 *   - 凭据：refresh_token（ExpertAddition 模式），可选 client_id/client_secret 等覆盖项
 *   - 列表：GET  {API}/files?parent_id&space&filters&with=url（next_page_token 翻页）
 *   - 下载：GET  {API}/files/{fileID}?with=url → web_content_link（可用 medias 视频直链）
 *   - 上传：POST {API}/files 创建 resumable 任务（hash=GCID 秒传）→ S3 兼容分片上传
 *           （endpoint 由服务端下发，AWS SigV4 签名，region=xunlei）
 *   - 删除：space=迅雷云盘("") 走 /files/{id}/trash；保险柜空间走 batchDelete；
 *           其余按 removeWay（默认 trash=batchTrash / delete=batchDelete）
 *   - 移动/复制：POST {API}/files:batchMove / :batchCopy（_from=源 space）
 *   - 重命名：PATCH {API}/files/{fileID}?space
 *   - token 刷新：POST https://xluser-ssl.xunlei.com/v1/auth/token
 *     （refresh_token → access_token；请求遇 4122/4121/10/16 强制刷新重试）
 *   - 验证码签名：内置 Algorithms 逐段 MD5 链（GetCaptchaSign），captcha/init 刷新
 *
 * 已知限制：
 *   - 仅支持 refresh_token 方式（无账号密码登录），token 过期需手动更新凭据；
 *     后续全局目标将增加"token 过期前定时提醒更新凭据"能力
 *   - 不实现"超级保险柜"（需要 SafePassword + space token），保险柜空间项可列出但操作可能失败
 *   - 上传受 Workers 请求体限制（整体读入内存计算 GCID 后单次/分片 S3 PUT）
 *   - COPY 到不同文件名时，通过目标目录列表定位刚复制的同名项后重命名（取最新同名项）
 */
import type { XunleiConfig } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { normalizePath, parentPath, baseName, joinPath } from '../utils/path';

// ===========================================================================
// 常量（与 AList thunder_browser/util.go 对齐）
// ===========================================================================
const API_URL = 'https://x-api-pan.xunlei.com/drive/v1';
const FILE_API_URL = API_URL + '/files';
const XLUSER_API_URL = 'https://xluser-ssl.xunlei.com/v1';

const DEFAULT_CLIENT_ID = 'ZUBzD9J_XPXfn7f7';
const DEFAULT_CLIENT_SECRET = 'yESVmHecEe6F0aou69vl-g';
const DEFAULT_CLIENT_VERSION = '1.10.0.2633';
const DEFAULT_PACKAGE_NAME = 'com.xunlei.browser';
const DEFAULT_DOWNLOAD_UA =
  'AndroidDownloadManager/13 (Linux; U; Android 13; M2004J7AC Build/SP1A.210812.016)';
const SDK_VERSION = '233100';

/** 内置签名算法串（逐段 MD5 链） */
const DEFAULT_ALGORITHMS = [
  'uWRwO7gPfdPB/0NfPtfQO+71',
  'F93x+qPluYy6jdgNpq+lwdH1ap6WOM+nfz8/V',
  '0HbpxvpXFsBK5CoTKam',
  'dQhzbhzFRcawnsZqRETT9AuPAJ+wTQso82mRv',
  'SAH98AmLZLRa6DB2u68sGhyiDh15guJpXhBzI',
  'unqfo7Z64Rie9RNHMOB',
  '7yxUdFADp3DOBvXdz0DPuKNVT35wqa5z0DEyEvf',
  'RBG',
  'ThTWPG5eC0UBqlbQ+04nZAptqGCdpv9o55A',
];

const KIND_FOLDER = 'drive#folder';
const KIND_FILE = 'drive#file';
const UPLOAD_TYPE_RESUMABLE = 'UPLOAD_TYPE_RESUMABLE';

/** 空间常量（space 参数） */
const SPACE_THUNDER = ''; // 迅雷云盘
const SPACE_SAFE = 'SPACE_SAFE'; // 迅雷云盘保险柜
const SPACE_BROWSER = 'SPACE_BROWSER'; // 迅雷浏览器云盘
const SPACE_BROWSER_SAFE = 'SPACE_BROWSER_SAFE'; // 浏览器云盘保险柜
const FOLDER_TYPE_DEFAULT_ROOT = 'DEFAULT_ROOT';

/** token 失效错误码（AList：4122/4121/10/16） */
const TOKEN_INVALID_CODES = new Set([4122, 4121, 10, 16]);

/** S3 单 PUT 阈值（与 AWS s3manager DefaultUploadPartSize 一致：5MB） */
const S3_SINGLE_PUT_MAX = 5 * 1024 * 1024;
const S3_PART_SIZE = 5 * 1024 * 1024;
const S3_REGION = 'xunlei';
const S3_SERVICE = 's3';

/** access_token 过期前提前刷新的余量（秒） */
const TOKEN_REFRESH_MARGIN_S = 60;

// ===========================================================================
// 类型
// ===========================================================================
interface XunleiFile {
  id: string;
  parent_id: string;
  name: string;
  size: number;
  kind: string;
  space: string;
  folder_type?: string;
  created_time?: string | number;
  modified_time?: string | number;
  web_content_link?: string;
  medias?: Array<{ link?: { url?: string } }>;
}

interface FileListResp {
  files?: XunleiFile[];
  next_page_token?: string;
}

interface TokenResp {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: string;
}

interface UploadTaskResp {
  upload_type?: string;
  resumable?: {
    params?: {
      access_key_id: string;
      access_key_secret: string;
      bucket: string;
      endpoint: string;
      key: string;
      security_token: string;
      expiration: number;
    };
  };
}

/** API 错误体（AList ErrResp） */
interface ApiErrorBody {
  error_code?: number;
  error_msg?: string;
}

interface ResolveCache {
  id: string;
  space: string;
  isDir: boolean;
  size: number;
  mtime: number;
  etag: string;
}

/** resumable.params 非空形态（供 s3Upload 使用） */
type S3UploadParams = NonNullable<NonNullable<UploadTaskResp['resumable']>['params']>;

// ===========================================================================
// 驱动
// ===========================================================================
export class XunleiDriver implements StorageDriver {
  readonly type = 'xunlei';

  private refreshToken: string;
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private userId = '';

  private deviceId: string;
  private clientId: string;
  private clientSecret: string;
  private clientVersion: string;
  private packageName: string;
  private userAgent: string;
  private downloadUserAgent: string;
  private useVideoUrl: boolean;
  private removeWay: 'trash' | 'delete';
  private algorithms: string[];
  private captchaSignMode: boolean;
  private captchaToken = '';

  private resolveCache = new Map<string, ResolveCache>();

  constructor(private cfg: XunleiConfig) {
    if (!cfg.refreshToken || !cfg.refreshToken.trim()) {
      throw new Error('XUNLEI_REFRESH_TOKEN is required for xunlei driver');
    }
    this.refreshToken = cfg.refreshToken.trim();

    this.clientId = cfg.clientId?.trim() || DEFAULT_CLIENT_ID;
    this.clientSecret = cfg.clientSecret?.trim() || DEFAULT_CLIENT_SECRET;
    this.clientVersion = cfg.clientVersion?.trim() || DEFAULT_CLIENT_VERSION;
    this.packageName = cfg.packageName?.trim() || DEFAULT_PACKAGE_NAME;
    this.deviceId = cfg.deviceId?.trim() || md5hex(this.refreshToken);
    if (this.deviceId.length !== 32) {
      this.deviceId = md5hex(this.refreshToken);
    }
    this.userAgent =
      cfg.userAgent?.trim() ||
      buildCustomUserAgent(this.deviceId, this.packageName, SDK_VERSION, this.clientVersion, this.packageName);
    this.downloadUserAgent = cfg.downloadUserAgent?.trim() || DEFAULT_DOWNLOAD_UA;
    this.useVideoUrl = !!cfg.useVideoUrl;
    this.removeWay = cfg.removeWay === 'delete' ? 'delete' : 'trash';

    // 签名方式：显式提供 timestamp+captchaSign 则用 captcha_sign 模式，否则用内置 Algorithms
    if (cfg.signTimestamp && cfg.signCaptchaSign) {
      this.captchaSignMode = true;
      this.algorithms = [];
    } else {
      this.captchaSignMode = false;
      this.algorithms = [...DEFAULT_ALGORITHMS];
    }
  }

  // -------------------------------------------------------------------------
  // 基础请求（不带 Authorization，供 token 刷新 / captcha init 使用）
  // -------------------------------------------------------------------------
  private async baseRequest<T = unknown>(
    url: string,
    method: string,
    opts: { query?: Record<string, string>; body?: unknown } = {}
  ): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: 'application/json;charset=UTF-8',
      'x-device-id': this.deviceId,
      'x-client-id': this.clientId,
      'x-client-version': this.clientVersion,
    };
    const res = await fetch(u.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON（如 HTML 错误页）
    }
    if (!res.ok && json === null) {
      throw new Error(`xunlei: ${method} ${url} failed with ${res.status}`);
    }
    const err = json as ApiErrorBody | null;
    if (err && typeof err.error_code === 'number' && err.error_code !== 0) {
      throw new XunleiApiError(err.error_code, err.error_msg ?? '', url);
    }
    return json as T;
  }

  // -------------------------------------------------------------------------
  // token 刷新
  // -------------------------------------------------------------------------
  /** 刷新 access_token（refresh_token → access_token）；成功后同步更新 refresh_token */
  private async refreshAccessToken(): Promise<void> {
    const json = await this.baseRequest<TokenResp>(XLUSER_API_URL + '/auth/token', 'POST', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      },
    });
    if (!json.access_token) {
      throw new Error('xunlei: refresh token is invalid, please update XUNLEI_REFRESH_TOKEN');
    }
    this.accessToken = json.access_token;
    if (json.refresh_token) this.refreshToken = json.refresh_token;
    this.userId = json.user_id ?? '';
    this.accessTokenExpiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : 0;
  }

  /** 非 force 时按剩余有效期判断；force 用于请求遇 token 失效错误时强制刷新 */
  private async ensureToken(force: boolean): Promise<void> {
    if (!force) {
      if (this.accessToken && this.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_MARGIN_S * 1000) {
        return;
      }
    }
    await this.refreshAccessToken();
  }

  // -------------------------------------------------------------------------
  // 验证码签名与刷新
  // -------------------------------------------------------------------------
  private getCaptchaSign(): { timestamp: string; sign: string } {
    if (this.captchaSignMode) {
      return { timestamp: this.cfg.signTimestamp ?? '', sign: this.cfg.signCaptchaSign ?? '' };
    }
    const timestamp = String(Date.now());
    let str = this.clientId + this.clientVersion + this.packageName + this.deviceId + timestamp;
    for (const algo of this.algorithms) {
      str = md5hex(str + algo);
    }
    return { timestamp, sign: '1.' + str };
  }

  /** 刷新 captcha_token（error_code=9 & captcha_invalid 时调用） */
  private async refreshCaptchaToken(action: string): Promise<void> {
    const { timestamp, sign } = this.getCaptchaSign();
    const metas: Record<string, string> = {
      client_version: this.clientVersion,
      package_name: this.packageName,
      timestamp,
      captcha_sign: sign,
    };
    if (this.userId) metas.user_id = this.userId;
    const json = await this.baseRequest<{ captcha_token?: string; url?: string }>(
      XLUSER_API_URL + '/shield/captcha/init',
      'POST',
      {
        body: {
          action,
          captcha_token: this.captchaToken,
          client_id: this.clientId,
          device_id: this.deviceId,
          meta: metas,
          redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
        },
      }
    );
    if (json.url) {
      throw new Error(`xunlei: need verify: ${json.url}`);
    }
    if (!json.captcha_token) {
      throw new Error('xunlei: empty captchaToken');
    }
    this.captchaToken = json.captcha_token;
  }

  /** 由 method+url 派生 captcha action（去掉协议/域名/query） */
  private static getAction(method: string, url: string): string {
    try {
      const u = new URL(url);
      return method + ':' + u.pathname;
    } catch {
      return method + ':' + url;
    }
  }

  // -------------------------------------------------------------------------
  // 业务请求（带 Authorization / X-Captcha-Token；token 失效与验证码过期自动处理）
  // -------------------------------------------------------------------------
  private async apiRequest<T = unknown>(
    url: string,
    method: string,
    opts: { query?: Record<string, string>; body?: unknown; rawBody?: string } = {},
    retried = false
  ): Promise<T> {
    await this.ensureToken(false);
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: 'application/json;charset=UTF-8',
      'x-device-id': this.deviceId,
      'x-client-id': this.clientId,
      'x-client-version': this.clientVersion,
      Authorization: `Bearer ${this.accessToken}`,
      'X-Captcha-Token': this.captchaToken,
      'X-Space-Authorization': '',
    };
    const res = await fetch(u.toString(), {
      method,
      headers,
      body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON
    }
    if (!res.ok && json === null) {
      throw new Error(`xunlei: ${method} ${url} failed with ${res.status}`);
    }
    const err = json as ApiErrorBody | null;
    if (err && typeof err.error_code === 'number' && err.error_code !== 0) {
      const code = err.error_code;
      const msg = err.error_msg ?? '';
      if (!retried && TOKEN_INVALID_CODES.has(code)) {
        await this.refreshAccessToken();
        return this.apiRequest<T>(url, method, opts, true);
      }
      if (!retried && code === 9 && msg === 'captcha_invalid') {
        await this.refreshCaptchaToken(XunleiDriver.getAction(method, url));
        return this.apiRequest<T>(url, method, opts, true);
      }
      throw new XunleiApiError(code, msg, url);
    }
    return json as T;
  }

  // -------------------------------------------------------------------------
  // 迅雷 API
  // -------------------------------------------------------------------------
  private async getFiles(parentId: string, space: string): Promise<XunleiFile[]> {
    const items: XunleiFile[] = [];
    let pageToken = '';
    for (;;) {
      const json = await this.apiRequest<FileListResp>(FILE_API_URL, 'GET', {
        query: {
          parent_id: parentId,
          page_token: pageToken,
          space,
          filters: '{"trashed":{"eq":false}}',
          with: 'url',
          with_audit: 'true',
          thumbnail_size: 'SIZE_LARGE',
        },
      });
      for (const f of json.files ?? []) {
        // 兼容迅雷后端重复返回的 "迅雷云盘" 占位根（AList 同样跳过）
        if (f.folder_type === FOLDER_TYPE_DEFAULT_ROOT && !f.id && !f.space && parentId) {
          continue;
        }
        items.push(f);
      }
      const next = json.next_page_token ?? '';
      if (!next) break;
      pageToken = next;
    }
    return items;
  }

  private async getFileLink(fileId: string, space: string): Promise<string> {
    const json = await this.apiRequest<XunleiFile>(`${FILE_API_URL}/${fileId}`, 'GET', {
      query: { _magic: '2021', space, thumbnail_size: 'SIZE_LARGE', with: 'url' },
    });
    let link = json.web_content_link ?? '';
    if (this.useVideoUrl) {
      for (const m of json.medias ?? []) {
        if (m.link?.url) {
          link = m.link.url;
          break;
        }
      }
    }
    if (!link) {
      throw new Error('xunlei: no download url');
    }
    return link;
  }

  // -------------------------------------------------------------------------
  // 路径解析与缓存
  // -------------------------------------------------------------------------
  private async resolveDir(path: string): Promise<ResolveCache> {
    const node = await this.resolveNode(path);
    if (!node.isDir) {
      throw new Error(`xunlei: not a directory: ${path}`);
    }
    return node;
  }

  private async resolveNode(path: string): Promise<ResolveCache> {
    const norm = normalizePath(path);
    const cached = this.resolveCache.get(norm);
    if (cached) return cached;
    if (norm === '/') {
      const root: ResolveCache = {
        id: '',
        space: SPACE_BROWSER,
        isDir: true,
        size: 0,
        mtime: Date.now(),
        etag: 'xunlei-root',
      };
      this.resolveCache.set('/', root);
      return root;
    }
    const parent = parentPath(norm);
    const name = baseName(norm);
    const parentNode = await this.resolveDir(parent);
    const items = await this.getFiles(parentNode.id, parentNode.space);
    const item = items.find((i) => i.name === name);
    if (!item) {
      throw new Error(`Not found: ${norm}`);
    }
    const node = this.itemToNode(item);
    this.resolveCache.set(norm, node);
    return node;
  }

  private itemToNode(it: XunleiFile): ResolveCache {
    const isDir = it.kind === KIND_FOLDER;
    return {
      id: it.id,
      space: it.space ?? SPACE_THUNDER,
      isDir,
      size: isDir ? 0 : it.size ?? 0,
      mtime: parseXunleiTime(it.modified_time),
      etag: it.id,
    };
  }

  private itemToStat(it: XunleiFile, dir: string): FileStat {
    const isDir = it.kind === KIND_FOLDER;
    const p = joinPath(dir, it.name);
    return {
      name: it.name,
      path: p + (isDir ? '/' : ''),
      isDirectory: isDir,
      size: isDir ? 0 : it.size ?? 0,
      mtime: parseXunleiTime(it.modified_time),
      etag: it.id,
      contentType: isDir ? undefined : guessContentType(it.name),
    };
  }

  private invalidate(path: string): void {
    const norm = normalizePath(path);
    for (const k of [...this.resolveCache.keys()]) {
      if (k === norm || (norm === '/' ? k.startsWith('/') : k.startsWith(norm + '/'))) {
        this.resolveCache.delete(k);
      }
    }
  }

  // -------------------------------------------------------------------------
  // StorageDriver 实现
  // -------------------------------------------------------------------------
  async list(path: string): Promise<ListResult> {
    const dir = await this.resolveDir(path);
    const items = await this.getFiles(dir.id, dir.space);
    const entries = items.map((it) => {
      this.resolveCache.set(joinPath(path, it.name), this.itemToNode(it));
      return this.itemToStat(it, path);
    });
    return { entries, truncated: false };
  }

  async stat(path: string): Promise<FileStat | null> {
    const norm = normalizePath(path);
    try {
      if (norm === '/') {
        return {
          name: '/',
          path: '/',
          isDirectory: true,
          size: 0,
          mtime: Date.now(),
          etag: 'xunlei-root',
        };
      }
      const node = await this.resolveNode(norm);
      const isDir = node.isDir;
      return {
        name: baseName(norm),
        path: norm + (isDir && !norm.endsWith('/') ? '/' : ''),
        isDirectory: isDir,
        size: node.size,
        mtime: node.mtime,
        etag: node.etag,
        contentType: isDir ? undefined : guessContentType(norm),
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
    const link = await this.getFileLink(node.id, node.space);
    const headers: Record<string, string> = { 'user-agent': this.downloadUserAgent };
    if (range) {
      headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    }
    const res = await fetch(link, { headers });
    if (!res.ok) {
      throw new Error(`xunlei: download failed with ${res.status}`);
    }
    return res.body;
  }

  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const name = baseName(path);
    const parent = parentPath(path);
    const parentNode = await this.resolveDir(parent);

    const bytes = new Uint8Array(
      body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()
    );
    const size = bytes.byteLength;
    const gcid = await calcGcid(bytes, size);

    // 1) 创建 resumable 上传任务（GCID 秒传）
    const json = await this.apiRequest<UploadTaskResp>(FILE_API_URL, 'POST', {
      body: {
        kind: KIND_FILE,
        parent_id: parentNode.id,
        name,
        size,
        hash: gcid,
        upload_type: UPLOAD_TYPE_RESUMABLE,
        space: parentNode.space,
      },
    });
    const params = json.resumable?.params;
    if (!params || json.upload_type !== UPLOAD_TYPE_RESUMABLE) {
      // 服务端未返回上传参数（罕见）：视为已受理
      this.invalidate(path);
      this.invalidate(parent);
      return;
    }

    // 2) S3 兼容上传（AWS SigV4，region=xunlei）
    await this.s3Upload(params, bytes);
    this.invalidate(path);
    this.invalidate(parent);
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolveNode(path);
    const space = node.space;
    if (space === SPACE_THUNDER) {
      // 迅雷云盘：走单文件 trash 接口
      await this.apiRequest(`${FILE_API_URL}/${node.id}/trash`, 'PATCH', { rawBody: '{}' });
    } else if (space === SPACE_SAFE || space === SPACE_BROWSER_SAFE) {
      // 保险柜空间：直接彻底删除
      await this.apiRequest(FILE_API_URL + ':batchDelete', 'POST', {
        body: { ids: [node.id], space },
      });
    } else if (this.removeWay === 'delete') {
      await this.apiRequest(FILE_API_URL + ':batchDelete', 'POST', {
        body: { ids: [node.id], space },
      });
    } else {
      await this.apiRequest(FILE_API_URL + ':batchTrash', 'POST', {
        body: { ids: [node.id], space },
      });
    }
    this.invalidate(path);
    this.invalidate(parentPath(path));
  }

  async mkdir(path: string): Promise<void> {
    const name = baseName(path);
    const parent = parentPath(path);
    const parentNode = await this.resolveDir(parent);
    await this.apiRequest(FILE_API_URL, 'POST', {
      body: {
        kind: KIND_FOLDER,
        name,
        parent_id: parentNode.id,
        space: parentNode.space,
      },
    });
    this.invalidate(path);
    this.invalidate(parent);
  }

  async move(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const srcName = baseName(src);
    const dstName = baseName(dst);
    const dstParent = parentPath(dst);
    const dstParentNode = await this.resolveDir(dstParent);

    if (dstName !== srcName) {
      // 目标名不同：先重命名，再移动
      await this.apiRequest(`${FILE_API_URL}/${node.id}`, 'PATCH', {
        query: { space: node.space },
        body: { name: dstName },
      });
    }
    await this.apiRequest(FILE_API_URL + ':batchMove', 'POST', {
      query: { _from: node.space },
      body: {
        to: { parent_id: dstParentNode.id, space: dstParentNode.space },
        space: node.space,
        ids: [node.id],
      },
    });
    this.invalidate(src);
    this.invalidate(dst);
    this.invalidate(dstParent);
  }

  async copy(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const srcName = baseName(src);
    const dstName = baseName(dst);
    const dstParent = parentPath(dst);
    const dstParentNode = await this.resolveDir(dstParent);

    await this.apiRequest(FILE_API_URL + ':batchCopy', 'POST', {
      query: { _from: node.space },
      body: {
        to: { parent_id: dstParentNode.id, space: dstParentNode.space },
        space: node.space,
        ids: [node.id],
      },
    });
    // batchCopy 不传新名：目标名不同时，在目标目录定位刚复制的同名项并重命名
    if (dstName !== srcName) {
      const items = await this.getFiles(dstParentNode.id, dstParentNode.space);
      const candidates = items.filter((i) => i.name === srcName);
      if (candidates.length > 0) {
        const target = candidates[0];
        await this.apiRequest(`${FILE_API_URL}/${target.id}`, 'PATCH', {
          query: { space: target.space ?? dstParentNode.space },
          body: { name: dstName },
        });
      }
    }
    this.invalidate(dstParent);
    this.invalidate(dst);
  }

  // -------------------------------------------------------------------------
  // S3 兼容上传（AWS SigV4）
  // -------------------------------------------------------------------------
  private async s3Upload(
    params: S3UploadParams,
    bytes: Uint8Array
  ): Promise<void> {
    const bucket = params.bucket;
    let endpoint = params.endpoint;
    if (endpoint.startsWith(bucket + '.')) {
      endpoint = endpoint.slice(bucket.length + 1);
    }
    const host = bucket + '.' + endpoint;
    const key = params.key;
    const creds = {
      accessKeyId: params.access_key_id,
      secretAccessKey: params.access_key_secret,
      token: params.security_token,
    };
    const date = new Date();
    const baseUrl = `https://${host}/${encodeKeyPath(key)}`;

    if (bytes.byteLength <= S3_SINGLE_PUT_MAX) {
      await this.s3PutObject(baseUrl, host, key, bytes, creds, date);
    } else {
      await this.s3MultipartUpload(baseUrl, host, key, bytes, creds, date);
    }
  }

  /** 单 PUT（≤5MB） */
  private async s3PutObject(
    url: string,
    host: string,
    key: string,
    bytes: Uint8Array,
    creds: { accessKeyId: string; secretAccessKey: string; token: string },
    date: Date
  ): Promise<void> {
    const payloadHash = await sha256Hex(bytes);
    const amzDate = formatAmzDate(date);
    const dateStamp = formatDateStamp(date);
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': creds.token,
      'content-length': String(bytes.byteLength),
    };
    const authorization = await signS3Request({
      method: 'PUT',
      url,
      payloadHash,
      headers,
      creds,
      region: S3_REGION,
      service: S3_SERVICE,
      date,
    });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, Authorization: authorization },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`xunlei: s3 put failed with ${res.status}`);
    }
  }

  /** 分片上传（>5MB）：CreateMultipartUpload → UploadPart → CompleteMultipartUpload */
  private async s3MultipartUpload(
    url: string,
    host: string,
    key: string,
    bytes: Uint8Array,
    creds: { accessKeyId: string; secretAccessKey: string; token: string },
    date: Date
  ): Promise<void> {
    const amzDate = formatAmzDate(date);
    const dateStamp = formatDateStamp(date);

    // 1) 创建分片任务
    const initUrl = url + '?uploads';
    const initPayloadHash = await sha256Hex(new Uint8Array(0));
    const initHeaders: Record<string, string> = {
      host,
      'x-amz-content-sha256': initPayloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': creds.token,
    };
    const initAuth = await signS3Request({
      method: 'POST',
      url: initUrl,
      payloadHash: initPayloadHash,
      headers: initHeaders,
      creds,
      region: S3_REGION,
      service: S3_SERVICE,
      date,
    });
    const initRes = await fetch(initUrl, {
      method: 'POST',
      headers: { ...initHeaders, Authorization: initAuth },
    });
    if (!initRes.ok) {
      throw new Error(`xunlei: s3 create multipart failed with ${initRes.status}`);
    }
    const initXml = await initRes.text();
    const uploadId = extractXmlTag(initXml, 'UploadId');
    if (!uploadId) {
      throw new Error('xunlei: s3 create multipart missing UploadId');
    }

    // 2) 逐片上传
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const partCount = Math.max(1, Math.ceil(bytes.byteLength / S3_PART_SIZE));
    for (let i = 0; i < partCount; i++) {
      const offset = i * S3_PART_SIZE;
      const part = bytes.subarray(offset, Math.min(offset + S3_PART_SIZE, bytes.byteLength));
      const partPayloadHash = await sha256Hex(part);
      const partDate = new Date();
      const partAmzDate = formatAmzDate(partDate);
      const partDateStamp = formatDateStamp(partDate);
      const partUrl =
        url + `?partNumber=${i + 1}&uploadId=${encodeURIComponent(uploadId)}`;
      const partHeaders: Record<string, string> = {
        host,
        'x-amz-content-sha256': partPayloadHash,
        'x-amz-date': partAmzDate,
        'x-amz-security-token': creds.token,
        'content-length': String(part.byteLength),
      };
      const partAuth = await signS3Request({
        method: 'PUT',
        url: partUrl,
        payloadHash: partPayloadHash,
        headers: partHeaders,
        creds,
        region: S3_REGION,
        service: S3_SERVICE,
        date: partDate,
      });
      const partRes = await fetch(partUrl, {
        method: 'PUT',
        headers: { ...partHeaders, Authorization: partAuth },
        body: part,
      });
      if (!partRes.ok) {
        throw new Error(`xunlei: s3 upload part #${i + 1} failed with ${partRes.status}`);
      }
      const etag = partRes.headers.get('etag');
      if (!etag) {
        throw new Error(`xunlei: s3 upload part #${i + 1} missing ETag`);
      }
      parts.push({ partNumber: i + 1, etag });
    }

    // 3) 完成上传
    const completeBody =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const completeBytes = new TextEncoder().encode(completeBody);
    const completePayloadHash = await sha256Hex(completeBytes);
    const completeDate = new Date();
    const completeAmzDate = formatAmzDate(completeDate);
    const completeDateStamp = formatDateStamp(completeDate);
    const completeUrl = url + `?uploadId=${encodeURIComponent(uploadId)}`;
    const completeHeaders: Record<string, string> = {
      host,
      'x-amz-content-sha256': completePayloadHash,
      'x-amz-date': completeAmzDate,
      'x-amz-security-token': creds.token,
      'content-length': String(completeBytes.byteLength),
    };
    const completeAuth = await signS3Request({
      method: 'POST',
      url: completeUrl,
      payloadHash: completePayloadHash,
      headers: completeHeaders,
      creds,
      region: S3_REGION,
      service: S3_SERVICE,
      date: completeDate,
    });
    const completeRes = await fetch(completeUrl, {
      method: 'POST',
      headers: { ...completeHeaders, Authorization: completeAuth },
      body: completeBytes,
    });
    if (!completeRes.ok) {
      throw new Error(`xunlei: s3 complete multipart failed with ${completeRes.status}`);
    }
  }
}

// ===========================================================================
// 辅助
// ===========================================================================

class XunleiApiError extends Error {
  constructor(
    public errorCode: number,
    public errorMsg: string,
    public url: string
  ) {
    super(`xunlei: ${errorMsg} (${errorCode})`);
    this.name = 'XunleiApiError';
  }
}

/** 迅雷时间（秒/毫秒/ISO）→ epoch ms */
function parseXunleiTime(v: string | number | undefined): number {
  if (v === undefined || v === null || v === '') return Date.now();
  if (typeof v === 'number') {
    return v < 1e12 ? v * 1000 : v; // 秒 → 毫秒
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) return Date.now();
  return t;
}

/** 扩展名 → MIME（无则 application/octet-stream） */
function guessContentType(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  const ext = path.slice(i + 1).toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    flac: 'audio/flac', opus: 'audio/opus',
    md: 'text/markdown', txt: 'text/plain', json: 'application/json',
    js: 'text/javascript', py: 'text/x-python', html: 'text/html', htm: 'text/html',
    xml: 'application/xml', csv: 'text/csv', log: 'text/plain', ini: 'text/plain',
    yaml: 'text/yaml', yml: 'text/yaml', ts: 'text/plain', java: 'text/plain',
    c: 'text/plain', cpp: 'text/plain', go: 'text/plain', rs: 'text/plain',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** 与 AList BuildCustomUserAgent 一致（注意 Go 实现中 deviceID 参数实际未使用） */
function buildCustomUserAgent(
  _deviceID: string,
  appName: string,
  sdkVersion: string,
  clientVersion: string,
  packageName: string
): string {
  return (
    `ANDROID-${appName}/${clientVersion} networkType/WIFI appid/22062 ` +
    `deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/13 protocolVersion/301 ` +
    `platformversion/10 sdkVersion/${sdkVersion} ` +
    `Oauth2Client/0.9 (Linux 4_9_337-perf-sn-uotan-gd9d488809c3d) (JAVA 0) `
  );
}

/** 计算文件 GCID（AList getGcid）：块级 SHA1 → 外层 SHA1 → hex */
async function calcGcid(bytes: Uint8Array, size: number): Promise<string> {
  const blockSize = calcBlockSize(size);
  const outer = new Uint8Array(20 * Math.max(1, Math.ceil(size / blockSize)));
  let written = 0;
  for (let offset = 0; offset < size; offset += blockSize) {
    const part = bytes.subarray(offset, Math.min(offset + blockSize, size));
    const hashBuf = await crypto.subtle.digest('SHA-1', part);
    outer.set(new Uint8Array(hashBuf), written);
    written += 20;
  }
  const finalBuf = await crypto.subtle.digest('SHA-1', outer.subarray(0, written));
  return hex(new Uint8Array(finalBuf));
}

function calcBlockSize(size: number): number {
  let psize = 0x40000; // 256KB
  while (size / psize > 0x200 && psize < 0x200000) {
    psize = psize << 1;
  }
  return psize;
}

// ---------------------------------------------------------------------------
// AWS SigV4（S3）
// ---------------------------------------------------------------------------
interface SigV4Params {
  method: string;
  url: string;
  payloadHash: string;
  headers: Record<string, string>; // 全部小写 key，host 必须存在
  creds: { accessKeyId: string; secretAccessKey: string; token: string };
  region: string;
  service: string;
  date: Date;
}

async function signS3Request(p: SigV4Params): Promise<string> {
  const u = new URL(p.url);
  const amzDate = formatAmzDate(p.date);
  const dateStamp = formatDateStamp(p.date);

  const canonicalUri = encodeCanonicalPath(u.pathname);
  const canonicalQuery = encodeCanonicalQuery(u.searchParams);
  const signedHeaders = Object.keys(p.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    signedHeaders.map((h) => `${h}:${String(p.headers[h] ?? '').trim()}\n`).join('') +
    // 保证 host 一定参与签名（调用方必传）
    '';
  const canonicalRequest = [
    p.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    p.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join('\n');

  const signingKey = await hmacChain(
    'AWS4' + p.creds.secretAccessKey,
    [dateStamp, p.region, p.service, 'aws4_request']
  );
  const signature = await hmacHex(signingKey, stringToSign);

  return (
    `AWS4-HMAC-SHA256 Credential=${p.creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`
  );
}

/** canonical URI：按段 encodeURIComponent（保留 '/'），并还原 AWS 不编码的 !'()* */
function encodeCanonicalPath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((seg) => encodeUriComponentAws(seg))
    .join('/');
}

/** canonical query：参数按名排序，值做 AWS 编码 */
function encodeCanonicalQuery(sp: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of sp.entries()) {
    pairs.push([encodeUriComponentAws(k), encodeUriComponentAws(v)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** AWS 编码：encodeURIComponent 后还原 !'()*（AWS 不编码 RFC3986 unreserved） */
function encodeUriComponentAws(s: string): string {
  return encodeURIComponent(s)
    .replace(/%21/g, '!')
    .replace(/%27/g, "'")
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*');
}

/** S3 对象键路径编码（分段编码，保留 '/'） */
function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function formatAmzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function extractXmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>(.*?)</${tag}>`).exec(xml);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(buf));
}

async function hmacHex(key: Uint8Array, data: string): Promise<string> {
  const keyBuf = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', keyBuf, new TextEncoder().encode(data));
  return hex(new Uint8Array(sig));
}

/** 依次用 data 派生 HMAC 链（AWS signing key） */
async function hmacChain(seed: string, steps: string[]): Promise<Uint8Array> {
  let key = new TextEncoder().encode(seed);
  for (const s of steps) {
    const keyBuf = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    key = new Uint8Array(await crypto.subtle.sign('HMAC', keyBuf, new TextEncoder().encode(s)));
  }
  return key;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// MD5（纯 TS 实现；WebCrypto 不支持 MD5）
// ---------------------------------------------------------------------------
function md5hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return hex(md5(bytes));
}

function md5(input: Uint8Array): Uint8Array {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  const bitLen = input.length * 8;
  const paddedLen = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

export default XunleiDriver;
