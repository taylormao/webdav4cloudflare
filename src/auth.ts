/**
 * 认证模块 — HTTP Basic Auth
 *
 * 凭据来自 Workers Secret（DAV_USER / DAV_PASS）。
 * 使用 timingSafeEqual 风格比较，避免时序侧信道。
 */
import type { Context } from 'hono';
import type { AuthConfig } from './config';

export async function requireAuth(
  c: Context<{ Bindings: Record<string, unknown> }>,
  config: AuthConfig
): Promise<boolean> {
  return requireAuthFlexible(c, config, undefined);
}

/**
 * 认证：优先校验 auth query 参数（base64(user:pass)），
 * 缺失时回退 Authorization: Basic 头。
 * 用于 /api/preview 等需要 <video>/<audio>/<img>/<iframe> 标签直接加载、
 * 无法携带请求头的场景。
 */
export async function requireAuthFlexible(
  c: Context<{ Bindings: Record<string, unknown> }>,
  config: AuthConfig,
  authQuery?: string | null
): Promise<boolean> {
  if (authQuery) {
    let decoded: string;
    try {
      decoded = atob(authQuery);
    } catch {
      return false;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return safeEqual(user, config.user) && safeEqual(pass, config.pass);
  }

  const header = c.req.header('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }

  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  return safeEqual(user, config.user) && safeEqual(pass, config.pass);
}

/** 恒定时间字符串比较（长度不同时直接短路） */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
