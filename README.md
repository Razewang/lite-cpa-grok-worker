# LiteCPA Grok Worker

这是一个轻量的 Cloudflare Worker 代理，把客户端的基础请求体转换为 xAI Responses API 请求，并通过统一的 `/v1` 地址分流模型、搜索和图片功能。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Razewang/LiteCPA)

推荐直接点击上面的按钮部署。Cloudflare 会在部署者自己的账号中创建仓库副本、Worker、KV namespace 和 Durable Object 绑定，不需要下载仓库、安装 Node.js、运行 Wrangler 或手动填写 KV ID。

当前版本只支持账号所有者授权的 xAI/Grok 订阅凭据。它不实现账号密码自动登录、多账号共享、Chat Completions、视频或管理网页；请自行确认服务条款和订阅授权范围。

## 路由

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /admin/credentials/import`
- `POST /admin/auth/start`
- `GET /admin/auth/callback`
- `GET /admin/auth/status`

`/v1/*` 使用客户端网关 Key；普通 `/admin/*` 使用独立的管理 Key。OAuth 浏览器回调不携带 Header，因此 `/admin/auth/callback` 使用一次性 PKCE state 作为短期凭据；`/health` 不需要 Key。

Responses 请求会清洗不兼容字段、移除 `grok/`、`xai/`、`x-ai/` 模型前缀、把 `prompt_cache_key` 映射为 `X-Grok-Conv-Id`，并强制上游使用 SSE。客户端要求流式时直接透传；非流式时聚合 `response.completed`。

搜索使用 Responses body 中的 `tools: [{"type":"web_search"}]` 或 `tools: [{"type":"x_search"}]`，不增加独立搜索地址。图片使用标准 `/v1/images/*` 路径。

## 本地运行

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run typecheck
npm test
npm run check:secrets
npm run dev
```

`.dev.vars` 至少需要设置：

```text
CLIENT_API_KEY=replace-with-client-key
ADMIN_API_KEY=replace-with-admin-key
CREDENTIAL_ENCRYPTION_KEY=replace-with-a-random-secret-at-least-16-chars
OAUTH_REDIRECT_URI=http://127.0.0.1:8787/admin/auth/callback
```

本地导入 CPA JSON 时，文件保持在 Downloads 外部路径，不复制到项目：

```powershell
$env:LIVE_TEST="1"
$env:CPA_CREDENTIAL_PATH="C:\Users\your-user\Downloads\xai-credential.json"
$env:WORKER_URL="http://127.0.0.1:8787"
$env:ADMIN_API_KEY="replace-with-admin-key"
$env:CLIENT_API_KEY="replace-with-client-key"
npm run test:live
```

`test:live` 默认只导入凭据并调用 `/v1/models`。只有显式设置 `LIVE_RESPONSES=1`、`LIVE_SEARCH=1` 或 `LIVE_IMAGE=1`，并提供 `LIVE_MODEL` 时，才会执行对应的真实请求；脚本不会打印凭据内容，也不会自动进入 CI。

根目录的 `live-test.env.example` 仅用于说明真实测试所需变量，不会被 Cloudflare 部署表单读取。不要在该文件或任何 Git 跟踪文件中填写真实密钥或 CPA 内容。

如需只测试“CPA 导入 → 取得 access token → 使用项目请求模块发送一次文本请求”的链路，可执行：

```powershell
$env:LIVE_TEST="1"
$env:LIVE_MODEL="grok-4"
npm run test:live:request
```

该脚本必须通过 `CPA_CREDENTIAL_PATH` 指向工作区外的 CPA 文件；示例路径仅为占位符。它只输出成功状态和耗时，不输出 access token 或完整模型响应，也不会回写 CPA 文件。

## 上游配置

默认 `TEXT_UPSTREAM_PROFILE=credential`，首次真实测试跟随 CPA JSON 中的 `https://api.x.ai/v1`。如需切换到 Grok CLI 兼容模式：

```text
TEXT_UPSTREAM_PROFILE=cli-proxy
CLI_PROXY_BASE_URL=https://cli-chat-proxy.grok.com/v1
CLI_PROXY_CLIENT_VERSION=0.2.93
```

CLI Proxy 模式只允许固定的 `cli-chat-proxy.grok.com` 主机，并添加 CLI 兼容请求头；用户不能通过请求体传入任意上游地址。媒体默认仍使用 CPA 的 `base_url`，也可以通过 `MEDIA_BASE_URL` 选择固定允许的 xAI/CLI Proxy 地址。

## Cloudflare 云端部署完整指南

本项目可以完全通过 Cloudflare Dashboard 和 GitHub 完成部署，不要求在本地运行 Wrangler。Cloudflare Workers Builds 会克隆仓库、安装依赖、运行构建命令并执行 `wrangler deploy`；后续生产分支有新提交时会自动重新部署。

部署配置的来源是仓库根目录中的 `wrangler.jsonc`：

- Worker 名称：`lite-cpa-grok-worker`
- Worker 入口：`src/index.ts`
- 生产 KV binding：`CREDENTIALS_KV`
- Durable Object binding：`CREDENTIAL_COORDINATOR`
- Durable Object 类：`CredentialCoordinator`
- Durable Object 存储：SQLite-backed
- 默认文本上游：CPA 文件中的 `https://api.x.ai/v1`
- CLI Proxy 地址：`https://cli-chat-proxy.grok.com/v1`

当前配置使用无资源 ID 的 KV binding。Cloudflare/Wrangler 会在首次部署时自动创建 KV namespace 并绑定，不需要预先创建 KV，也不要向公共仓库写入账号专属 namespace ID。Durable Object 同样由部署配置创建和绑定。

参考：

- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Deploy to Cloudflare 按钮与自动资源配置](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [KV namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)

### 部署前准备

需要准备：

- 一个 Cloudflare 账号。
- 一个 GitHub 账号。
- GitHub 仓库 `Razewang/LiteCPA`，或部署者自己创建的副本/Fork。
- 三个互不相同的强随机 Secret。
- 部署者本人有权使用的 CPA JSON。

三个必需 Secret：

| Secret | 用途 | 建议 |
| --- | --- | --- |
| `CLIENT_API_KEY` | 客户端访问 `/v1/*` | 32 字符以上的随机值 |
| `ADMIN_API_KEY` | 导入 CPA、查询状态和访问普通 `/admin/*` | 必须与客户端 Key 不同 |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-GCM 加密 KV 中的 OAuth 凭据 | 32 字符以上，部署后妥善备份 |

`CREDENTIAL_ENCRYPTION_KEY` 一旦更换，KV 中已有凭据将无法解密。若确实需要轮换，应先准备重新导入 CPA，而不是直接覆盖后继续使用旧 KV 数据。

CPA JSON、`access_token`、`refresh_token` 和 `id_token` 都不是构建变量，也不应写入 GitHub、Cloudflare 构建日志或 README。CPA 只在 Worker 部署完成后，通过 HTTPS 管理接口导入。

### 选择部署方式

| 场景 | 建议方式 |
| --- | --- |
| 最少步骤，接受 Cloudflare 创建新的仓库副本 | README 顶部的 **Deploy to Cloudflare** |
| 使用现有仓库或保留 GitHub Fork 关系 | Dashboard 的 **Import a repository** |
| 已经有同名 Worker，只想连接 GitHub | Worker → **Settings → Builds → Connect** |

### 方式 A：Deploy to Cloudflare 一键部署

Deploy to Cloudflare 按钮的源仓库必须是公开仓库。当前官方仓库可直接使用该按钮；如果部署的是私有仓库，请使用方式 B，并在 GitHub App 中仅授权对应私有仓库。

1. 点击 README 顶部的 **Deploy to Cloudflare**。
2. 登录 Cloudflare，并选择要部署到的 Cloudflare Account。
3. 登录 GitHub，安装或授权 **Cloudflare Workers & Pages** GitHub App。
4. GitHub App 的 Repository access 建议选择 **Only select repositories**，只授权本项目需要的仓库。
5. 设置 Cloudflare 将要创建的 GitHub 仓库名称。
6. Worker name 使用 `lite-cpa-grok-worker`。如需换名，应保证最终 Worker 名称与生成仓库中的 `wrangler.jsonc` 一致。
7. 在部署表单中填写三个必需 Secret：
   - `CLIENT_API_KEY`
   - `ADMIN_API_KEY`
   - `CREDENTIAL_ENCRYPTION_KEY`
8. 检查资源列表中包含：
   - KV：`CREDENTIALS_KV`
   - Durable Object：`CREDENTIAL_COORDINATOR`
9. Build command 可使用 `npm run test:all`；Deploy command 使用 `npm run deploy`。
10. 确认并开始部署。

此方式会：

- 在部署者自己的 GitHub 账号中创建一个可继续维护的仓库副本。
- 在部署者自己的 Cloudflare 账号中创建 Worker。
- 自动创建并绑定 KV namespace。
- 创建 SQLite-backed Durable Object binding。
- 配置 Workers Builds，使生产分支后续提交自动部署。

Cloudflare 创建的仓库副本不保证在 GitHub 中显示为 Fork。如果必须保留 Fork 关系，使用方式 B。

### 方式 B：Dashboard 导入现有 GitHub 仓库

#### 1. 授权 GitHub 仓库

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Workers & Pages**。
3. 点击 **Create application**。
4. 在 **Import a repository** 旁点击 **Get started**。
5. 选择 GitHub Account；首次使用时安装 **Cloudflare Workers & Pages** GitHub App。
6. GitHub Repository access 建议选择 **Only select repositories**。
7. 选择 `Razewang/LiteCPA`，或者部署者自己的 Fork。
8. 生产分支选择 `main`。

如果仓库未显示：

1. 打开 GitHub → **Settings → Applications → Installed GitHub Apps**。
2. 找到 **Cloudflare Workers and Pages** → **Configure**。
3. 把目标仓库加入允许列表。
4. 回到 Cloudflare 刷新仓库列表。

#### 2. 填写 Build 配置

推荐设置：

| Dashboard 字段 | 填写值 |
| --- | --- |
| Project / Worker name | `lite-cpa-grok-worker` |
| Production branch | `main` |
| Root directory | `/` 或留空表示仓库根目录 |
| Build command | `npm run test:all` |
| Deploy command | `npm run deploy` |
| Non-production deploy command | 保持默认 `npx wrangler versions upload` |
| API token | 使用 Cloudflare 自动生成的 Workers Builds token |

Worker 名称必须与 `wrangler.jsonc` 的 `name` 一致。仓库不是 monorepo，因此不要把 Root directory 设置为 `src`、`api` 或其他子目录。

Workers Builds 会自动安装 `package-lock.json` 中的依赖。不要把 `npm ci` 重复写入 Deploy command；测试放在 Build command，部署只使用 `npm run deploy`。

#### 3. 区分 Build secrets 与 Worker runtime secrets

Cloudflare 页面可能显示 **Build variables and secrets**。它们只在构建容器中可见，不会自动成为 Worker 运行时变量，不能代替本项目的三个 Worker Secret。

如果导入页面直接显示 Worker application secrets，则在那里填写三个必需 Secret。

如果导入页面只显示 Build variables：

1. 不要把 CPA JSON 或 xAI token 填入 Build variables。
2. 点击 **Save and Deploy** 创建 Worker/Build 项目。
3. 如果首次构建提示缺少 required secrets，这是 `wrangler.jsonc` 的安全检查在生效。
4. 打开创建出的 Worker → **Settings → Variables and Secrets**。
5. 依次点击 **Add**，Type 选择 **Secret**，添加：
   - `CLIENT_API_KEY`
   - `ADMIN_API_KEY`
   - `CREDENTIAL_ENCRYPTION_KEY`
6. 点击 **Deploy** 保存 Secrets。
7. 回到 **Deployments → View build history**，打开失败的 Build 并选择 **Retry build**。

不要把这三个值创建为明文 Variable；必须选择 Secret 类型。

如果首次失败后 Cloudflare 没有创建可进入 Settings 的 Worker，可使用以下云端兜底流程：

1. 在 **Workers & Pages → Create application** 中先创建名为 `lite-cpa-grok-worker` 的 Worker。
2. 在该 Worker 的 **Settings → Variables and Secrets** 中添加三个运行时 Secret。
3. 打开 **Settings → Builds → Connect**，连接目标 GitHub 仓库和 `main` 分支。
4. 使用上表中的 Root directory、Build command 和 Deploy command，然后开始第一次 Git 构建。

#### 4. 首次部署后的绑定检查

部署成功后进入 Worker → **Settings → Bindings**，确认：

| Binding | 类型 | 预期状态 |
| --- | --- | --- |
| `CREDENTIALS_KV` | KV Namespace | 已绑定到自动创建的私有 namespace |
| `CREDENTIAL_COORDINATOR` | Durable Object | 类名为 `CredentialCoordinator` |

正常情况下不需要手动创建资源。若 KV 自动配置失败：

1. 进入 Cloudflare 的 **Workers KV** 页面。
2. 点击 **Create instance**，创建一个仅供本 Worker 使用的 namespace。
3. 回到 Worker → **Settings → Bindings → Add → KV Namespace**。
4. Variable name 必须填写 `CREDENTIALS_KV`。
5. 选择刚创建的 namespace 并点击 **Deploy**。
6. 回到 Build history 重试构建。

不要把 CPA token 直接写成 KV Pair；Worker 会在导入时自行加密并写入固定的内部键。

### 部署后的运行时设置

#### 非敏感环境变量

以下值已经由 `wrangler.jsonc` 管理，通常不需要在 Dashboard 重复填写：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `TEXT_UPSTREAM_PROFILE` | `credential` | 使用 CPA 的 `base_url` |
| `MEDIA_BASE_URL` | 空 | 图片默认跟随 CPA base URL |
| `CLI_PROXY_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | CLI Proxy 固定地址 |
| `CLI_PROXY_CLIENT_VERSION` | `0.2.93` | CLI 兼容请求头版本 |
| `XAI_OAUTH_ISSUER` | `https://auth.x.ai` | xAI OAuth issuer |
| `XAI_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` | OAuth scopes |

`wrangler.jsonc` 是这些变量的配置源。在 Dashboard 临时修改同名 Variable，下一次 Git 构建部署时可能被仓库配置覆盖。需要长期修改时，应在 GitHub 网页编辑 `wrangler.jsonc` 并提交，由 Workers Builds 自动部署；不要求修改本地文件夹。

#### 切换 CLI Proxy Provider

默认保持：

```text
TEXT_UPSTREAM_PROFILE=credential
```

需要使用 `https://cli-chat-proxy.grok.com/v1` 时，在 GitHub 网页编辑 `wrangler.jsonc`：

```jsonc
"TEXT_UPSTREAM_PROFILE": "cli-proxy"
```

提交到生产分支后等待 Cloudflare 自动部署。不要允许客户端通过请求体指定任意上游 URL。

#### workers.dev 地址和自定义域名

部署成功后，Worker 默认地址通常为：

```text
https://lite-cpa-grok-worker.<account-subdomain>.workers.dev
```

Cloudflare 账号第一次使用 Workers 时，Dashboard 可能先要求创建一个唯一的 `workers.dev` account subdomain。完成该提示后再访问上面的地址；本项目已在 `wrangler.jsonc` 中启用 `workers_dev`。

先测试：

```text
https://lite-cpa-grok-worker.<account-subdomain>.workers.dev/health
```

预期响应包含：

```json
{
  "status": "ok",
  "service": "lite-cpa-grok-worker"
}
```

如需自定义域名，在 Worker → **Settings → Domains & Routes** 中添加 Custom Domain。启用自定义域名后，客户端 `WORKER_URL` 和 OAuth redirect URI 应统一使用最终域名。

#### 日志与故障定位

仓库已经通过 `wrangler.jsonc` 启用 Worker Observability，不需要再添加日志服务：

- Git 构建、测试或部署失败：打开 Worker → **Deployments → View build history** 查看 Build logs。
- Worker 已部署但请求返回 5xx：打开 Worker → **Observability → Logs** 查看 Runtime logs。
- 修改 Secret 或 binding 后：先确认对应设置已经生成新 Deployment，再重试请求。

不要在排错时打印 Authorization header、CPA JSON、access token、refresh token、id token 或完整上游响应。向他人提供日志前先删除这些内容。

#### 不需要配置的 Cloudflare 产品

本项目不要求 Pages、D1、R2、Queues、Cron Triggers、Service Bindings 或 AI Gateway。Custom Domain、WAF/Rate Limiting 和 Cloudflare Access 都是可选项。若为 API 添加浏览器质询或 Access 策略，应确保程序客户端仍能调用 `/v1/*`，并且不要阻断 `/admin/auth/callback` 的 OAuth 回调。

### 导入 CPA JSON

先确保三个必需 Secret 和两个资源 binding 都已配置。CPA JSON 保持在用户设备上，通过 HTTPS 发送给部署者自己的 Worker，不进入 GitHub 或 Cloudflare Build 环境。

PowerShell 示例：

```powershell
$workerUrl = "https://lite-cpa-grok-worker.<account-subdomain>.workers.dev"
$adminKey = Read-Host "ADMIN_API_KEY" -MaskInput
$cpaPath = "C:\Users\your-user\Downloads\xai-credential.json"

Invoke-RestMethod `
  -Uri "$workerUrl/admin/credentials/import" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $adminKey" } `
  -ContentType "application/json" `
  -InFile $cpaPath
```

成功响应只包含脱敏状态，不会返回 token。Worker 会使用 `CREDENTIAL_ENCRYPTION_KEY` 加密凭据后写入 `CREDENTIALS_KV`。

检查凭据状态：

```powershell
Invoke-RestMethod `
  -Uri "$workerUrl/admin/auth/status" `
  -Headers @{ Authorization = "Bearer $adminKey" }
```

检查模型接口：

```powershell
$clientKey = Read-Host "CLIENT_API_KEY" -MaskInput

Invoke-RestMethod `
  -Uri "$workerUrl/v1/models" `
  -Headers @{ Authorization = "Bearer $clientKey" }
```

发送最小文本请求：

```powershell
$body = @{
  model = "grok-4"
  input = "Reply with the single word OK."
  stream = $false
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "$workerUrl/v1/responses" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $clientKey" } `
  -ContentType "application/json" `
  -Body $body
```

也可以使用仓库中的安全测试脚本；它不会修改项目文件，也不会输出 CPA token：

```powershell
$env:LIVE_TEST="1"
$env:CPA_CREDENTIAL_PATH="C:\Users\your-user\Downloads\xai-credential.json"
$env:WORKER_URL="https://lite-cpa-grok-worker.<account-subdomain>.workers.dev"
$env:ADMIN_API_KEY="<admin-key>"
$env:CLIENT_API_KEY="<client-key>"
$env:LIVE_RESPONSES="1"
$env:LIVE_MODEL="grok-4"
npm run test:live
```

生图和搜索会消耗额外订阅额度，只有显式设置 `LIVE_IMAGE=1` 或 `LIVE_SEARCH=1` 时才测试。

### 可选：启用浏览器 OAuth 登录

只使用 CPA JSON 导入时不需要 OAuth redirect 设置。

要启用直接 OAuth 登录：

1. 先取得最终 Worker URL 或自定义域名。
2. 进入 Worker → **Settings → Variables and Secrets**。
3. 添加 Secret：`OAUTH_REDIRECT_URI`。
4. 值必须精确为：

```text
https://<最终-worker-域名>/admin/auth/callback
```

5. 点击 **Deploy**。
6. 使用管理 Key 调用 `POST /admin/auth/start`。
7. 打开返回的 `authorization_url` 完成登录。

如果更换 workers.dev 子域名或自定义域名，必须同步更新 `OAUTH_REDIRECT_URI`，否则 OAuth callback 会因 redirect URI 不一致失败。

### 自动部署、预览和回滚

#### 生产部署

Workers Builds 监听 `main`。每次向生产分支提交时：

1. Cloudflare 拉取新的 commit。
2. 自动安装依赖。
3. 执行 `npm run test:all`。
4. 测试通过后执行 `npm run deploy`。
5. 新 Worker version 被提升为 Active Deployment。

在 Worker → **Deployments → View build history** 查看构建日志。GitHub commit 页面也会显示 Cloudflare Check Run。

#### 非生产分支预览

在 Worker → **Settings → Builds → Branch control** 中启用 non-production branch builds 后，其他分支默认执行：

```text
npx wrangler versions upload
```

它会创建预览 version/URL，但不会自动替换生产流量。不要在预览环境导入正式 CPA，除非已经为预览部署配置了独立 Secrets 和独立存储。

#### 回滚

进入 Worker → **Deployments / Version History**，选择上一版本并重新部署即可回滚 Worker 代码。

注意：Worker version 回滚只回滚代码和绑定配置，不会回滚 KV 或 Durable Object 中的数据。若轮换了 `CREDENTIAL_ENCRYPTION_KEY`，单纯回滚代码不能恢复旧密钥。

### Cloudflare 配置检查清单

部署完成后逐项确认：

- [ ] GitHub App 只获得目标仓库权限。
- [ ] Production branch 是 `main`。
- [ ] Worker name 是 `lite-cpa-grok-worker`。
- [ ] Root directory 是仓库根目录。
- [ ] Build command 是 `npm run test:all`。
- [ ] Deploy command 是 `npm run deploy`。
- [ ] `CLIENT_API_KEY` 已设置为 Secret。
- [ ] `ADMIN_API_KEY` 已设置为另一个 Secret。
- [ ] `CREDENTIAL_ENCRYPTION_KEY` 已设置并已安全备份。
- [ ] `CREDENTIALS_KV` binding 存在。
- [ ] `CREDENTIAL_COORDINATOR` Durable Object binding 存在。
- [ ] `workers.dev` account subdomain 已启用，或 Custom Domain 已生效。
- [ ] `/health` 返回 200。
- [ ] CPA 导入后 `/admin/auth/status` 显示 `configured: true`。
- [ ] `/v1/models` 使用客户端 Key 可以访问。
- [ ] CPA JSON 和 token 没有出现在 GitHub、Build variables 或日志中。

### 常见部署错误

#### Worker name 不一致

错误通常包含 `name in your Wrangler configuration file must match`。

处理：把 Dashboard Worker name 设为 `lite-cpa-grok-worker`，或在 GitHub 中同步修改 `wrangler.jsonc` 的 `name`，然后重试构建。

#### Missing required secrets

处理：到 Worker → **Settings → Variables and Secrets**，以 Secret 类型添加三个必需值，点击 Deploy 后重试 Build。不要放到 Build variables。

#### KV binding 缺失

处理：确认 binding 名称严格为 `CREDENTIALS_KV`。可让自动资源配置重新运行，或在 Dashboard 创建 KV namespace 并通过 **Settings → Bindings** 手动绑定。

#### Durable Object binding 缺失

处理：确认 Cloudflare 构建使用仓库根目录的 `wrangler.jsonc`，且 Deploy command 是 `npm run deploy`；不要把 Root directory 指向 `src`。

#### `401 invalid_api_key`

处理：

- `/v1/*` 必须使用 `CLIENT_API_KEY`。
- 普通 `/admin/*` 必须使用 `ADMIN_API_KEY`。
- Header 格式必须是 `Authorization: Bearer <key>`。

#### `credential_not_configured`

处理：Worker 已部署但 CPA 尚未导入。调用 `POST /admin/credentials/import`，再检查 `/admin/auth/status`。

#### OAuth redirect 失败

处理：确认 `OAUTH_REDIRECT_URI` 与浏览器实际访问的 Worker 域名、协议和路径完全一致，路径必须是 `/admin/auth/callback`。

#### GitHub 仓库未显示

处理：到 GitHub Installed GitHub Apps 中重新配置 **Cloudflare Workers and Pages** 的 Repository access，然后刷新 Cloudflare 仓库列表。

### Cloudflare 免费层级可用性

本项目可部署到 Workers Free 做个人或低流量使用。受保护 API 请求通常会经过一次 Durable Object 协调和一次 KV 读取；只有导入凭据或刷新 token 时才写 KV。

实际限额可能调整，部署前请检查：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

Cloudflare 免费层级不包含 xAI/Grok 订阅、上游额度或其他第三方服务费用。

## 使用 Wrangler 手动部署（可选）

云端部署不需要执行这一节。只有维护者或需要本地调试的人才需要 Wrangler：

```powershell
npm ci
npx wrangler login
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars，为三个 Secret 填写真实强随机值
npm run test:all
npx wrangler deploy --secrets-file .dev.vars
```

自动资源配置会创建 KV，不要求预先取得 namespace ID。Durable Object 使用 SQLite-backed declarative 配置；凭据在写入 KV 前使用 AES-GCM 加密。原始 CPA 文件只用于显式导入或真实测试，不应加入 Git、Cloudflare Build variables、日志、快照或错误输出。
