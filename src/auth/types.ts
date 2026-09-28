/**
 * 自动登录获取凭据服务 — 公共类型
 *
 * 目标：为需要填写配置的外挂存储驱动提供"系统代替用户登录并获取凭据"的能力，
 * 前端调用 /api/auth/<driver>/<action> 获取 token 等配置字段后自动回填表单。
 *
 * 安全约束：
 *   - 登录凭据（密码等）仅经请求体传递，不落库、不写日志、不回显；
 *   - 响应仅回传可回填配置的字段（如 refreshToken / accessToken / 过期时间），
 *     绝不回传明文密码或任何未要求的敏感中间值。
 */

/** 登录入参：driver 自定义字段（如 xunlei 的 username/password/safePassword） */
export interface AuthLoginParams {
  username?: string;
  password?: string;
  /** 驱动自定义扩展字段（如 xunlei 的可选安全密码 safePassword） */
  [key: string]: unknown;
}

/** 登录成功结果：可直接回填配置表单的字段集合 */
export interface AuthLoginResult {
  /** 供回填配置表单的字段（如 refreshToken / accessToken / accessTokenExpiresAt / deviceId / userAgent） */
  fields: Record<string, string | number>;
  /** 人类可读成功提示（前端展示，如"已获取，请保存"） */
  message?: string;
}

/**
 * 登录失败错误：携带给前端的可读信息与错误类型。
 * - kind='invalid'：入参/凭据错误（400）
 * - kind='verify'：需要用户手动处理（如验证码/风控 URL），前端应给出提示（409）
 * - kind='upstream'：上游服务异常（502）
 */
export class AuthProviderError extends Error {
  readonly status: number;
  readonly kind: 'invalid' | 'verify' | 'upstream';

  constructor(message: string, status = 400, kind: 'invalid' | 'verify' | 'upstream' = 'invalid') {
    super(message);
    this.name = 'AuthProviderError';
    this.status = status;
    this.kind = kind;
  }
}

/** 自动登录提供者接口：每驱动一份实现，注册进 AUTH_PROVIDERS */
export interface AuthProvider {
  /** 驱动标识（对应 /api/auth/<driver>/ 与 StorageType） */
  readonly driver: string;
  /** 执行登录并返回可回填配置的凭据字段 */
  login(params: AuthLoginParams): Promise<AuthLoginResult>;
}
