# 部署说明（Deployment）

本文档说明如何从零部署 webdav-cloud-drive 到 Cloudflare Workers，并绑定自定义域名。
使用说明请见 [usage.md](./usage.md)。

## 1. 前置条件

- Node.js ≥ 18（推荐 20 LTS）与 npm；
- Cloudflare 账号（免费版即可）；
- wrangler CLI（项目内已含，直接用 `npx wrangler` 或全局安装 `npm i -g wrangler`）；
- 若本机网络无法直连 Cloudflare API，请先配置代理（如 `HTTPS_PROXY` 环境变量），
  本服务运行期访问 Telegram / Google Drive 等外网后端由 **Cloudflare 边缘网络发起**，
  无需本地代理。

```bash
npm install
npx wrangler login   # 浏览器授权 Cloudflare 账号
```

## 2. 创建云资源（一次即可）

```bash
# ① R2 bucket（s3 驱动使用；若只用 gdrive/telegram 可跳过）
npx wrangler r2 bucket create webdav-cloud-drive

# ② KV namespace × 3：WebDAV 锁 + Telegram 索引 + 驱动自助配置
npx wrangler kv namespace create DAV_LOCKS
npx wrangler kv namespace create TELEGRAM_INDEX
npx wrangler kv namespace create DRIVER_CONFIG

# ③ D1 database（请求日志持久化）
npx wrangler d1 create webdav-logs
```

## 3. 回填 wrangler.toml

将上一步输出中的资源 ID 填入 `wrangler.toml` 对应字段：

```toml
[[kv_namespaces]]
binding = "DAV_LOCKS"
id = "<DAV_LOCKS_KV_ID>"            # 替换为 kv create DAV_LOCKS 输出的 id

[[kv_namespaces]]
binding = "TELEGRAM_INDEX"
id = "<TELEGRAM_INDEX_KV_ID>"       # 替换为 kv create TELEGRAM_INDEX 输出的 id

[[kv_namespaces]]
binding = "DRIVER_CONFIG"
id = "<DRIVER_CONFIG_KV_ID>"        # 替换为 kv create DRIVER_CONFIG 输出的 id；Web UI 自助配置存储服务持久化

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "webdav-cloud-drive"

[[d1_databases]]
binding = "LOGS_DB"
database_name = "webdav-logs"
database_id = "<D1_DATABASE_ID>"    # 替换为 d1 create webdav-logs 输出的 database_id
```

非敏感配置（`[vars]`）可按需调整：

```toml
[vars]
STORAGE_TYPE = "gdrive"   # 默认驱动：s3 | telegram | baidu | gdrive | dropbox
LOG_ENABLED = "true"      # D1 请求日志开关
```

## 4. 初始化 D1 建表

```bash
npx wrangler d1 execute webdav-logs --remote --file=db/schema.sql
# 本地开发可加 --local
```

## 5. 注入敏感凭据（Secret）

> 所有密钥一律通过 `wrangler secret put` 注入，**严禁**写入 `wrangler.toml` 或提交到仓库。

必填（Basic Auth + 默认驱动所需）：

```bash
npx wrangler secret put DAV_USER                # WebDAV/UI 登录用户名
npx wrangler secret put DAV_PASS                # WebDAV/UI 登录密码
npx wrangler secret put TELEGRAM_BOT_TOKEN      # Telegram 驱动（BotFather 创建）
npx wrangler secret put TELEGRAM_CHAT_ID        # Telegram 存储目标 chat/频道 ID
npx wrangler secret put GDRIVE_CLIENT_ID        # Google Drive OAuth 客户端 ID
npx wrangler secret put GDRIVE_CLIENT_SECRET    # Google Drive OAuth 客户端密钥
npx wrangler secret put GDRIVE_REFRESH_TOKEN    # Google Drive 离线 refresh_token
```

按需（使用对应驱动时配置）：

| 变量 | 对应驱动 |
| --- | --- |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | s3（R2 面板创建 API Token） |
| `BAIDU_APP_ID` / `BAIDU_ACCESS_TOKEN` | baidu |
| `DROPBOX_ACCESS_TOKEN`（或 `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET`） | dropbox |

各驱动的凭据获取方式与可选变量（`S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` /
`S3_FORCE_PATH_STYLE` / `BAIDU_USER_AGENT` / `GDRIVE_ROOT_ID` 等）参见项目 README。

### 5.1 Web UI 自助配置存储服务（可选）

自 v2 起支持通过 Web UI「存储配置」页在线填写驱动配置并保存生效，**替代**部分
`wrangler secret put` 流程（无需改代码、无需重新部署）：

- 配置以 JSON 持久化到 `DRIVER_CONFIG` KV namespace，key 为驱动类型名
  （`s3` / `telegram` / `baidu` / `gdrive` / `dropbox` / `yun139`）；
- 用户自填配置**优先**于环境变量，env Secret 作为兜底默认值；
- 保存后下一次请求即按新配置装配驱动（配置合并发生在每次请求的装配链路中）；
- 页面仅回显字段是否已配置及其来源（页面 / 环境变量），**永不回显明文凭据**；
- 已配置字段留空保存 = 保持不变；提供「清除页面配置」回退环境变量。

> 该 API（`/api/config`）与 WebDAV 共用 `DAV_USER` / `DAV_PASS` Basic 鉴权，
> 未鉴权一律 401。注意 KV 配置在 Workers 边缘最终一致，保存后可能有数秒延迟。

## 6. 本地开发（可选）

```bash
cp .dev.vars.example .dev.vars   # 填入本地凭据（与线上 Secret 同名）
npx wrangler dev                 # 默认 http://localhost:8787
```

浏览器打开 `http://localhost:8787/ui/`；WebDAV 挂载地址为 `http://localhost:8787/`。

## 7. 部署

```bash
npx wrangler deploy
```

## 8. 绑定自定义域名

1. 在 Cloudflare 控制台将域名（如 `webdav.915577.xyz`）接入当前账号（DNS 托管到 Cloudflare）；
2. Workers & Pages → 选择 `webdav-cloud-drive` Worker → **设置 → 域和路由 → 添加自定义域**；
3. 输入 `webdav.915577.xyz`，等待证书签发（一般数分钟）；
4. 绑定后访问 `https://webdav.915577.xyz/ui/` 验证 Web UI，用 Cyberduck/rclone 验证 WebDAV 挂载。

> 绑定自定义域名可同时解决 `*.workers.dev` 域名在中国大陆访问受限的问题。

## 9. GitHub Actions 自动部署

项目内置 CI 工作流 `.github/workflows/deploy.yml`：**push 到 main 分支自动部署**，
也可在 GitHub 仓库 Actions 页面点击 **Run workflow** 手动触发（`workflow_dispatch`）。

### 9.1 配置仓库 Secrets

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置两个 Secret：

| Secret | 值 | 获取方式 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | Cloudflare dashboard → **My Profile → API Tokens → Create Token** → 模板选 **Edit Cloudflare Workers**；Account Resources 选你的账号，Zone Resources 选 **All zones** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID | Cloudflare dashboard 首页右侧 **Account ID**（32 位十六进制字符串） |

也可使用 gh CLI 配置：

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

### 9.2 触发方式

- **自动**：push / merge 到 `main` 分支 → 自动运行 `Deploy Worker` 工作流；
- **手动**：GitHub Actions 页面 → 选择 `Deploy Worker` → **Run workflow**（可选填分支）。

### 9.3 工作流内容

1. `actions/checkout@v4` 拉取代码；
2. `actions/setup-node@v4` 安装 Node 20（LTS）；
3. `npm ci` 按 `package-lock.json` 锁定安装依赖；
4. `npm run build` 执行类型检查（`tsc --noEmit`）；
5. `cloudflare/wrangler-action@v3` 执行 `wrangler deploy`，认证使用
   `secrets.CLOUDFLARE_API_TOKEN` 与 `secrets.CLOUDFLARE_ACCOUNT_ID`。

> 注意：首次部署前仍需手动完成云资源创建与 `wrangler secret put` 凭据注入
> （见本文档第 2、5 节）；CI 只负责发布代码，不创建资源。

## 10. 部署后验证清单

- [ ] `https://webdav.915577.xyz/ui/` 弹出 Basic Auth 并可登录；
- [ ] WebDAV 根路径 `PROPFIND` 返回已装配分区（如 `/gdrive/`、`/telegram/`）；
- [ ] 向配置的 Telegram chat 发送一个文件，刷新 `/telegram/` 可见自动同步；
- [ ] `/api/logs` 能查询到请求日志（需开启 `LOG_ENABLED`）。
