/**
 * 配置管理模块
 *
 * 从 Workers env（vars + secrets）读取配置，输出强类型配置对象；
 * 支持合并 DRIVER_CONFIG KV 中用户自助填写的驱动配置（KV 优先、env 兜底）。
 * 原则：所有敏感信息来自 Secret / 鉴权表单提交，零硬编码；所有模块以参数注入方式消费配置。
 */

import { KV_DRIVER_KEYS, readKvDriverConfig, sanitizeDriverConfig, applyDriverConfigPatch } from './kv-config';

export type StorageType = 's3' | 'telegram' | 'baidu' | 'gdrive' | 'dropbox' | 'yun139' | 'xunlei';

export interface AuthConfig {
  user: string;
  pass: string;
}

export interface S3Config {
  endpoint: string; // S3 端点，如 https://<account>.r2.cloudflarestorage.com
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface BaiduConfig {
  accessToken: string;
  appId: string;
  userAgent: string;
}

export interface GDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface DropboxConfig {
  accessToken: string;
  refreshToken: string;
  appKey: string;
  appSecret: string;
}

/** 中国移动云盘（139/和彩云）配置：Authorization = base64("pc:<账号>:<token|...|exp>") */
export interface Yun139Config {
  authorization: string;
}

/**
 * 迅雷网盘配置（thunder_browser 方案，对应 AList ExpertAddition）：
 * 必填 refreshToken（迅雷浏览器 com.xunlei.browser 客户端刷新令牌）；
 * accessToken 等为运行时缓存字段，可在请求间回填复用；
 * clientId/clientSecret/clientVersion/packageName 默认使用内置迅雷浏览器客户端凭据，可覆盖；
 * deviceId 默认由 refreshToken 的 MD5 派生，可显式指定 32 位十六进制值；
 * useVideoUrl 优先使用 medias 视频直链；removeWay 控制删除落回收站（trash，默认）或彻底删除（delete）；
 * signTimestamp/signCaptchaSign 同时提供时使用显式验证码签名（captcha_sign 模式）。
 */
export interface XunleiConfig {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  deviceId?: string;
  clientId?: string;
  clientSecret?: string;
  clientVersion?: string;
  packageName?: string;
  userAgent?: string;
  downloadUserAgent?: string;
  useVideoUrl?: boolean;
  removeWay?: string;
  signTimestamp?: string;
  signCaptchaSign?: string;
}

export interface LogConfig {
  enabled: boolean; // 是否写 D1 请求日志（LOG_ENABLED != 'false' 且已绑定 D1）
  table: string;
}

export interface AppConfig {
  storageType: StorageType;
  auth: AuthConfig;
  s3: S3Config;
  telegram: TelegramConfig;
  baidu: BaiduConfig;
  gdrive: GDriveConfig;
  dropbox: DropboxConfig;
  yun139: Yun139Config;
  xunlei: XunleiConfig;
  log: LogConfig;
}

/** 从原始 env 中提取配置键，兼容可选绑定不存在的情况 */
interface RawEnv {
  STORAGE_TYPE?: string;
  DAV_USER?: string;
  DAV_PASS?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BUCKET?: string;
  S3_FORCE_PATH_STYLE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  BAIDU_ACCESS_TOKEN?: string;
  BAIDU_APP_ID?: string;
  BAIDU_USER_AGENT?: string;
  GDRIVE_CLIENT_ID?: string;
  GDRIVE_CLIENT_SECRET?: string;
  GDRIVE_REFRESH_TOKEN?: string;
  DROPBOX_ACCESS_TOKEN?: string;
  DROPBOX_REFRESH_TOKEN?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  YUN139_AUTHORIZATION?: string;
  XUNLEI_REFRESH_TOKEN?: string;
  XUNLEI_ACCESS_TOKEN?: string;
  XUNLEI_ACCESS_TOKEN_EXPIRES_AT?: string;
  XUNLEI_DEVICE_ID?: string;
  XUNLEI_CLIENT_ID?: string;
  XUNLEI_CLIENT_SECRET?: string;
  XUNLEI_CLIENT_VERSION?: string;
  XUNLEI_PACKAGE_NAME?: string;
  XUNLEI_USER_AGENT?: string;
  XUNLEI_DOWNLOAD_USER_AGENT?: string;
  XUNLEI_USE_VIDEO_URL?: string;
  XUNLEI_REMOVE_WAY?: string;
  XUNLEI_SIGN_TIMESTAMP?: string;
  XUNLEI_SIGN_CAPTCHA_SIGN?: string;
  LOG_ENABLED?: string;
  [key: string]: unknown;
}

/**
 * 装配完整配置：env 为基础（兜底），DRIVER_CONFIG KV 用户配置优先覆盖。
 * 异步：每次请求读取 KV，保存后无需重新部署即生效。
 */
export async function buildConfig(env: RawEnv, kv?: KVNamespace | null): Promise<AppConfig> {
  const config = buildBaseConfig(env);
  if (kv) {
    await Promise.all(
      KV_DRIVER_KEYS.map(async (type) => {
        const obj = await readKvDriverConfig(kv, type);
        if (!obj) return;
        const { value } = sanitizeDriverConfig(type, obj);
        applyDriverConfigPatch(config, type, value);
      })
    );
  }
  return config;
}

/** 纯 env 基础配置（同步，供 buildConfig 使用） */
function buildBaseConfig(env: RawEnv): AppConfig {
  const storageType = normalizeStorageType(env.STORAGE_TYPE);
  const auth: AuthConfig = {
    user: env.DAV_USER ?? '',
    pass: env.DAV_PASS ?? '',
  };

  const s3: S3Config = {
    endpoint: env.S3_ENDPOINT ?? 'https://<account>.r2.cloudflarestorage.com',
    region: env.S3_REGION ?? 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    bucket: env.S3_BUCKET ?? 'webdav-cloud-drive',
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
  };

  const telegram: TelegramConfig = {
    botToken: env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: env.TELEGRAM_CHAT_ID ?? '',
  };

  const baidu: BaiduConfig = {
    accessToken: env.BAIDU_ACCESS_TOKEN ?? '',
    appId: env.BAIDU_APP_ID ?? '',
    userAgent: env.BAIDU_USER_AGENT ?? 'Mozilla/5.0 (WebDAV Cloud Drive)',
  };

  const gdrive: GDriveConfig = {
    clientId: env.GDRIVE_CLIENT_ID ?? '',
    clientSecret: env.GDRIVE_CLIENT_SECRET ?? '',
    refreshToken: env.GDRIVE_REFRESH_TOKEN ?? '',
  };

  const dropbox: DropboxConfig = {
    accessToken: env.DROPBOX_ACCESS_TOKEN ?? '',
    refreshToken: env.DROPBOX_REFRESH_TOKEN ?? '',
    appKey: env.DROPBOX_APP_KEY ?? '',
    appSecret: env.DROPBOX_APP_SECRET ?? '',
  };

  const yun139: Yun139Config = {
    authorization: env.YUN139_AUTHORIZATION ?? '',
  };

  const xunlei: XunleiConfig = {
    refreshToken: env.XUNLEI_REFRESH_TOKEN ?? '',
    accessToken: env.XUNLEI_ACCESS_TOKEN ?? undefined,
    accessTokenExpiresAt: parseTimestamp(env.XUNLEI_ACCESS_TOKEN_EXPIRES_AT),
    deviceId: env.XUNLEI_DEVICE_ID ?? undefined,
    clientId: env.XUNLEI_CLIENT_ID ?? undefined,
    clientSecret: env.XUNLEI_CLIENT_SECRET ?? undefined,
    clientVersion: env.XUNLEI_CLIENT_VERSION ?? undefined,
    packageName: env.XUNLEI_PACKAGE_NAME ?? undefined,
    userAgent: env.XUNLEI_USER_AGENT ?? undefined,
    downloadUserAgent: env.XUNLEI_DOWNLOAD_USER_AGENT ?? undefined,
    useVideoUrl: (env.XUNLEI_USE_VIDEO_URL ?? 'false') === 'true',
    removeWay: env.XUNLEI_REMOVE_WAY ?? undefined,
    signTimestamp: env.XUNLEI_SIGN_TIMESTAMP ?? undefined,
    signCaptchaSign: env.XUNLEI_SIGN_CAPTCHA_SIGN ?? undefined,
  };

  const log: LogConfig = {
    enabled: (env.LOG_ENABLED ?? 'true') !== 'false',
    table: 'webdav_logs',
  };

  return { storageType, auth, s3, telegram, baidu, gdrive, dropbox, yun139, xunlei, log };
}

/** 解析可选数字环境变量（空/非法返回 undefined，供 accessTokenExpiresAt 等时间戳使用） */
function parseTimestamp(v?: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeStorageType(v?: string): StorageType {
  switch (v) {
    case 's3':
    case 'telegram':
    case 'baidu':
    case 'gdrive':
    case 'dropbox':
    case 'yun139':
    case 'xunlei':
      return v;
    default:
      return 's3';
  }
}

/** 驱动是否已配置完整（凭据齐备才可装配/挂载） */
export function driverConfigured(key: string, cfg: AppConfig): boolean {
  switch (key) {
    case 's3':
      return !!(cfg.s3.accessKeyId && cfg.s3.secretAccessKey);
    case 'telegram':
      return !!(cfg.telegram.botToken && cfg.telegram.chatId);
    case 'baidu':
      return !!(cfg.baidu.accessToken && cfg.baidu.appId);
    case 'gdrive':
      return !!(cfg.gdrive.clientId && cfg.gdrive.clientSecret && cfg.gdrive.refreshToken);
    case 'dropbox':
      return !!(
        cfg.dropbox.accessToken ||
        (cfg.dropbox.refreshToken && cfg.dropbox.appKey && cfg.dropbox.appSecret)
      );
    case 'yun139':
      return !!cfg.yun139.authorization;
    case 'xunlei':
      return !!cfg.xunlei.refreshToken;
    default:
      return false;
  }
}
