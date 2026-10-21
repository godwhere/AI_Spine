# 图片生成与任务

工作台提供 Codex、OpenAI API 和 Sub2API 三种显式图片连接。Codex 路径复用本机已登录的 ChatGPT 账号；其他路径使用各自配置。失败不会自动更换服务。没有积分、充值、会员、支付或独立账户系统。

## 工作流

`模板 → 角色形象候选 → 选定形象参考 → 选定模板部件 → 逐部件生成 → 候选确认 → 透明轮廓适配 → 现有校准 → 同步动画 → 导出 / 重新导入`

- 形象生成输入：提示词、模板当前姿势，可选已有形象参考。
- 部件生成输入：原始 Atlas 区域还原的独立 PNG、模板当前姿势、可选形象参考、用户提示词及区域尺寸。还原步骤处理 Atlas 90°、裁切偏移和 PMA。
- 每个区域单独调用一次所选图片服务，Codex 路径使用原生生图。部件 ID 由服务绑定，模型不负责返回文件名映射。单批按所选 1–4 并发处理，候选仍按固定部件映射排序。
- 结果须为能解码、有可见内容及真实透明像素的 PNG。失败显示错误，不用占位图或代码绘图伪装成功。
- 应用前比较骨架与 Atlas 的 SHA-256 指纹，再验证部件映射；整批初步适配完成后才一次性写入编辑状态，可撤销。
- 单部件应用直接打开校准；多部件应用可在原工作台继续选择、校准。初步适配依据透明轮廓，不是关节语义识别。
- 关闭候选窗口不会应用图片。应用前同时核对资源 ID、模板指纹与部件映射；不同资源即使使用同一模板也不能接收旧候选。骨架候选另核对当前几何和源图快照，过期候选不会覆盖新的关节、绑定或动作。

## 本地服务与账号

正式本机后台由登录启动项运行，在 4175 提供网页与 `/api/generation/*`、`/api/rig/*`；开发/预览插件使用独立目录。选择 Codex 时，适配器通过 stdio 启动 `codex app-server`，完成 `initialize`，调用 `account/read` 检查 `chatgpt` 登录，再为每张图创建 ephemeral thread，发送文字和 `localImage` 输入。

只有 `item/completed` 的 `imageGeneration` 结果加上成功的 `turn/completed` 才会成为候选。工具返回的 base64 PNG 经校验和重新编码后保存。不会把登录成功、文本回复或图片路径字符串当作生成成功。

账号 OAuth 和续期都在 Codex 内部处理。应用不打开认证文件，不返回账号邮箱或令牌，也不把任意 RPC 暴露给浏览器。Codex 子进程关闭 shell、统一命令执行、应用连接器、浏览器和多代理工具，使用只读沙箱；图片任务指令限定为原生生图，该路径不调用第三方站点的生成服务。

程序自动寻找已安装的 Codex；特殊安装路径可通过 `AI_SPINE_CODEX_BIN` 指定可执行文件。工作台使用 Codex 当前配置的控制模型，原生图片模型由 Codex 工具管理；不会把控制模型名称当作图片模型。

官方资料（2026-10-19 核对）：

- [Codex 原生图像生成](https://learn.chatgpt.com/docs/image-generation)：内置生成使用 Codex 账号能力。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：stdio、托管 ChatGPT 登录、临时任务和事件。
- [通用 Sign in with ChatGPT API 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：该 API 路径不支持 image generation；本实现使用原生 Codex 路径。

## API 与保存

| 接口 | 用途 |
| --- | --- |
| `GET /api/generation/status` | 检查本机 Codex ChatGPT 登录，只返回连接状态 |
| `POST /api/generation/jobs` | 提交一个形象或批量部件任务 |
| `GET /api/generation/jobs?projectId=...` | 当前工程的生成记录 |
| `GET /api/generation/jobs/:id` | 进度、候选、错误 |
| `DELETE /api/generation/jobs/:id` | 中断当前任务，保留已完成候选 |
| `GET /api/generation/jobs/:id/images/:imageId` | 读取已登记的 PNG 候选 |

服务仅接受 loopback Host；写请求须来自同源工作台，不允许跨站提交。请求上限 40 MB，参考 PNG 合计 28 MB，每张 18 MB；每批最多 128 个区域，每张生成最长 12 分钟。服务一次执行一批，每个工程只能有一个待完成任务。

`work/generation/jobs/<uuid>/` 保存任务、参考 PNG、生成 PNG 和最终提示词，默认不纳入版本控制。候选通过受限图片接口读取，不提供任意文件下载。服务重启时把未完成任务标记中断，不自动重新生成；已完成候选保留。

当前工程的形象参考和两种提示词保存在 IndexedDB，可编辑 ZIP 另含 `.ai-spine/generation/appearance.png` 与元数据。批量候选历史属于本机服务；跨机器备份可编辑 ZIP 保留选定形象、已应用部件和校准，不携带整份候选历史。运行时包没有生图元数据。

## 验证与边界

自动测试覆盖真实图像解码、透明度、逐部件映射、取消和部分完成、错误/文本回复拒绝、重启恢复、同源限制、模板指纹、校准与工程往返。测试不发送付费 API 请求，也不自动调用真实生图；真实账号验证由浏览器流程单独执行并记录于 [validation.md](validation.md)。

完整生成验收样例为 [蛋仔「星莓果冻精灵」](../outputs/egg-starberry/README.md)：6/6 部件、5/5 动作、两种导出重导入、全部校准和形象恢复，另有 `pnpm test:egg` 的 9 项专项检查。该样例包含网格身体和 Atlas 90° 双叶，不以局部换色作为完整角色验收。

原生工具和账号可用性依赖本机 Codex 版本、登录和服务状态。静态部署不包含本机 Codex 服务。AI 可能改变轮廓、连接点或细节，仍需人工检查；自动适配不会重建网格，也不保证任意大幅外形变化可直接使用原骨架。
## 任务所有权与关闭

`server/jobs/generation-service.mjs` 与 `server/jobs/rig-service.mjs` 分别负责模板、骨架任务的请求验证和固定快照。`server/jobs/manifests.mjs` 负责按任务串行、临时文件加 rename 的原子记录；`queue.mjs` 负责排队、活动状态、取消和关闭排空。模板形象/部件、骨架形象/补绘、结构/动作规划与动作研究由独立 handler 执行，图片和任务 ID、原提示词及文件布局保持。

模板队列与骨架队列独立，每条同时执行一个任务。两条部件队列各可使用 1–4 个图片请求，因此可同时存在 8 个在途图片请求；这里没有引入全进程 4 并发限制或共享预算。动作画面仍最多 3 并发。失败重试固定原 provider、model、网关、协议、描述、参考图和 part/frame 映射，只处理未完成项。

首次 manifest 保存完成后任务才进入可执行队列。创建失败不会被另一任务的排空意外拾取而开始生图。同工程的并发创建会被拒绝；关闭后不再接受新任务，已经开始的创建也纳入关闭等待。取消为所有在途请求发送同一任务的 AbortSignal；上游立即停止的能力仍由对应服务决定。服务关闭会等待模板与骨架请求收尾、终态记录及全部 manifest 写入，再关闭共享连接和 Codex RPC。Codex handler 还等待迟到的 turn/start、interrupt 和 unsubscribe 控制请求完成或达到各自 RPC 超时，避免发出取消后立即断开连接。

任务保存在 `~/Library/Application Support/AI Spine/generation/jobs`，骨架任务继续位于其 `.rig` 子目录。重启把上次活动任务显示为中断失败，保留候选，不自动重做。开发/预览的端口目录互相隔离；启动第二个相同正式端口实例在打开数据之前失败，不能改写运行实例的任务。日常入口见[本机工作台](workbench.md)，完整角色仍需逐部件、全部动作和实际导出回导验收。

