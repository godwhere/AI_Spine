# Sub2API 网关

iSpine 将 Sub2API 作为独立的图片服务接入，保留 Codex 和 OpenAI 的原有设置。网关密钥、模型和图片接口均由用户明确选择，生成失败不自动切换服务。

## 连接

在「AI 连接 → Sub2API」填写服务地址、网关密钥和模型，点击「保存并验证连接」。个人部署的本机入口为 `http://127.0.0.1:18080/v1`；管理后台为 `http://127.0.0.1:18080`。

- GPT Image：选择 OpenAI Images，填写后台分组开放的模型名。
- Gemini：选择 Gemini 原生图片接口，填写支持图片输出的 Gemini 模型；Antigravity 分组可使用 `/antigravity/v1beta` 前缀。
- 模型目录验证成功只确认网关连接和模型名，实际生图、透明度、上游额度和取消能力仍需真实请求验证。

## ChatGPT 网页图片通道

个人部署的网页链路为 `iSpine → Sub2API → chatgpt2api → ChatGPT 网页接口`。在 iSpine 选择 Sub2API、OpenAI Images 接口和当前兼容模型名 `gpt-image-2`。此名称是后端兼容别名，不能据此确认网页图片引擎的 2/2.5 版本；当前先使用网页默认引擎。

上游 Sub2API `v0.2.17` 的 OAuth 图片通道使用 `/backend-api/codex/...`。网页通道另设本机后端，调用 `/backend-api/f/conversation` 等网页接口。简化模式下不能仅依赖分组名隔离账号：授权来源账号关闭生图调度，网页图片上游保持可调度。不要把一次出图成功直接视为网页通道验收；还需核对实际使用账号和网页请求记录。

| 项目 | 位置或设置 |
| --- | --- |
| 网页后端 | `ispine-chatgpt-web.service`，服务器本机 `127.0.0.1:18081` |
| 上游源码 | `basketikun/chatgpt2api`，固定提交 `dc105e51bd486bd75c8ef4f74be4bc4724bdfc33` |
| 程序 / 数据 | `/opt/ispine-chatgpt-web` / `/var/lib/ispine-chatgpt-web` |
| 网页分组 / 图片上游 | `iSpine ChatGPT Web` / `ChatGPT Web - ethanwill` |
| 每账号图片并发 | Sub2API 网页图片上游为 3；网页后端 `image_account_concurrency` 为 3 |
| 调用限制 | `scripts/sub2api-web-entry.py` 阻止 Codex 路径，仅记录脱敏的网页路径与 HTTP 状态 |
| 授权同步 | `ispine-chatgpt-web-sync.timer`，每 5 分钟同步已授权账号的访问令牌 |

授权同步通过 Sub2API 的正常导出与刷新 API 获取指定账号；刷新令牌留在 Sub2API，网页后端只接收访问令牌，并在进程内轮换，保持正在执行的请求。同步接口要求网页后端管理员密钥，定时服务只能连接本机。iSpine 仅保存网关密钥，使用桌面系统加密，不接收上游账号令牌。

网关继续使用 `simple` 模式。该模式的分组 API 不暴露图片开关，因此部署时仅为明确选用的图片分组开启数据库的 `allow_image_generation`，再通过分组更新 API 刷新缓存。未启用计费或付款流程。网页后端不开放公网端口，未配置出站代理，也未启用验证码处理、云备份或第三方文件存储。

账号在 Sub2API 后台通过授权流程添加，浏览器中已有的账号会话可供官方授权页面使用。iSpine 只接收网关密钥，不读取 Codex 的认证文件。图片服务的切换不替代现有 Codex 结构、坐标和动作分析服务。

按用户要求，网页图片上游与网页后端的每账号并发均已从 1 调为 3，与 iSpine 默认值对齐。通过各自正常的管理 API 保存并重新读取核对，网页后端也已核对持久化配置；服务无需重启。验证记录为 `outputs/desktop/evidence/chatgpt-web-concurrency.json`。本次未发起图片请求，生成继续暂停；配置验证不代表已经验证三路同时出图，也未修复下述上游传输或会话故障。

### 批量部件故障排查

2026-10-20 20:18—20:42（北京时间）的只读排查确认：网页账号当时的网关并发上限为 1；四个 429 请求记录了 `timeout waiting for account concurrency slot`，属于网关排队超时，不能据此认定 ChatGPT 图片额度耗尽。排查时面板默认并发为 3，只有活动任务会恢复其并发值，重新打开面板可能再次造成排队。

四个 502 与网页后端错误逐次对应：20:24:08 和 20:28:17 的参考图上传返回 503 `ServerBusy / Ingress is over the account limit`；20:37:07 的图片下载返回 503 `ServerBusy / The server is busy`；20:40:03 的 `/backend-api/f/conversation` 返回 500，正文为空。上传错误中的 account limit 来自图片存储服务，不是 ChatGPT 订阅或账单额度证明。后端把这些失败转换为 502，Sub2API 尝试切换时没有第二个可用图片账号；目前 iSpine 又会丢弃失败正文，所以界面仅显示通用错误。

其他修复方向是让任务调度与账号并发上限一致、记住用户选定的并发值，保留有大小限制且脱敏的错误详情，并对图片上传、下载的临时 503 做有次数限制的退避重试。下载重试应复用已经生成的文件，不重新发起生图；网页会话 POST 的失败不能盲目重放，以免重复生成。调整并发不能保证解决存储服务或网页接口故障。

脱敏记录为 `outputs/desktop/evidence/chatgpt-web-batch-diagnosis.json`，包含时间、请求 ID、状态和错误阶段。原始日志仅保存在服务器 root 私有目录。诊断阶段未修改应用代码或网关配置，未发起图片请求；尚未验证上游恢复情况，也不把这次排查作为部件质量或完整角色验收。

## Gemini / Antigravity 通道

Antigravity 使用单独的 Google OAuth 账号、分组和网关密钥，地址为 `http://127.0.0.1:18080/antigravity/v1beta`，图片协议为 Gemini，当前图片模型为 `gemini-3.1-flash-image`。这是 Antigravity 通道；Gemini 消费者网页和 AI Studio API 是另外的接入方式。

2026-10-20 的同授权、同模型、同请求对照中，Mac 上的 `gemini-3.8-flash-high` 请求成功返回文字，服务器直连 daily 入口返回地区限制，prod 入口返回 429。Mac 上的原生图片请求也成功返回一张图片。第三方 IP 查询显示美国，不能代替对 Google 实际请求的验证。

当前仅为 Gemini 账号选择 Google 出站转发：`Sub2API → 服务器回环端口 → SSH → Mac 回环转发 → Google`。ChatGPT 网页账号保留原来的服务器直连设置。Mac 需要保持在线；代理的 `fallback_mode` 为 `none`，不自动改用服务器直连。

| 项目 | 位置或设置 |
| --- | --- |
| Mac 转发程序 | `scripts/sub2api-gemini-egress.py`，部署副本位于 `~/Library/Application Support/iSpine Gateway/gemini-egress/` |
| Mac 监听 | `127.0.0.1:18082` |
| 服务器监听 | `127.0.0.1:19081`，不开放公网端口 |
| Mac 登录自启 | `local.ispine.gemini-egress`、`local.ispine.gemini-egress-tunnel` LaunchAgent |
| SSH 账号 | `ispine-gemini-egress`，独立密钥，仅允许反向监听指定回环端口，不允许 shell 或其他转发 |
| Sub2API 代理 | `iSpine Gemini Mac egress`，只绑定 Gemini 账号 |

转发程序仅允许指定 Google 域名的 443 端口 CONNECT，保留端到端 TLS，不接收明文 Google 令牌或图片内容；限制并发、持续时间与传输大小，日志仅包含域名、状态、字节数和耗时。原有网关隧道账号、密钥与 SSH 限制保持独立。

经此出口的 Sub2API 文字调用与 OAuth 续期已通过。网关图片调用仍返回 Google 的模型额度冷却提示，但随后原生模型余量查询显示约 97.8% 剩余；不同配额口径或图片请求适配仍待核实，不能据此认定账号只支持生成一张图片，也不能保证冷却提示结束后即可使用。

原生图片测试返回 1024×1024 JPEG，棋盘格属于图片像素，没有真实 Alpha。将其转成 PNG 不会产生透明背景，当前不能通过 iSpine 的透明部件校验。保留现有校验和 ChatGPT 连接；本次没有把 Gemini 选为工作台的默认图片服务，也没有把测试图片加入资源库。

验证记录为 `outputs/desktop/evidence/gemini-integration.json`；原生测试图片和详细对照记录保存在本机网关私有目录。转发程序检查使用 `python3 tests/sub2api-gemini-egress.test.py`，覆盖目标限制、二进制转发、日志脱敏、连接失败和并发限制。

## 个人服务器部署

当前部署使用上游 `v0.2.17` 的 Linux amd64 发布文件，并以同一版本的 `checksums.txt` 校验。使用独立的系统用户、数据库和服务，不依赖容器。

| 项目 | 位置或设置 |
| --- | --- |
| 服务 | `ispine-sub2api.service` |
| 程序 | `/opt/ispine-sub2api/sub2api` |
| 数据 | `/var/lib/ispine-sub2api` |
| 环境配置 | `/etc/ispine-sub2api.env`，仅 root 可读 |
| 数据库 | PostgreSQL `ispine_sub2api` |
| 缓存 | 本机 Redis，数据库 7 |
| 监听 | 服务器本机 `127.0.0.1:18080` |
| 运行模式 | `simple`，跳过网关计费流程 |
| 内存限制 | 服务软阈值 256 MiB，上限 384 MiB |

本机通过 SSH 将 `127.0.0.1:18080` 转发到服务器同一端口。登录启动项为 `~/Library/LaunchAgents/local.ispine.sub2api-tunnel.plist`。连接使用独立的 `ispine-tunnel` 系统账号和专用密钥，权限限制为转发服务器 `127.0.0.1:18080`，禁止密码登录、交互 shell、远程端口监听和其他目标端口。既有 SSH 密钥的限制保持不变。网关和数据库不需要开放公网端口，现有服务器服务的端口保持独立。

服务器重启后由 systemd 恢复服务，Mac 登录后由 LaunchAgent 恢复加密连接。SSH 无法连接时，先检查原服务器连接及 `/tmp/ispine-sub2api-tunnel.log`。管理员凭据和隧道密钥单独保存在本机 `~/Library/Application Support/iSpine Gateway/`，目录权限 0700，凭据文件权限 0600，不进入仓库、角色工程或任务记录。

首次使用管理后台需管理员接受上游的《部署与运营合规承诺》。账号授权通过正常 OAuth 页面完成；后台部署、管理员协议确认、上游账号授权与真实生图是独立的验收步骤。

浏览器已有登录会话仍可能需要官方页面再次验证通行密钥。若出现 Touch ID 或安全密钥提示，由账号本人完成验证，再继续 OAuth；已有的 Google 登录状态不代表已完成这一步。

## 验证范围

本地测试覆盖两种图片协议、参考图传输、地址和密钥保护、任务归属、并发取消、候选应用与可编辑导出回导。真实上游授权与真实图片生成需分别检查，模拟响应不作为账号或图片质量验收。

网页专用入口的阻断、脱敏日志及管理员授权轮换检查：`python3 tests/sub2api-web-entry.test.py`。真实网页通道证据保存于 `outputs/desktop/evidence/chatgpt-web-job.json`、`chatgpt-web-image-check.json` 和 `chatgpt-web-integration.json`，包含实际使用账号、网页请求路径与 PNG 透明度检查。连接测试图不进入资源库，也不作为完整角色验收。

上游资料：[项目](https://github.com/Wei-Shaw/sub2api)、[版本](https://github.com/Wei-Shaw/sub2api/releases/tag/v0.2.17)、[图片与账号接入说明](https://github.com/Wei-Shaw/sub2api/blob/main/README_CN.md)。
