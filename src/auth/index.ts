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
    return c.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AuthProviderError) {
      return c.json(
        { ok: false, error: e.message, kind: e.kind },
        e.status as 400 | 404 | 409 | 502
      );
    }
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), kind: 'upstream' }, 502);
  }
}
