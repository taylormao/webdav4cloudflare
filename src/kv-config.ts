/**
 * KV 驱动配置存储（Web UI 自助配置存储服务）
 *
 * 职责：
 *   1. DRIVER_FIELD_SCHEMAS：各驱动字段元数据（名称/类型/必填/是否敏感/默认值/提示），
 *      同时驱动后端校验、脱敏元数据与前端动态表单渲染（单一事实来源）；
 *   2. KV 读写：以 key=驱动类型名 将用户自填配置 JSON 持久化到 DRIVER_CONFIG namespace；
 *   3. 合并与校验：仅接受 schema 已知字段、类型转换、KV 优先 env 兜底；
 *   4. 完整度检查：按 schema required 字段 + 凭据完整性口径（driverConfigured，由 index.ts 消费）。
 *
 * 安全约束：本模块只读写/校验/合并配置对象，绝不向响应输出明文凭据；
 * 脱敏元数据（set/source）由 index.ts 的 /api/config GET 组装。
 */
import type { AppConfig, StorageType } from './config';

/** 可自助配置的驱动类型（与 StorageType 一致） */
export const KV_DRIVER_KEYS: StorageType[] = ['s3', 'telegram', 'baidu', 'gdrive', 'dropbox', 'yun139', 'xunlei', 'guangyapan'];

/** 驱动字段元数据：后端校验 + 脱敏元数据 + 前端表单渲染共用 */
export interface DriverFieldSchema {
  name: string;
  type: 'string' | 'boolean';
  required: boolean;
  secret: boolean;
  default?: string | boolean;
  hint?: string;
}

export const DRIVER_FIELD_SCHEMAS: Record<StorageType, DriverFieldSchema[]> = {
  s3: [
    { name: 'endpoint', type: 'string', required: true, secret: false, default: 'https://<account>.r2.cloudflarestorage.com', hint: 'S3 端点，如 https://<account>.r2.cloudflarestorage.com' },
    { name: 'region', type: 'string', required: true, secret: false, default: 'auto', hint: '区域，R2 固定 auto' },
    { name: 'accessKeyId', type: 'string', required: true, secret: true, hint: 'Access Key ID（敏感）' },
    { name: 'secretAccessKey', type: 'string', required: true, secret: true, hint: 'Secret Access Key（敏感）' },
    { name: 'bucket', type: 'string', required: true, secret: false, default: 'webdav-cloud-drive', hint: '存储桶名称' },
    { name: 'forcePathStyle', type: 'boolean', required: false, secret: false, default: false, hint: '是否使用 path-style 寻址（通用 S3 需 true，R2 可 false）' },
  ],
  telegram: [
    { name: 'botToken', type: 'string', required: true, secret: true, hint: 'Bot Token（敏感）' },
    { name: 'chatId', type: 'string', required: true, secret: false, hint: '目标聊天/频道 ID' },
  ],
  baidu: [
    { name: 'accessToken', type: 'string', required: true, secret: true, hint: '百度开放平台 access_token（敏感）' },
    { name: 'appId', type: 'string', required: true, secret: false, hint: '应用 AppID' },
    { name: 'userAgent', type: 'string', required: false, secret: false, default: 'Mozilla/5.0 (WebDAV Cloud Drive)', hint: '请求 UA（可选）' },
  ],
  gdrive: [
    { name: 'clientId', type: 'string', required: true, secret: false, hint: 'OAuth2 Client ID' },
    { name: 'clientSecret', type: 'string', required: true, secret: true, hint: 'OAuth2 Client Secret（敏感）' },
    { name: 'refreshToken', type: 'string', required: true, secret: true, hint: 'OAuth2 Refresh Token（敏感）' },
  ],
  dropbox: [
    { name: 'accessToken', type: 'string', required: false, secret: true, hint: 'Access Token（敏感）；与下方 refresh 三件套二选一' },
    { name: 'refreshToken', type: 'string', required: false, secret: true, hint: 'Refresh Token（敏感）' },
    { name: 'appKey', type: 'string', required: false, secret: false, hint: 'App Key' },
    { name: 'appSecret', type: 'string', required: false, secret: true, hint: 'App Secret（敏感）' },
  ],
  yun139: [
    { name: 'authorization', type: 'string', required: true, secret: true, hint: 'base64("pc:<账号>:<token|...|exp>")（敏感）' },
  ],
  xunlei: [
    { name: 'refreshToken', type: 'string', required: true, secret: true, hint: '迅雷浏览器 refresh_token（敏感）' },
    { name: 'accessToken', type: 'string', required: false, secret: true, hint: 'access_token 缓存（可选，敏感；过期自动用 refreshToken 刷新）' },
    { name: 'accessTokenExpiresAt', type: 'string', required: false, secret: false, hint: 'access_token 过期时间戳（秒，可选）' },
    { name: 'deviceId', type: 'string', required: false, secret: false, hint: '设备 ID（32 位十六进制；留空自动由 refreshToken 派生）' },
    { name: 'clientId', type: 'string', required: false, secret: false, default: 'ZUBzD9J_XPXfn7f7', hint: '客户端 ID（默认迅雷浏览器内置值）' },
    { name: 'clientSecret', type: 'string', required: false, secret: true, hint: '客户端密钥（默认迅雷浏览器内置值，敏感）' },
    { name: 'clientVersion', type: 'string', required: false, secret: false, default: '1.10.0.2633', hint: '客户端版本（默认迅雷浏览器内置值）' },
    { name: 'packageName', type: 'string', required: false, secret: false, default: 'com.xunlei.browser', hint: '包名（默认迅雷浏览器）' },
    { name: 'userAgent', type: 'string', required: false, secret: false, hint: '请求 UA（可选，默认自动生成）' },
    { name: 'downloadUserAgent', type: 'string', required: false, secret: false, hint: '下载 UA（可选，默认 AndroidDownloadManager）' },
    { name: 'useVideoUrl', type: 'boolean', required: false, secret: false, default: false, hint: '优先使用视频媒体直链下载' },
    { name: 'removeWay', type: 'string', required: false, secret: false, default: 'trash', hint: '删除方式：trash（回收站，默认）/ delete（彻底删除）' },
    { name: 'signTimestamp', type: 'string', required: false, secret: false, hint: '验证码签名时间戳（显式签名模式；与下方 signCaptchaSign 成对）' },
    { name: 'signCaptchaSign', type: 'string', required: false, secret: false, hint: '验证码签名值（显式签名模式；与上方 signTimestamp 成对）' },
  ],
  guangyapan: [
    { name: 'clientId', type: 'string', required: true, secret: false, hint: '光鸭网盘 Client ID（Web 端抓取，必填）' },
    { name: 'refreshToken', type: 'string', required: false, secret: true, hint: 'Refresh Token（敏感；短信登录自动获取）' },
    { name: 'accessToken', type: 'string', required: false, secret: true, hint: 'Access Token（敏感；可选，过期自动用 refreshToken 刷新）' },
    { name: 'accessTokenExpiresAt', type: 'string', required: false, secret: false, hint: 'access_token 过期时间戳（秒，可选）' },
    { name: 'rootPath', type: 'string', required: false, secret: false, default: '/', hint: '挂载根目录（可填文件夹路径，如 /我的文件/资料；留空为网盘根）' },
    { name: 'phoneNumber', type: 'string', required: false, secret: false, hint: '登录手机号（如 +86 13800000000）' },
    { name: 'captchaToken', type: 'string', required: false, secret: false, hint: '验证码令牌（可选；手动从光鸭页面获取时填写）' },
    { name: 'sendCode', type: 'boolean', required: false, secret: false, default: false, hint: '保存后发送短信验证码（发送后自动复位为 false）' },
    { name: 'verifyCode', type: 'string', required: false, secret: false, hint: '短信验证码（与下方 verificationId 一起保存完成登录）' },
    { name: 'verificationId', type: 'string', required: false, secret: false, hint: '验证码会话 ID（发送验证码后回填）' },
    { name: 'deviceId', type: 'string', required: false, secret: false, hint: '设备 ID（32 位十六进制；留空自动随机生成）' },
    { name: 'deviceSign', type: 'string', required: false, secret: false, hint: '设备签名（留空自动生成 wdi10.<deviceId>）' },
    { name: 'pageSize', type: 'string', required: false, secret: false, default: '300', hint: '列表每页大小（默认 300）' },
    { name: 'orderBy', type: 'string', required: false, secret: false, default: '0', hint: '排序字段：0=文件名 1=文件大小 2=修改时间（默认 0）' },
    { name: 'sortType', type: 'string', required: false, secret: false, default: '1', hint: '排序方向：1=升序 2=降序（默认 1）' },
  ],
};

/** 读取某驱动的 KV 配置原始对象；无 KV / 非对象 JSON 返回 null */
export async function readKvDriverConfig(
  kv: KVNamespace | undefined,
  type: StorageType
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;
  const raw = await kv.get(type);
  if (!raw) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    // KV 值损坏时视为未配置，不影响 env 兜底
    return null;
  }
}

/**
 * 清洗用户提交的配置对象：
 * - 仅保留 schema 已知字段（未知字段忽略并记入 warnings）；
 * - 按字段类型做转换（boolean 接受 true/false/'true'/'false'/1/0）；
 * - 类型错误记入 errors（由调用方决定 400）。
 */
export function sanitizeDriverConfig(
  type: StorageType,
  obj: Record<string, unknown>
): { value: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const schema = DRIVER_FIELD_SCHEMAS[type];
  const value: Record<string, unknown> = {};
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const f of schema) {
    if (!(f.name in obj)) continue;
    const v = obj[f.name];
    if (f.type === 'boolean') {
      if (typeof v === 'boolean') value[f.name] = v;
      else if (v === 'true' || v === 1) value[f.name] = true;
      else if (v === 'false' || v === 0) value[f.name] = false;
      else errors.push(`字段 ${f.name} 需要布尔值`);
    } else {
      if (typeof v === 'string') value[f.name] = v;
      else if (typeof v === 'number') value[f.name] = String(v);
      else errors.push(`字段 ${f.name} 需要字符串`);
    }
  }

  for (const k of Object.keys(obj)) {
    if (!schema.some((f) => f.name === k)) {
      warnings.push(`未知字段 ${k} 已忽略`);
    }
  }
  return { value, errors, warnings };
}

/** 将清洗后的 KV 配置逐字段覆盖到 AppConfig 对应驱动子对象（仅覆盖出现的字段） */
export function applyDriverConfigPatch(config: AppConfig, type: StorageType, patch: Record<string, unknown>): void {
  const target = config[type] as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    target[k] = v;
  }
}

/** 保存后完整度检查：schema 必填 string 字段最终为空则列出（boolean 无必填） */
export function missingRequiredFields(type: StorageType, cfg: AppConfig): string[] {
  const obj = cfg[type] as unknown as Record<string, unknown>;
  const missing: string[] = [];
  for (const f of DRIVER_FIELD_SCHEMAS[type]) {
    if (!f.required || f.type !== 'string') continue;
    const v = obj[f.name];
    if (typeof v !== 'string' || v === '') missing.push(f.name);
  }
  return missing;
}
