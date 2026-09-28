# WebDAV Cloud Drive — 需求分析文档

## 1. 项目背景

用户希望利用 Cloudflare 免费服务构建一个支持 WebDAV 协议的挂载网盘（WebDAV Cloud Drive），
使其可以被 Windows 资源管理器、macOS Finder、Linux 文件管理器、第三方挂载工具（rclone、Cyberduck 等）
作为网络驱动器直接挂载使用；同时提供浏览器 Web UI 作为轻量管理界面。

项目完全基于 Cloudflare 免费额度运行，不依赖自有服务器：

| Cloudflare 服务 | 免费额度 | 用途 |
| --- | --- | --- |
| Workers | 每日 100,000 次请求 | WebDAV 协议处理 + Web UI + 管理 API（HTTP 边缘计算） |
| Workers Assets | 随 Workers 托管 | Web UI 静态资源（无需 Pages） |
| R2 | 每月 10GB 存储、100 万次 Class A 操作 | 默认对象存储后端（S3 兼容） |
| KV | 每日 100,000 次读、1,000 次写 | WebDAV 锁状态、Telegram 文件索引 |
| D1 | 每日 5GB 读、500 万行读 | 请求日志持久化（方法/路径/状态码/耗时/存储后端） |

## 2. 项目目标

### 2.1 总体目标

在 Cloudflare Workers 上实现一个**完整的、可直接部署的 WebDAV 服务器**，具备：

- 标准 WebDAV 协议（RFC 4918 / RFC 7233 子集）支持，兼容主流客户端挂载；
- 浏览器 **Web UI**：文件浏览 / 上传 / 下载 / 删除 / 重命名 / 新建文件夹、存储驱动配置页、请求日志查看页；
- 多存储后端抽象，支持 **S3 兼容对象存储（含 Cloudflare R2）**、**Telegram Bot 存储**、
  **百度网盘（开放平台 API）**、**Google Drive（OAuth2 + Drive API v3）**、**Dropbox（API v2）** 五类驱动；
- **D1 持久化请求日志**：记录方法 / 路径 / 状态码 / 耗时 / 存储后端，提供查询 API 与 UI 展示；
- 良好的工程结构：模块高内聚、低耦合，便于后期维护与扩展新存储驱动。

### 2.2 参考项目

- [bugparty/cloudflare_webdav_server](https://github.com/bugparty/cloudflare_webdav_server)：Workers + R2 + KV 的完整 WebDAV 实现，重点参考其锁（LOCK/UNLOCK）与客户端兼容处理。
- [OpenList](https://github.com/OpenListTeam/OpenList)：云存储聚合管理，参考其多驱动抽象与配置管理思路。
- [CloudFlare-ImgBed](https://github.com/marseventh/cloudflare-imgbed)：参考其 Telegram 存储后端实现（Bot API file_id 存取）。

## 3. 功能需求

### 3.1 WebDAV 协议能力（优先级 P0）

| 方法 | 说明 | 必需行为 |
| --- | --- | --- |
| OPTIONS | 能力协商 | 返回 `DAV: 1, 2`、`Allow` 头，支持跨域 |
| PROPFIND | 属性查询 | 支持 `Depth: 0 / 1`，返回 `multistatus` XML；属性含 getcontentlength、getlastmodified、getetag、resourcetype、displayname、creationdate |
| PROPPATCH | 属性修改 | 支持 `set/remove`（仅接受标准属性，自定义属性忽略） |
| MKCOL | 建目录 | 创建目录 marker；父目录不存在时返回 409 |
| GET / HEAD | 读取 | 支持 Range 请求（RFC 7233），正确返回 Content-Type / Content-Length / ETag |
| PUT | 写入 | 支持覆盖与新建；父目录不存在返回 409 |
| DELETE | 删除 | 支持目录递归删除（深度不限） |
| MOVE / COPY | 移动 / 复制 | 解析 `Destination` 头；目录递归；`Overwrite` 头语义 |
| LOCK / UNLOCK | 锁 | 基于 KV 的写锁（depth 0/infinity），超时刷新；为 Windows/macOS 客户端兼容提供基本能力 |

### 3.2 Web UI（优先级 P0，新增）

| 页面 | 能力 |
| --- | --- |
| 文件浏览 | 面包屑导航、目录进入、文件夹/文件图标区分、大小与修改时间展示 |
| 上传 | 多文件选择、逐文件上传进度、完成后刷新列表 |
| 下载 | 通过 `/api/download` 流式下载（避免浏览器无法携带 Basic Auth 头） |
| 删除 | 文件夹/文件删除（删除前确认） |
| 重命名 | 基于 WebDAV MOVE 实现 |
| 新建文件夹 | 基于 WebDAV MKCOL 实现 |
| 驱动配置页 | 展示当前存储后端、认证状态、各驱动是否已配置（不泄露密钥原文） |
| 日志查看页 | 分页查询 D1 请求日志，支持按方法 / 状态码过滤、手动刷新 |

Web UI 静态资源由 **Workers Assets（`[assets]`）** 直接托管，访问 `/ui/` 即可，**无需额外 Pages 部署**。

### 3.3 存储后端（优先级 P0）

| 驱动 | 协议 / API | 说明 |
| --- | --- | --- |
| S3 兼容对象存储 | AWS S3 REST API（SigV4） | 通用 S3 端点；Cloudflare R2 即 S3 兼容端点，作为默认实现 |
| Telegram Bot 存储 | Bot API（sendDocument / getFile） | 文件内容上传至 Telegram，`file_id` 与元数据存于 KV 索引 |
| 百度网盘 | 百度开放平台 xpan REST API | 使用开放平台接口，兼容百度网盘青春版账号体系 |
| **Google Drive** | Drive API v3（OAuth2 refresh_token） | 新增（P0）：refresh_token 换取 access_token，按路径解析 fileId，实现完整 StorageDriver 接口 |
| **Dropbox** | Dropbox API v2 | 新增（P0）：access_token 或 refresh_token 鉴权，实现完整 StorageDriver 接口 |

新增驱动均实现同一 `StorageDriver` 接口，由 `registry` 工厂按 `STORAGE_TYPE` 装配；**协议层零改动**。

### 3.4 认证与安全（优先级 P0）

- HTTP Basic Auth，凭据来自 Workers Secret（`DAV_USER` / `DAV_PASS`），禁止硬编码。
- 所有写操作（PUT/MKCOL/DELETE/MOVE/COPY/PROPPATCH）与 Web UI / 管理 API 均需认证；OPTIONS 允许匿名以提升客户端兼容性。
- 路径规范化：禁止 `..` 越权路径穿越。
- 配置页仅返回"是否已配置"，不返回任何密钥原文。

### 3.5 请求日志（优先级 P1，新增）

- **D1 持久化**：每次请求记录 `ts / method / path / status / duration_ms / storage`。
- 查询 API：`GET /api/logs?limit=&offset=&method=&status=`（需认证），返回 `{ enabled, total, entries }`。
- Web UI 日志页展示与过滤。
- 日志写入采用 `waitUntil` 后台执行，不阻塞主流程；写入失败静默降级。

### 3.6 配置管理（优先级 P1）

- 存储类型选择：`STORAGE_TYPE = s3 | telegram | baidu | gdrive | dropbox`。
- 各驱动凭据均通过 Secret / vars 注入，代码零硬编码。
- 支持 `.dev.vars` 本地开发配置。

### 3.7 可观测性（优先级 P2）

- 关键操作错误返回标准 WebDAV 错误码（`DAV:` 错误体），便于客户端诊断。
- D1 日志接口（不阻塞主流程），可通过 Web UI 日志页查看。

## 4. 非功能需求

| 维度 | 要求 |
| --- | --- |
| 性能 | Workers 免费额度内稳定运行；大文件读写走流式（R2/S3），不落内存 |
| 兼容性 | Windows 资源管理器、macOS Finder、rclone、Cyberduck 均可挂载 |
| 可维护性 | 存储驱动实现统一接口 `StorageDriver`，新增驱动只需注册一个类 |
| 可测试性 | 协议层与存储层解耦，可用本地 mock 驱动做单元测试 |
| 部署 | `wrangler deploy` 一键部署；文档给出完整初始化步骤 |

## 5. 网络出站机制（新增说明）

- **服务端出站**：Workers 的所有对外请求（Telegram Bot API、Google Drive API、Dropbox API、百度开放平台等）均由 **Cloudflare 边缘网络**发起，天然具备访问公网能力，**用户本地无需任何代理**即可对 TG、Google Drive 等外网网盘文件执行增删改操作。
- **入站域名**：`*.workers.dev` 域名在中国大陆访问受限。国内用户使用时应**绑定自定义域名**（在 Cloudflare 控制台将域名 CNAME 至 Workers，或使用 Workers 自定义域），通过自有域名访问服务。

## 6. 约束与限制

- Workers 免费版请求体上限 100MB，因此 **Telegram / 百度驱动** 单文件上传受此限制（R2/S3 流式上传不受影响；Google Drive / Dropbox 上传同样受 Workers 请求体限制，建议单文件 ≤ 100MB）。
- Telegram 上传需整文件缓冲到内存，建议单文件 ≤ 50MB。
- 百度网盘开放平台部分接口需实名 / 审核，凭据由用户在百度开放平台自行申请。
- Google Drive / Dropbox 需先在各自开发者控制台创建 OAuth 应用并获取 refresh_token。
- KV 免费额度有限，锁状态与索引数据量控制在极小规模（每个条目 < 1KB）。

## 7. 验收标准

1. `wrangler dev` 可本地启动，`wrangler deploy` 可部署到 Workers。
2. 浏览器访问 `https://<domain>/ui/` 可完成文件浏览、上传、下载、删除、重命名、新建文件夹。
3. Windows 资源管理器输入 `https://<domain>/` 输入凭据后可浏览、上传、下载、新建文件夹、重命名、删除。
4. `STORAGE_TYPE` 切换为 s3 / telegram / baidu / gdrive / dropbox 时，WebDAV 行为保持一致。
5. `GET /api/logs` 返回 D1 日志数据；Web UI 日志页可查看与过滤。
6. rclone 配置 `webdav` 类型可完成 `rclone mount` 挂载。
7. 项目结构符合本需求第 4 节可维护性要求，新增驱动无需改动 WebDAV 协议层。
