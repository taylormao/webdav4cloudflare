/**
 * 迅雷（thunder 方案 v3 流程）自动登录提供者
 *
 * 移植自 AList thunder 驱动（util.go / driver.go / meta.go / types.go，PR #8342 之后主流程）：
 *   - 内置 client 凭据：com.xunlei.downloadprovider 客户端 8.31.0.9726
 *     （ClientID=Xp6vsxz_7IYVw2BB / ClientSecret=Xp6vsy4tN9toTVdMSpomVdXpRmES）
 *   - 设备 ID 派生：md5hex(username + password)（与 AList Addition.GetIdentity 一致）
 *   - 登录流程：
 *       1) POST /xluser.core.login/v3/login 获取 sessionID（带 devicesign，可选 creditkey 信任密钥）
 *       2) POST /v1/shield/captcha/init 获取 captcha_token（按 username 形态填
 *          email/phone_number/username meta，RedirectUri=xlaccsdk01://xunlei.com/callback?state=harbor）
 *       3) POST /v1/auth/signin/token 以 signin_token=sessionID 换取 access_token / refresh_token
 *   - 风控处理：v3/login 返回 error=review_panel（或 result=review）时，解析
 *     creditkey / reviewurl / devicesign 并以 409 verify 返回；用户完成短信验证拿到
 *     creditkey 后，携带 creditKey 字段重试登录即可通过
 *
 * 安全：密码仅存在于本次请求体内；响应只回传可回填配置的凭据字段。
 */
import type { AuthLoginParams, AuthLoginResult, AuthProvider } from './types';
import { AuthProviderError } from './types';

// ===========================================================================
// 常量（与 AList thunder/util.go、meta.go 对齐）
// ===========================================================================
const XLUSER_API_BASE_URL = 'https://xluser-ssl.xunlei.com';
const XLUSER_API_URL = XLUSER_API_BASE_URL + '/v1';
const V3_LOGIN_URL = XLUSER_API_BASE_URL + '/xluser.core.login/v3/login';
const SIGNIN_TOKEN_URL = XLUSER_API_URL + '/auth/signin/token';
const CAPTCHA_INIT_URL = XLUSER_API_URL + '/shield/captcha/init';
const REDIRECT_URI = 'xlaccsdk01://xunlei.com/callback?state=harbor';

const DEFAULT_CLIENT_ID = 'Xp6vsxz_7IYVw2BB';
const DEFAULT_CLIENT_SECRET = 'Xp6vsy4tN9toTVdMSpomVdXpRmES';
const DEFAULT_CLIENT_VERSION = '8.31.0.9726';
const DEFAULT_PACKAGE_NAME = 'com.xunlei.downloadprovider';
const DEFAULT_USER_AGENT =
  'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 ' +
  'deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 ' +
  'platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)';
const V3_LOGIN_USER_AGENT = 'android-ok-http-client/xl-acc-sdk/version-5.0.12.512000';

/** devicesign 签名常量（与 AList thunder/util.go APPID/APPKey 对齐） */
const APPID = '40';
const APP_KEY = '34a062aaa22f906fca4fefe9fb3a3021';

/** 登录 action（与 AList GetAction("POST", signinTokenUrl) 一致） */
const LOGIN_ACTION = 'POST:/v1/auth/signin/token';

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
}

/** v3/login 请求体（CoreLoginRequest） */
interface CoreLoginRequest {
  protocolVersion: string;
  sequenceNo: string;
  platformVersion: string;
  isCompressed: string;
  appid: string;
  clientVersion: string;
  peerID: string;
  appName: string;
  sdkVersion: string;
  devicesign: string;
  netWorkType: string;
  providerName: string;
  deviceModel: string;
  deviceName: string;
  OSVersion: string;
  creditkey: string;
  hl: string;
  userName: string;
  passWord: string;
  verifyKey: string;
  verifyCode: string;
  isMd5Pwd: string;
}

/** v3/login 响应体（CoreLoginResp） */
interface CoreLoginResp {
  account?: string;
  creditkey?: string;
  expires_in?: number;
  loginKey?: string;
  nickName?: string;
  secureKey?: string;
  sessionID?: string;
  timestamp?: string;
  userID?: string;
  userName?: string;
  userNewNo?: string;
  version?: string;
}

/** signin/token 请求体（SignInRequest） */
interface SignInRequest {
  client_id: string;
  client_secret: string;
  provider: string;
  signin_token: string;
}

/** 风控验证响应体（LoginReviewResp） */
interface LoginReviewResp {
  creditkey?: string;
  reviewurl?: string;
  error?: string;
  errorCode?: string;
  errorDescription?: string;
  errorDescUrl?: string;
  verifyType?: string;
  userID?: string;
}

/** 回传给用户完成验证的数据（ReviewData） */
interface ReviewData {
  creditkey: string;
  reviewurl: string;
  deviceid: string;
  devicesign: string;
}

/** 上游错误体：兼容 error_code/error/error_description 与 result:review 两种形态 */
interface ApiErrorBody {
  error_code?: number;
  error?: string;
  error_description?: string;
  result?: string;
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

/** SHA-1（用于 devicesign 签名） */
function sha1hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const ml = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, Math.floor(ml / 4294967296), false);
  dv.setUint32(padded.length - 8, ml >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = ((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) << 1) | ((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  return hex(out);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** AList generateDeviceSign：div101.{deviceID}{md5(sha1(deviceID+packageName+APPID+APPKey))} */
function generateDeviceSign(deviceId: string, packageName: string): string {
  const sha1String = sha1hex(deviceId + packageName + APPID + APP_KEY);
  const md5String = md5hex(sha1String);
  return 'div101.' + deviceId + md5String;
}

// ===========================================================================
// 提供者
// ===========================================================================
export class XunleiLoginProvider implements AuthProvider {
  readonly driver = 'xunlei';

  async login(params: AuthLoginParams): Promise<AuthLoginResult> {
    const username = typeof params.username === 'string' ? params.username.trim() : '';
    const password = typeof params.password === 'string' ? params.password : '';
    const creditKey = typeof params.creditKey === 'string' ? params.creditKey.trim() : '';

    if (!username || !password) {
      throw new AuthProviderError('请输入迅雷账号与密码');
    }

    // 设备 ID 派生：与 AList Addition.GetIdentity 一致（md5hex(username + password)）
    const deviceId = md5hex(username + password);
    const clientId = DEFAULT_CLIENT_ID;
    const clientSecret = DEFAULT_CLIENT_SECRET;
    const clientVersion = DEFAULT_CLIENT_VERSION;
    const packageName = DEFAULT_PACKAGE_NAME;
    const userAgent = DEFAULT_USER_AGENT;

    const common = new XunleiCommon({
      deviceId,
      clientId,
      clientSecret,
      clientVersion,
      packageName,
      userAgent,
    });

    // 1) v3/login 获取 sessionID（review 风控在此拦截）
    const sessionId = await common.coreLogin(username, password, creditKey);

    // 2) captcha/init 获取 captcha_token
    await common.refreshCaptchaTokenInLogin(LOGIN_ACTION, username);

    // 3) signin/token 以 sessionID 换取令牌
    const token = await common.signinToken(sessionId);

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

  // 基础请求（不带 Authorization，供 v3 login / captcha init / signin token 使用；与 AList Common.Request 对齐）
  // overrideUserAgent 供 v3/login 使用（需 android-ok-http-client UA）
  private async request<T = unknown>(
    url: string,
    body: unknown,
    overrideUserAgent?: string
  ): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'user-agent': overrideUserAgent || this.opts.userAgent,
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
    const isError = err.error_code !== undefined && err.error_code !== 0;
    // 风控拦截：error=review_panel（AList 判断）或 result=review（实测形态）
    const isReview =
      err.error === 'review_panel' ||
      err.result === 'review' ||
      err.error_description === 'review_panel';
    if (isReview) {
      throw this.buildReviewError(json as Record<string, unknown>);
    }
    if (isError || (err.error && err.error !== 'success')) {
      const msg = err.error_description || err.error || `error_code=${err.error_code}`;
      const e = new AuthProviderError(`迅雷返回错误：${msg}`, 502, 'upstream');
      if (typeof err.error_code === 'number') {
        (e as AuthProviderError & { code?: number }).code = err.error_code;
      }
      throw e;
    }
    return json as T;
  }

  // 风控验证错误：解析 creditkey/reviewurl 并构造 ReviewData（AList getReviewData）
  private buildReviewError(body: Record<string, unknown>): AuthProviderError {
    const review = body as unknown as LoginReviewResp;
    const deviceSign = generateDeviceSign(this.opts.deviceId, this.opts.packageName);
    const reviewData: ReviewData = {
      creditkey: review.creditkey || '',
      reviewurl: (review.reviewurl || '') + '&deviceid=' + deviceSign,
      deviceid: deviceSign,
      devicesign: deviceSign,
    };
    const jsonText = JSON.stringify(reviewData, null, 2);
    const e = new AuthProviderError(
      `本次登录需要短信验证（result: review）。请按以下步骤完成验证后重试：\n` +
        `1. 在浏览器打开：${reviewData.reviewurl}\n` +
        `2. 按页面提示完成短信验证，验证通过后从页面控制台 reviewCb 回调或页面返回结果中获取 creditkey\n` +
        `3. 携带 creditKey 字段重新调用本登录接口（POST /api/auth/xunlei/login，body 增加 "creditKey": "..."）\n\n` +
        `验证数据：\n${jsonText}`,
      409,
      'verify'
    );
    (e as AuthProviderError & { review?: ReviewData }).review = reviewData;
    return e;
  }

  // v3/login：获取 sessionID（CoreLogin）
  async coreLogin(username: string, password: string, creditKey: string): Promise<string> {
    const deviceSign = generateDeviceSign(this.opts.deviceId, this.opts.packageName);
    const body: CoreLoginRequest = {
      protocolVersion: '301',
      sequenceNo: '1000012',
      platformVersion: '10',
      isCompressed: '0',
      appid: APPID,
      clientVersion: '8.31.0.9726',
      peerID: '00000000000000000000000000000000',
      appName: 'ANDROID-com.xunlei.downloadprovider',
      sdkVersion: '512000',
      devicesign: deviceSign,
      netWorkType: 'WIFI',
      providerName: 'NONE',
      deviceModel: 'M2004J7AC',
      deviceName: 'Xiaomi_M2004j7ac',
      OSVersion: '12',
      creditkey: creditKey,
      hl: 'zh-CN',
      userName: username,
      passWord: password,
      verifyKey: '',
      verifyCode: '',
      isMd5Pwd: '0',
    };
    const resp = await this.request<CoreLoginResp>(V3_LOGIN_URL, body, V3_LOGIN_USER_AGENT);
    if (!resp.sessionID) {
      // 兼容异常返回：有 error 字段时已在 request 层抛出，这里兜底
      throw new AuthProviderError('迅雷 v3 登录未返回 sessionID，请稍后重试', 502, 'upstream');
    }
    return resp.sessionID;
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
  // 与 AList 对齐：登录时（RefreshCaptchaTokenInLogin）meta 仅含账号形态字段；
  // client_version/package_name/timestamp/captcha_sign 仅用于登录后的刷新（本服务无需），不得注入。
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

  // signin/token：以 v3 sessionID 换取 access_token / refresh_token
  async signinToken(sessionId: string): Promise<TokenResp> {
    const body: SignInRequest = {
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      provider: 'access_end_point_token',
      signin_token: sessionId,
    };
    return this.request<TokenResp>(SIGNIN_TOKEN_URL, body);
  }
}
