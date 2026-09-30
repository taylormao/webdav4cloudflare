/**
 * 光鸭网盘（GuangYaPan）存储驱动
 *
 * 移植自 OpenList guangyapan 驱动（driver.go / types.go / util.go / meta.go）：
 *   - 账号基址 account.guangyapan.com（登录 / captcha / token 刷新 / 用户信息）
 *   - API 基址 api.guangyapan.com（文件列表 / 下载 / 上传 / 删除 / 移动 / 复制 / 建目录）
 *   - 鉴权：access_token（Bearer）优先，缺失或失效时用 refresh_token 自动换取；
 *     401/403 时强制刷新并重试一次
 *   - 列表：POST /userres/v1/file/get_file_list（parentId/page/pageSize/orderBy/sortType 分页）
 *   - 下载：POST /nd.bizuserres.s/v1/get_res_download_url → signedURL/downloadUrl 直链
 *   - 上传：先计算 MD5 走秒传（get_res_center_token，code 156 / "上传已完成" 命中）；
 *     未命中则经阿里云 OSS V1 签名上传（单 PUT 或 Multipart），完成后轮询
 *     /file/get_info_by_task_id 直到文件可见
 *   - 删除/移动/复制：异步任务接口（delete_file / move_file / copy_file → taskId →
 *     get_task_status 轮询 status==2）
 *   - 创建目录：POST /nd.bizuserres.s/v1/file/create_dir；重命名：/file/rename
 *   - root_path：可配置挂载根目录（逐级解析文件夹 ID）
 *
 * 已知限制：
 *   - 上传受 Workers 请求体限制（整体读入内存计算 MD5 后单次/分片 OSS PUT）
 *   - COPY 到不同文件名时，通过目标目录列表定位刚复制的同名项后重命名（取最新同名项）
 *   - 短信验证码登录由 /api/auth/guangyapan/login 提供（见 src/auth/guangyapan-login.ts）
 */
import type { GuangYaPanConfig } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { normalizePath, parentPath, baseName, joinPath } from '../utils/path';
import { readKvDriverConfig } from '../kv-config';

// ===========================================================================
// 常量（与 OpenList guangyapan 对齐）
// ===========================================================================
const ACCOUNT_BASE_URL = 'https://account.guangyapan.com';
const API_BASE_URL = 'https://api.guangyapan.com';

/** 同一 API 端点的最小请求间隔（Go: apiRateInterval = 500ms） */
const API_RATE_INTERVAL = 500;

/** 默认分页大小（Go: PageSize <= 0 时 100） */
const DEFAULT_PAGE_SIZE = 100;
/** 默认排序字段（Go: OrderBy < 0 时 3） */
const DEFAULT_ORDER_BY = 3;
/** 默认排序方向（Go: SortType 非 0/1 时 1） */
const DEFAULT_SORT_TYPE = 1;

/** 任务轮询参数（Go: waitTaskDone maxTry=30 interval=300ms） */
const TASK_MAX_TRY = 30;
const TASK_INTERVAL_MS = 300;

/** 上传完成轮询参数（Go: waitUploadTaskInfo maxTry=300 interval=1s） */
const UPLOAD_MAX_TRY = 300;
const UPLOAD_INTERVAL_MS = 1000;

// ===========================================================================
// 类型（与 OpenList types.go 对齐）
// ===========================================================================
interface ApiEnvelope {
  code?: number;
  msg?: string;
  data?: unknown;
}

interface FileItem {
  fileId: string;
  parentId: string;
  fileName: string;
  fileSize: number;
  /** 2 = 目录（Go: item.ResType == 2 判定 IsFolder） */
  resType: number;
  ctime: number;
  utime: number;
}

interface ListResp extends ApiEnvelope {
  data?: { total: number; list?: FileItem[] };
}

interface DownloadResp extends ApiEnvelope {
  data?: { signedURL?: string; downloadUrl?: string };
}

interface TaskResp extends ApiEnvelope {
  data?: { taskId?: string };
}

interface TaskStatusResp extends ApiEnvelope {
  data?: { status?: number };
}

interface UploadTokenResp extends ApiEnvelope {
  data?: UploadTokenData;
}

interface UploadTokenData {
  taskId?: string;
  objectPath?: string;
  region?: string;
  bucketName?: string;
  endPoint?: string;
  fullEndPoint?: string;
  callbackVar?: string;
  accessKeyID?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  creds?: {
    accessKeyID?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
}

interface TaskInfoResp extends ApiEnvelope {
  data?: { fileId?: string };
}

/** token 刷新响应（Go: tokenResp） */
interface TokenResp {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  sub?: string;
  error?: string;
  error_code?: number;
  error_description?: string;
}

/** API 错误体（含 HTTP 层错误信息） */
class GuangYaPanApiError extends Error {
  constructor(message: string, public status?: number, public code?: number) {
    super(message);
    this.name = 'GuangYaPanApiError';
  }
}

interface ResolveCache {
  id: string;
  isDir: boolean;
  size: number;
  mtime: number;
  etag: string;
}

// ===========================================================================
// 驱动
// ===========================================================================
export class GuangYaPanDriver implements StorageDriver {
  readonly type = 'guangyapan';

  private clientId: string;
  private accessToken: string;
  private refreshToken: string;
  private deviceId: string;
  private deviceSign: string;
  private rootPath: string;
  private pageSize: number;
  private orderBy: number;
  private sortType: number;

  private resolveCache = new Map<string, ResolveCache>();
  private resolvedRootFolderId = '';
  private rootFolderResolved = false;

  /** 每 endpoint 最近请求时间（Go: apiRateLimit） */
  private apiRateLimit = new Map<string, number>();

  constructor(private cfg: GuangYaPanConfig, private driverConfigKv?: KVNamespace) {
    const clientId = (cfg.clientId ?? '').trim();
    if (!clientId) {
      throw new Error('GUANGYAPAN_CLIENT_ID is required for guangyapan driver');
    }
    this.clientId = clientId;
    this.accessToken = (cfg.accessToken ?? '').trim();
    this.refreshToken = (cfg.refreshToken ?? '').trim();
    this.rootPath = (cfg.rootPath ?? '').trim();
    this.pageSize = numOrDefault(cfg.pageSize, DEFAULT_PAGE_SIZE, (n) => n > 0);
    this.orderBy = numOrDefault(cfg.orderBy, DEFAULT_ORDER_BY, (n) => n >= 0);
    this.sortType = cfg.sortType === 0 ? 0 : 1;

    this.deviceId = normalizeDeviceID(cfg.deviceId) || randomDeviceID();
    const deviceSign = (cfg.deviceSign ?? '').trim();
    this.deviceSign = deviceSign || 'wdi10.' + this.deviceId;
  }

  // -------------------------------------------------------------------------
  // token 管理
  // -------------------------------------------------------------------------
  private async refreshAccessToken(): Promise<void> {
    const json = await this.accountRequest<TokenResp>('/v1/auth/token', {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });
    if (!json.access_token) {
      const desc = json.error_description || json.error || 'unknown error';
      throw new Error(`guangyapan: refresh token failed: ${desc}`);
    }
    this.accessToken = json.access_token;
    if (json.refresh_token) this.refreshToken = json.refresh_token;
    await this.persistTokens();
  }

  /** 刷新成功后把新令牌字段级合并写回 DRIVER_CONFIG KV（对齐 Go MustSaveDriverStorage；尽力而为，失败不阻断） */
  private async persistTokens(): Promise<void> {
    const kv = this.driverConfigKv;
    if (!kv) return;
    try {
      const existing = await readKvDriverConfig(kv, 'guangyapan');
      const merged: Record<string, unknown> = { ...(existing ?? {}) };
      merged.accessToken = this.accessToken;
      if (this.refreshToken) merged.refreshToken = this.refreshToken;
      await kv.put('guangyapan', JSON.stringify(merged));
    } catch (e) {
      console.error('[guangyapan] persist tokens to KV failed:', e);
    }
  }

  /** 确保 accessToken 可用：为空时用 refreshToken 换取 */
  private async ensureAccessToken(): Promise<void> {
    if (this.accessToken) return;
    if (!this.refreshToken) {
      throw new Error('guangyapan: not logged in, please provide access_token or refresh_token');
    }
    await this.refreshAccessToken();
  }

  // -------------------------------------------------------------------------
  // HTTP 封装
  // -------------------------------------------------------------------------
  /** account 基址请求（token 刷新 / 用户信息），无 Bearer */
  private async accountRequest<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(ACCOUNT_BASE_URL + path, {
      method: 'POST',
      headers: this.accountHeaders(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON
    }
    if (!res.ok && json === null) {
      throw new Error(`guangyapan: POST ${path} failed with ${res.status}`);
    }
    const err = (json ?? {}) as TokenResp;
    if (err.error || typeof err.error_code === 'number') {
      throw new Error(
        `guangyapan: POST ${path} error: ${err.error_description || err.error || `error_code=${err.error_code}`}`
      );
    }
    return json as T;
  }

  private accountHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Device-Model': 'chrome%2F147.0.0.0',
      'X-Device-Name': 'PC-Chrome',
      'X-Device-Sign': this.deviceSign,
      'X-Net-Work-Type': 'NONE',
      'X-OS-Version': 'MacIntel',
      'X-Platform-Version': '1',
      'X-Protocol-Version': '301',
      'X-Provider-Name': 'NONE',
      'X-SDK-Version': '9.0.2',
      'X-Client-Id': this.clientId,
      'X-Client-Version': '0.0.1',
      'X-Device-Id': this.deviceId,
    };
  }

  private apiHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Did: this.deviceId,
      Dt: '4',
      Authorization: 'Bearer ' + this.accessToken,
    };
  }

  /** 每 endpoint 最小间隔节流（Go: apiRateLimitWait） */
  private async apiRateLimitWait(path: string): Promise<void> {
    const now = Date.now();
    const last = this.apiRateLimit.get(path) ?? 0;
    const wait = API_RATE_INTERVAL - (now - last);
    if (wait > 0) await sleep(wait);
    this.apiRateLimit.set(path, Date.now());
  }

  /** 业务 POST：Bearer 鉴权，401/403 时刷新 token 重试一次（Go: postAPI） */
  private async postAPI<T = ApiEnvelope>(path: string, body: unknown, retried = false): Promise<T> {
    await this.ensureAccessToken();
    await this.apiRateLimitWait(path);
    const res = await fetch(API_BASE_URL + path, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: JSON.stringify(body),
    });
    if ((res.status === 401 || res.status === 403) && !retried) {
      if (!this.refreshToken) {
        throw new Error(`guangyapan: POST ${path} failed with ${res.status}`);
      }
      await this.refreshAccessToken();
      return this.postAPI<T>(path, body, true);
    }
    if (!res.ok) {
      throw new Error(`guangyapan: POST ${path} failed with ${res.status}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`guangyapan: POST ${path} returned non-JSON: ${res.status}`);
    }
    if (!json || typeof json !== 'object') {
      throw new Error(`guangyapan: POST ${path} returned empty body`);
    }
    return json as T;
  }

  // -------------------------------------------------------------------------
  // 光鸭 API
  // -------------------------------------------------------------------------
  private async getFileList(parentId: string): Promise<FileItem[]> {
    const items: FileItem[] = [];
    for (let page = 0; page < 10000; page++) {
      const json = await this.postAPI<ListResp>('/userres/v1/file/get_file_list', {
        parentId,
        page,
        pageSize: this.pageSize,
        orderBy: this.orderBy,
        sortType: this.sortType,
      });
      const data = json.data ?? ({} as { total: number; list?: FileItem[] });
      const list = data.list ?? [];
      for (const item of list) items.push(item);
      if (list.length < this.pageSize) break;
      if (data.total > 0 && items.length >= data.total) break;
    }
    return items;
  }

  private async getDownloadUrl(fileId: string): Promise<string> {
    const json = await this.postAPI<DownloadResp>('/nd.bizuserres.s/v1/get_res_download_url', {
      fileId,
    });
    const url = (json.data?.signedURL ?? '').trim() || (json.data?.downloadUrl ?? '').trim();
    if (!url) throw new Error('guangyapan: empty download url');
    return url;
  }

  /** 异步任务轮询（删除/移动/复制；status 2=成功） */
  private async waitTaskDone(taskId: string): Promise<void> {
    for (let i = 0; i < TASK_MAX_TRY; i++) {
      const json = await this.postAPI<TaskStatusResp>('/nd.bizuserres.s/v1/get_task_status', {
        taskId,
      });
      if (!isSuccessMsg(json.msg)) {
        throw new Error(`guangyapan: get task status failed: ${(json.msg ?? '').trim()}`);
      }
      const status = json.data?.status ?? 0;
      if (status === 2) return;
      if (status === -1 || status === 3) {
        throw new Error(`guangyapan: task ${taskId} failed with status=${status}`);
      }
      if (i === TASK_MAX_TRY - 1) break;
      await sleep(TASK_INTERVAL_MS);
    }
    throw new Error(`guangyapan: task ${taskId} timeout`);
  }

  /** 上传完成轮询（get_info_by_task_id 返回 fileId 即完成） */
  private async waitUploadTaskInfo(taskId: string): Promise<void> {
    for (let i = 0; i < UPLOAD_MAX_TRY; i++) {
      const json = await this.postAPI<TaskInfoResp>('/nd.bizuserres.s/v1/file/get_info_by_task_id', {
        taskId,
      });
      if (json.data?.fileId) return;
      const code = json.code ?? 0;
      if (code !== 145 && code !== 146 && code !== 147 && code !== 155 && code !== 163 && code !== 0) {
        if ((json.msg ?? '').trim()) {
          throw new Error(`guangyapan: upload task failed: code=${code} msg=${json.msg}`);
        }
      }
      if (i === UPLOAD_MAX_TRY - 1) break;
      await sleep(UPLOAD_INTERVAL_MS);
    }
    throw new Error(`guangyapan: upload task ${taskId} timeout`);
  }

  // -------------------------------------------------------------------------
  // 路径解析与缓存
  // -------------------------------------------------------------------------
  private async getRootFolderId(): Promise<string> {
    if (this.rootFolderResolved) return this.resolvedRootFolderId;
    if (this.rootPath) {
      this.resolvedRootFolderId = await this.resolveFolderPath(this.rootPath);
    } else {
      this.resolvedRootFolderId = '';
    }
    this.rootFolderResolved = true;
    return this.resolvedRootFolderId;
  }

  private async resolveFolderPath(rootPath: string): Promise<string> {
    const cleanPath = rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!cleanPath) return '';
    let parentId = '';
    for (const name of cleanPath.split('/')) {
      if (!name) continue;
      parentId = await this.findChildFolderId(parentId, name);
    }
    return parentId;
  }

  private async findChildFolderId(parentId: string, name: string): Promise<string> {
    for (let page = 0; page < 10000; page++) {
      const json = await this.postAPI<ListResp>('/userres/v1/file/get_file_list', {
        parentId,
        page,
        pageSize: this.pageSize,
        orderBy: this.orderBy,
        sortType: this.sortType,
      });
      const data = json.data ?? ({} as { total: number; list?: FileItem[] });
      const list = data.list ?? [];
      for (const item of list) {
        if (item.resType === 2 && item.fileName === name) return item.fileId;
      }
      if (list.length < this.pageSize) break;
      if (data.total > 0 && page * this.pageSize + list.length >= data.total) break;
    }
    if (!parentId) {
      throw new Error(`guangyapan: resolve root folder path failed: folder "${name}" not found under /`);
    }
    throw new Error(
      `guangyapan: resolve root folder path failed: folder "${name}" not found under parent ${parentId}`
    );
  }

  private async resolveDir(path: string): Promise<ResolveCache> {
    const node = await this.resolveNode(path);
    if (!node.isDir) throw new Error(`guangyapan: not a directory: ${path}`);
    return node;
  }

  private async resolveNode(path: string): Promise<ResolveCache> {
    const norm = normalizePath(path);
    const cached = this.resolveCache.get(norm);
    if (cached) return cached;
    if (norm === '/') {
      const id = await this.getRootFolderId();
      const root: ResolveCache = { id, isDir: true, size: 0, mtime: Date.now(), etag: 'guangyapan-root' };
      this.resolveCache.set('/', root);
      return root;
    }
    const parent = parentPath(norm);
    const name = baseName(norm);
    const parentNode = await this.resolveDir(parent);
    const items = await this.getFileList(parentNode.id);
    const item = items.find((i) => i.fileName === name);
    if (!item) throw new Error(`Not found: ${norm}`);
    const node = this.itemToNode(item);
    this.resolveCache.set(norm, node);
    return node;
  }

  private itemToNode(it: FileItem): ResolveCache {
    const isDir = it.resType === 2;
    return {
      id: it.fileId,
      isDir,
      size: isDir ? 0 : it.fileSize,
      mtime: it.utime > 0 ? it.utime * 1000 : Date.now(),
      etag: it.fileId,
    };
  }

  private itemToStat(it: FileItem, dir: string): FileStat {
    const isDir = it.resType === 2;
    const p = joinPath(dir, it.fileName);
    return {
      name: it.fileName,
      path: p + (isDir ? '/' : ''),
      isDirectory: isDir,
      size: isDir ? 0 : it.fileSize,
      mtime: it.utime > 0 ? it.utime * 1000 : Date.now(),
      etag: it.fileId,
      contentType: isDir ? undefined : guessContentType(it.fileName),
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
    const items = await this.getFileList(dir.id);
    const entries = items.map((it) => {
      this.resolveCache.set(joinPath(path, it.fileName), this.itemToNode(it));
      return this.itemToStat(it, path);
    });
    return { entries, truncated: false };
  }

  async stat(path: string): Promise<FileStat | null> {
    const norm = normalizePath(path);
    try {
      if (norm === '/') {
        return { name: '/', path: '/', isDirectory: true, size: 0, mtime: Date.now(), etag: 'guangyapan-root' };
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
    const url = await this.getDownloadUrl(node.id);
    const headers: Record<string, string> = {};
    if (range) {
      headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`guangyapan: download failed with ${res.status}`);
    }
    return res.body;
  }

  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const name = baseName(path);
    const parent = parentPath(path);
    const parentId = (await this.resolveDir(parent)).id;

    const bytes = new Uint8Array(
      body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()
    );
    const size = bytes.byteLength;

    // 1) 计算 MD5 并申请上传令牌（秒传：命中 code 156 / "上传已完成" 直接完成）
    const md5sum = md5hex(bytes);
    const { token, code } = await this.getUploadToken(parentId, name, size, md5sum);
    const taskId = (token.taskId ?? '').trim();

    if (code === 156 || token.AlreadyDone) {
      if (!taskId) throw new Error('guangyapan: instant upload returns empty task id');
      await this.waitUploadTaskInfo(taskId);
      this.invalidate(path);
      this.invalidate(parent);
      return;
    }

    // 2) 真实上传到阿里云 OSS
    if (
      !token.objectPath ||
      !token.bucketName ||
      !token.endPoint ||
      !token.accessKeyID ||
      !token.secretAccessKey
    ) {
      throw new Error('guangyapan: upload token is incomplete');
    }
    const creds: OssCreds = {
      accessKeyId: token.accessKeyID,
      secretAccessKey: token.secretAccessKey,
      token: token.sessionToken ?? '',
    };
    await this.uploadToOss(token, creds, bytes);

    if (taskId) {
      await this.waitUploadTaskInfo(taskId);
    }
    this.invalidate(path);
    this.invalidate(parent);
  }

  /** 获取上传令牌（Go: getUploadToken，含秒传判定与 endpoint/creds 归一化） */
  private async getUploadToken(
    parentId: string,
    name: string,
    size: number,
    md5sum: string
  ): Promise<{ token: UploadTokenData & { AlreadyDone: boolean }; code: number }> {
    const res: Record<string, unknown> = { fileSize: size };
    if (md5sum) res.md5 = md5sum;

    const json = await this.postAPI<UploadTokenResp>('/nd.bizuserres.s/v1/get_res_center_token', {
      capacity: 2,
      name,
      parentId,
      res,
    });
    const msg = (json.msg ?? '').trim();
    if (!isSuccessMsg(msg) && !isUploadAlreadyDone(msg)) {
      throw new Error(`guangyapan: get upload token failed: ${msg}`);
    }
    const data = json.data ?? ({} as UploadTokenData);
    if (!(data.taskId ?? '').trim()) {
      throw new Error('guangyapan: get upload token failed: empty task id');
    }
    if (data.accessKeyID === undefined && data.creds?.accessKeyID) {
      data.accessKeyID = data.creds.accessKeyID;
    }
    if (data.secretAccessKey === undefined && data.creds?.secretAccessKey) {
      data.secretAccessKey = data.creds.secretAccessKey;
    }
    if (data.sessionToken === undefined && data.creds?.sessionToken) {
      data.sessionToken = data.creds.sessionToken;
    }
    if (!data.endPoint && data.fullEndPoint) {
      data.endPoint = data.fullEndPoint;
    }
    if (data.endPoint && !/^https?:\/\//i.test(data.endPoint)) {
      if (data.fullEndPoint) data.endPoint = data.fullEndPoint;
      else if (data.bucketName) {
        const host = data.endPoint.trim();
        const prefix = data.bucketName + '.';
        data.endPoint = host.startsWith(prefix) ? 'https://' + host : 'https://' + data.bucketName + '.' + host;
      } else {
        data.endPoint = 'https://' + data.endPoint.trim();
      }
    }
    const code = json.code ?? 0;
    const alreadyDone = code === 156 || isUploadAlreadyDone(msg);
    return { token: { ...data, AlreadyDone: alreadyDone }, code };
  }

  /** 上传到 OSS（Go: multipartUploadToOSS / bucket.PutObject，OSS V1 签名） */
  private async uploadToOss(
    token: UploadTokenData,
    creds: OssCreds,
    bytes: Uint8Array
  ): Promise<void> {
    const { baseUrl } = buildOssBaseUrl(token.endPoint!, token.bucketName!);
    const key = token.objectPath!;
    const encodedKey = encodeKeyPath(key);
    const objectUrl = `${baseUrl}/${encodedKey}`;

    if (bytes.byteLength === 0) {
      // 0 字节走单 PUT；其余大小统一走 Multipart（对齐 Go guangyapan_ref/driver.go L435-439）
      await ossPutObject(objectUrl, encodedKey, new Uint8Array(0), creds, token.bucketName!);
      return;
    }
    await ossMultipartUpload(objectUrl, encodedKey, bytes, creds, token.bucketName!);
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolveNode(path);
    const json = await this.postAPI<TaskResp>('/nd.bizuserres.s/v1/file/delete_file', {
      fileIds: [node.id],
    });
    if (!isSuccessMsg(json.msg)) {
      throw new Error(`guangyapan: delete failed: ${(json.msg ?? '').trim()}`);
    }
    const taskId = (json.data?.taskId ?? '').trim();
    if (taskId) await this.waitTaskDone(taskId);
    this.invalidate(path);
    this.invalidate(parentPath(path));
  }

  async mkdir(path: string): Promise<void> {
    const name = baseName(path);
    const parent = parentPath(path);
    const parentId = (await this.resolveDir(parent)).id;
    const json = await this.postAPI<ApiEnvelope>('/nd.bizuserres.s/v1/file/create_dir', {
      parentId,
      dirName: name,
    });
    if (!isSuccessMsg(json.msg)) {
      throw new Error(`guangyapan: make dir failed: ${(json.msg ?? '').trim()}`);
    }
    this.invalidate(path);
    this.invalidate(parent);
  }

  async move(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const srcName = baseName(src);
    const dstName = baseName(dst);
    const dstParent = parentPath(dst);
    const dstParentId = (await this.resolveDir(dstParent)).id;

    // 目标名不同：先重命名，再移动（与 xunlei 驱动一致）
    if (dstName !== srcName) {
      await this.renameNode(node.id, dstName);
    }
    const json = await this.postAPI<TaskResp>('/nd.bizuserres.s/v1/file/move_file', {
      fileIds: [node.id],
      parentId: dstParentId,
    });
    if (!isSuccessMsg(json.msg)) {
      throw new Error(`guangyapan: move failed: ${(json.msg ?? '').trim()}`);
    }
    const taskId = (json.data?.taskId ?? '').trim();
    if (taskId) await this.waitTaskDone(taskId);
    this.invalidate(src);
    this.invalidate(dst);
    this.invalidate(dstParent);
  }

  async copy(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const srcName = baseName(src);
    const dstName = baseName(dst);
    const dstParent = parentPath(dst);
    const dstParentId = (await this.resolveDir(dstParent)).id;

    const json = await this.postAPI<TaskResp>('/nd.bizuserres.s/v1/file/copy_file', {
      fileIds: [node.id],
      parentId: dstParentId,
    });
    if (!isSuccessMsg(json.msg)) {
      throw new Error(`guangyapan: copy failed: ${(json.msg ?? '').trim()}`);
    }
    const taskId = (json.data?.taskId ?? '').trim();
    if (taskId) await this.waitTaskDone(taskId);

    // copy_file 不传新名：目标名不同时，在目标目录定位刚复制的同名项并重命名
    if (dstName !== srcName) {
      const items = await this.getFileList(dstParentId);
      const candidates = items.filter((i) => i.fileName === srcName);
      if (candidates.length > 0) {
        // 列表排序按 orderBy/sortType，刚复制的项取第一个同名项
        await this.renameNode(candidates[0].fileId, dstName);
      }
    }
    this.invalidate(dstParent);
    this.invalidate(dst);
  }

  private async renameNode(fileId: string, newName: string): Promise<void> {
    const json = await this.postAPI<ApiEnvelope>('/nd.bizuserres.s/v1/file/rename', {
      fileId,
      newName,
    });
    if (!isSuccessMsg(json.msg)) {
      throw new Error(`guangyapan: rename failed: ${(json.msg ?? '').trim()}`);
    }
  }
}

// ===========================================================================
// 阿里云 OSS V1 签名上传
// ===========================================================================
interface OssCreds {
  accessKeyId: string;
  secretAccessKey: string;
  token: string;
}

/** 归一化 OSS endpoint → virtual-hosted base URL（Go: normalizeOSSEndpoint + bucket.Client） */
function buildOssBaseUrl(endpoint: string, bucket: string): { baseUrl: string } {
  let ep = endpoint.trim();
  if (!/^https?:\/\//i.test(ep)) ep = 'https://' + ep;
  let host: string;
  try {
    host = new URL(ep).host;
  } catch {
    host = ep.replace(/^https?:\/\//i, '').split('/')[0];
  }
  if (host.startsWith(bucket + '.')) host = host.slice(bucket.length + 1);
  return { baseUrl: `https://${bucket}.${host}` };
}

/** OSS V1 单对象 PUT */
async function ossPutObject(
  url: string,
  encodedKey: string,
  bytes: Uint8Array,
  creds: OssCreds,
  bucket: string
): Promise<void> {
  const headers = ossCommonHeaders(creds, 'application/octet-stream');
  const authorization = await ossSign(creds, 'PUT', `/${bucket}/${encodedKey}`, headers);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, Authorization: authorization },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`guangyapan: oss put failed with ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
}

/** OSS V1 分片上传（InitiateMultipartUpload → UploadPart → CompleteMultipartUpload） */
async function ossMultipartUpload(
  url: string,
  encodedKey: string,
  bytes: Uint8Array,
  creds: OssCreds,
  bucket: string
): Promise<void> {
  const partSize = calcUploadPartSize(bytes.byteLength);
  const partCount = Math.max(1, Math.ceil(bytes.byteLength / partSize));

  // 1) 创建分片任务
  const initUrl = url + '?uploads';
  const initHeaders = ossCommonHeaders(creds, 'application/xml');
  const initAuth = await ossSign(creds, 'POST', `/${bucket}/${encodedKey}?uploads`, initHeaders);
  const initRes = await fetch(initUrl, {
    method: 'POST',
    headers: { ...initHeaders, Authorization: initAuth },
  });
  if (!initRes.ok) {
    throw new Error(`guangyapan: oss initiate multipart failed with ${initRes.status}: ${(await initRes.text().catch(() => '')).slice(0, 300)}`);
  }
  const initXml = await initRes.text();
  const uploadId = extractXmlTag(initXml, 'UploadId');
  if (!uploadId) {
    throw new Error('guangyapan: oss initiate multipart missing UploadId');
  }

  // 2) 逐片上传
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let i = 0; i < partCount; i++) {
    const offset = i * partSize;
    const part = bytes.subarray(offset, Math.min(offset + partSize, bytes.byteLength));
    // 请求 URL 的 query 需 URL 编码以正确传输（uploadId 可能含 +/=）；签名 resource 用原始值（OSS 服务端解码 query 后按原始值校验签名）
    const partUrl = url + `?partNumber=${i + 1}&uploadId=${encodeURIComponent(uploadId)}`;
    const resource = `/${bucket}/${encodedKey}?partNumber=${i + 1}&uploadId=${uploadId}`;
    const partHeaders = ossCommonHeaders(creds, 'application/octet-stream');
    const partAuth = await ossSign(creds, 'PUT', resource, partHeaders);
    const partRes = await fetch(partUrl, {
      method: 'PUT',
      headers: { ...partHeaders, Authorization: partAuth },
      body: part,
    });
    if (!partRes.ok) {
      throw new Error(`guangyapan: oss upload part #${i + 1} failed with ${partRes.status}: ${(await partRes.text().catch(() => '')).slice(0, 300)}`);
    }
    const etag = partRes.headers.get('etag');
    if (!etag) {
      throw new Error(`guangyapan: oss upload part #${i + 1} missing ETag`);
    }
    parts.push({ partNumber: i + 1, etag });
  }

  // 3) 完成上传
  const completeBody =
    '<CompleteMultipartUpload>' +
    parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join('') +
    '</CompleteMultipartUpload>';
  const completeUrl = url + `?uploadId=${encodeURIComponent(uploadId)}`;
  // 同上：签名 resource 使用原始 uploadId
  const completeResource = `/${bucket}/${encodedKey}?uploadId=${uploadId}`;
  const completeHeaders = ossCommonHeaders(creds, 'application/xml');
  const completeAuth = await ossSign(creds, 'POST', completeResource, completeHeaders);
  const completeRes = await fetch(completeUrl, {
    method: 'POST',
    headers: { ...completeHeaders, Authorization: completeAuth },
    body: completeBody,
  });
  if (!completeRes.ok) {
    throw new Error(`guangyapan: oss complete multipart failed with ${completeRes.status}: ${(await completeRes.text().catch(() => '')).slice(0, 300)}`);
  }
}

/** OSS 公共头：标准 Date 头（对齐 Go SDK）+ 可选安全令牌 */
function ossCommonHeaders(creds: OssCreds, contentType: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Date': new Date().toUTCString(),
  };
  if (creds.token) headers['x-oss-security-token'] = creds.token;
  return headers;
}

/**
 * OSS V1 签名（与 aliyun-oss-go-sdk 对齐）：
 * StringToSign = VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n"
 *              + CanonicalizedOSSHeaders + CanonicalizedResource
 * 与 Go SDK 一致：使用标准 Date 头承载时间（GMT），不发送 x-oss-date。
 */
async function ossSign(
  creds: OssCreds,
  method: string,
  resource: string,
  headers: Record<string, string>
): Promise<string> {
  const date = headers['Date'] ?? '';
  const canonicalizedOssHeaders = Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith('x-oss-'))
    .map((k) => k.toLowerCase())
    .sort()
    .map((k) => `${k}:${(headers[k] ?? '').trim()}\n`)
    .join('');
  const stringToSign = [
    method,
    '',
    headers['Content-Type'] ?? '',
    date,
    canonicalizedOssHeaders + resource,
  ].join('\n');
  const signature = await hmacSha1Base64(creds.secretAccessKey, stringToSign);
  return `OSS ${creds.accessKeyId}:${signature}`;
}

// ===========================================================================
// 辅助
// ===========================================================================
function isSuccessMsg(msg: string | undefined): boolean {
  const m = (msg ?? '').trim();
  return m === '' || m.toLowerCase() === 'success';
}

/** 秒传完成消息判定（Go: isUploadAlreadyDone） */
function isUploadAlreadyDone(msg: string): boolean {
  const m = msg.trim();
  if (!m) return false;
  const lower = m.toLowerCase();
  return (
    lower === '上传已完成' ||
    lower === 'upload completed' ||
    lower === 'already uploaded' ||
    lower === '秒传成功'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function numOrDefault(v: number | undefined, dft: number, ok: (n: number) => boolean): number {
  if (v !== undefined && Number.isFinite(v) && ok(v)) return v;
  return dft;
}

/** 设备 ID 规范化（Go: normalizeDeviceID；32 位 hex，去 "-" 小写） */
function normalizeDeviceID(v: string | undefined): string {
  if (!v) return '';
  let s = v.trim().toLowerCase();
  s = s.replace(/-/g, '');
  if (s.length !== 32) return '';
  if (!/^[0-9a-f]{32}$/.test(s)) return '';
  return s;
}

/** 随机设备 ID（Go: randomDeviceID；16 字节 hex） */
function randomDeviceID(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 分片大小（Go: calcUploadPartSize） */
function calcUploadPartSize(size: number): number {
  const MB = 1024 * 1024;
  const GB = 1024 * 1024 * 1024;
  if (size <= 100 * MB) return 1 * MB;
  if (size <= 16 * GB) return 2 * MB;
  if (size <= 160 * GB) return 4 * MB;
  return 8 * MB;
}

/** 对象键路径编码（分段编码，保留 '/'） */
function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function extractXmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>(.*?)</${tag}>`).exec(xml);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------
/** HMAC-SHA1 → base64（OSS V1 签名用；WebCrypto 支持 SHA-1 HMAC） */
async function hmacSha1Base64(secret: string, data: string): Promise<string> {
  const keyBuf = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', keyBuf, new TextEncoder().encode(data));
  return base64Encode(new Uint8Array(sig));
}

/** 标准 base64 编码（Uint8Array → string；不依赖 btoa） */
function base64Encode(bytes: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? CHARS[b2 & 63] : '=';
  }
  return out;
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

// ---------------------------------------------------------------------------
// MD5（纯 TS 实现；WebCrypto 不支持 MD5，秒传计算用）
// ---------------------------------------------------------------------------
function md5hex(input: Uint8Array): string {
  return hex(md5(input));
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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default GuangYaPanDriver;
