/**
 * 存储驱动抽象层 — 接口定义
 *
 * 协议层（webdav/）只依赖本接口，不感知具体存储实现。
 * 新增驱动只需实现本接口并在 registry.ts 注册。
 */

/** 文件 / 目录元数据 */
export interface FileStat {
  /** 显示名（不含路径） */
  name: string;
  /** 完整 WebDAV 路径（以 / 开头；目录以 / 结尾） */
  path: string;
  isDirectory: boolean;
  /** 字节数（目录可为 0） */
  size: number;
  /** 最后修改时间（epoch ms） */
  mtime: number;
  etag?: string;
  contentType?: string;
}

export interface ListResult {
  entries: FileStat[];
  /** 是否因数量限制被截断（当前实现恒为 false，预留） */
  truncated: boolean;
}

export interface Range {
  offset: number;
  length: number;
}

export interface WriteOptions {
  contentType?: string;
  size?: number;
}

export interface StorageDriver {
  /** 驱动类型标识：s3 / telegram / baidu */
  readonly type: string;

  /** 列出目录下所有子项（不含递归） */
  list(path: string): Promise<ListResult>;

  /** 查询单条元数据；不存在返回 null */
  stat(path: string): Promise<FileStat | null>;

  /** 读取文件内容流；支持可选 Range */
  read(path: string, range?: Range): Promise<ReadableStream | null>;

  /** 写入文件（覆盖或新建） */
  write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void>;

  /** 删除文件或目录（目录递归删除） */
  remove(path: string): Promise<void>;

  /** 创建空目录（marker） */
  mkdir(path: string): Promise<void>;

  /** 移动（目录递归） */
  move(src: string, dst: string): Promise<void>;

  /** 复制（目录递归） */
  copy(src: string, dst: string): Promise<void>;
}
