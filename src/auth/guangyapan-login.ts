/**
 * 光鸭网盘（GuangYaPan）短信验证码自动登录提供者
 *
 * 移植自 OpenList guangyapan 驱动（driver.go Init/loginBySMSCode/prepareSMSCode/
 * requestVerificationID/ensureCaptchaToken 与 util.go）：
 *   - 两阶段登录：
 *       1) 无 verify_code：发送验证码（先 captcha/init 获取 captcha_token，再
 *          /v1/auth/verification 获取 verification_id），返回 409 verify 供前端回填
 *       2) 有 verify_code：/v1/auth/verification/verify 换取 verification_token，
 *          再 /v1/auth/signin 换取 access_token / refresh_token
 *   - captcha 失效（captcha_invalid / captcha_token expired）自动刷新一次重试；
 *     captcha/init 无法自动完成（如人工滑块）时返回 verify，可携带用户手动获取的
 *     captchaToken 重试
 *
 * 安全：验证码仅存在于请求体内；响应只回传可回填配置的凭据字段（token 等）。
 */
import type { AuthLoginParams, AuthLoginResult, AuthProvider } from './types';
import { AuthProviderError } from './types';

// ===========================================================================
// 常量（与 OpenList guangyapan 对齐）
// ===========================================================================
const ACCOUNT_BASE_URL = 'https://account.guangyapan.com';

/** 登录换取令牌 action（与 OpenList ensureCaptchaToken 一致） */
const CAPTCHA_ACTION = 'POST:/v1/auth/verification';

// ===========================================================================
// 类型（与 OpenList types.go 对齐）
// ===========================================================================
interface CaptchaInitResp {
  captcha_token?: string;
  expires_in?: number;
  error?: string;
  error_code?: number;
  error_description?: string;
}

interface VerificationResp {
  verification_id?: string;
  error?: string;
  error_code?: number;
  error_description?: string;
}

interface VerifyResp {
  verification_token?: string;
  error?: string;
  error_code?: number;
  error_description?: string;
}

interface SigninResp {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  sub?: string;
  error?: string;
  error_code?: number;
  error_description?: string;
}

// ===========================================================================
// 工具函数（与 OpenList util.go 对齐）
// ===========================================================================
/** 手机号 E164 归一化（Go: normalizePhoneE164） */
function normalizePhoneE164(phone: string): string {
  let p = phone.trim();
  if (!p) return '';
  p = p.replace(/\s+/g, '');
  if (p.startsWith('+')) {
    if (p.startsWith('+86') && p.length > 3) {
      return '+86 ' + p.slice(3);
    }
    return p;
  }
  const digits = normalizeCaptchaUsername(p);
  if (digits.length === 11) return '+86 ' + digits;
  return p;
}

/** 纯数字归一化（Go: normalizeCaptchaUsername；大陆号码去 86 前缀） */
function normalizeCaptchaUsername(phone: string): string {
  let p = phone.trim().replace(/\s+/g, '').replace(/^\+/, '');
  let digits = '';
  for (const ch of p) {
    if (ch >= '0' && ch <= '9') digits += ch;
  }
  if (digits.startsWith('86') && digits.length > 11) {
    digits = digits.slice(2);
  }
  return digits;
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

// ===========================================================================
// 提供者
// ===========================================================================
export class GuangYaPanLoginProvider implements AuthProvider {
  readonly driver = 'guangyapan';

  async login(params: AuthLoginParams): Promise<AuthLoginResult> {
    const clientId = typeof params.clientId === 'string' ? params.clientId.trim() : '';
    const phoneRaw = typeof params.phoneNumber === 'string' ? params.phoneNumber.trim() : '';
    const verifyCode = typeof params.verifyCode === 'string' ? params.verifyCode.trim() : '';
    const captchaToken = typeof params.captchaToken === 'string' ? params.captchaToken.trim() : '';
    const verificationId = typeof params.verificationId === 'string' ? params.verificationId.trim() : '';
    const deviceId = normalizeDeviceID(typeof params.deviceId === 'string' ? params.deviceId : '') || randomDeviceID();
    const deviceSign =
      (typeof params.deviceSign === 'string' ? params.deviceSign.trim() : '') || 'wdi10.' + deviceId;

    if (!clientId) {
      throw new AuthProviderError('请输入光鸭网盘 clientId（必填）');
    }
    const phoneNumber = normalizePhoneE164(phoneRaw);
    if (!phoneNumber) {
      throw new AuthProviderError('请输入手机号（如 +86 13800000000 或 13800000000）');
    }

    const ctx = new GuangYaPanLoginContext({
      clientId,
      phoneNumber,
      deviceId,
      deviceSign,
    });

    // 阶段一：未提供验证码 → 发送短信
    if (!verifyCode) {
      await ctx.ensureCaptchaToken(captchaToken);
      let vid = verificationId;
      if (!vid) {
        try {
          vid = await ctx.requestVerificationID(captchaToken);
        } catch (e) {
          // captcha 失效时刷新一次重试（与 OpenList requestVerificationID 一致）
          if (e instanceof GuangYaPanLoginError && e.captchaInvalid) {
            await ctx.ensureCaptchaToken('');
            vid = await ctx.requestVerificationID('');
          } else {
            throw e;
          }
        }
      }
      const e = new AuthProviderError(
        `验证码已发送至 ${phoneNumber}，请填写收到的验证码后重新调用登录接口（body 增加 "verifyCode": "..." 与 "verificationId": "${vid}"）`,
        409,
        'verify'
      );
      (e as AuthProviderError & { verificationId?: string }).verificationId = vid;
      throw e;
    }

    // 阶段二：验证码登录
    let vid = verificationId;
    if (!vid) {
      vid = await ctx.requestVerificationID(captchaToken);
    }
    const verificationToken = await ctx.verifyCode(vid, verifyCode);
    const token = await ctx.signin(verificationToken, verifyCode);

    if (!token.refresh_token) {
      throw new AuthProviderError('登录成功但未返回 refresh_token，请稍后重试', 502, 'upstream');
    }

    const fields: Record<string, string | number> = {
      refreshToken: token.refresh_token,
      clientId,
      deviceId,
      deviceSign,
    };
    if (token.access_token) fields.accessToken = token.access_token;
    if (typeof token.expires_in === 'number' && token.expires_in > 0) {
      fields.accessTokenExpiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
    }

    return {
      fields,
      message: '登录成功，accessToken/refreshToken 已获取，请保存配置',
    };
  }
}

/** 登录内部错误：标记是否 captcha 失效（供自动刷新重试） */
class GuangYaPanLoginError extends Error {
  constructor(message: string, public captchaInvalid = false) {
    super(message);
    this.name = 'GuangYaPanLoginError';
  }
}

interface GuangYaPanLoginContextOptions {
  clientId: string;
  phoneNumber: string;
  deviceId: string;
  deviceSign: string;
}

/** 光鸭短信登录请求上下文（仅本模块使用） */
class GuangYaPanLoginContext {
  private captchaToken = '';

  constructor(private opts: GuangYaPanLoginContextOptions) {}

  private accountHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Device-Model': 'chrome%2F147.0.0.0',
      'X-Device-Name': 'PC-Chrome',
      'X-Device-Sign': this.opts.deviceSign,
      'X-Net-Work-Type': 'NONE',
      'X-OS-Version': 'MacIntel',
      'X-Platform-Version': '1',
      'X-Protocol-Version': '301',
      'X-Provider-Name': 'NONE',
      'X-SDK-Version': '9.0.2',
      'X-Client-Id': this.opts.clientId,
      'X-Client-Version': '0.0.1',
      'X-Device-Id': this.opts.deviceId,
    };
    if (this.captchaToken) h['X-Captcha-Token'] = this.captchaToken;
    return h;
  }

  /** 基础 POST（account 基址；业务错误统一转 GuangYaPanLoginError） */
  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
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
      throw new AuthProviderError(`光鸭服务响应异常（HTTP ${res.status}）`, 502, 'upstream');
    }
    const err = (json ?? {}) as {
      error?: string;
      error_code?: number;
      error_description?: string;
    };
    const hasError =
      (err.error && err.error !== 'success') ||
      (typeof err.error_code === 'number' && err.error_code !== 0);
    if (hasError) {
      const desc = err.error_description || err.error || `error_code=${err.error_code}`;
      const captchaInvalid =
        err.error === 'captcha_invalid' ||
        (err.error_description || '').includes('captcha_token expired');
      if (captchaInvalid) {
        throw new GuangYaPanLoginError(`captcha 失效：${desc}`, true);
      }
      throw new GuangYaPanLoginError(`光鸭接口错误：${desc}`);
    }
    return json as T;
  }

  /** 获取 captcha_token（Go: ensureCaptchaToken；token 为空或强制时重新初始化） */
  async ensureCaptchaToken(explicitToken: string): Promise<void> {
    if (this.captchaToken || explicitToken) return;
    const resp = await this.post<CaptchaInitResp>('/v1/shield/captcha/init', {
      client_id: this.opts.clientId,
      action: CAPTCHA_ACTION,
      device_id: this.opts.deviceId,
      meta: {
        username: this.opts.phoneNumber,
        phone_number: this.opts.phoneNumber,
        VERIFICATION_PHONE: this.opts.phoneNumber,
      },
    });
    if (!resp.captcha_token) {
      throw new AuthProviderError(
        '获取验证码令牌失败：可能需要人工验证（滑块/短信）。请在光鸭网盘页面手动获取 captchaToken 后，携带 "captchaToken" 字段重试登录接口',
        409,
        'verify'
      );
    }
    this.captchaToken = resp.captcha_token;
  }

  /** 请求发送验证码（Go: requestVerificationID；失败标记 captcha 失效由调用方刷新重试） */
  async requestVerificationID(explicitToken: string): Promise<string> {
    if (!this.captchaToken && explicitToken) {
      this.captchaToken = explicitToken;
    }
    const resp = await this.post<VerificationResp>('/v1/auth/verification', {
      phone_number: this.opts.phoneNumber,
      target: 'ANY',
      client_id: this.opts.clientId,
    });
    if (!resp.verification_id) {
      throw new GuangYaPanLoginError('请求验证码失败：未返回 verification_id');
    }
    return resp.verification_id;
  }

  /** 验证码 → verification_token（Go: loginBySMSCode 阶段一） */
  async verifyCode(verificationId: string, code: string): Promise<string> {
    const resp = await this.post<VerifyResp>('/v1/auth/verification/verify', {
      verification_id: verificationId,
      verification_code: code,
      client_id: this.opts.clientId,
    });
    if (!resp.verification_token) {
      throw new GuangYaPanLoginError('验证码校验失败：未返回 verification_token');
    }
    return resp.verification_token;
  }

  /** verification_token → access/refresh token（Go: loginBySMSCode 阶段二） */
  async signin(verificationToken: string, code: string): Promise<SigninResp> {
    return this.post<SigninResp>('/v1/auth/signin', {
      verification_code: code,
      verification_token: verificationToken,
      username: this.opts.phoneNumber,
      client_id: this.opts.clientId,
    });
  }
}

export default GuangYaPanLoginProvider;
