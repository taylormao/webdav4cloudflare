---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 932475866bc48bd2f98012d270878988_6612ca15bafb11f1a1bf52540064ee0f
    ReservedCode1: J7Rd0LT2hBnxidndjHBlbgjuOKMpdUr7YFgfsgCnxO+psK0W3p+DnadIj038swRmGRNYGdDLjcGb4BtKFc+z7Nn7RUwJTgRt9OoBNQyCOS+gSEKA2s7qevYqcjgc732/BguEoTSe/LrzEg7+zay4LX+D0W7tBC9l8QoYhEzg8/Sd2m8sWHekSaBp1qM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 932475866bc48bd2f98012d270878988_6612ca15bafb11f1a1bf52540064ee0f
    ReservedCode2: J7Rd0LT2hBnxidndjHBlbgjuOKMpdUr7YFgfsgCnxO+psK0W3p+DnadIj038swRmGRNYGdDLjcGb4BtKFc+z7Nn7RUwJTgRt9OoBNQyCOS+gSEKA2s7qevYqcjgc732/BguEoTSe/LrzEg7+zay4LX+D0W7tBC9l8QoYhEzg8/Sd2m8sWHekSaBp1qM=
---

---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 932475866bc48bd2f98012d270878988_6be703cbbaf811f1a1bf52540064ee0f
    ReservedCode1: XNJQgCPDIzk1fsXJkUO/LgtyInTsiN8ASnZTkiuOGQmO2nOVoyCL5oGsEgRqiQwlnIhc/5F8rC2KEMcKsxypw0xIquDCKIPlozhXHGk9fAwjUIVLqVpW7y3qTKA1iWWoTNt4O26/wvsz3m/4dfX81leul3k1QD1g1OvywfvMc6m33VPKN6Ezbwro1cs=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 932475866bc48bd2f98012d270878988_6be703cbbaf811f1a1bf52540064ee0f
    ReservedCode2: XNJQgCPDIzk1fsXJkUO/LgtyInTsiN8ASnZTkiuOGQmO2nOVoyCL5oGsEgRqiQwlnIhc/5F8rC2KEMcKsxypw0xIquDCKIPlozhXHGk9fAwjUIVLqVpW7y3qTKA1iWWoTNt4O26/wvsz3m/4dfX81leul3k1QD1g1OvywfvMc6m33VPKN6Ezbwro1cs=
---

# 使用说明（Usage）

本文档说明部署完成后如何通过 WebDAV 客户端与浏览器 UI 使用本服务。
部署步骤请见 [deployment.md](./deployment.md)。

## 1. 服务入口

| 用途 | 地址 | 说明 |
| --- | --- | --- |
| WebDAV 挂载地址 | `https://webdav.915577.xyz/` | 端口 `443`（HTTPS），所有 WebDAV 客户端使用 |
| 浏览器 UI | `https://webdav.915577.xyz/ui/` | 文件管理 / 配置 / 日志页面 |

访问根路径 `/` 会自动 302 跳转到 `/ui/`。

## 2. 认证

本服务使用 HTTP Basic Auth，所有请求（WebDAV + UI + API）共用一套凭据：

- 用户名：`<DAV_USER>`
- 密码：`<DAV_PASS>`

凭据通过 `wrangler secret put` 注入线上环境（本地开发写入 `.dev.vars`），
具体配置位置见 [deployment.md](./deployment.md) 第 6 节。请将 `<DAV_USER>` / `<DAV_PASS>`
替换为你部署时实际设置的值。

## 3. 存储分区说明（多存储虚拟根分区）

服务启动时，会依据各驱动凭据是否齐全自动装配驱动，根路径下列出所有已装配的**分区**，
每个分区对应一个存储后端：

| 分区 | 后端 | 特点与限制 |
| --- | --- | --- |
| `/gdrive/` | Google Drive | 大文件友好：R2/S3 流式读写，下载支持 Range 分片续传 |
| `/telegram/` | Telegram Bot | 单文件上限 **20MB**（Bot API 下载上限）；支持入站消息自动同步 |
| `/s3/` | S3 / R2 | 大文件友好：流式读写，无请求体上限问题 |
| `/baidu/` | 百度网盘 | 受 Workers 请求体上限（100MB）约束 |
| `/dropbox/` | Dropbox | 受 Workers 请求体上限（100MB）约束 |
| `/yun139/` | 中国移动云盘（139 / 和彩云） | 受 Workers 请求体上限（100MB）约束；凭据过期需手动更新 |
| `/xunlei/` | 迅雷网盘 | 受 Workers 请求体上限（100MB）约束；refreshToken 默认 30 天有效，过期可在「存储配置」页一键自动登录重新获取（见 §5.2） |

- 根路径（`/`）列出所有已装配分区；`PROPFIND /` 会返回各分区目录。
- 只配置了单一驱动时，兼容不带分区前缀的根路径直接映射（例如只配了 gdrive，
  则 `/foo.txt` 等价于 `/gdrive/foo.txt`）。
- **Telegram 分区**：文件内容以文档形式存入 Telegram，`file_id` 与元数据保存在
  KV 索引（`TELEGRAM_INDEX`）中；目录为虚拟节点。
  - **入站自动同步**：向配置的 chat 发送文件（document/photo/voice 等）后，
    执行 list/stat 时驱动会自动增量拉取 `getUpdates` 同步到分区根目录
    `idx:/文件名`；`>20MB` 的消息自动跳过；同名文件自动追加 `-1` 后缀。
  - **手动上传**：也可通过 WebDAV 客户端直接 PUT 上传（走 `sendDocument`）。

## 4. WebDAV 客户端挂载

### 4.1 Cyberduck

1. 新建连接 → 协议选择 **WebDAV (HTTPS)**；
2. 服务器：`webdav.915577.xyz`，端口：`443`，路径：`/`；
3. 用户名：`<DAV_USER>`，密码：`<DAV_PASS>`；
4. 连接后即可浏览 / 上传 / 下载各分区文件。

### 4.2 RaiDrive

1. 添加 → 存储类型选择 **WebDAV**；
2. 地址：`https://webdav.915577.xyz`，端口：`443`，路径：`/`；
3. 账号：`<DAV_USER>`，密码：`<DAV_PASS>`，加密：SSL；
4. 挂载后映射为本地盘符使用。

### 4.3 rclone

```ini
[cloud]
type = webdav
url = https://webdav.915577.xyz/
vendor = other
user = <DAV_USER>
pass = <rclone obscure 加密后的密码>   # 用 `rclone obscure '你的密码'` 生成
```

挂载/使用示例：

```bash
rclone lsd cloud:/                 # 列出分区
rclone copy cloud:/gdrive/xxx.pdf ./  # 下载
rclone copy ./xxx.pdf cloud:/telegram/ # 上传
```

### 4.4 Windows 资源管理器（可选）

右键"此电脑 → 映射网络驱动器"，地址填 `https://webdav.915577.xyz/`，
勾选"使用其他凭据连接"。部分 Windows 客户端对 WebDAV 兼容性有限，推荐优先使用
Cyberduck / RaiDrive / rclone。

## 5. 浏览器 UI

访问 `https://webdav.915577.xyz/ui/`，首次会弹出 Basic Auth 登录框。

| 模块 | 功能 |
| --- | --- |
| 文件 | 分区浏览：面包屑逐级导航、「⬆ 上级目录」按钮、`Alt+↑` / `Backspace` 返回上级；上传（带进度）、下载、删除、重命名、新建文件夹 |
| 存储配置 | 在线填写 / 修改各驱动配置并保存，**立即生效、无需重新部署**；查看 `STORAGE_TYPE`、日志开关、各驱动配置状态与来源（页面 / 环境变量），密钥永不回显 |
| 日志 | 分页查看 D1 请求日志，按方法 / 状态码过滤 |

### 5.1 存储配置（自助配置存储服务）

「存储配置」页按驱动类型动态渲染表单，可在网页中直接添加 / 更新存储服务配置：

- 每个驱动一张表单卡，字段与 `src/config.ts` 对应 Config 接口一致；
  必填字段带 `*`，凭据字段带 🔒 标识（输入框为密码类型）；
- 保存后配置以 JSON 持久化到 `DRIVER_CONFIG` KV（key = 驱动类型名），
  并**优先**于环境变量生效；已配置字段留空 = 保持不变；
- 页面只显示"是否已配置 + 来源（页面 / 环境变量）"，**永不回显明文凭据**；
- 「清除页面配置」可删除该驱动的 KV 配置，回退到环境变量兜底。

> 新增驱动后返回「文件」页即可看到对应分区出现在根目录；KV 边缘最终一致，
> 保存后生效可能有数秒延迟。

进入某个服务分区后，顶部常驻显示该服务名称徽标（如 `gdrive`、`telegram`），便于确认当前所在后端。

### 5.2 自动登录获取凭据（迅雷）

xunlei 配置卡片上有「自动登录获取凭据」按钮，代替手动抓包获取 `refreshToken`：

1. 进入「存储配置」页，找到 **迅雷云盘** 卡片，点击 **自动登录获取凭据**；
2. 弹窗中填写迅雷**账号**与**密码**（安全密码可选，可留空），点击「登录并获取」；
3. 登录成功后，`refreshToken`（及可用的 `accessToken` / 过期时间 / `deviceId` /
   `userAgent`）自动回填到表单，`refreshToken` 输入框短暂高亮，卡片提示「已获取，请保存」；
4. 点击「保存配置」即生效（服务端按 KV 持久化，凭据加密存储、永不回显）。

说明与安全：

- 该功能调用 `POST /api/auth/xunlei/login`（复用 DAV_USER/DAV_PASS 鉴权），
  后端按迅雷 `xluser-ssl.xunlei.com/v1` 登录协议完成登录并返回 `refreshToken`；
- 密码仅存在于本次请求体内：不落库、不写日志、不回显，前端弹窗关闭即销毁；
- 若迅雷要求滑块 / 短信验证（返回"需人工处理验证"），需在浏览器中完成验证后重试；
- `refreshToken` 默认 30 天有效，过期后重新走上述流程即可。

## 6. 在线预览与下载

WebDAV 之外，服务提供两个管理 API（均需 Basic Auth，路径带分区前缀）：

| API | 行为 |
| --- | --- |
| `GET /api/preview?path=/gdrive/xxx.pdf` | 在线预览（`inline` 返回，支持 Range） |
| `GET /api/download?path=/gdrive/xxx.pdf` | 强制下载（`attachment`，支持 Range 分片续传） |

## 7. 常见问题

- **国内访问受限**：`*.workers.dev` 域名在中国大陆访问受限，请绑定自定义域名后访问
  （本文档默认使用 `webdav.915577.xyz`）。
- **上传大文件失败**：Telegram / 百度 / Google Drive / Dropbox 单文件上传受
  Workers 请求体上限（100MB）约束，建议 ≤ 50MB 稳妥；大文件请使用 `/gdrive/` 或 `/s3/`。
- **Telegram 分区看不到刚发送的文件**：同步在 list/stat 时触发，刷新目录即可；
  `>20MB` 的消息不会被同步。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
