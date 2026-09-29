/**
 * 存储驱动注册与工厂（多驱动装配）
 *
 * 依据各驱动配置完整性，装配一个或多个驱动实例：
 *   createDrivers(config, env) -> Map<driverType, StorageDriver>
 * key 即驱动类型名（s3 / telegram / baidu / gdrive / dropbox）。
 * 新增驱动：实现 StorageDriver 接口后在此装配表中增加工厂即可。
 */
import type { AppConfig } from '../config';
import { driverConfigured } from '../config';
import type { StorageDriver } from './types';
import { S3Driver } from './s3';
import { TelegramDriver } from './telegram';
import { BaiduDriver } from './baidu';
import { GDriveDriver } from './gdrive';
import { DropboxDriver } from './dropbox';
import { Yun139Driver } from './yun139';
import { XunleiDriver } from './xunlei';
import { GuangYaPanDriver } from './guangyapan';

/** 驱动所需的 Workers bindings（KV / R2） */
export interface DriverEnv {
  R2_BUCKET?: R2Bucket;
  TELEGRAM_INDEX?: KVNamespace;
  LOGS_DB?: D1Database;
  DRIVER_CONFIG?: KVNamespace;
  [key: string]: unknown;
}

/** 驱动装配表：key = 驱动类型名，factory = 实例工厂 */
type DriverFactory = (config: AppConfig, env: DriverEnv) => StorageDriver;

const DRIVER_FACTORIES: ReadonlyArray<[string, DriverFactory]> = [
  ['s3', (cfg, e) => new S3Driver(cfg.s3, e.R2_BUCKET)],
  ['telegram', (cfg, e) => new TelegramDriver(cfg.telegram, e.TELEGRAM_INDEX)],
  ['baidu', (cfg) => new BaiduDriver(cfg.baidu)],
  ['gdrive', (cfg) => new GDriveDriver(cfg.gdrive)],
  ['dropbox', (cfg) => new DropboxDriver(cfg.dropbox)],
  ['yun139', (cfg) => new Yun139Driver(cfg.yun139)],
  ['xunlei', (cfg) => new XunleiDriver(cfg.xunlei)],
  ['guangyapan', (cfg) => new GuangYaPanDriver(cfg.guangyapan)],
];

/**
 * 多驱动装配：返回全部凭据完整的驱动实例 Map。
 * config 已由 buildConfig 合并 env + DRIVER_CONFIG KV（KV 优先、env 兜底），
 * 此处保持同步消费合并后的配置，装配口径不变。
 */
export function createDrivers(config: AppConfig, env: DriverEnv): Map<string, StorageDriver> {
  const map = new Map<string, StorageDriver>();
  for (const [key, factory] of DRIVER_FACTORIES) {
    if (driverConfigured(key, config)) {
      map.set(key, factory(config, env));
    }
  }
  return map;
}
