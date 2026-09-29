/**
 * 自动登录获取凭据服务 — 路由注册与分发
 *
 * 统一框架：/api/auth/<driver>/<action>（全部走管理 API 的 Basic 鉴权，
 * 由 src/index.ts 在 /api/* 分支内先 requireAuth 再分发到本模块）。
 *
 * 以 AUTH_PROVIDERS 注册表组织各驱动的登录实现；本阶段已实现：
 *   - xunlei：POST /api/auth/xunlei/login（迅雷账号密码登录，自动获取 refreshToken）
 * 后续新增驱动只需实现 AuthProvider 并注册进 AUTH_PROVIDERS。
 *
 * 安全：密码等敏感入参仅存在于请求体，响应只回传可回填配置的凭据字段。
 */
import type { Context } from 'hono';
import type { AuthLoginParams } from './types';
import { AuthProviderError } from './types';
import { readKvDriverConfig } from '../kv-config';
import type { StorageType } from '../config';
import { XunleiLoginProvider } from './xunlei-login';
import { GuangYaPanLoginProvider } from './guangyapan-login';

/** 自动登录提供者注册表：driver 标识 → 实现 */
export const AUTH_PROVIDERS: Readonly<Record<string, { login: (p: AuthLoginParams) => Promise<{ fields: Record<string, string | number>; message?: string }> }>> = {
  xunlei: new XunleiLoginProvider(),
  guangyapan: new GuangYaPanLoginProvider(),
};

export interface AuthRoute {
  driver: string;
  action: string;
}

/** 解析 /api/auth/<driver>/<action>；不匹配返回 null */
export function parseAuthPath(rawPath: string): AuthRoute | null {
  const m = /^\/api\/auth\/([^/]+)\/([^/]+)\/?$/.exec(rawPath);
  if (!m) return null;
  return { driver: m[1], action: m[2] };
}

/**
 * 登录成功后落盘：将凭据字段合并写回 DRIVER_CONFIG KV（key=驱动类型名）。
 * 仅更新 fields 中出现的键，保留 KV 已有其余字段（不覆盖用户已配置项）。
 */
async function persistLoginFields(
  kv: KVNamespace,
  driver: string,
  fields: Record<string, string | number>
): Promise<string[]> {
  const existing = await readKvDriverConfig(kv, driver as StorageType);
  const merged = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(fields)) {
    merged[k] = typeof v === 'boolean' ? v : String(v);
  }
  await kv.put(driver, JSON.stringify(merged));
  return Object.keys(fields);
}

/** 处理 /api/auth/* 请求（已通过 Basic 鉴权） */
export async function handleAuthApi(c: Context, route: AuthRoute): Promise<Response> {
  const provider = AUTH_PROVIDERS[route.driver];
  if (!provider) {
    return c.json({ ok: false, error: `不支持的驱动：${route.driver}` }, 404);
  }
  if (route.action !== 'login') {
    return c.json({ ok: false, error: `不支持的操作：${route.action}` }, 404);
  }
  if (c.req.method !== 'POST') {
    return c.json({ ok: false, error: '仅支持 POST' }, 405);
  }

  let params: AuthLoginParams;
  try {
    const body: unknown = await c.req.json();
    params = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as AuthLoginParams;
  } catch {
    return c.json({ ok: false, error: '请求体必须为 JSON' }, 400);
  }

  try {
    const result = await provider.login(params);
    // 登录验证通过后自动落盘凭据到 KV（默认开启；persist=false 时仅返回字段不回写）
    const persist = params.persist !== false;
    const kv = (c.env as { DRIVER_CONFIG?: KVNamespace }).DRIVER_CONFIG;
    let persistedFields: string[] | undefined;
    if (persist && kv) {
      persistedFields = await persistLoginFields(kv, route.driver, result.fields);
    }
    return c.json({
      ok: true,
      ...result,
      ...(persistedFields ? { persisted: true, persistedFields } : {}),
    });
  } catch (e) {
    if (e instanceof AuthProviderError) {
      // 透传提供者附加的中间状态（如光鸭两阶段登录的 verificationId），供前端进入下一阶段
      const extra: Record<string, unknown> = {};
      for (const k of Object.keys(e)) {
        if (k === 'name' || k === 'message' || k === 'stack' || k === 'status' || k === 'kind') continue;
        extra[k] = (e as unknown as Record<string, unknown>)[k];
      }
      return c.json(
        { ok: false, error: e.message, kind: e.kind, ...extra },
        e.status as 400 | 404 | 409 | 502
      );
    }
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), kind: 'upstream' }, 502);
  }
}
