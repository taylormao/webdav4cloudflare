/**
 * 迅雷（thunder_browser 方案）自动登录提供者
 *
 * 移植自 AList thunder_browser 驱动（util.go / driver.go / meta.go）：
 *   - 内置 client 凭据：com.xunlei.browser 客户端（ClientID/ClientSecret/ClientVersion/PackageName）
 *   - 设备 ID 派生：md5hex(username + password)（与 AList Login 模式一致）
 *   - 登录流程：先 POST /v1/shield/captcha/init 获取 captcha_token（按 username 形态填
 *     email/phone_number/username meta），再 POST /v1/auth/signin 完成登录；
 *     signin 遇 error_code=9 & captcha_invalid 时重新获取 captcha_token 并重试一次
 *   - 验证码签名：内置 Algorithms 逐段 MD5 链（GetCaptchaSign，timestamp=Unix 毫秒）
 *   - 登录成功返回 refresh_token（含 access_token / expires_in），可回填 xunlei 配置
 *
 * 安全：密码仅存在于本次请求体内；响应只回传可回填配置的凭据字段。
 */
import type { AuthLoginParams, AuthLoginResult, AuthProvider } from './types';
import { AuthProviderError } from './types';

// ===========================================================================
// 常量（与 AList thunder_browser/util.go、meta.go 对齐）
// ===========================================================================
const XLUSER_API_URL = 'https://xluser-ssl.xunlei.com/v1';
const SIGNIN_URL = XLUSER_API_URL + '/auth/signin';
const CAPTCHA_INIT_URL = XLUSER_API_URL + '/shield/captcha/init';
const REDIRECT_URI = 'xlaccsdk01://xunlei.com/callback?state=harbor';

const DEFAULT_CLIENT_ID = 'ZUBzD9J_XPXfn7f7';
const DEFAULT_CLIENT_SECRET = 'yESVmHecEe6F0aou69vl-g';
const DEFAULT_CLIENT_VERSION = '1.10.0.2633';
const DEFAULT_PACKAGE_NAME = 'com.xunlei.browser';
const SDK_VERSION = '233100';

/** 登录 action（与 AList GetAction("POST", signinUrl) 一致） */
const LOGIN_ACTION = 'POST:/v1/auth/signin';

// ===========================================================================
// 类型（与 AList types.go 对齐）
// ===========================================================================
interface CaptchaTokenResponse {
  captcha_token?: string;
  expires_in?: number;
  url?: string;
}

interface TokenResp {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  sub?: string;
  user_id?: string;
  token?: string; // 超级保险箱访问 token（本服务不回填）
}

interface ApiErrorBody {
  error_code?: number;
  error?: string;
  error_description?: string;
}

// ===========================================================================
// 工具函数（纯 TS 移植）
// ===========================================================================
/** AList utils.GetMD5EncodeStr 等价实现（WebCrypto 不支持 MD5，用纯 TS 实现） */
function md5hex(s: string): string {
  return hex(md5(new TextEncoder().encode(s)));
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

/** AList BuildCustomUserAgent（Android 模拟串；deviceSign 生成被 AList 注释，按原样跳过） */
function buildCustomUserAgent(
  deviceId: string,
  appName: string,
  sdkVersion: string,
  clientVersion: string,
  packageName: string
): string {
  void packageName; // 与 AList 签名保持一致（传入但未使用）
  return (
    `ANDROID-${appName}/${clientVersion} ` +
    'networkType/WIFI ' +
    'appid/22062 ' +
    'deviceName/Xiaomi_M2004j7ac ' +
    'deviceModel/M2004J7AC ' +
    'OSVersion/13 ' +
    'protocolVersion/301 ' +
    'platformversion/10 ' +
    `sdkVersion/${sdkVersion} ` +
    'Oauth2Client/0.9 (Linux 4_9_337-perf-sn-uotan-gd9d488809c3d) (JAVA 0) '
  );
}

// ===========================================================================
// 提供者
// ===========================================================================
export class XunleiLoginProvider implements AuthProvider {
  readonly driver = 'xunlei';

  async login(params: AuthLoginParams): Promise<AuthLoginResult> {
    const username = typeof params.username === 'string' ? params.username.trim() : '';
    const password = typeof params.password === 'string' ? params.password : '';

    if (!username || !password) {
      throw new AuthProviderError('请输入迅雷账号与密码');
    }

    // 设备 ID 派生：与 AList Login 模式一致（md5hex(username + password)）
    const deviceId = md5hex(username + password);
    const clientId = DEFAULT_CLIENT_ID;
    const clientSecret = DEFAULT_CLIENT_SECRET;
    const clientVersion = DEFAULT_CLIENT_VERSION;
    const packageName = DEFAULT_PACKAGE_NAME;
    const userAgent = buildCustomUserAgent(
      deviceId,
      packageName,
      SDK_VERSION,
      clientVersion,
      packageName
    );

    const common = new XunleiCommon({
      deviceId,
      clientId,
      clientSecret,
      clientVersion,
      packageName,
      userAgent,
    });

    // 登录前先获取 captcha_token
    await common.refreshCaptchaTokenInLogin(LOGIN_ACTION, username);

    // signin；遇 captcha_invalid 时重新获取 captcha_token 并重试一次（第二次失败直接抛错）
    let token = await common.signin(username, password);
    if (token === null) {
      await common.refreshCaptchaTokenInLogin(LOGIN_ACTION, username);
      token = await common.signin(username, password);
    }

    if (!token || !token.refresh_token) {
      throw new AuthProviderError('登录成功但未返回 refresh_token，请稍后重试', 502, 'upstream');
    }

    const fields: Record<string, string | number> = {
      refreshToken: token.refresh_token,
      deviceId,
      userAgent,
    };
    if (token.access_token) fields.accessToken = token.access_token;
    if (typeof token.expires_in === 'number' && token.expires_in > 0) {
      fields.accessTokenExpiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
    }

    return {
      fields,
      message: '登录成功，refreshToken 已获取，请保存配置',
    };
  }
}

/** 迅雷登录公共请求上下文（仅本模块使用，内置凭据不对外暴露） */
interface XunleiCommonOptions {
  deviceId: string;
  clientId: string;
  clientSecret: string;
  clientVersion: string;
  packageName: string;
  userAgent: string;
}

class XunleiCommon {
  private captchaToken = '';

  constructor(private opts: XunleiCommonOptions) {}

  // 基础请求（不带 Authorization，供 captcha init / signin 使用；与 AList Common.Request 对齐）
  private async request<T = unknown>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'user-agent': this.opts.userAgent,
        accept: 'application/json;charset=UTF-8',
        'x-device-id': this.opts.deviceId,
        'x-client-id': this.opts.clientId,
        'x-client-version': this.opts.clientVersion,
        'content-type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON（如 HTML 错误页）
    }
    if (!res.ok && json === null) {
      throw new AuthProviderError(`迅雷服务响应异常（HTTP ${res.status}）`, 502, 'upstream');
    }
    const err = (json ?? {}) as ApiErrorBody;
    if (typeof err.error_code === 'number' && err.error_code !== 0) {
      const msg = err.error_description || err.error || `error_code=${err.error_code}`;
      const e = new AuthProviderError(`迅雷返回错误：${msg}`, 502, 'upstream');
      (e as AuthProviderError & { code?: number }).code = err.error_code;
      throw e;
    }
    return json as T;
  }

  // 验证码签名：GetCaptchaSign（timestamp=UnixMilli，Algorithms 逐段 MD5 链）
  // 仅登录后刷新（RefreshCaptchaTokenAtLogin）使用，本服务不需要，保留实现备用。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private getCaptchaSign(): { timestamp: string; sign: string } {
    const timestamp = String(Date.now());
    const algorithms = [
      'uWRwO7gPfdPB/0NfPtfQO+71',
      'F93x+qPluYy6jdgNpq+lwdH1ap6WOM+nfz8/V',
      '0HbpxvpXFsBK5CoTKam',
      'dQhzbhzFRcawnsZqRETT9AuPAJ+wTQso82mRv',
      'SAH98AmLZLRa6DB2u68sGhyiDh15guJpXhBzI',
      'unqfo7Z64Rie9RNHMOB',
      '7yxUdFADp3DOBvXdz0DPuKNVT35wqa5z0DEyEvf',
      'RBG',
      'ThTWPG5eC0UBqlbQ+04nZAptqGCdpv9o55A',
    ];
    let str =
      this.opts.clientId + this.opts.clientVersion + this.opts.packageName + this.opts.deviceId + timestamp;
    for (const algo of algorithms) {
      str = md5hex(str + algo);
    }
    return { timestamp, sign: '1.' + str };
  }

  // 登录时获取 captcha_token（按 username 形态填 email/phone_number/username meta）
  async refreshCaptchaTokenInLogin(action: string, username: string): Promise<void> {
    const metas: Record<string, string> = {};
    if (/^\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*$/.test(username)) {
      metas.email = username;
    } else if (/^1\d{10}$/.test(username)) {
      metas.phone_number = username;
    } else {
      metas.username = username;
    }
    await this.refreshCaptchaToken(action, metas);
  }

  // refreshCaptchaToken：POST /v1/shield/captcha/init
  // 与 AList 对齐：登录时（RefreshCaptchaTokenInLogin）meta 仅含账号形态字段
  // （email/phone_number/username）；client_version/package_name/timestamp/captcha_sign
  // 仅用于登录后的 RefreshCaptchaTokenAtLogin（本服务无需），不得注入。
  private async refreshCaptchaToken(action: string, metas: Record<string, string>): Promise<void> {
    const resp = await this.request<CaptchaTokenResponse>(CAPTCHA_INIT_URL, {
      action,
      captcha_token: this.captchaToken,
      client_id: this.opts.clientId,
      device_id: this.opts.deviceId,
      meta: metas,
      redirect_uri: REDIRECT_URI,
    });

    if (resp.url) {
      // 需要人工验证（滑块/短信等），无法自动完成
      throw new AuthProviderError(`需要人工验证：${resp.url}`, 409, 'verify');
    }
    if (!resp.captcha_token) {
      throw new AuthProviderError('获取验证码令牌失败（空 captcha_token），请稍后重试', 502, 'upstream');
    }
    this.captchaToken = resp.captcha_token;
  }

  // signin：POST /v1/auth/signin
  // 返回 null 表示验证码令牌失效（captcha_invalid），上层应重新获取 captcha_token 后重试
  async signin(username: string, password: string): Promise<TokenResp | null> {
    try {
      return await this.request<TokenResp>(SIGNIN_URL, {
        captcha_token: this.captchaToken,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        username,
        password,
      });
    } catch (e) {
      if (e instanceof AuthProviderError && (e as AuthProviderError & { code?: number }).code === 9) {
        return null;
      }
      throw e;
    }
  }
}
