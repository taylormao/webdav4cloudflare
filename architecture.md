---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 932475866bc48bd2f98012d270878988_6473e442bafb11f1a1bf52540064ee0f
    ReservedCode1: THB+4i/cSvucRSNszPY3D9Edy1wgB4R4IYRNLOBV3S59BbgeqjSDsvboNvNCF/dyE9Xg+UK+blmDD9RVTRJG5pYvcKdcEwVwTa+1RknVq14cXA8Gt+RG49IBROPdbrUxrDby8ZrtYiLiNfbIT+DLHj478DYjReqCXaOkKxa421OLZusWi7d6lOi8pzU=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 932475866bc48bd2f98012d270878988_6473e442bafb11f1a1bf52540064ee0f
    ReservedCode2: THB+4i/cSvucRSNszPY3D9Edy1wgB4R4IYRNLOBV3S59BbgeqjSDsvboNvNCF/dyE9Xg+UK+blmDD9RVTRJG5pYvcKdcEwVwTa+1RknVq14cXA8Gt+RG49IBROPdbrUxrDby8ZrtYiLiNfbIT+DLHj478DYjReqCXaOkKxa421OLZusWi7d6lOi8pzU=
---

---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 932475866bc48bd2f98012d270878988_6a5082fcbaf811f19ba1525400638852
    ReservedCode1: 96rjMD6zdXRAO7lHjXeQHAvEXhOc9b22vpWcB0tSOIpiWBnugOuxWCKL06o4wCIh8M0iXvbb9hTmLu88e3vmJ0ZZ9ax0pLZ4zXjME/GPa4jtBDZMFdiWGK2vN8a/Zg4GlxTcp/slnh8/HaDseNEi7Yk7YnYyBYhV8oUty/sVGb4gMI+nbHKvrMSeddM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 932475866bc48bd2f98012d270878988_6a5082fcbaf811f19ba1525400638852
    ReservedCode2: 96rjMD6zdXRAO7lHjXeQHAvEXhOc9b22vpWcB0tSOIpiWBnugOuxWCKL06o4wCIh8M0iXvbb9hTmLu88e3vmJ0ZZ9ax0pLZ4zXjME/GPa4jtBDZMFdiWGK2vN8a/Zg4GlxTcp/slnh8/HaDseNEi7Yk7YnYyBYhV8oUty/sVGb4gMI+nbHKvrMSeddM=
---

# WebDAV Cloud Drive — 架构设计与项目结构规划

## 1. 总体架构

```
                        ┌─────────────────────────────────────────────┐
                        │      WebDAV 客户端 / 浏览器 Web UI           │
                        │  (Windows 资源管理器 / Finder / rclone / …)  │
                        └──────────────────┬──────────────────────────┘
                                           │ HTTP(S) + Basic Auth
                        ┌──────────────────▼──────────────────────────┐
                        │        Cloudflare Workers (边缘节点)         │
                        │  ┌───────────────────────────────────────┐  │
                        │  │            src/index.ts               │  │
                        │  │  Hono App 入口：认证 → 路由分发 → 日志  │  │
                        │  └───────────────┬───────────────────────┘  │
                        │                  │                          │
                        │   ┌──────────────▼──────────────┐           │
                        │   │      webdav/ 协议层         │           │
                        │   │  方法处理器（高内聚模块）     │           │
                        │   │  propfind/proppatch/mkcol/  │           │
                        │   │  get/put/delete/movecopy/   │           │
                        │   │  lock/unlock/options        │           │
                        │   └──────────────┬──────────────┘           │
                        │                  │ StorageDriver 接口        │
                        │   ┌──────────────▼──────────────┐           │
                        │   │      storage/ 驱动层        │           │
                        │   │  S3 / Telegram / Baidu /    │           │
                        │   │  GDrive / Dropbox           │           │
                        │   │  (Registry → createDrivers) │           │
                        │   └──────────────┬──────────────┘           │
                        │                  │                          │
                        │   ┌──────────────▼──────────────┐           │
                        │   │        log/ 日志模块        │           │
                        │   │  D1Logger（write+query）    │           │
                        │   └──────────────┬──────────────┘           │
                        └──────────────────┼──────────────────────────┘
                                           │
   ┌──────────┬───────────┬──────────────┬─┴───────────┬──────────┬──────────────┐
   ▼          ▼           ▼              ▼             ▼          ▼              ▼
R2/S3     Telegram   百度开放平台   Google Drive   Dropbox   Cloudflare KV   D1
(对象存储)  (Bot API)  (xpan REST)   (Drive v3)   (API v2)  (锁+索引+驱动配置)  (日志)
```

### 分层职责

| 层 | 职责 | 依赖方向 |
| --- | --- | --- |
| 入口层 `index.ts` | HTTP 路由（WebDAV + /api/*）、认证、环境装配、驱动选择、日志埋点 | → auth / config / webdav / log |
| 协议层 `webdav/` | WebDAV 方法语义、XML 响应、状态码 | → storage 接口（仅依赖抽象，不依赖具体驱动） |
| 驱动层 `storage/` | 各类存储后端的物理操作实现 | → 无反向依赖；仅依赖 `storage/types.ts` 接口 |
| 日志层 `log/` | D1 请求日志写入与查询 | → 仅依赖 `config.ts` 的 LogConfig |
| 基础设施层 `utils/` `locks.ts` | 路径/XML/锁工具函数 | 无业务依赖 |
| 配置层 `config.ts` | 解析 env + 合并 KV 用户配置，装配配置对象 | 依赖 `kv-config.ts`（仅类型与 schema） |

### 依赖原则（高内聚低耦合）

1. **协议层只依赖 `StorageDriver` 接口**，不 import 任何具体驱动类。新增存储后端时协议层零改动。
2. 驱动层只实现接口 + 自身协议细节，不感知 WebDAV 语义（如 `multistatus`）。
3. 每个 WebDAV 方法一个独立处理器文件，方法间无共享可变状态（无状态服务）。
4. 锁状态 / 索引等跨请求状态统一走 KV，由 `locks.ts` 与驱动内部封装，不散落各处。
5. 配置对象在启动时一次性装配（`buildConfig(env)`），各模块以参数注入方式消费，便于测试。
6. 日志模块与协议/驱动解耦：`index.ts` 统一埋点，`D1Logger` 独立可测；日志写入失败静默。

## 2. 核心抽象

### 2.1 StorageDriver 接口

```ts
interface StorageDriver {
  readonly type: string;
  list(path: string): Promise<ListResult>;              // 列出子项
  stat(path: string): Promise<FileStat | null>;         // 单条元数据
  read(path: string, range?: Range): Promise<ReadableStream | null>;
  write(path: string, body: BodyInit, opts?: WriteOptions): Promise<void>;
  remove(path: string): Promise<void>;                  // 文件或目录（递归）
  mkdir(path: string): Promise<void>;
  move(src: string, dst: string): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
}
```

- `FileStat` 含 name / path / isDirectory / size / mtime / etag / contentType。
- 路径约定：内部统一使用 **以 `/` 开头、目录以 `/` 结尾** 的规范路径（见 `utils/path.ts`）。

### 2.2 目录模型约定

| 驱动 | 目录表示 |
| --- | --- |
| S3 / R2 | 对象键 `dir/` 结尾的空对象作为目录 marker；`list` 使用 `delimiter=/` 模拟层级 |
| Telegram | KV 索引记录文件（`path → {fileId,…}`），目录为路径前缀推导的虚拟节点 |
| 百度网盘 | 开放平台本身即文件系统语义，直接使用 API |
| Google Drive | Drive 本身无目录概念；实现"虚拟目录 = 类型为 folder 的 Drive 文件"，按路径逐级解析 fileId |
| Dropbox | Dropbox 本身即文件系统语义，路径直接映射（去掉 WebDAV 目录尾斜杠） |
| 迅雷网盘 | 开放平台本身即文件系统语义；`list/stat` 按路径逐级解析 fileId（实例 Map 缓存父目录），上传走 S3 兼容分片（AWS SigV4），下载走 getFileLink 302 直链 |

## 3. 模块划分（目录结构）

```
webdav-cloud-drive/
├── README.md                     # 部署与使用说明
├── requirements.md               # 需求分析（本文档的源头）
├── architecture.md               # 本架构文档
├── package.json                  # 工程配置（hono + wrangler + typescript）
├── tsconfig.json
├── wrangler.toml                 # Workers 部署配置（KV/R2/D1/assets 绑定）
├── .gitignore
├── .dev.vars.example             # 本地开发环境变量模板
├── db/
│   └── schema.sql                # D1 建表语句（webdav_logs + 索引）
├── public/                       # Workers Assets 静态资源（Web UI）
│   └── ui/
│       ├── index.html            # 单页：登录 + 文件/配置/日志三 Tab
│       ├── style.css
│       └── app.js                # PROPFIND/PUT/DELETE/MOVE/MKCOL + /api/*
└── src/
    ├── index.ts                  # 入口：装配 + 路由 + Basic Auth + 日志埋点
    ├── config.ts                 # 配置管理（env → 强类型 Config，支持 KV 用户配置合并）
    ├── kv-config.ts              # KV 驱动配置存储（schema/校验/读写/脱敏元数据）
    ├── auth.ts                   # Basic Auth 校验
    ├── types.ts                  # 公共类型（请求上下文等）
    ├── locks.ts                  # KV 锁存储（LOCK/UNLOCK 状态）
    ├── log/
    │   └── d1logger.ts           # D1 日志：log() 写入 / query() 分页查询
    ├── utils/
    │   ├── path.ts               # 路径规范化 / 父子关系 / 拼接
    │   └── xml.ts                # 轻量 XML 解析与 multistatus 生成
    ├── webdav/                   # 协议层：每方法一个模块
    │   ├── router.ts             # 方法分发 + 公共错误处理
    │   ├── responses.ts          # multistatus / 错误响应构造
    │   ├── options.ts
    │   ├── propfind.ts
    │   ├── proppatch.ts
    │   ├── mkcol.ts
    │   ├── get.ts                # GET / HEAD（含 Range）
    │   ├── put.ts
    │   ├── delete.ts
    │   ├── movecopy.ts           # MOVE / COPY 公共实现
    │   └── lock.ts               # LOCK / UNLOCK
    └── storage/                  # 驱动层
        ├── types.ts              # StorageDriver / FileStat / Range 接口
        ├── registry.ts           # 驱动注册与工厂（createDrivers 多驱动装配为 Map）
        ├── s3.ts                 # S3 兼容对象存储（含 R2）：SigV4 客户端
        ├── telegram.ts           # Telegram Bot 存储（KV 索引）
        ├── baidu.ts              # 百度网盘开放平台驱动
        ├── gdrive.ts             # Google Drive（OAuth2 + Drive API v3）
        ├── dropbox.ts            # Dropbox（API v2，token 或 refresh_token）
        └── xunlei.ts             # 迅雷网盘（thunder_browser 方案，refresh_token）
```

## 4. 关键设计决策

| 决策点 | 方案 | 理由 |
| --- | --- | --- |
| Web 框架 | Hono | 轻量、Workers 原生支持、TS 类型友好 |
| XML 处理 | 自研轻量解析（正则 + 手写生成） | 避免大依赖，PROPFIND/PROPPATCH 请求体结构简单 |
| S3 客户端 | 手写 AWS SigV4（fetch 实现） | 免 SDK 体积，R2 与通用 S3 一套代码 |
| 锁存储 | KV | 免费额度内足够；客户端锁行为以兼容为目标 |
| 大文件 | R2/S3 流式读写；Telegram/百度/GDrive/Dropbox 受 Workers 请求体限制 | 在免费约束下达到最优 |
| 认证 | Basic Auth + Workers Secret | 所有桌面客户端原生支持 |
| Web UI | Workers Assets 静态托管 + Hono /api/* | 免 Pages、免 CORS 配置，同域部署 |
| Google Drive 鉴权 | refresh_token → access_token（内存缓存） | 无回调端点需求，OAuth2 配置最简；也避免 Workers 定时任务复杂度 |
| 日志 | D1 + waitUntil 异步写 | 不阻塞响应；查询 API 直接 SQL 分页 |
| 配置展示 | `/api/settings` 返回是否已配置 + `mountedDrivers` 挂载列表 | 不泄露密钥原文；多驱动挂载状态一目了然 |
| 多驱动装配 | `createDrivers(config, env)` 返回 `Map<type, StorageDriver>`，凭据完整的驱动全部装配 | 多存储并存、按需挂载，协议层按 Map 路由 |
| 用户自助配置 | KV（`DRIVER_CONFIG`）持久化用户自填驱动配置 JSON，`buildConfig(env, kv)` 合并（KV 优先、env 兜底） | 新增存储服务无需改代码/重部署，网页表单保存即生效 |
| 虚拟根分区 | 根 `/` 的 PROPFIND 返回各驱动分区目录（目录名=驱动类型）；单驱动兼容根路径直接映射 | 多驱动时文件列表中清晰区分来源，单驱动保持旧体验 |
| 在线预览 | `/api/preview` 内联返回 + Range 支持，前端 video/audio/iframe/img/pre 原生标签 | 大文件渐进播放/查看，无需整文件下载 |
| 分片下载 | 前端并发 Range 分片请求拼接 Blob（单片 ≤80MB） | 绕过 Workers 100MB 响应体上限并提速 |

## 5. 请求处理流程

### 5.1 通用流程（index.ts）

```
请求 → index.ts（Hono all('*')）
     ├─ GET / | /ui → 302 /ui/（静态资源由 [assets] 命中，不经 Worker）
     ├─ /api/* → requireAuth → 路由（logs / download / preview / settings / config）→ 响应
     └─ 其余   → requireAuth（OPTIONS 放行）→ 虚拟分区解析（parseStoragePath）
                 ├─ 虚拟根：PROPFIND → 分区目录响应；OPTIONS → 能力协商；其余 404
                 └─ 驱动分区：dispatch(ctx, storage=目标驱动, path=驱动内部路径)
                 → 统一在返回前 waitUntil(D1Logger.log(...))
```

### 5.2 PROPFIND 示例

```
请求 → index.ts（Hono all('*')）
     → auth.requireAuth(ctx)          [失败 → 401 + WWW-Authenticate]
     → 解析路径（utils/path.normalize）
     → router.dispatch(method, path, ctx)
         ├── OPTIONS → options.ts
         ├── PROPFIND → propfind.ts
         │     ├── 解析 Depth 头 / 请求体 prop
         │     ├── storage.stat(path) → 目标节点
         │     ├── Depth=1 → storage.list(path)
         │     └── responses.buildMultistatus(...)  [XML 响应]
         └── …其余方法同理
```

### 5.3 Web UI 与 API 的配合

- 文件浏览：UI 向 `/` 发送 **PROPFIND（Depth:1）**，根目录返回各驱动分区（目录名=驱动类型）；进入分区后继续 PROPFIND。前端 DOMParser 解析 multistatus XML。
- 上传：UI 向目标路径发送 **PUT**（XMLHttpRequest 以获取上传进度）。
- 下载：UI 调用 **`GET /api/download?path=…`**（支持 Range，返回 206；>50MB 由前端并发分片请求后拼接 Blob）。
- 在线预览：UI 调用 **`GET /api/preview?path=…&auth=…`**，内联返回（无 Content-Disposition attachment），文本/图片/PDF/视频/音频分别用 pre/img/iframe/video/audio 标签加载；`auth` 为 base64(user:pass) 以兼容标签无法携带 Authorization 头；后端支持 Range 由浏览器自动分片流式加载。
- 超大文本：`/api/preview` 对文本类内容最多返回前 500KB（`readUpTo` 截断，附 `X-Preview-Truncated: 1`），前端据此提示"文件过大，仅显示前 500KB"。
- 删除 / 重命名 / 新建文件夹：UI 分别调用 **DELETE / MOVE（Destination 头）/ MKCOL**。
- 配置页：**`GET /api/settings`** 返回驱动配置概览 + `mountedDrivers`。
- 日志页：**`GET /api/logs?limit&offset&method&status`** 返回 D1 日志分页。

## 10. Web UI 自助配置存储服务（本迭代新增）

### 10.1 目标

新增存储服务不再需要"改代码 + `wrangler secret put`"，用户可直接在 Web UI 的「存储配置」页表单中填写驱动配置并保存，**保存后无需重新部署立即生效**。已用 env Secret 配置的驱动行为完全不变。

### 10.2 KV 持久化（DRIVER_CONFIG）

- 新增独立 KV namespace：**`DRIVER_CONFIG`**（`wrangler.toml` 中 `[[kv_namespaces]] binding = "DRIVER_CONFIG"`）。
- Key = 驱动类型名（`s3` / `telegram` / `baidu` / `gdrive` / `dropbox` / `yun139` / `xunlei`），Value = 该驱动完整 Config 对象的 JSON 字符串。
- 部署前置：`npx wrangler kv namespace create DRIVER_CONFIG` 后将返回的 `id` 填入 `wrangler.toml`。

### 10.3 后端 API（/api/config，复用 DAV_USER/DAV_PASS Basic 鉴权）

| 方法 | 语义 |
| --- | --- |
| `GET /api/config` | 返回全部驱动配置的**脱敏元数据**（字段级：类型/必填/是否已配置/来源），**严禁回显任何明文凭据** |
| `PUT /api/config?type=<driver>` | 保存某驱动配置（body = 字段 JSON，可部分更新：未提交字段保留 KV/env 原值） |
| `POST /api/config?type=<driver>` | 与 PUT 同语义 |
| `DELETE /api/config?type=<driver>` | 清除该驱动的 KV 配置（回退到 env 兜底） |

- 校验：type 必须为已知驱动（否则 400）；body 必须为 JSON 对象且非空；仅接受 schema 已知字段（未知字段忽略并提示）；类型错误 400；保存后按 `driverConfigured` 口径校验凭据完整性，不完整则 400 并提示缺少字段。
- 鉴权：`/api/config` 位于 `/api/*` 分支内，统一走 `requireAuth`，未通过一律 401。

### 10.4 配置合并（KV 优先、env 兜底）

```
buildConfig(env, kv?)  [async]
  ├─ 基础配置 = 原 env 解析（零硬编码，Secret 兜底默认）
  └─ 对每个驱动读 KV key=<type>
       ├─ 无 KV 配置 → 维持 env 值（行为不变）
       └─ 有 KV 配置 → 逐字段覆盖（仅覆盖 KV 中出现的字段，缺失字段保留 env 值）
```

- `buildConfig` 改为异步；`index.ts` 的 fetch 装配链路在请求内 `await buildConfig(c.env, c.env.DRIVER_CONFIG)`，因此 KV 保存后下一次请求即生效。
- `createDrivers` 保持同步，消费合并后的 `AppConfig`，装配口径不变（`driverConfigured` 判定凭据完整才挂载）。

### 10.5 前端「存储配置」页

- `public/ui/index.html` 新增 Tab「存储配置」，`app.js` 动态渲染各驱动表单卡片：
  - 字段按 `kv-config.ts` 的 `DRIVER_FIELD_SCHEMAS` 渲染（敏感字段用 `type=password`，布尔字段用下拉/勾选）；
  - 已配置字段不回显明文，输入框占位提示「已配置，留空保持不变」；
  - 保存 = `PUT /api/config?type=<driver>`，清除 = `DELETE /api/config?type=<driver>`；
  - 保存/清除后刷新当前视图，切回「文件」Tab 时自动刷新驱动分区徽标。

### 10.6 安全约束

- 任何凭据**零硬编码**进代码与文档；日志只记录方法/路径/状态码，不记录请求体。
- `/api/config` 响应只含 `set: boolean` 与字段元数据，**不回显明文**；敏感值仅经鉴权后的表单提交写入 KV（KV 值本身为密文存储，仅 Worker 可读）。
- `.dev.vars.example` 补充 KV 占位说明；`wrangler.toml` 注释写明 `kv namespace create` 步骤。

## 11. 自动登录获取凭据服务（本迭代新增）

### 11.1 目标

外挂存储（如迅雷）配置字段多、凭据获取门槛高，用户往往需要自行抓包或借助第三方工具。本服务让系统**代替用户完成第三方登录**：前端弹窗输入账号密码，后端按各驱动协议登录，成功后把 `refreshToken` 等配置字段**自动回填**到配置表单，用户只需点击「保存配置」即可生效。

### 11.2 统一框架：/api/auth/<driver>/<action>（AUTH_PROVIDERS 注册表）

- 路由前缀 `/api/auth/<driver>/<action>`，位于 `/api/*` 分支内，统一走 `requireAuth`（DAV_USER/DAV_PASS Basic 鉴权），未通过一律 401。
- `src/auth/index.ts` 以 `AUTH_PROVIDERS` 注册表组织各驱动登录实现：`parseAuthPath` 解析 `/api/auth/<driver>/<action>`，`handleAuthApi` 分发到注册表实现；当前仅 `action=login`。
- 后续新增驱动只需实现 `AuthProvider`（`src/auth/types.ts` 接口：`driver` + `login(params)`）并注册进 `AUTH_PROVIDERS`，入口零改动。
- 请求/响应契约：
  - `POST /api/auth/<driver>/login`，body = JSON 对象（如 `{ username, password, safePassword? }`）；
  - 成功：`{ ok: true, fields: { refreshToken, accessToken?, accessTokenExpiresAt?, deviceId?, userAgent? }, message }`；
  - 失败：`{ ok: false, error, kind }`，`kind` ∈ `invalid`(400，入参/凭据错误) / `verify`(409，需人工处理验证码或风控) / `upstream`(502，上游异常)。

### 11.3 迅雷自动登录（POST /api/auth/xunlei/login）

`src/auth/xunlei-login.ts` 移植 AList `thunder_browser` 驱动（`util.go` / `driver.go` / `meta.go`）的 `xluser-ssl.xunlei.com/v1` 登录协议：

- **内置 client 凭据**：`client_id=ZUBzD9J_XPXfn7f7`、`client_secret=yESVmHecEe6F0aou69vl-g`、`client_version=1.10.0.2633`、`package_name=com.xunlei.browser`（与 `xunlei.ts` 常量对齐，代码内硬编码，不落库）。
- **设备 ID 派生**：`device_id = md5hex(username + password)`（与 AList Login 模式一致）。
- **captcha_token 获取**：登录前 `POST /v1/shield/captcha/init`，按 username 形态填 `email` / `phone_number` / `username` meta；请求附带 `captcha_sign`（内置 `Algorithms` 逐段 MD5 链签名 + 毫秒时间戳）；响应含 `url` 时判定为需人工验证（409 verify），空 `captcha_token` 视为上游异常（502）。
- **登录**：`POST /v1/auth/signin`，body 携带 `captcha_token / client_id / client_secret / username / password`；响应 `error_code=9 & captcha_invalid` 时**重新获取 captcha_token 并重试一次**（第二次失败直接报错）。
- **成功回填**：`refreshToken`（必填）+ `accessToken` / `accessTokenExpiresAt`（登录响应含 `expires_in` 时按当前时间换算秒级时间戳）+ `deviceId` / `userAgent`（均为 xunlei 配置 schema 已有字段，可一并回填）。
- **safePassword（可选）**：入参接受但本阶段不参与业务（AList 中用于超级保险箱 space token，xunlei schema 无对应存储位），文档注明。

### 11.4 前端：配置卡片「自动登录获取凭据」

- xunlei 配置卡片（`app.js` `renderDriverFormCard`）新增按钮「自动登录获取凭据」。
- 点击弹出模态框（复用 `.modal-overlay` 样式）：账号（必填）/ 密码（必填）/ 安全密码（可选）。
- 提交后 `POST /api/auth/xunlei/login`（携带 Basic 凭据与 JSON body）；成功后把 `fields` 逐项回填到表单对应 `data-field` 输入框，`refreshToken` 输入框短暂高亮（`.auth-filled`），卡片消息提示「已获取，请保存」；失败在弹窗内展示错误（`kind=verify` 时提示需人工处理验证）。
- 新增 UI 样式：`.config-msg.ok-flash`（成功高亮消息）、`.auth-filled`（输入框绿色描边）。

### 11.5 安全约束

- 登录密码仅存在于**请求体内**：不落库、不写日志（D1 日志只记方法/路径/状态码）、不回显。
- 响应只回传可回填配置的凭据字段（`refreshToken` / `accessToken` 等），**绝不回传密码**或任何未要求的中间值。
- 前端弹窗密码框 `autocomplete=current-password`，关闭/成功即移除 DOM，密码不写入 sessionStorage。

## 6. 多存储虚拟根分区与在线预览（本迭代升级）

### 6.1 多驱动装配（A）

- `registry.ts` 以 `createDrivers(config, env): Map<string, StorageDriver>` 取代单实例工厂：对凭据完整的 s3 / telegram / baidu / gdrive / dropbox / yun139 / xunlei 逐一创建驱动实例，key 为驱动类型名。
- 凭据完整性判定由 `config.driverConfigured(key, config)` 统一提供，registry 装配与 `/api/settings` 展示共用同一口径。
- 无任何驱动配置时 Map 为空：根目录 PROPFIND 返回空列表，`/api/settings` 提示无可用存储。

### 6.2 虚拟根分区与路径路由

- 根 `/` 为虚拟根：PROPFIND 返回各已装配驱动的虚拟目录（目录名即驱动类型名，如 `gdrive/`、`dropbox/`）。
- 非根路径 `/ <driver> / <子路径>`：按首段解析驱动实例，剩余路径作为该驱动内部路径（以 `/` 开头、目录以 `/` 结尾，与 StorageDriver 契约一致）。
- **兼容策略（单驱动直接映射）**：仅装配一个驱动时，除 `/ <driver>/…` 分区外，任何不以驱动名开头的路径（如 `/foo.txt`）也直接映射到该唯一驱动——WebDAV 客户端在根下直接浏览/上传的行为保持不变；根目录仍列出该服务分区，进入分区后正常。
- 多驱动时未命中任何分区的路径返回 404；虚拟根上除 PROPFIND / OPTIONS 外的方法返回 404（不能对虚拟根做写操作）。
- 路径 normalize 全程在分区解析之前进行，服务分区段不会被当作文件名编码；GDrive 内部仍走其 `resolveNode` 解析。
- MOVE / COPY 的 Destination 头经 `ctx.resolveInnerPath()` 映射到当前驱动内部路径；跨驱动移动返回 400。

### 6.3 在线预览（B）与分片下载（C）

- 新增 `GET /api/preview?path=<内部 WebDAV 路径>&auth=<base64(user:pass)>`：
  - 认证优先取 `auth` query 参数（兼容 `<video>/<audio>/<iframe>/<img>` 标签无法携带 Authorization 头），缺失时回退 Basic Auth 头；
  - 响应不带 `Content-Disposition: attachment`（内联展示），Content-Type 按文件类型返回；Google 原生格式复用导出逻辑（`nativeExportMime` 映射）；
  - 支持 `Range` 头（复用 `parseRange`），返回 206 + Content-Range，供浏览器对 PDF/视频/音频渐进分片加载。
- `/api/download` 同步支持 `Range`（206），供前端大文件分片下载。
- 前端分片下载：文件 >50MB 时按并发 6 片均分，单片 clamp 至 ≤80MB（`chunkSize = min(80MB, size/6)`），并发 Range 请求、整体进度条、按序拼接 Blob 后触发保存；小文件保持单请求直下。
- 超大文本预览：`/api/preview` 对文本类内容用 `readUpTo` 截断至前 500KB（附 `X-Preview-Truncated: 1`），前端提示已截断。

## 6.5 迅雷网盘驱动（xunlei，thunder_browser 方案）

### 6.5.1 方案来源与鉴权

- 驱动 `xunlei.ts` 移植自 AList `thunder_browser` 驱动（内置 `com.xunlei.browser` 客户端凭据），API 基址 `https://x-api-pan.xunlei.com/drive/v1`。
- 必填凭据为 `refreshToken`（迅雷浏览器客户端的刷新令牌）；`accessToken` 仅作缓存，缺失/过期时用 refreshToken 刷新。
- 刷新令牌默认 30 天有效（AList 语义 `Valid: true` 时以 `expires_in` 为准，否则按 30 天乐观处理）；剩余有效期不足 15 天（`exp < now + 15d`）且无 refreshToken 时拒绝访问。
- 请求鉴权：`Bearer <accessToken>` + `X-Captcha-Token`（`sign` 签名字段，基于客户端 ID/Secret 与请求体哈希的 SHA1 签名）。

### 6.5.2 路径与目录模型

- 虚拟根分区名 `xunlei/`；内部路径以 `/` 开头、目录以 `/` 结尾，与 StorageDriver 契约一致。
- `list`：`POST /drive/v1/files`（parentID=根时取 `root` 的 fileId），返回子项并映射 `FileStat`。
- `stat`：按路径逐级解析父目录 fileId（实例内 `Map<path, fileId>` 缓存父目录解析结果，失效自动重查）。
- `mkdir`：`POST /drive/v1/files`（kind=folder），幂等处理"同名已存在"。

### 6.5.3 传输

- 下载：`POST /drive/v1/files/{fileId}/download` 取 302 直链，`read()` 跟随重定向流式返回，支持 `Range`（透传 `Range` 头）。
- 上传（小文件）：`POST /drive/v1/files`（kind=file，父目录 uploadType=resumable）→ 单请求 PUT 到 `resumable.params` 的 S3 预签名 URL（AWS SigV4）。
- 上传（大文件，>5MB）：AList resumable 上传逻辑逐行移植：`PUT /drive/v1/files/{fileId}/content` 建任务 → 按 5MB 分片经 `resumable.params`（S3 预签名）逐个 `PUT` → `POST /drive/v1/files/{fileId}/content` 完成。GCID（迅雷内容指纹）与 S3 SigV4 签名均为纯 TS 实现（SHA1/HMAC/UTF-8 手写，避免依赖 node:crypto）。
- `move` / `copy` / `remove` 走 `POST /drive/v1/files/{fileId}/move|copy|trash`（remove 即移入回收站 trash）。

### 6.5.4 已知限制

- **token 过期需人工刷新**：当前实现仅在访问时发现凭据失效返回明确错误；`refreshToken` 本身过期后无法静默续期，可通过「存储配置」页 xunlei 卡片的**自动登录获取凭据**（见 §11）重新获取并保存。
- **Workers 请求体限制**：上传受 Cloudflare Workers 单请求体上限约束，超 100MB 文件在浏览器端需依赖分片/外部工具；下载不受影响（流式）。
- **captcha 签名依赖客户端固定密钥**：签名仅用于满足 API 的 `X-Captcha-Token` 校验，不保证长期有效；若迅雷收紧校验，需更新签名算法或切换开放平台方案（`alist_thunder`）。
- 未实现：分享/离线下载/秒传等迅雷特有能力，仅覆盖 WebDAV 基本文件语义。
- 目录删除为非空递归（trash 语义），与 WebDAV DELETE 的递归行为一致。

## 7. 扩展新存储驱动指南

1. 在 `src/storage/` 新建 `xxx.ts`，实现 `StorageDriver` 全部方法。
2. 在 `registry.ts` 的 `createDrivers` 装配表中注册驱动实例工厂。
3. 在 `config.ts` 增加对应配置字段；在 `.dev.vars.example`、`README.md` 补充说明。
4. 在 `wrangler.toml` 增加需要的 binding（KV/R2/Secret）。

协议层、入口层均无需改动 —— 这是本架构低耦合的核心体现。

## 8. 网络出站机制（重要）

### 8.1 服务端出站由 Cloudflare 边缘发起

Workers 运行时位于 Cloudflare 全球边缘网络，**服务端发出的所有出站请求**（fetch 调用 Telegram Bot API、Google Drive API、Dropbox API、百度开放平台等）**均由 Cloudflare 边缘节点直接发起**，天然具备访问公网能力：

- 用户本地**无需任何代理、无需科学上网**，即可通过本服务对 TG、Google Drive、Dropbox 等外网网盘文件执行上传、下载、删除、重命名等操作；
- 边缘直连 api.telegram.org、googleapis.com、api.dropboxapi.com 等域名，无需额外配置；
- 用户的 WebDAV 客户端 / 浏览器只与本 Worker 域名通信，不直接访问外网网盘。

### 7.2 入站域名限制与自定义域名

- Cloudflare 默认提供的 `*.workers.dev` 域名在**中国大陆访问受限**（DNS 污染 / 阻断）。
- 国内用户使用时应**绑定自定义域名**：
  1. 在 Cloudflare 控制台将域名（或其子域，如 `dav.example.com`）添加 DNS 记录；
  2. 使用 Workers 的 **Custom Domains**（自定义域）功能绑定到本 Worker；
  3. 或在 Workers 路由（Routes）中配置 `dav.example.com/*` 指向本 Worker。
- 绑定后，WebDAV 挂载地址与 Web UI 地址均使用自定义域名，国内可直接访问。

## 9. 部署架构

- 代码部署：`wrangler deploy`（Workers，全球边缘）。
- 资源：3 个 KV namespace（`DAV_LOCKS` 锁、`TELEGRAM_INDEX` Telegram 索引、`DRIVER_CONFIG` 驱动自助配置）+ 1 个 R2 bucket + 1 个 D1 数据库（`LOGS_DB`，建表见 `db/schema.sql`）。
- 静态资源：`[assets] directory = ./public`，由 Workers 直接托管。
- 密钥：`dav_user` / `dav_pass` / 各存储凭据均以 `wrangler secret put` 注入。
- 自定义域名：Cloudflare 控制台绑定，启用后即为 WebDAV 服务地址。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
