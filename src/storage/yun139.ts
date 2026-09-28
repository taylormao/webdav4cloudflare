/**
 * 中国移动云盘（139 云盘 / 和彩云）存储驱动
 *
 * 实现 OpenList 的 personal_new（个人云新 API）协议：
 *   - 根 fileId 为 "/"
 *   - 列表：POST {host}/file/list（pageCursor 翻页）
 *   - 下载：POST {host}/file/getDownloadUrl → cdnUrl/url
 *   - 上传：POST {host}/file/create（SHA256 秒传）→ 分片 PUT uploadUrl → POST {host}/file/complete
 *   - 删除：POST {host}/recyclebin/batchTrash
 *   - 移动/复制：POST {host}/file/batchMove / file/batchCopy
 *   - 创建目录 / 重命名：POST {host}/file/create（type=folder）/ file/update
 *   - token 刷新：Authorization 内嵌过期时间（token|...|exp），剩余有效期不足 15 天时自动调用
 *     aas.caiyun.feixin.10086.cn/tellin/authTokenRefresh.do 刷新；请求 401 时强制刷新重试
 *   - 签名：mcloud-sign（URL 编码 → 字符排序 → base64 → MD5 拼接 MD5(ts:rand) → MD5 大写）
 *
 * 凭据：YUN139_AUTHORIZATION = base64("pc:<账号>:<token|...|exp>")
 *
 * 已知限制：
 *   - 不支持密码登录恢复 token，过期需手动更新 YUN139_AUTHORIZATION
 *   - 目录递归复制依赖服务端 batchCopy 行为
 *   - COPY 到不同文件名时，通过目标目录列表定位刚复制的同名项后重命名（取最新同名项）
 */
import type { Yun139Config } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { normalizePath, parentPath, baseName, joinPath } from '../utils/path';

// ===========================================================================
// 常量
// ===========================================================================
const AUTH_REFRESH_URL = 'https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do';
const ROUTE_URL = 'https://user-njs.yun.139.com/user/route/qryRoutePolicy';
const CLIENT_TYPE = '656';
const REFRESH_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000; // 剩余有效期不足 15 天时刷新
const UPLOAD_PART_SIZE = 100 * 1024 * 1024; // 100MB / 分片（与 OpenList getPartSize 对齐）
const UPLOAD_BATCH = 100; // 每次 create/getUploadUrl 携带的分片信息上限

// ===========================================================================
// 类型
// ===========================================================================
interface PersonalFileItem {
  fileId: string;
  name: string;
  size: number;
  type: 'folder' | 'file' | string;
  createdAt?: string;
  updatedAt?: string;
  thumbnailUrls?: string[];
}

interface PersonalPartInfo {
  partNumber: number;
  partSize?: number;
  uploadUrl?: string;
}

interface PersonalUploadResp {
  exist?: boolean;
  fileId?: string;
  uploadId?: string;
  partInfos?: PersonalPartInfo[];
}

interface RoutePolicy {
  modName?: string;
  httpsUrl?: string;
}

interface BaseResp {
  success: boolean;
  code?: string;
  message?: string;
  data?: unknown;
}

interface ResolveCache {
  id: string;
  isDir: boolean;
  size: number;
  mtime: number;
  etag?: string;
}

// ===========================================================================
// 驱动
// ===========================================================================
export class Yun139Driver implements StorageDriver {
  readonly type = 'yun139';

  private account: string;
  private token: string;
  private authorization: string;
  private tokenExpiryMs: number | null = null;
  private host: string | null = null;
  private resolveCache = new Map<string, ResolveCache>();

  constructor(private cfg: Yun139Config) {
    if (!cfg.authorization || !cfg.authorization.trim()) {
      throw new Error('YUN139_AUTHORIZATION is required for yun139 driver');
    }
    let raw = cfg.authorization.trim();
    if (/^basic\s+/i.test(raw)) raw = raw.replace(/^basic\s+/i, '');
    let decoded: string;
    try {
      decoded = atob(raw);
    } catch {
      throw new Error('yun139: YUN139_AUTHORIZATION is not valid base64');
    }
    const parts = decoded.split(':');
    if (parts.length < 3 || parts[0] !== 'pc') {
      throw new Error("yun139: YUN139_AUTHORIZATION must be base64('pc:<账号>:<token>')");
    }
    this.account = parts[1];
    this.token = parts.slice(2).join(':');
    this.authorization = raw;
    this.parseExpiry(this.token);
  }

  // -------------------------------------------------------------------------
  // 令牌与路由
  // -------------------------------------------------------------------------
  /** 从 token 的 |exp 段解析过期时间（epoch ms），无则置 null */
  private parseExpiry(token: string): void {
    const segs = token.split('|');
    if (segs.length >= 4) {
      const exp = parseInt(segs[3], 10);
      if (Number.isFinite(exp)) this.tokenExpiryMs = exp * 1000;
    }
  }

  /**
   * 刷新 token：非 force 时按剩余有效期判断（>15 天跳过；<0 报错；期间刷新）；
   * force 用于 401 强制刷新。
   */
  private async refreshToken(force: boolean): Promise<void> {
    if (!force) {
      if (this.tokenExpiryMs === null) return;
      const remaining = this.tokenExpiryMs - Date.now();
      if (remaining > REFRESH_THRESHOLD_MS) return;
      if (remaining < 0) {
        throw new Error('yun139: authorization token has expired, please update YUN139_AUTHORIZATION');
      }
    }
    const xml =
      `<root><token>${this.token}</token><account>${this.account}</account>` +
      `<clienttype>${CLIENT_TYPE}</clienttype></root>`;
    const res = await fetch(AUTH_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
    });
    const text = await res.text();
    const ret = /<return>([^<]*)<\/return>/.exec(text);
    const tokenM = /<token>([^<]*)<\/token>/.exec(text);
    if (!ret || ret[1] !== '0' || !tokenM || !tokenM[1]) {
      throw new Error(`yun139: token refresh failed (return=${ret?.[1] ?? 'n/a'})`);
    }
    this.token = tokenM[1];
    this.authorization = btoa(`pc:${this.account}:${this.token}`);
    this.parseExpiry(this.token);
  }

  /** 获取个人云 API 域名（PersonalCloudHost），首次调用时经路由接口探测并缓存 */
  private async ensureHost(): Promise<string> {
    if (this.host) return this.host;
    const ts = formatTime(new Date());
    const rand = randomString(16);
    const bodyStr = JSON.stringify({
      userInfo: { userType: 1, accountType: 1, accountName: this.account },
      modAddrType: 1,
    });
    const res = await fetch(ROUTE_URL, {
      method: 'POST',
      headers: this.buildHeaders(bodyStr, ts, rand),
      body: bodyStr,
    });
    if (!res.ok) {
      throw new Error(`yun139: route request failed with ${res.status}`);
    }
    const json = (await res.json()) as BaseResp & { data?: { routePolicyList?: RoutePolicy[] } };
    const policy = (json.data?.routePolicyList ?? []).find(
      (i) => i.modName === 'personal' && !!i.httpsUrl
    );
    if (!policy?.httpsUrl) {
      throw new Error('yun139: PersonalCloudHost not found');
    }
    this.host = policy.httpsUrl.replace(/\/+$/, '');
    return this.host;
  }

  // -------------------------------------------------------------------------
  // 请求封装
  // -------------------------------------------------------------------------
  private buildHeaders(bodyStr: string, ts: string, rand: string): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Basic ${this.authorization}`,
      Caller: 'web',
      'Cms-Device': 'default',
      'Content-Type': 'application/json',
      'Mcloud-Channel': '1000101',
      'Mcloud-Client': '10701',
      'Mcloud-Route': '001',
      'Mcloud-Sign': `${ts},${rand},${calSign(bodyStr, ts, rand)}`,
      'Mcloud-Version': '7.14.0',
      'x-DeviceInfo': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||',
      'x-huawei-channelSrc': '10000034',
      'x-inner-ntwk': '2',
      'x-m4c-caller': 'PC',
      'x-m4c-src': '10002',
      'x-SvcType': '1',
      'X-Yun-Api-Version': 'v1',
      'X-Yun-App-Channel': '10000034',
      'X-Yun-Channel-Source': '10000034',
      'X-Yun-Client-Info': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||',
      'X-Yun-Module-Type': '100',
      'X-Yun-Svc-Type': '1',
    };
  }

  /** 通用 POST（JSON），401 时强制刷新 token 重试一次 */
  private async request<T = BaseResp>(pathname: string, data: unknown, retried = false): Promise<T> {
    await this.refreshToken(false);
    const host = await this.ensureHost();
    const ts = formatTime(new Date());
    const rand = randomString(16);
    const bodyStr = JSON.stringify(data ?? {});
    const res = await fetch(host + pathname, {
      method: 'POST',
      headers: this.buildHeaders(bodyStr, ts, rand),
      body: bodyStr,
    });
    if (res.status === 401 && !retried) {
      await this.refreshToken(true);
      return this.request<T>(pathname, data, true);
    }
    if (!res.ok) {
      throw new Error(`yun139: ${pathname} failed with ${res.status}`);
    }
    const json = (await res.json()) as BaseResp;
    if (!json.success) {
      throw new Error(`yun139: ${pathname} error: ${json.message ?? json.code ?? 'unknown'}`);
    }
    return json as unknown as T;
  }

  // -------------------------------------------------------------------------
  // 139 API
  // -------------------------------------------------------------------------
  private async personalGetFiles(fileId: string): Promise<PersonalFileItem[]> {
    const items: PersonalFileItem[] = [];
    let cursor = '';
    do {
      const json = await this.request<
        BaseResp & { data?: { items?: PersonalFileItem[]; nextPageCursor?: string } }
      >('/file/list', {
        imageThumbnailStyleList: ['Small', 'Large'],
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        pageInfo: { pageCursor: cursor, pageSize: 100 },
        parentFileId: fileId,
      });
      items.push(...(json.data?.items ?? []));
      cursor = json.data?.nextPageCursor ?? '';
    } while (cursor);
    return items;
  }

  private async personalGetLink(fileId: string): Promise<string> {
    const json = await this.request<
      BaseResp & { data?: { cdnSwitch?: boolean; cdnUrl?: string; url?: string } }
    >('/file/getDownloadUrl', { fileId });
    const d = json.data ?? {};
    if (d.cdnSwitch && d.cdnUrl) return d.cdnUrl;
    if (d.url) return d.url;
    throw new Error('yun139: no download url');
  }

  // -------------------------------------------------------------------------
  // 路径解析与缓存
  // -------------------------------------------------------------------------
  private async resolveDirId(path: string): Promise<string> {
    if (path === '/' || path === '') return '/';
    const node = await this.resolveNode(path);
    if (!node.isDir) {
      throw new Error(`yun139: not a directory: ${path}`);
    }
    return node.id;
  }

  private async resolveNode(path: string): Promise<ResolveCache> {
    const norm = normalizePath(path);
    const cached = this.resolveCache.get(norm);
    if (cached) return cached;
    if (norm === '/') {
      const root: ResolveCache = { id: '/', isDir: true, size: 0, mtime: Date.now(), etag: 'yun139-root' };
      this.resolveCache.set('/', root);
      return root;
    }
    const parent = parentPath(norm);
    const name = baseName(norm);
    const parentId = await this.resolveDirId(parent);
    const items = await this.personalGetFiles(parentId);
    const item = items.find((i) => i.name === name);
    if (!item) {
      throw new Error(`Not found: ${norm}`);
    }
    const node = this.itemToNode(item);
    this.resolveCache.set(norm, node);
    return node;
  }

  private itemToNode(it: PersonalFileItem): ResolveCache {
    const isDir = it.type === 'folder';
    return {
      id: it.fileId,
      isDir,
      size: isDir ? 0 : it.size,
      mtime: it.updatedAt ? Date.parse(it.updatedAt) : Date.now(),
      etag: it.fileId,
    };
  }

  private itemToStat(it: PersonalFileItem, dir: string): FileStat {
    const isDir = it.type === 'folder';
    const p = joinPath(dir, it.name);
    return {
      name: it.name,
      path: p + (isDir ? '/' : ''),
      isDirectory: isDir,
      size: isDir ? 0 : it.size,
      mtime: it.updatedAt ? Date.parse(it.updatedAt) : Date.now(),
      etag: it.fileId,
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
    const dirId = await this.resolveDirId(path);
    const items = await this.personalGetFiles(dirId);
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
        return { name: '/', path: '/', isDirectory: true, size: 0, mtime: Date.now(), etag: 'yun139-root' };
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
    const url = await this.personalGetLink(node.id);
    const headers: Record<string, string> = {};
    if (range) {
      headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`yun139: download failed with ${res.status}`);
    }
    return res.body;
  }

  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const name = baseName(path);
    const parent = parentPath(path);
    const parentId = await this.resolveDirId(parent);

    const bytes = new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
    const size = bytes.byteLength;
    const sha256 = await sha256Hex(bytes);

    // 构造分片信息（与 OpenList getPartSize 对齐：100MB/片）
    const partCount = Math.max(1, Math.ceil(size / UPLOAD_PART_SIZE));
    const partInfos: Array<{ partNumber: number; partSize: number; parallelHashCtx: { partOffset: number } }> = [];
    for (let i = 0; i < partCount; i++) {
      const offset = i * UPLOAD_PART_SIZE;
      partInfos.push({
        partNumber: i + 1,
        partSize: Math.min(size - offset, UPLOAD_PART_SIZE),
        parallelHashCtx: { partOffset: offset },
      });
    }

    // 1) 创建上传任务（秒传：contentHash 命中 exist=true 直接成功）
    const created = await this.request<BaseResp & { data?: PersonalUploadResp }>('/file/create', {
      contentHash: sha256,
      contentHashAlgorithm: 'SHA256',
      contentType: 'application/octet-stream',
      parallelUpload: false,
      partInfos: partInfos.slice(0, UPLOAD_BATCH),
      size,
      parentFileId: parentId,
      name,
      type: 'file',
      fileRenameMode: 'auto_rename',
    });
    const cdata = created.data ?? {};
    if (cdata.exist) {
      this.invalidate(path);
      return;
    }
    const fileId = cdata.fileId;
    const uploadId = cdata.uploadId;
    if (!fileId || !uploadId) {
      // 无上传地址（罕见）：视为服务端已接收
      this.invalidate(path);
      return;
    }

    // 2) 分片上传（首 100 片地址来自 create，其余经 getUploadUrl 分批获取）
    const uploadParts = async (list: PersonalPartInfo[]): Promise<void> => {
      for (const up of list) {
        const info = partInfos[up.partNumber - 1];
        if (!info || !up.uploadUrl) {
          throw new Error(`yun139: invalid part #${up.partNumber}`);
        }
        const part = bytes.subarray(
          info.parallelHashCtx.partOffset,
          info.parallelHashCtx.partOffset + info.partSize
        );
        const res = await fetch(up.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            Origin: 'https://yun.139.com',
            Referer: 'https://yun.139.com/',
          },
          body: part,
        });
        if (!res.ok) {
          throw new Error(`yun139: upload part #${up.partNumber} failed with ${res.status}`);
        }
      }
    };

    await uploadParts(cdata.partInfos ?? []);
    for (let i = UPLOAD_BATCH; i < partInfos.length; i += UPLOAD_BATCH) {
      const batch = partInfos.slice(i, i + UPLOAD_BATCH);
      const more = await this.request<BaseResp & { data?: PersonalUploadResp }>('/file/getUploadUrl', {
        fileId,
        uploadId,
        partInfos: batch,
      });
      await uploadParts(more.data?.partInfos ?? []);
    }

    // 3) 完成上传（SHA256 校验）
    await this.request('/file/complete', {
      contentHash: sha256,
      contentHashAlgorithm: 'SHA256',
      fileId,
      uploadId,
    });
    this.invalidate(path);
  }

  async remove(path: string): Promise<void> {
    const node = await this.resolveNode(path);
    await this.request('/recyclebin/batchTrash', { fileIds: [node.id] });
    this.invalidate(path);
  }

  async mkdir(path: string): Promise<void> {
    const name = baseName(path);
    const parent = parentPath(path);
    const parentId = await this.resolveDirId(parent);
    await this.request('/file/create', {
      parentFileId: parentId,
      name,
      description: '',
      type: 'folder',
      fileRenameMode: 'force_rename',
    });
    this.invalidate(path);
    this.invalidate(parent);
  }

  async move(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const srcName = baseName(src);
    const dstName = baseName(dst);
    const dstParent = parentPath(dst);
    // 目标名不同 → 先重命名（file/update），再移动到目标父目录
    if (dstName !== srcName) {
      await this.request('/file/update', { fileId: node.id, name: dstName, description: '' });
    }
    const dstParentId = await this.resolveDirId(dstParent);
    await this.request('/file/batchMove', { fileIds: [node.id], toParentFileId: dstParentId });
    this.invalidate(src);
    this.invalidate(dst);
    this.invalidate(dstParent);
  }

  async copy(src: string, dst: string): Promise<void> {
    const node = await this.resolveNode(src);
    const srcName = baseName(src);
    const dstName = baseName(dst);
    const dstParent = parentPath(dst);
    const dstParentId = await this.resolveDirId(dstParent);
    await this.request('/file/batchCopy', { fileIds: [node.id], toParentFileId: dstParentId });
    // batchCopy 不传新名：目标名不同时，在目标目录定位刚复制的同名项并重命名
    if (dstName !== srcName) {
      const items = await this.personalGetFiles(dstParentId);
      const candidates = items.filter((i) => i.name === srcName);
      if (candidates.length > 0) {
        // 列表按 updated_at DESC，刚复制的最靠前
        const target = candidates[0];
        await this.request('/file/update', { fileId: target.fileId, name: dstName, description: '' });
      }
    }
    this.invalidate(dstParent);
    this.invalidate(dst);
  }
}

// ===========================================================================
// 辅助
// ===========================================================================

/** OpenList calSign：URL 编码 → 字符排序 → base64 → MD5 拼接 → MD5 大写 */
function calSign(body: string, ts: string, randStr: string): string {
  let b = encodeURIComponent(body);
  // 与 Go 的 encodeURIComponent 对齐（QueryEscape 后还原 !'()*）
  b = b.replace(/%21/g, '!').replace(/%27/g, "'").replace(/%28/g, '(').replace(/%29/g, ')').replace(/%2A/g, '*');
  const sorted = [...b].sort().join('');
  const enc = btoa(sorted);
  const res = md5hex(enc) + md5hex(`${ts}:${randStr}`);
  return md5hex(res).toUpperCase();
}

function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const RAND_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomString(n: number): string {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < n; i++) s += RAND_CHARS[arr[i] % RAND_CHARS.length];
  return s;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

// ===========================================================================
// MD5（纯 TS 实现，供 mcloud-sign 签名；WebCrypto 不支持 MD5）
// ===========================================================================
function md5hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const out = md5(bytes);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
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

export default Yun139Driver;
