/**
 * WebDAV Cloud Drive — 入口文件（多存储虚拟根分区）
 *
 * 职责：
 *   1. 装配环境配置（config.ts）与多存储驱动（storage/registry.ts createDrivers）
 *   2. 挂载 Hono 应用：Web UI 重定向 / 管理 API / WebDAV 路由
 *   3. 接入 Basic Auth（OPTIONS 匿名放行以兼容客户端探测）
 *   4. D1 请求日志中间件（方法/路径/状态码/耗时/存储后端）
 *   5. 多存储虚拟根分区：根路径列出各已装配驱动分区（/<driver>/…），
 *      单驱动时兼容无前缀根路径直接映射
 *
 * 路由约定：
 *   - /           → 302 到 /ui/（Web UI 由 wrangler.toml [assets] 静态托管，不经 Worker）
 *   - /api/logs   → 请求日志查询（GET，需认证）
 *   - /api/download → 流式下载存储文件（GET，需认证；支持 Range）
 *   - /api/preview → 在线预览（GET，需认证；inline 返回，支持 Range 与 auth query）
 *   - /api/settings → 驱动/日志配置概要（GET，需认证；含 mountedDrivers 挂载列表）
 *   - 其余路径   → WebDAV 协议层分发（按路径首段路由到对应驱动）
 */
import { Hono } from 'hono';
import { buildConfig, driverConfigured, type AppConfig } from './config';
import {
  KV_DRIVER_KEYS,
  DRIVER_FIELD_SCHEMAS,
  readKvDriverConfig,
  sanitizeDriverConfig,
  applyDriverConfigPatch,
  missingRequiredFields,
} from './kv-config';
import { createDrivers, type DriverEnv } from './storage/registry';
import { requireAuth, requireAuthFlexible } from './auth';
import { handleAuthApi, parseAuthPath } from './auth/index';
import { normalizePath, baseName } from './utils/path';
import { dispatch } from './webdav/router';
import { buildOptionsResponse } from './webdav/options';
import { parseRange } from './webdav/get';
import { buildMultistatus } from './utils/xml';
import { buildResponse, defaultEtag } from './webdav/responses';
import { nativeExportMime } from './storage/gdrive';
import { D1Logger } from './log/d1logger';
import type { Context } from 'hono';
import type { DavContext } from './types';
import type { StorageDriver, FileStat } from './storage/types';

export interface Env extends DriverEnv {
  DAV_USER?: string;
  DAV_PASS?: string;
  STORAGE_TYPE?: string;
  LOG_ENABLED?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.all('*', async (c) => {
  const start = Date.now();
  // 异步装配：env 兜底 + DRIVER_CONFIG KV 用户配置优先（保存后无需重部署即生效）
  const config: AppConfig = await buildConfig(c.env, c.env.DRIVER_CONFIG);
  const logger = new D1Logger(c.env.LOGS_DB, config.log);

  const method = c.req.method;
  const url = new URL(c.req.url);
  const rawPath = url.pathname;

  // ------------------------------------------------------------------
  // 0) Web UI 入口重定向（静态资源本身由 [assets] 托管）
  // ------------------------------------------------------------------
  if (method === 'GET' && (rawPath === '/' || rawPath === '/ui' || rawPath === '/ui/')) {
    return c.redirect('/ui/', 302);
  }

  // ------------------------------------------------------------------
  // 1) 管理 API（均需认证）
  // ------------------------------------------------------------------
  if (rawPath.startsWith('/api/')) {
    const authed = await requireAuth(c, config.auth);
    if (!authed) {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="WebDAV Cloud Drive"',
      });
    }

    // 管理 API 使用的路径一律带驱动分区前缀（/api/download?path=/gdrive/xxx）
    const drivers = createDrivers(config, c.env);
    try {
      let res: Response;
      // 自动登录获取凭据服务：/api/auth/<driver>/<action>（登录框架，AUTH_PROVIDERS 注册表）
      const authRoute = parseAuthPath(rawPath);
      if (authRoute) {
        res = await handleAuthApi(c, authRoute);
        finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: config.storageType });
        return res;
      }
      switch (rawPath) {
        case '/api/logs': {
          const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
          const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
          const m = url.searchParams.get('method') ?? undefined;
          const s = url.searchParams.get('status');
          const status = s === null ? undefined : parseInt(s, 10);
          const page = await logger.query({ limit, offset, method: m, status });
          res = c.json({ enabled: logger.enabled, ...(page ?? { total: 0, entries: [] }) });
          break;
        }
        case '/api/download': {
          res = await handleApiStream(c, drivers, url, { disposition: 'attachment' });
          break;
        }
        case '/api/preview': {
          res = await handleApiStream(c, drivers, url, { disposition: 'inline' });
          break;
        }
        case '/api/settings': {
          res = c.json(buildSettings(config, drivers));
          break;
        }
        case '/api/config': {
          res = await handleConfigApi(c, config);
          break;
        }
        default:
          res = c.json({ error: 'Not found' }, 404);
      }
      finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: config.storageType });
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[api] ${method} ${rawPath} failed:`, e);
      const res = c.text(`Internal error: ${msg}`, 500);
      finishLog(c, logger, { method, path: rawPath, status: 500, durationMs: Date.now() - start, storage: config.storageType });
      return res;
    }
  }

  // ------------------------------------------------------------------
  // 2) WebDAV 协议层
  // ------------------------------------------------------------------
  if (method !== 'OPTIONS') {
    const authed = await requireAuth(c, config.auth);
    if (!authed) {
      const res = c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="WebDAV Cloud Drive"',
      });
      finishLog(c, logger, { method, path: rawPath, status: 401, durationMs: Date.now() - start, storage: config.storageType });
      return res;
    }
  }

  // OPTIONS：协议能力协商（匿名放行，不依赖具体驱动）
  if (method === 'OPTIONS') {
    const res = buildOptionsResponse();
    finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: 'root' });
    return res;
  }

  const drivers = createDrivers(config, c.env);
  const resolved = resolveRequestPath(rawPath, drivers);

  // 虚拟根：仅 PROPFIND 可列出各驱动分区
  if (resolved.virtualRoot) {
    if (method !== 'PROPFIND') {
      const res = c.text('Method Not Allowed on virtual root', 405);
      finishLog(c, logger, { method, path: rawPath, status: 405, durationMs: Date.now() - start, storage: 'root' });
      return res;
    }
    const res = await handleVirtualRootPropfind(c, drivers);
    finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: 'root' });
    return res;
  }

  // 分区首段未命中任何已装配驱动（多驱动模式访问未知分区）→ 404
  if (resolved.storage === null) {
    const res = c.text('Not found', 404);
    finishLog(c, logger, { method, path: rawPath, status: 404, durationMs: Date.now() - start, storage: 'root' });
    return res;
  }

  // 经上述 null 校验，此处 resolved.storage 必然为已装配驱动
  const activeStorage = resolved.storage as StorageDriver;
  const ctx: DavContext = {
    request: c.req,
    env: c.env,
    config,
    storage: activeStorage,
    drivers,
    storageType: resolved.driverName,
    virtualRoot: false,
    path: resolved.path,
    resolveInnerPath: (externalPath: string): string | null =>
      resolveInnerPath(externalPath, drivers, activeStorage),
  };

  try {
    const res = await dispatch(ctx);
    finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: config.storageType });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[webdav] ${method} ${resolved.path} failed:`, e);
    const res = c.text(`Internal error: ${msg}`, 500);
    finishLog(c, logger, { method, path: rawPath, status: 500, durationMs: Date.now() - start, storage: config.storageType });
    return res;
  }
});

/** 异步落日志（waitUntil 后台执行，不阻塞响应） */
function finishLog(
  c: ContextLike,
  logger: D1Logger,
  entry: { method: string; path: string; status: number; durationMs: number; storage: string }
): void {
  if (!logger.enabled) return;
  c.executionCtx.waitUntil(logger.log(entry));
}

/** 最小上下文类型（仅需 waitUntil），避免与 Hono 类型耦合过深 */
interface ContextLike {
  executionCtx: { waitUntil(p: Promise<unknown>): void };
}

function clampInt(v: string | null, dft: number, min: number, max: number): number {
  const n = parseInt(v ?? '', 10);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

/** 配置概要（不泄露密钥原文，仅标记是否已配置；含 mountedDrivers 挂载列表） */
function buildSettings(config: AppConfig, drivers: Map<string, StorageDriver>): Record<string, unknown> {
  const flag = (v: string) => (v ? true : false);
  return {
    storageType: config.storageType,
    auth: { configured: !!(config.auth.user && config.auth.pass) },
    logging: { enabled: config.log.enabled, table: config.log.table },
    mountedDrivers: {
      list: [...drivers.keys()],
      count: drivers.size,
      singleDriverCompat: drivers.size === 1 ? [...drivers.keys()][0] : null,
      note: drivers.size === 0 ? '未配置任何存储驱动，根目录为空' : '',
    },
    drivers: Object.fromEntries(
      KV_DRIVER_KEYS.map((k) => [k, { configured: driverConfigured(k, config) }])
    ),
  };
}

// ===========================================================================
// Web UI 自助配置存储服务（/api/config）
// ===========================================================================

/** 驱动类型判断（限定为已知驱动，拒绝未知类型） */
function isKnownDriver(type: string | null): type is import('./config').StorageType {
  return !!type && (KV_DRIVER_KEYS as string[]).includes(type);
}

/**
 * /api/config 管理路由（已位于 /api/* 分支，requireAuth 401 已在入口统一处理）：
 *   GET            → 全驱动脱敏元数据（字段级 set/source，不回显明文）
 *   PUT/POST ?type → 保存某驱动配置（可部分更新；校验未知驱动/非空/类型/完整度）
 *   DELETE ?type   → 清除该驱动的 KV 配置（回退 env 兜底）
 */
async function handleConfigApi(c: Context<{ Bindings: Env }>, config: AppConfig): Promise<Response> {
  const kv = c.env.DRIVER_CONFIG;
  const method = c.req.method;
  const url = new URL(c.req.url);
  const type = url.searchParams.get('type');

  if (method === 'GET') {
    return c.json({ drivers: await buildDriverConfigSummary(config, kv) });
  }

  if (!isKnownDriver(type)) {
    return c.json(
      { error: `未知驱动类型：${type ?? '(空)'}，可选：${KV_DRIVER_KEYS.join(' / ')}` },
      400
    );
  }
  const t = type;

  if (method === 'DELETE') {
    if (!kv) return c.json({ error: 'DRIVER_CONFIG KV 未绑定，无法清除配置' }, 500);
    await kv.delete(t);
    return c.json({ ok: true, removed: true, type: t });
  }

  if (method !== 'PUT' && method !== 'POST') {
    return c.json({ error: 'Method Not Allowed' }, 405);
  }
  if (!kv) return c.json({ error: 'DRIVER_CONFIG KV 未绑定，无法保存配置' }, 500);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求体必须为 JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: '请求体必须为非空 JSON 对象' }, 400);
  }
  const patch = body as Record<string, unknown>;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: '配置不能为空' }, 400);
  }

  // 清洗：仅接受 schema 已知字段，类型错误直接拒绝
  const { value, errors, warnings } = sanitizeDriverConfig(t, patch);
  if (errors.length > 0) {
    return c.json({ error: `配置校验失败：${errors.join('；')}` }, 400);
  }
  if (Object.keys(value).length === 0) {
    return c.json({ error: '配置不能为空（仅包含未知字段会被忽略）' }, 400);
  }

  // 合并 KV 现有配置 + 本次 patch，再次清洗后入库（防脏数据）
  const existing = (await readKvDriverConfig(kv, t)) ?? {};
  const merged = { ...existing, ...value };
  const { value: mergedClean, errors: mergeErrors } = sanitizeDriverConfig(t, merged);
  if (mergeErrors.length > 0) {
    return c.json({ error: `合并后配置校验失败：${mergeErrors.join('；')}` }, 400);
  }

  // 完整度检查：required 字段 + 凭据完整性（与 createDrivers 装配口径一致）
  const trial: AppConfig = { ...config };
  const targetKey = t as keyof AppConfig;
  const srcObj = config[targetKey] as unknown as Record<string, unknown>;
  (trial as unknown as Record<string, Record<string, unknown>>)[targetKey] = { ...srcObj };
  applyDriverConfigPatch(trial, t, mergedClean);

  const missing = missingRequiredFields(t, trial);
  if (missing.length > 0) {
    return c.json({ error: `缺少必填字段：${missing.join(', ')}` }, 400);
  }
  if (!driverConfigured(t, trial)) {
    return c.json(
      {
        error:
          t === 'dropbox'
            ? 'Dropbox 需要 accessToken，或 refreshToken + appKey + appSecret 三件套'
            : '该驱动凭据仍不完整，无法启用',
      },
      400
    );
  }

  await kv.put(t, JSON.stringify(mergedClean));
  return c.json({ ok: true, type: t, warnings });
}

/** /api/config GET：驱动配置脱敏元数据（只回显 set/source，严禁回显明文凭据） */
async function buildDriverConfigSummary(
  config: AppConfig,
  kv: KVNamespace | undefined
): Promise<Record<string, unknown>> {
  const drivers: Record<string, unknown> = {};
  for (const type of KV_DRIVER_KEYS) {
    const kvObj = kv ? await readKvDriverConfig(kv, type) : null;
    const current = config[type] as unknown as Record<string, unknown>;
    const fields = DRIVER_FIELD_SCHEMAS[type].map((f) => {
      const hasKv = kvObj !== null && f.name in kvObj;
      const val = hasKv ? kvObj![f.name] : current[f.name];
      const set =
        f.type === 'boolean' ? hasKv || val === true : hasKv || (typeof val === 'string' && val !== '');
      return {
        name: f.name,
        type: f.type,
        required: f.required,
        secret: f.secret,
        set,
        source: hasKv ? 'kv' : set ? 'env' : 'none',
        ...(f.default !== undefined ? { default: f.default } : {}),
        ...(f.hint ? { hint: f.hint } : {}),
      };
    });
    drivers[type] = {
      configured: driverConfigured(type, config),
      source:
        kvObj !== null && Object.keys(kvObj).length > 0
          ? 'kv'
          : driverConfigured(type, config)
            ? 'env'
            : 'none',
      fields,
    };
  }
  return drivers;
}

// ===========================================================================
// 多存储虚拟根分区辅助
// ===========================================================================

interface ResolvedPath {
  /** 路由到的驱动实例；null 表示首段未命中任何已装配驱动 */
  storage: StorageDriver | null;
  /** 驱动类型名（分区名）；虚拟根时为 'root' */
  driverName: string;
  /** 传给驱动/协议层的内部路径（不含分区前缀） */
  path: string;
  /** 是否虚拟根（/） */
  virtualRoot: boolean;
}

/** 解析外部 WebDAV 路径 → 驱动实例 + 内部路径 */
function resolveRequestPath(rawPath: string, drivers: Map<string, StorageDriver>): ResolvedPath {
  const normalized = normalizePath(rawPath);
  const segs = normalized.split('/').filter(Boolean);

  // 虚拟根
  if (segs.length === 0) {
    return { storage: null, driverName: 'root', path: '/', virtualRoot: true };
  }

  // 首段命中已装配驱动 → 分区路由
  const driver = drivers.get(segs[0]);
  if (driver) {
    return {
      storage: driver,
      driverName: segs[0],
      path: '/' + segs.slice(1).join('/'),
      virtualRoot: false,
    };
  }

  // 兼容策略：仅装配一个驱动时，无前缀路径直接映射该驱动（单驱动使用方式）
  if (drivers.size === 1) {
    const [name, only] = [...drivers.entries()][0];
    return { storage: only, driverName: name, path: normalized, virtualRoot: false };
  }

  // 多驱动模式访问未知分区首段
  return { storage: null, driverName: '', path: normalized, virtualRoot: false };
}

/** 解析管理 API 的 path 参数（须带分区前缀） → 驱动实例 + 内部路径 */
function resolveApiPath(
  p: string,
  drivers: Map<string, StorageDriver>
): { storage: StorageDriver; path: string } | null {
  const np = normalizePath(p);
  const segs = np.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  const driver = drivers.get(segs[0]);
  if (driver) return { storage: driver, path: '/' + segs.slice(1).join('/') };
  // 单驱动兼容：无前缀路径直接映射唯一驱动
  if (drivers.size === 1) {
    const [, only] = [...drivers.entries()][0];
    return { storage: only, path: np };
  }
  return null;
}

/** MOVE/COPY Destination 解析：仅允许同驱动内部路径，跨驱动返回 null */
function resolveInnerPath(
  externalPath: string,
  drivers: Map<string, StorageDriver>,
  current: StorageDriver
): string | null {
  const np = normalizePath(externalPath);
  const segs = np.split('/').filter(Boolean);
  if (segs.length === 0) return null; // 目标为根不允许移动/复制到根
  const driver = drivers.get(segs[0]);
  if (driver) {
    if (driver !== current) return null; // 跨驱动禁止
    return '/' + segs.slice(1).join('/');
  }
  // 单驱动兼容：无前缀路径按唯一驱动解析
  if (drivers.size === 1) {
    const [, only] = [...drivers.entries()][0];
    if (only !== current) return null;
    return np;
  }
  return null;
}

/** 虚拟根 PROPFIND：返回各已装配驱动分区目录（Depth 0/1） */
async function handleVirtualRootPropfind(
  c: Context<{ Bindings: Env }>,
  drivers: Map<string, StorageDriver>
): Promise<Response> {
  const depthHeader = c.req.header('depth') ?? 'infinity';
  const now = Date.now();
  const rootStat: FileStat = { name: '/', path: '/', isDirectory: true, size: 0, mtime: now };
  const responses: string[] = [buildResponse('/', rootStat, 'all', defaultEtag(rootStat))];

  if (depthHeader === '1' || depthHeader === 'infinity') {
    for (const name of drivers.keys()) {
      const dirName = name + '/';
      const stat: FileStat = { name: dirName, path: dirName, isDirectory: true, size: 0, mtime: now };
      responses.push(buildResponse(encodeHref(dirName), stat, 'all', defaultEtag(stat)));
    }
  }

  return new Response(buildMultistatus(responses.join('')), {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'DAV': '1, 2' },
  });
}

/** /api/download 与 /api/preview 的通用流式响应 */
async function handleApiStream(
  c: Context<{ Bindings: Env }>,
  drivers: Map<string, StorageDriver>,
  url: URL,
  opts: { disposition: 'attachment' | 'inline' }
): Promise<Response> {
  const p = url.searchParams.get('path');
  if (!p) return c.text('Missing path param', 400);
  const api = resolveApiPath(p, drivers);
  if (!api) return c.text('Not found', 404);
  const { storage, path } = api;
  if (path === '/' || path.endsWith('/')) return c.text('Not a file', 400);

  const stat = await storage.stat(path);
  if (!stat || stat.isDirectory) return c.text('Not found', 404);

  const range = parseRange(c.req.header('range'), stat.size);
  let stream: ReadableStream | null;
  try {
    stream = await storage.read(path, range ?? undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('Not found')) return c.text('Not found', 404);
    throw e;
  }
  if (stream === null) return c.text('Not found', 404);

  // Google 原生格式（doc/sheet/...）：read() 已自动导出，Content-Type 用导出 MIME
  let contentType = stat.contentType ?? guessMime(path) ?? 'application/octet-stream';
  if (stat.contentType && stat.contentType.startsWith('application/vnd.google-apps.')) {
    contentType = nativeExportMime(stat.contentType, path);
  }

  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  });
  if (opts.disposition === 'attachment') {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`);
  }

  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(stream, { status: 206, headers });
  }

  // 文本预览截断：inline 且为文本类内容时最多返回 500KB，超出附加 X-Preview-Truncated 提示
  if (opts.disposition === 'inline' && isTextContent(contentType, path)) {
    const { bytes, truncated } = await readUpTo(stream, PREVIEW_TEXT_MAX);
    headers.set('Content-Length', String(bytes.byteLength));
    if (truncated) headers.set('X-Preview-Truncated', '1');
    return new Response(bytes, { status: 200, headers });
  }

  if (stat.size > 0) headers.set('Content-Length', String(stat.size));
  return new Response(stream, { status: 200, headers });
}

/** 文本预览截断阈值（前 500KB） */
const PREVIEW_TEXT_MAX = 500 * 1024;
const PREVIEW_TEXT_EXTS = new Set([
  'md', 'txt', 'json', 'js', 'py', 'html', 'htm', 'xml', 'csv', 'log', 'ini', 'yaml', 'yml',
  'ts', 'java', 'c', 'cpp', 'go', 'rs',
]);

/** 扩展名 → MIME 推断（stat 无 contentType 时兜底，供预览/下载使用） */
function guessMime(path: string): string | undefined {
  const i = path.lastIndexOf('.');
  if (i < 0) return undefined;
  const ext = path.slice(i + 1).toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    m4v: 'video/x-m4v', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    flac: 'audio/flac', opus: 'audio/opus', aac: 'audio/aac',
    md: 'text/markdown', txt: 'text/plain', json: 'application/json',
    js: 'text/javascript', py: 'text/x-python', html: 'text/html', htm: 'text/html',
    xml: 'application/xml', csv: 'text/csv', log: 'text/plain', ini: 'text/plain',
    yaml: 'text/yaml', yml: 'text/yaml', ts: 'text/plain', java: 'text/plain',
    c: 'text/plain', cpp: 'text/plain', go: 'text/plain', rs: 'text/plain',
    zip: 'application/zip', ipynb: 'application/x-ipynb+json',
  };
  return map[ext];
}
/** 判断是否为文本类内容（预览截断用） */
function isTextContent(contentType: string, path: string): boolean {
  if (contentType.startsWith('text/')) return true;
  const i = path.lastIndexOf('.');
  const ext = i < 0 ? '' : path.slice(i + 1).toLowerCase();
  return PREVIEW_TEXT_EXTS.has(ext);
}

/** 从流中读取至多 maxBytes；超过则截断并返回 truncated=true */
async function readUpTo(
  stream: ReadableStream,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const need = maxBytes - total;
      if (need <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (value.byteLength > need) {
        chunks.push(value.subarray(0, need));
        total += need;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, truncated };
}

/** URL 编码 href（保留 /） */
function encodeHref(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export default app;
