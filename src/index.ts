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
import { fetchUpstreamGuarded } from './utils/upstream';
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
  //    auth query（base64(user:pass)）优先：<video>/<audio>/<img>/<iframe> 等
  //    标签加载子资源时无法附加 Authorization 头，只能靠 query 传凭据。
  // ------------------------------------------------------------------
  if (rawPath.startsWith('/api/')) {
    const authed = await requireAuthFlexible(c, config.auth, url.searchParams.get('auth'));
    if (!authed) {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="WebDAV Cloud Drive"',
      });
    }

    // 管理 API 使用的路径一律带驱动分区前缀（/api/download?path=/gdrive/xxx）
    const drivers = createDrivers(config, c.env);
    // 日志归因：按 path 参数解析真实驱动名，避免统一记成主存储类型
    const apiStorageLabel = resolveApiStorageLabel(url, drivers, config.storageType);
    try {
      let res: Response;
      // 自动登录获取凭据服务：/api/auth/<driver>/<action>（登录框架，AUTH_PROVIDERS 注册表）
      const authRoute = parseAuthPath(rawPath);
      if (authRoute) {
        res = await handleAuthApi(c, authRoute);
        finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: apiStorageLabel });
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
        case '/api/stream': {
          // 媒体内联中继：重写上游 Content-Disposition/CORS，供 <video>/<audio> 直接播放
          res = await handleInlineRelay(c, drivers, url);
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
      finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: apiStorageLabel });
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[api] ${method} ${rawPath} failed:`, e);
      const res = c.text(`Internal error: ${msg}`, 500);
      finishLog(c, logger, { method, path: rawPath, status: 500, durationMs: Date.now() - start, storage: apiStorageLabel });
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
    finishLog(c, logger, { method, path: rawPath, status: res.status, durationMs: Date.now() - start, storage: resolved.driverName });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[webdav] ${method} ${resolved.path} failed:`, e);
    const res = c.text(`Internal error: ${msg}`, 500);
    finishLog(c, logger, { method, path: rawPath, status: 500, durationMs: Date.now() - start, storage: resolved.driverName });
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

/** 管理 API 日志归因：从 path 参数解析出真实驱动分区名（用于修正日志 storage 字段） */
function resolveApiStorageLabel(
  url: URL,
  drivers: Map<string, StorageDriver>,
  fallback: string
): string {
  const p = url.searchParams.get('path');
  if (!p) return fallback;
  const api = resolveApiPath(p, drivers);
  if (!api) return fallback;
  for (const [name, driver] of drivers) {
    if (driver === api.storage) return name;
  }
  return fallback;
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

/** 直连重定向阈值：达到该大小才考虑 302 到上游直链 */
const REDIRECT_MIN_SIZE = 4 * 1024 * 1024;

/**
 * 是否对本次请求返回 302 直链。
 * - 文本预览需在 Worker 侧截断，不能直连
 * - 媒体（video/audio）在 preview 下自动直连：浏览器会持续发 Range，代理每次都要重新回源，体验极差
 * - 其他类型（PDF/图片/压缩包等）仅在显式 redirect=1 时直连，避免上游直链自带
 *   Content-Disposition: attachment 破坏 iframe/img 的 inline 预览
 */
function shouldRedirect(
  url: URL,
  disposition: 'attachment' | 'inline',
  contentType: string,
  textLike: boolean,
  size: number
): boolean {
  if (textLike) return false;
  const explicit = url.searchParams.get('redirect') === '1';
  const isMedia = /^(video|audio)\//.test(contentType);
  if (disposition === 'inline' && isMedia) return true;
  return explicit && (isMedia || size >= REDIRECT_MIN_SIZE);
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

  // Google 原生格式（doc/sheet/...）：read() 已自动导出，Content-Type 用导出 MIME
  let contentType = stat.contentType ?? guessMime(path) ?? 'application/octet-stream';
  if (stat.contentType && stat.contentType.startsWith('application/vnd.google-apps.')) {
    contentType = nativeExportMime(stat.contentType, path);
  }
  let textLike = isTextContent(contentType, path);

  // .ts / .mts / .m2ts 扩展名有歧义（TypeScript 源码 vs MPEG-TS 流容器）：
  // 光鸭等网盘常见「扩展名 mp4、实体 MPEG-TS」或后端按扩展名给了 text/plain，
  // 只有命中 TS 同步字节（0x47）才改判为视频，否则保持文本预览行为。
  const ext = fileExt(path);
  let container: MediaContainer = 'unknown';
  if (AMBIGUOUS_TS_EXTS.has(ext)) {
    container = await sniffContainer(storage, path, stat.size);
    if (container === 'mpegts') {
      contentType = 'video/mp2t';
      textLike = false;
    }
  }

  // 媒体探测（probe=1）：前端在把地址交给 <video> 之前先确认容器，
  // MPEG-TS 由浏览器内核直接判定「不能在线播放」，避免长时间黑屏无提示。
  if (url.searchParams.get('probe') === '1') {
    if (container === 'unknown') container = await sniffContainer(storage, path, stat.size);
    if (container === 'unknown' && /mpegts|mp2t/i.test(contentType)) container = 'mpegts';
    const playable = container === 'mpegts' ? uaSupportsMpegTs(c.req.header('user-agent') ?? '') : true;
    return c.json({
      path,
      size: stat.size,
      contentType,
      container,
      playable,
      // 播放链路：前端默认一律 /api/preview 302 直连（CDN 直出，毫秒级 TTFB）；
      // /api/stream 中继只在直连 error 时兜底重试一次，故此处不再区分 stream/direct
      mode: 'direct',
      // 光鸭驱动只有签名直链（signedURL / downloadUrl），无 HLS / 转码播放地址
      playUrl: null,
      hint: !playable && container === 'mpegts' ? MPEGTS_HINT : undefined,
    });
  }

  // 直连上游（302）：媒体与大文件不再经 Worker 逐字节代理。
  // 浏览器拿到签名直链后直连对象存储，首字节与拖动 seek 均不再受 Worker 往返与上游限速叠加影响。
  // - /api/preview（inline）默认启用；/api/download 需显式 redirect=1（前端失败可回退代理）
  if (shouldRedirect(url, opts.disposition, contentType, textLike, stat.size)) {
    try {
      const target = await storage.directUrl?.(path);
      if (target) {
        const redirectHeaders: Record<string, string> = {
          Location: target,
          // 短缓存：减少重复 302 与签名换取，同时保证签名过期前会被刷新
          'Cache-Control': 'private, max-age=30',
          // Content-Type 透传：302 无实体，但部分客户端/代理会据此预判资源类型
          'Content-Type': contentType,
        };
        if (opts.disposition === 'attachment') {
          // 原生下载：跨域 302 后浏览器会忽略 <a download>，文件名只能靠该头保证
          redirectHeaders['Content-Disposition'] =
            `attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`;
        } else {
          // 预览必须显式 inline：一旦是 attachment，浏览器会把媒体/PDF 当下载而非内联渲染
          redirectHeaders['Content-Disposition'] =
            `inline; filename*=UTF-8''${encodeURIComponent(baseName(path))}`;
        }
        return new Response(null, { status: 302, headers: redirectHeaders });
      }
    } catch (e) {
      // 换取直链失败（签名接口异常 / 驱动不支持）→ 回退代理，不影响可用性
      console.warn('[api] direct link unavailable, fallback to proxy:', e);
    }
  }

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

/**
 * /api/stream 签名直链缓存（isolate 内共享）。
 *
 * TTL 与 guangyapan 驱动的 URL_CACHE_TTL（110s）对齐：视频播放会连续发起大量
 * Range 请求，若每次都用不同签名（URL 带不同的 OSS 签名参数），CDN 缓存键随之
 * 变化，每个分片都会重新回源、握手，表现为吞吐进一步下降。缓存后同一文件在
 * TTL 内复用同一签名直链，命中 CDN 边缓存。
 */
const STREAM_URL_CACHE_TTL = 110 * 1000;
const STREAM_URL_CACHE_MAX = 300;
const streamUrlCache = new Map<string, { url: string; expiresAt: number }>();

/** 取驱动分区名（用于拼缓存键，避免不同驱动的同名路径互相污染） */
function driverNameOf(drivers: Map<string, StorageDriver>, storage: StorageDriver): string {
  for (const [name, driver] of drivers) {
    if (driver === storage) return name;
  }
  return 'default';
}

/** 取（或缓存）某文件的签名直链；force=true 时强制重新签名 */
async function cachedStreamUrl(
  drivers: Map<string, StorageDriver>,
  storage: StorageDriver,
  path: string,
  force = false
): Promise<string | null> {
  if (!storage.directUrl) return null;
  const key = driverNameOf(drivers, storage) + '|' + path;
  if (force) {
    streamUrlCache.delete(key);
  } else {
    const hit = streamUrlCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.url;
    if (hit) streamUrlCache.delete(key);
  }
  const fresh = await storage.directUrl(path);
  if (!fresh) return null;
  if (streamUrlCache.size >= STREAM_URL_CACHE_MAX && !streamUrlCache.has(key)) {
    const oldest = streamUrlCache.keys().next();
    if (!oldest.done) streamUrlCache.delete(oldest.value);
  }
  streamUrlCache.set(key, { url: fresh, expiresAt: Date.now() + STREAM_URL_CACHE_TTL });
  return fresh;
}

/**
 * 内联中继：/api/stream —— 供 <video>/<audio> 作为媒体源使用的同源端点。
 *
 * 为什么不能直接用 302 直链（历史结论，已被实测推翻，保留说明）：
 * 光鸭 CDN 对 Range 响应附带 `Content-Disposition: attachment` 且不返回 CORS 头，
 * 但实测 attachment 只影响顶层导航（下载），不影响 <video>/<audio> 按 Content-Type
 * 与 206 解码；缺 CORS 只影响 fetch/XHR 拉流，不影响媒体元素直接加载。
 * 因中继吞吐（1.4~58KB/s）远低于 CDN 直连（~200KB/s），前端默认已改回 /api/preview
 * 302 直连，本端点保留为「直连出错时的一次性兜底」与调试入口。
 *
 * 与 /api/preview 的分工（现状）：
 *   - 默认播放 → /api/preview 302 直连（毫秒级 TTFB，CDN 直出）
 *   - 直连 <video>/<audio> 触发 error → 前端改指本端点重试一次（头部由 Worker 重写）
 *   - 不可解码容器（mpegts 等）→ 前端直接提示下载，不走任何端点播放
 */
async function handleInlineRelay(
  c: Context<{ Bindings: Env }>,
  drivers: Map<string, StorageDriver>,
  url: URL
): Promise<Response> {
  const p = url.searchParams.get('path');
  if (!p) return c.text('Missing path param', 400);
  const api = resolveApiPath(p, drivers);
  if (!api) return c.text('Not found', 404);
  const { storage, path } = api;
  if (path === '/' || path.endsWith('/')) return c.text('Not a file', 400);

  const stat = await storage.stat(path);
  if (!stat || stat.isDirectory) return c.text('Not found', 404);

  let contentType = stat.contentType ?? guessMime(path) ?? 'application/octet-stream';
  if (stat.contentType && stat.contentType.startsWith('application/vnd.google-apps.')) {
    contentType = nativeExportMime(stat.contentType, path);
  }
  // .ts 歧义扩展名：命中 TS 同步字节才认定视频流（TypeScript 源码不在此端点使用）
  if (AMBIGUOUS_TS_EXTS.has(fileExt(path))) {
    const sniffed = await sniffContainer(storage, path, stat.size);
    if (sniffed === 'mpegts') contentType = 'video/mp2t';
  }

  const reqRange = c.req.header('range');
  const range = parseRange(reqRange, stat.size);
  const filename = `inline; filename*=UTF-8''${encodeURIComponent(baseName(path))}`;

  /** 统一重写的响应头：inline + 真实类型 + Range 支持 + 允许同源/跨域读取 */
  const baseHeaders = (): Headers =>
    new Headers({
      'Content-Type': contentType,
      'Content-Disposition': filename,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=30',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    });

  // 预检（同源请求不会触发，跨域 embed 时需要）
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders() });
  }

  // 首选：签名直链 + 上游 fetch（Worker 只搬字节，头部由自己写）
  if (storage.directUrl) {
    try {
      const target = await cachedStreamUrl(drivers, storage, path);
      if (target) {
        // 诊断开关：仅显式带 probe=1 / debug=1 时才做 64KB 阻塞探测与慢速重试。
        // 正常播放路径直接透传上游流，首字节延迟 = 上游 TTFB（毫秒级）。
        const wantProbe =
          url.searchParams.get('probe') === '1' || url.searchParams.get('debug') === '1';
        // 光鸭 CDN 附加浏览器 UA/Referer/Origin；4xx/5xx 自动重试一次（诊断时另含慢速重试）
        const upstream = await fetchUpstreamGuarded(target, {
          tag: `stream:${driverNameOf(drivers, storage)}`,
          headers: reqRange ? { Range: reqRange } : {},
          maxAttempts: 2,
          probeFirst: wantProbe,
          refreshUrl: async () => cachedStreamUrl(drivers, storage, path, true),
        });
        if ((upstream.ok || upstream.status === 206) && upstream.body) {
          const headers = baseHeaders();
          const status = upstream.status === 206 ? 206 : 200;
          // 上游的 Content-Range / Content-Length / Content-Type 优先（真实切片长度）
          const upstreamRange = upstream.headers.get('content-range');
          if (upstreamRange) headers.set('Content-Range', upstreamRange);
          else if (status === 206 && range) {
            headers.set(
              'Content-Range',
              `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.size}`
            );
          }
          const upstreamLen = upstream.headers.get('content-length');
          if (upstreamLen) headers.set('Content-Length', upstreamLen);
          else if (status === 200 && stat.size > 0) headers.set('Content-Length', String(stat.size));
          const upstreamType = upstream.headers.get('content-type');
          if (upstreamType && !/^application\/octet-stream$/i.test(upstreamType)) {
            headers.set('Content-Type', upstreamType);
          }
          return new Response(upstream.body, { status, headers });
        }
        // 非 2xx：丢弃上游响应体，回退驱动直读
        await upstream.body?.cancel();
        console.warn(
          '[api/stream] upstream status',
          upstream.status,
          `(attempts=${upstream.attempts}, probe=${upstream.probeMs}ms/${upstream.probedBytes}B)`,
          '→ fallback to driver read'
        );
      }
    } catch (e) {
      console.warn('[api/stream] upstream fetch failed, fallback to driver read:', e);
    }
  }

  // 兜底：驱动 read() 直读（Range 由驱动处理），响应头同样重写
  let stream: ReadableStream | null;
  try {
    stream = await storage.read(path, range ?? undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('Not found')) return c.text('Not found', 404);
    throw e;
  }
  if (stream === null) return c.text('Not found', 404);

  const headers = baseHeaders();
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(stream, { status: 206, headers });
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
/* ============================ 媒体容器探测（MPEG-TS 兜底） ============================ */

/** 媒体容器类型（当前只区分影响浏览器解码能力的两类） */
type MediaContainer = 'mpegts' | 'mp4' | 'unknown';

/** TS 取样长度：覆盖 188 字节包边界（0 / 188 / 376 处应为同步字节 0x47） */
const TS_SNIFF_BYTES = 377;

/** 扩展名有歧义（TypeScript 源码 vs MPEG-TS 流）：需嗅探文件头才能定性 */
const AMBIGUOUS_TS_EXTS = new Set(['ts', 'mts', 'm2ts', 'mpegts']);

/** 取小写扩展名（不含点） */
function fileExt(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i + 1).toLowerCase();
}

/**
 * 按文件头识别容器：
 *   - fMP4 / MP4：偏移 4 起为 "ftyp"
 *   - MPEG-TS：188 字节包，0 / 188 / 376 处均为 0x47
 *   - m2ts：192 字节包（4 字节时间戳前缀），4 / 196 处为 0x47
 */
function detectContainer(b: Uint8Array): MediaContainer {
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4';
  if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'mpegts';
  if (b.length >= 197 && b[4] === 0x47 && b[196] === 0x47) return 'mpegts';
  if (b.length >= 2 && b[0] === 0x47 && b[1] !== 0x47) return 'mpegts';
  return 'unknown';
}

/** 读取文件头识别容器；任何失败都返回 unknown，不阻断主流程 */
async function sniffContainer(
  storage: StorageDriver,
  path: string,
  size?: number
): Promise<MediaContainer> {
  const length = size && size > 0 ? Math.min(TS_SNIFF_BYTES, size) : TS_SNIFF_BYTES;
  try {
    const stream = await storage.read(path, { offset: 0, length });
    if (!stream) return 'unknown';
    const { bytes } = await readUpTo(stream, length);
    return detectContainer(bytes);
  } catch (e) {
    console.warn('[api] container sniff failed, treat as unknown:', e);
    return 'unknown';
  }
}

/**
 * 浏览器能否解码 MPEG-TS：
 * 只有 Safari（iOS/macOS 的 AVFoundation）内置 mpegts demuxer，
 * Chrome / Edge / Firefox 的 FFmpeg demuxer 均不含 mpegts，必然黑屏并抛 MEDIA_ERR_SRC_NOT_SUPPORTED。
 */
function uaSupportsMpegTs(ua: string): boolean {
  const chromeLike = /(Chrome|CriOS|Chromium|Edg|OPR|Firefox|FxiOS)\//.test(ua);
  return /Safari\//.test(ua) && !chromeLike;
}

/** MPEG-TS 不可在线播放时的统一提示文案 */
const MPEGTS_HINT = '该文件为 MPEG-TS 流容器，浏览器无法在线播放，请下载后使用播放器观看。';

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
