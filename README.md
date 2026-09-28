# WebDAV Cloud Drive

基于 **Cloudflare Workers** 的 WebDAV 云盘服务：一个可直接部署的 WebDAV 服务器 + 浏览器
Web UI，可挂载到 Windows 资源管理器 / macOS Finder / rclone / Cyberduck / RaiDrive，
支持 **Google Drive、Telegram、S3（R2）、百度网盘、Dropbox、中国移动云盘（139/和彩云）**
多种存储后端。
借助 Cloudflare 边缘网络，**无需本地任何代理**即可直接对外网网盘文件执行增删改操作。

## 功能特性

- **标准 WebDAV 协议**：OPTIONS / PROPFIND / PROPPATCH / MKCOL / GET / HEAD / PUT /
  DELETE / MOVE / COPY / LOCK / UNLOCK，HTTP Basic Auth 鉴权（`DAV_USER` / `DAV_PASS`）。
- **多存储虚拟根分区**：根路径按已装配驱动列出分区（`/gdrive/`、`/telegram/` 等），
  协议层与驱动层完全解耦；只配单一驱动时兼容无前缀根路径直接映射。
- **六种存储后端**，统一 `StorageDriver` 接口：

  | 类型 | `STORAGE_TYPE` | 后端 |
  | --- | --- | --- |
  | Google Drive | `gdrive` | Drive API v3（OAuth2 refresh_token），目录逐级解析 fileId |
  | Telegram | `telegram` | Bot API 存储（KV 索引 file_id），支持入站消息自动同步 |
  | S3 兼容对象存储 | `s3` | AWS S3 / Cloudflare R2（默认），流式读写适合大文件 |
  | 百度网盘 | `baidu` | 百度开放平台 xpan REST API |
  | Dropbox | `dropbox` | Dropbox API v2（token / refresh_token） |
  | 中国移动云盘 | `yun139` | 139/和彩云 personal_new API（Authorization 凭据，token 自动刷新） |

- **Telegram 入站自动同步**：向配置的 chat 发送文件后，list/stat 时自动增量拉取
  `getUpdates` 同步到分区根目录（`>20MB` 跳过，同名加 `-1` 后缀，offset 存 KV）。
- **在线预览**：`GET /api/preview?path=/<driver>/...` 内联返回文件，支持 Range。
- **分片下载**：WebDAV GET 与 `/api/download` 均支持 `Range` 请求（206 响应），
  断点续传友好；R2/S3 流式读写不受请求体上限约束。
- **浏览器 Web UI**（Workers Assets 直接托管，访问 `/ui/`）：文件浏览 / 上传（带进度）/
  下载 / 删除 / 重命名 / 新建文件夹；分区服务名徽标与面包屑导航（`Alt+↑` / `Backspace`
  返回上级）；驱动配置查看页（不泄露密钥）；D1 请求日志查看页（方法 / 路径 / 状态码 /
  耗时 / 存储后端，支持过滤分页）。
- **D1 持久化请求日志**：`GET /api/logs` 分页查询；写入走 `waitUntil` 异步，不阻塞响应。
- **KV 存储**：WebDAV 锁状态（`DAV_LOCKS`）与 Telegram 索引（`TELEGRAM_INDEX`）。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 运行时 | Cloudflare Workers（`nodejs_compat`） |
| 框架 | Hono（TypeScript） |
| 存储 | R2（对象存储）/ KV（锁与索引）/ D1（请求日志） |
| 静态资源 | Workers Assets（`./public`，无需单独 Pages） |

## 代码结构

```
webdav-cloud-drive/
├── README.md / requirements.md / architecture.md
├── package.json / tsconfig.json / wrangler.toml / .gitignore
├── .dev.vars.example              # 本地开发环境变量模板
├── db/schema.sql                  # D1 建表语句（webdav_logs）
├── docs/
│   ├── usage.md                   # 使用说明：客户端挂载 / UI / 分区
│   └── deployment.md              # 部署说明：资源创建 / Secret / 域名
├── public/ui/                     # Web UI 静态资源
│   ├── index.html                 # UI 入口页
│   ├── style.css                  # 样式
│   └── app.js                     # 交互逻辑（浏览/上传/配置/日志）
└── src/
    ├── index.ts                   # 入口：路由分发 + Basic Auth + 日志埋点 + 虚拟根分区
    ├── config.ts                  # 配置管理（六驱动 + LogConfig，Secret 零硬编码）
    ├── auth.ts                    # HTTP Basic Auth 校验
    ├── types.ts                   # DavContext / DavError 等公共类型
    ├── locks.ts                   # WebDAV LOCK/UNLOCK 的 KV 锁管理
    ├── log/d1logger.ts            # D1 日志封装（log / query 分页）
    ├── utils/
    │   ├── path.ts                # 路径规范化 / 编码 / 父子路径工具
    │   └── xml.ts                 # WebDAV XML 响应（multistatus / 错误体）
    ├── webdav/                    # WebDAV 协议层（每方法一模块）
    │   ├── router.ts              # 方法 → 处理器分发 + 统一错误处理
    │   ├── options.ts             # OPTIONS（能力协商）
    │   ├── propfind.ts            # PROPFIND（列目录 / 属性）
    │   ├── proppatch.ts           # PROPPATCH（属性修改）
    │   ├── mkcol.ts               # MKCOL（建目录）
    │   ├── get.ts                 # GET/HEAD（支持 Range 分片）
    │   ├── put.ts                 # PUT（上传）
    │   ├── delete.ts              # DELETE
    │   ├── movecopy.ts            # MOVE / COPY
    │   ├── lock.ts                # LOCK / UNLOCK
    │   └── responses.ts           # 响应头 / ETag 构造
    └── storage/                   # 驱动层（统一 StorageDriver 接口）
        ├── types.ts               # StorageDriver / FileStat / Range 等接口
        ├── registry.ts            # 驱动工厂（按配置完整性装配）
        ├── s3.ts                  # S3 / R2 驱动
        ├── telegram.ts            # Telegram 驱动（含入站同步 syncUpdates）
        ├── baidu.ts               # 百度网盘驱动
        ├── gdrive.ts              # Google Drive 驱动（含原生格式导出）
        ├── dropbox.ts             # Dropbox 驱动
        └── yun139.ts              # 中国移动云盘驱动（139/和彩云 personal_new）
```

## 快速开始

```bash
npm install
npx wrangler login                # 授权 Cloudflare 账号
npx wrangler kv namespace create DRIVER_CONFIG   # 自助配置存储服务（KV 持久化）
npx wrangler d1 execute webdav-logs --remote --file=db/schema.sql   # 建 D1 表
npx wrangler secret put DAV_USER  # 输入用户名
npx wrangler secret put DAV_PASS  # 输入密码
npx wrangler deploy
```

> 创建 KV 后需将输出 id 回填到 `wrangler.toml` 的 `DRIVER_CONFIG` 绑定（同 `DAV_LOCKS` 等）。

> 完整流程（R2 / KV / D1 创建、wrangler.toml 回填、Secret 清单、自定义域名绑定）见
> **[docs/deployment.md](./docs/deployment.md)**。
> CI 自动部署：push 到 main 分支自动触发 GitHub Actions 部署，也可手动触发；
> 需在仓库配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` Secrets，详见
> **[docs/deployment.md](./docs/deployment.md)「GitHub Actions 自动部署」**。
> 本地开发：`cp .dev.vars.example .dev.vars` 后 `npx wrangler dev`（默认 `http://localhost:8787`）。

## 使用说明

> 详见 **[docs/usage.md](./docs/usage.md)**。

- WebDAV 挂载地址：`https://webdav.915577.xyz/`（端口 443），账号 `<DAV_USER>` / `<DAV_PASS>`；
- 浏览器 UI：`https://webdav.915577.xyz/ui/`；
- 分区：`/gdrive/`（大文件）、`/telegram/`（单文件 20MB 上限、支持入站自动同步）等；
- 客户端示例：Cyberduck（WebDAV HTTPS）、RaiDrive（WebDAV）、rclone（`type = webdav`）。

## 各驱动配置

> 公共：`STORAGE_TYPE` 选择默认驱动；`LOG_ENABLED=true` 开启 D1 日志（默认开）。
> 所有密钥放入 `.dev.vars` 做本地开发，线上用 `wrangler secret put`。
>
> **自 v2 起支持 Web UI 自助配置**：绑定 `DRIVER_CONFIG` KV 后，可在
> 「存储配置」页在线填写各驱动配置并保存，立即生效、无需改代码或重新部署；
> 用户配置优先于环境变量。详见 **[docs/usage.md](./docs/usage.md)「5.1 存储配置」**。

| 驱动 | 必填 Secret | 可选变量 |
| --- | --- | --- |
| `s3` | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_FORCE_PATH_STYLE` |
| `telegram` | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 绑定 `TELEGRAM_INDEX`（KV） |
| `baidu` | `BAIDU_APP_ID` / `BAIDU_ACCESS_TOKEN` | `BAIDU_USER_AGENT` |
| `gdrive` | `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET` / `GDRIVE_REFRESH_TOKEN` | `GDRIVE_ROOT_ID` |
| `dropbox` | `DROPBOX_ACCESS_TOKEN`（或 `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET`） | — |
| `yun139` | `YUN139_AUTHORIZATION`（base64("pc:\<账号\>:\<token\|...\|exp\>")） | — |

**Google Drive refresh_token 获取**（一次性）：

1. [Google Cloud Console](https://console.cloud.google.com/) 创建项目并启用 **Google Drive API**；
2. 创建 OAuth 2.0 客户端（类型 Web），记录 client_id / client_secret，`http://localhost` 加入授权重定向 URI；
3. 浏览器打开授权链接（替换 `<CLIENT_ID>`）获取 code：
   ```
   https://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive&redirect_uri=http%3A%2F%2Flocalhost&response_type=code&client_id=<CLIENT_ID>&access_type=offline&prompt=consent
   ```
4. 用 code 换取 refresh_token：
   ```bash
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET> \
     -d code=<CODE> -d grant_type=authorization_code -d redirect_uri=http://localhost
   ```

## 网络出站说明（无需本地代理）

- 本服务对 Telegram、Google Drive、Dropbox、百度等后端的访问，**全部由 Cloudflare 边缘网络
  服务端发起**，用户本地（浏览器 / 资源管理器 / rclone）**无需任何代理**即可对外网网盘
  文件做增删改操作。
- 国内访问限制：Cloudflare 默认 `*.workers.dev` 域名在中国大陆访问受限。国内使用请绑定
  **自定义域名**（如 `webdav.915577.xyz`），绑定后即可直接访问。

## 已知限制

- Workers 免费版请求体上限 100MB：Telegram / 百度 / Google Drive / Dropbox / 中国移动云盘
  单文件上传受此限制（Telegram 因 `getFile` 下载上限，单文件建议 ≤ 20MB；其余建议 ≤ 50MB
  稳妥）；R2/S3 流式上传不受此限制，适合大文件。
- Telegram / 百度 / Google Drive / Dropbox / 中国移动云盘下载为服务端中转，大文件下载受
  Workers 响应体与 CPU 时长限制（免费版 10ms CPU/请求，IO 等待不计）。
- 中国移动云盘（yun139）凭据 `YUN139_AUTHORIZATION` 内嵌 token 有效期：剩余 <15 天自动
  刷新；token 已过期或刷新失败时需重新获取并更新该 Secret。驱动不做密码登录恢复。
- KV 免费额度有限：锁与索引条目极小（< 1KB），勿用于存储大对象。
- Google Drive / Dropbox 目录层次较深时路径解析涉及多次 API 调用，深度建议 ≤ 20 层。
- WebDAV 为"尽力兼容"实现：Windows 资源管理器 / macOS Finder / rclone / Cyberduck /
  RaiDrive 为主要验证对象，其他客户端的边缘行为可能不完全兼容。

## License

MIT
