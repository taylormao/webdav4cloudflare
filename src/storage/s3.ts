/**
 * S3 兼容对象存储驱动（含 Cloudflare R2）
 *
 * 两种模式：
 *   1. r2 模式：存在 R2 binding 且未配置 S3 凭据时，直接使用 R2Bucket API（零配置、最快）
 *   2. s3 模式：配置 S3 endpoint + 凭据时，使用手写 AWS SigV4 REST 客户端（兼容任意 S3 服务）
 *
 * 目录模型：对象键以 "/" 结尾的空对象作为目录 marker；list 使用 delimiter="/" 模拟层级。
 */
import type { S3Config } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { fromKey, trimSlashes, parentPath, baseName } from '../utils/path';

export class S3Driver implements StorageDriver {
  readonly type = 's3';
  private mode: 'r2' | 's3';
  private r2: R2Bucket | null = null;
  private client: S3RestClient | null = null;

  constructor(private cfg: S3Config, r2?: R2Bucket) {
    if (r2 && !cfg.accessKeyId) {
      this.mode = 'r2';
      this.r2 = r2;
    } else {
      this.mode = 's3';
      this.client = new S3RestClient(cfg);
    }
  }

  // ---------- list ----------
  async list(path: string): Promise<ListResult> {
    const prefix = toKeyPrefix(path);
    if (this.mode === 'r2') return this.listR2(prefix);
    return this.client!.listObjects(this.cfg.bucket, prefix, '/');
  }

  private async listR2(prefix: string): Promise<ListResult> {
    const entries: FileStat[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.r2!.list({ prefix, delimiter: '/', cursor });
      for (const obj of res.objects) {
        entries.push(r2ObjectToStat(obj.key, obj));
      }
      for (const p of res.delimitedPrefixes) {
        entries.push(markerToStat(p));
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
    return { entries, truncated: false };
  }

  // ---------- stat ----------
  async stat(path: string): Promise<FileStat | null> {
    const key = toKeyStrict(path);
    if (key === '') {
      // 根目录
      return {
        name: '/',
        path: '/',
        isDirectory: true,
        size: 0,
        mtime: Date.now(),
        etag: '"root"',
      };
    }

    if (this.mode === 'r2') {
      // 目录 marker 优先，其次文件对象
      const headDir = await this.r2!.head(key.endsWith('/') ? key : key + '/');
      if (headDir) return r2ObjectToStat(headDir.key, headDir);
      const headFile = await this.r2!.head(key);
      if (headFile) return r2ObjectToStat(headFile.key, headFile);
      return null;
    }

    const c = this.client!;
    const headDir = await c.headObject(this.cfg.bucket, key.endsWith('/') ? key : key + '/');
    if (headDir) return s3HeadToStat(headDir);
    const headFile = await c.headObject(this.cfg.bucket, key);
    if (headFile) return s3HeadToStat(headFile);
    return null;
  }

  // ---------- read ----------
  async read(path: string, range?: Range): Promise<ReadableStream | null> {
    const key = toKeyStrict(path);
    if (!key) return null;

    if (this.mode === 'r2') {
      const opts: R2GetOptions = {};
      if (range) {
        opts.range = { offset: range.offset, length: range.length };
      }
      const obj = await this.r2!.get(key, opts);
      if (!obj) return null;
      return obj.body;
    }

    return this.client!.getObject(this.cfg.bucket, key, range);
  }

  // ---------- write ----------
  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    const key = toKeyStrict(path);
    if (this.mode === 'r2') {
      await this.r2!.put(key, body, {
        httpMetadata: opts?.contentType
          ? { contentType: opts.contentType }
          : undefined,
      });
      return;
    }
    await this.client!.putObject(this.cfg.bucket, key, body, opts?.contentType);
  }

  // ---------- remove ----------
  async remove(path: string): Promise<void> {
    const key = toKeyStrict(path);
    const c = this.mode === 'r2' ? null : this.client!;

    // 目录：递归列出所有对象并删除
    if (path.endsWith('/') || (await this.isDirKey(key))) {
      const prefix = key.endsWith('/') ? key : key + '/';
      const keys: string[] = [];
      if (this.mode === 'r2') {
        let cursor: string | undefined;
        do {
          const res = await this.r2!.list({ prefix });
          for (const o of res.objects) keys.push(o.key);
          cursor = res.truncated ? res.cursor : undefined;
        } while (cursor);
      } else {
        const listed = await c!.listAllObjects(this.cfg.bucket, prefix);
        keys.push(...listed);
      }
      // 目录 marker 本身
      if (prefix !== key) keys.unshift(key);
      await this.deleteKeys(keys);
      return;
    }

    await this.deleteKeys([key]);
  }

  private async isDirKey(key: string): Promise<boolean> {
    if (key.endsWith('/')) return true;
    if (this.mode === 'r2') {
      const head = await this.r2!.head(key + '/');
      return !!head;
    }
    const head = await this.client!.headObject(this.cfg.bucket, key + '/');
    return !!head;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    // R2 binding 无批量删除，逐个删除
    for (const k of keys) {
      if (this.mode === 'r2') {
        await this.r2!.delete(k);
      } else {
        await this.client!.deleteObject(this.cfg.bucket, k);
      }
    }
  }

  // ---------- mkdir ----------
  async mkdir(path: string): Promise<void> {
    const key = toKeyStrict(path);
    if (!key) return;
    const marker = key.endsWith('/') ? key : key + '/';
    if (this.mode === 'r2') {
      await this.r2!.put(marker, new Uint8Array(0), { httpMetadata: { contentType: 'application/x-directory' } });
    } else {
      await this.client!.putObject(this.cfg.bucket, marker, new Uint8Array(0), 'application/x-directory');
    }
  }

  // ---------- move / copy ----------
  async move(src: string, dst: string): Promise<void> {
    await this.copy(src, dst);
    await this.remove(src);
  }

  async copy(src: string, dst: string): Promise<void> {
    const srcKey = toKeyStrict(src);
    const dstKey = toKeyStrict(dst);
    const srcIsDir = src.endsWith('/') || (await this.isDirKey(srcKey));

    if (!srcIsDir) {
      await this.copyOne(srcKey, dstKey);
      return;
    }

    // 目录递归复制
    const prefix = srcKey.endsWith('/') ? srcKey : srcKey + '/';
    const pairs: Array<{ from: string; to: string }> = [];

    if (this.mode === 'r2') {
      let cursor: string | undefined;
      do {
        const res = await this.r2!.list({ prefix });
        for (const o of res.objects) {
          pairs.push({ from: o.key, to: dstKey + o.key.slice(prefix.length) });
        }
        // marker 目录本身
        if (res.objects.length === 0 && res.delimitedPrefixes.length === 0 && !pairs.length) {
          // 空目录：复制 marker
        }
        cursor = res.truncated ? res.cursor : undefined;
      } while (cursor);
    } else {
      const keys = await this.client!.listAllObjects(this.cfg.bucket, prefix);
      for (const k of keys) {
        pairs.push({ from: k, to: dstKey + k.slice(prefix.length) });
      }
    }

    // 目录 marker 本身
    pairs.push({ from: prefix, to: dstKey.endsWith('/') ? dstKey : dstKey + '/' });

    for (const p of pairs) {
      await this.copyOne(p.from, p.to);
    }
  }

  private async copyOne(fromKey: string, toKey: string): Promise<void> {
    if (this.mode === 'r2') {
      const obj = await this.r2!.get(fromKey);
      if (!obj) throw new Error(`copy source not found: ${fromKey}`);
      await this.r2!.put(toKey, obj.body, { httpMetadata: obj.httpMetadata });
      return;
    }
    await this.client!.copyObject(this.cfg.bucket, fromKey, toKey);
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 目录路径 → 对象前缀（含尾部 /） */
function toKeyPrefix(path: string): string {
  if (path === '/') return '';
  const t = trimSlashes(path);
  return t + '/';
}

/** 路径 → 对象键（文件不带尾 /，目录带尾 /） */
function toKeyStrict(path: string): string {
  if (path === '/') return '';
  return path.startsWith('/') ? path.slice(1) : path;
}

function r2ObjectToStat(key: string, obj: R2ObjectBody | R2Object): FileStat {
  const isDir = key.endsWith('/');
  return {
    name: baseName(fromKey(key)) || key,
    path: fromKey(key) + (isDir ? '/' : ''),
    isDirectory: isDir,
    size: obj.size,
    mtime: obj.uploaded?.getTime() ?? Date.now(),
    etag: typeof obj.etag === 'string' ? `"${obj.etag}"` : undefined,
    contentType: obj.httpMetadata?.contentType,
  };
}

function markerToStat(prefix: string): FileStat {
  return {
    name: baseName('/' + prefix),
    path: '/' + prefix,
    isDirectory: true,
    size: 0,
    mtime: Date.now(),
  };
}

interface HeadResult {
  key: string;
  size: number;
  mtime: number;
  etag?: string;
  contentType?: string;
}

function s3HeadToStat(h: HeadResult): FileStat {
  const isDir = h.key.endsWith('/');
  return {
    name: baseName(fromKey(h.key)),
    path: fromKey(h.key) + (isDir ? '/' : ''),
    isDirectory: isDir,
    size: h.size,
    mtime: h.mtime,
    etag: h.etag,
    contentType: h.contentType,
  };
}

// ---------------------------------------------------------------------------
// 手写 AWS SigV4 S3 REST 客户端（fetch 实现，无 SDK 依赖）
// ---------------------------------------------------------------------------

class S3RestClient {
  private endpoint: URL;

  constructor(private cfg: S3Config) {
    this.endpoint = new URL(cfg.endpoint);
  }

  async listObjects(bucket: string, prefix: string, delimiter: string): Promise<ListResult> {
    const entries: FileStat[] = [];
    let token: string | undefined;
    do {
      const qs = new URLSearchParams({
        'list-type': '2',
        prefix,
        delimiter,
        'max-keys': '1000',
      });
      if (token) qs.set('continuation-token', token);
      const res = await this.request('GET', bucket, '', qs, null);
      const xml = await res.text();
      // 解析 Contents / CommonPrefixes（轻量正则）
      const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = contentRe.exec(xml)) !== null) {
        const key = tagValue(m[1], 'Key');
        const size = parseInt(tagValue(m[1], 'Size') || '0', 10);
        const lastMod = tagValue(m[1], 'LastModified') || '';
        entries.push({
          name: baseName('/' + key),
          path: '/' + key,
          isDirectory: false,
          size,
          mtime: lastMod ? new Date(lastMod).getTime() : Date.now(),
        });
      }
      const prefixRe = /<CommonPrefixes>[\s\S]*?<Prefix>([^<]*)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
      while ((m = prefixRe.exec(xml)) !== null) {
        const p = m[1];
        entries.push({
          name: baseName('/' + p),
          path: '/' + p,
          isDirectory: true,
          size: 0,
          mtime: Date.now(),
        });
      }
      token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    } while (token);
    return { entries, truncated: false };
  }

  async listAllObjects(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const qs = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
      if (token) qs.set('continuation-token', token);
      const res = await this.request('GET', bucket, '', qs, null);
      const xml = await res.text();
      const re = /<Key>([^<]*)<\/Key>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) keys.push(m[1]);
      token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    } while (token);
    return keys;
  }

  async headObject(bucket: string, key: string): Promise<HeadResult | null> {
    const res = await this.request('HEAD', bucket, key, null, null);
    if (res.status === 404 || res.status === 403) return null;
    return {
      key,
      size: parseInt(res.headers.get('content-length') ?? '0', 10),
      mtime: parseHttpDate(res.headers.get('last-modified')) ?? Date.now(),
      etag: res.headers.get('etag') ?? undefined,
      contentType: res.headers.get('content-type') ?? undefined,
    };
  }

  async getObject(bucket: string, key: string, range?: Range): Promise<ReadableStream | null> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const res = await this.request('GET', bucket, key, null, headers);
    if (res.status === 404) return null;
    if (res.body) return res.body;
    return null;
  }

  async putObject(bucket: string, key: string, body: BodyInit, contentType?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (contentType) headers['Content-Type'] = contentType;
    const res = await this.request('PUT', bucket, key, null, headers, body);
    if (res.status >= 400) throw new Error(`S3 put failed: ${res.status} ${await res.text()}`);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const res = await this.request('DELETE', bucket, key, null, null);
    if (res.status >= 400) throw new Error(`S3 delete failed: ${res.status} ${await res.text()}`);
  }

  async copyObject(bucket: string, fromKey: string, toKey: string): Promise<void> {
    const headers: Record<string, string> = {
      'x-amz-copy-source': `/${bucket}/${encodeURIComponent(fromKey)}`,
    };
    const res = await this.request('PUT', bucket, toKey, null, headers);
    if (res.status >= 400) throw new Error(`S3 copy failed: ${res.status} ${await res.text()}`);
  }

  /** 统一请求入口：构造 URL + SigV4 签名 + fetch */
  private async request(
    method: string,
    bucket: string,
    key: string,
    qs: URLSearchParams | null,
    extraHeaders: Record<string, string> | null,
    body?: BodyInit | null
  ): Promise<Response> {
    const url = new URL(this.endpoint);
    if (this.cfg.forcePathStyle) {
      url.pathname = '/' + bucket + (key ? '/' + encodeKey(key) : '');
    } else {
      url.hostname = bucket + '.' + this.endpoint.hostname;
      if (key) url.pathname = '/' + encodeKey(key);
    }
    if (qs) url.search = qs.toString();

    const headers: Record<string, string> = {
      host: url.host,
      ...(extraHeaders ?? {}),
    };

    await this.sign(method, url, headers, body);

    return fetch(url.toString(), { method, headers, body: body ?? undefined });
  }

  /** AWS Signature V4 签名 */
  private async sign(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body?: BodyInit | null
  ): Promise<void> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';

    const region = this.cfg.region || 'auto';
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const canonicalHeaders = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort()
      .map((k) => `${k}:${headers[k].trim()}\n`)
      .join('');

    const signedHeaders = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort()
      .join(';');

    const canonicalRequest = [
      method,
      url.pathname,
      url.search,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const hash = await sha256Hex(canonicalRequest);
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hash,
    ].join('\n');

    const kDate = await hmac(dateStamp, `AWS4${this.cfg.secretAccessKey}`);
    const kRegion = await hmac(region, kDate);
    const kService = await hmac('s3', kRegion);
    const kSigning = await hmac('aws4_request', kService);
    const signature = toHex(await hmac(stringToSign, kSigning));

    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }
}

// ---------------------------------------------------------------------------
// SigV4 辅助
// ---------------------------------------------------------------------------

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(new Uint8Array(buf));
}

async function hmac(data: string, key: ArrayBuffer | string): Promise<ArrayBuffer> {
  const keyBuf =
    typeof key === 'string' ? new TextEncoder().encode(key) : (key as ArrayBuffer);
  return crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  ).then((k) => crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseHttpDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function encodeKey(key: string): string {
  return key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function tagValue(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1] : '';
}
