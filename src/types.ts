/**
 * 公共类型定义
 */
import type { Context } from 'hono';
import type { AppConfig } from './config';
import type { StorageDriver } from './storage/types';

/** 传递到协议层的请求上下文 */
export interface DavContext {
  request: Context['req'];
  env: unknown;
  config: AppConfig;
  /** 当前路径解析出的存储驱动（虚拟根路径不构造协议层 ctx） */
  storage: StorageDriver;
  /** 全部已装配驱动（key = 驱动类型名） */
  drivers: Map<string, StorageDriver>;
  /** 当前存储标识：'root'（虚拟根）或驱动类型名 */
  storageType: string;
  /** 是否为虚拟根（未进入任何驱动分区；仅 PROPFIND 列出分区 / OPTIONS） */
  virtualRoot: boolean;
  /** 规范化后的 WebDAV 路径（已解析到驱动内部，以 / 开头，目录以 / 结尾） */
  path: string;
  /** 将外部 WebDAV 路径（可能带 /<driver> 前缀）映射为当前驱动内部路径；跨驱动或非法返回 null */
  resolveInnerPath(externalPath: string): string | null;
}

/** WebDAV 错误：携带 DAV 错误码，响应时构造 <D:error> 体 */
export class DavError extends Error {
  status: number;
  davCode?: string;
  headers?: Record<string, string>;

  constructor(status: number, message: string, davCode?: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.davCode = davCode;
    this.headers = headers;
  }
}
