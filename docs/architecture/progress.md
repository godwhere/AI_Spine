# iSpine 架构实施记录

当前进度（2026-10-21）：P0–P7 实施与本地验收已完成，最终版本已安装。各节保留阶段当时的范围与证据；当前结论见 [P7 验收](../evidence/architecture-p7/acceptance.md)。

2026-10-20 范围修订（历史记录）：用户明确放弃桌面 App，后续交付只包含浏览器界面与本机后台。P0、P1 下方保留当时的实际实施和验证记录；其中桌面关闭接线与 desktop 测试结果属于历史范围，不代表继续维护 App。P3 将迁出通用服务与有效测试，退役桌面代码，详见[修订后的执行计划](execution-plan.md#p3-整理网页边界并退役桌面代码)。该次仅更新文档；随后实施结果记录在 P3。

## P0 建立基线与隔离环境

2026-10-20 完成。基线提交 `961b7cf02f5163e5c7a891df3e70b25ba45f5bbb`，工作区干净；Node `v24.19.0`，原生 Canvas 可用。当前 shell 默认 Node 是包装器，验证使用启动器选择的真实 Node。包管理器沿用 pnpm，仅更新 `pnpm-lock.yaml`；原有 `package-lock.json` 未改动。

变更范围：新增 `tests/support/isolated-workbench.mjs`、Playwright 基础设施、两个浏览器基线场景、隔离实例测试、架构检查、内容基线与性能测量脚本，以及测试依赖和文档。没有改动保存业务、数据库 schema、provider 路由、页面样式或用户素材。

- 隔离启动器强制使用新临时目录与系统分配端口，不接受正式数据目录参数。真实任务队列接入确定性假图像服务；账户 RPC、密钥保护与外部请求均禁止。两个实例同时运行并关闭其中一个，另一个的在途任务和 manifest 保持活跃。
- 浏览器测试构建到临时目录，绕开 Vite 开发代理。使用本机 Google Chrome 和真实 React；每个用例使用独立后台与浏览器上下文。预览入口 `pnpm preview:isolated` 同样不连接正式工作台，退出后清理自身目录。
- 依赖检查解析静态导入、再导出、可解析的动态导入及 require，检查缺失模块和循环。[例外清单](exceptions.json) 逐条登记 4 条 P2 `server → src` 与 1 条 P3 `server → desktop`；不允许新违规，已经消除的例外必须删除。

验证结果：

| 检查 | 结果 |
| --- | --- |
| 原主测试 | 458/458 通过 |
| 架构与隔离测试 | 5/5 通过 |
| desktop 兼容 | 8 通过、1 跳过（历史实际 App 包验收） |
| Sites | 4/4 通过，受保护文件未改动 |
| 两组 Python 网关工具 | 3/3、4/4 通过；仅本地假服务 |
| 真实浏览器 | 2/2 通过：共享测试库、模板预览/列表三列切换与返回不新增资源 |
| 导出基线 | 模板 22 的 runtime、editable、Unity 各自重新解析，49 个区域及全部动作保留 |
| 内容边界 | 774 个原文件中仅 package.json、pnpm-lock.yaml 及本阶段文档有预期修改；原素材与 Sites 文件 hash 保持 |

性能基线采用固定种子的合成素材，每组在重开数据库后测一次首次查询，再预热测 30 次；不是清空系统文件缓存后的冷磁盘测量。测试时本机可能还有其他进程负载，耗时用于后续同机对比。列表仍读取完整 payload，保存仍传输全部素材，均是 P4/P5 待解决问题：

| 资源数 × 单资源素材 | 列表 p50 | 列表 p95 | 改名请求字节 |
| --- | --- | --- | --- |
| 10 × 1 MiB | 16.68 ms | 21.82 ms | 1,398,364 |
| 100 × 1 MiB | 181.01 ms | 303.46 ms | 1,398,364 |
| 500 × 1 MiB | 1,346.35 ms | 2,384.47 ms | 1,398,364 |
| 10 × 10 MiB | 135.07 ms | 1,192.86 ms | 13,981,276 |
| 1 × 50 MiB | 15.84 ms | 17.88 ms | 69,905,328 |

证据：[内容基线](../evidence/architecture-p0/baseline.json)、[依赖图](../evidence/architecture-p0/dependencies.json)、[性能与导出 hash](../evidence/architecture-p0/performance.json)、[资源库截图](../evidence/architecture-p0/resource-library.png)、[模板动作截图](../evidence/architecture-p0/template-preview.png)。完整执行日志在 `/tmp/ispine-P0-*.log`，临时导出包在 `/tmp/ispine-P0-{runtime,editable,unity}.zip`。日志和临时包不作为长期唯一证据；持久记录保留条目 hash、动作和采样数据，不包含用户数据库或账户信息。

复核入口：`pnpm test:architecture`、`pnpm test:isolation`、`pnpm test:e2e`、`pnpm test:performance`。真实 Node 的路径由 `启动工作台.command` 给出；运行 pnpm 时确保该 Node 在 PATH 前部。`pnpm baseline:architecture --compare docs/evidence/architecture-p0/baseline.json` 对照本次基线列出变化并拒绝原素材/受保护文件变化。

截至 P0，待修场景包含普通工程自动保存与导航竞争、写入中继续编辑、跨会话回调、网络回执丢失、离页保护。后续 P1 结果见下节。P0 浏览器通过不代表真实 AI、完整角色或官方 Spine 编辑器验收。

回退：移除 P0 新增测试、脚本、依赖和对应文档即可；正式数据库与任务历史未变更。保留作为基线的证据以供后续阶段对照。

## P1 统一保存与会话生命周期

2026-10-20 完成。源代码与隔离预览已更新；正式静态目录、后台进程、数据库和生成任务均未切换。P2 至 P7 继续按执行计划推进。

实际修改边界：

- `src/application/save-coordinator.js` 按实体串行写入、按会话保留基础版本和本地修订；待写快照合并，失败保留，明确拒绝不自动重试。编辑快照共享不可变图片引用，不复制原始图片集合。
- `src/application/editor-session.js` 管理本地作者修订；`exit-guards.js` 接受注入的浏览器目标。`src/App.jsx` 将自动/手动/导出后保存、导航、骨架正常资源发布及历史桌面关闭接入同一机制。已结束且没有待写数据的普通会话会释放，旧回执只能刷新资源摘要缓存，不能修改新会话的文档、状态或选中项。
- `src/core/rig-draft-writer.js` 是草稿适配器；`rig-drafts.js` 显式传入每个会话的预期版本，历史 IndexedDB 使用原事务执行版本校验和单调时间戳。更换原图产生新草稿 ID 时，不借用旧实体的版本；已关联资源和另存归属规则保留。
- `src/core/workspace.js` 为无业务错误码的明确 4xx 拒绝提供稳定错误码，区别于网络回执未知。未知提交先读回核对；未能确认的新资源创建不会无条件重发。P5 的 mutation 回执尚未实现。
- `SpineViewer` 提供显式缩略图端口，`RigWorkbench` 将缩略图作为保存输入；保存函数不再全局查询画布。保存失败状态提供“另存为新资源”，保留原资源。三栏布局与样式未变。
- 真实 React 测试发现 `RigCanvas` 在空起点同时比较两个缺失 ID，错误地读取空的拖动预览。仅增加非空条件，恢复空起点及 source-only 草稿流程；未改校准、骨骼或动作算法。

验证：主测试 **472/472**；架构/隔离 **5/5**；desktop **8 通过、1 跳过**（实际历史 App 包）；Sites **4/4**。未新增架构例外，原 5 条仍留待 P2/P3 消除。构建在隔离目录完成，现有大 chunk 提示保留，未借此改动构建拆包或正式静态文件。

真实 Chrome 浏览器 **14/14**：

| 场景 | 结果 |
| --- | --- |
| 资源库、真实模板多动作与一列/三列切换 | 保持，预览不新增资源 |
| 改名与部件校准后立即切页并重新打开 | 最新名字、变换与原图字节保持 |
| A 在途时连续 B/C 编辑、导航等待 C | 只提交 A、C；C 回执前保持待保存 |
| 丢失 HTTP 保存响应后继续编辑 | 读回确认已提交内容，未重复提交，后续版本正确 |
| 两页面旧版本冲突与另存 | 原资源不覆盖，本地内容成为独立新 ID |
| 回收站、永久删除后的迟到保存 | 拒绝，旧 ID 不复活，本地内容保留 |
| 未改模板开关 AI、显式保存、编辑后撤销到初始内容 | 未改稿不入库，已保存资源保留 |
| 仅原图草稿导航、隔离后台重启与页面刷新 | 草稿可恢复，未成为普通资源 |
| 完成的合成骨架保存为正常资源 | 共用 writer，草稿归属版本与实际资源回执一致 |
| 在途保存刷新并取消离页 | 真实 beforeunload 提示，本地内容保留，确认保存后可刷新 |
| 历史桌面关闭命令 | 浏览器内注入兼容桥验证；提交回执前不发送 closeReady |
| 未改临时模板直接导出 | 实际下载可编辑 ZIP 并重新解析全部 7 个动作，显式保存进入资源库 |

单元/集成另覆盖同一实体的两会话独立基础版本、失败跨会话恢复、旧回调身份、未知创建不无条件重发、未知结果重试前重新核对、历史 IndexedDB 版本冲突，以及已关联旧草稿的保留/另存规则。

证据：[校准重新打开](../evidence/architecture-p1/calibration-reopened.png)、[冲突另存](../evidence/architecture-p1/conflict-saved-as-new.png)、[阶段检查摘要](../evidence/architecture-p1/verification.json)。完整日志在 `/tmp/ispine-P1-*-final.log`。浏览器合成骨架仅验证保存合同，不是完整角色美术或正式 Spine 编辑器验收；真实 AI 服务没有调用。

当前限制：未确认的浏览器强制退出不能保证保存。稳定 mutation 回执、无素材重复传输、摘要独立查询及模块全面迁移分别仍由 P2 至 P7 负责。正式 App 已由既有方案退役，本阶段没有重建或安装该 App。

回退：保留现有数据格式，逆向恢复 P1 的保存/导航、版本和预览端口接线；可以保留独立空画布修复。P0 测试基础设施独立保留。不删除已保存的资源、草稿、原图、生成记录或导出文件。对应使用说明已更新 `docs/workbench.md`，README 仅新增已经存在的应用层目录与当前保存行为。

## P2 共享规则与计算引擎

完成日期：2026-10-21。按用户修订后的纯网页范围实施；桌面壳删除和通用后台迁出仍属于 P3。本阶段没有切换正式服务、修改数据库 schema、接触账号认证或调用真实 AI。

已实施：

- `shared/domain/` 管理作者内容比较、临时保存政策、source-only 草稿、资源归属、附件组/文档命令、候选匹配、模板元数据和作者摘要。后台与前端引用同一几何投影；摘要读取不再加载浏览器存储或 WebGL。
- `shared/codec/` 统一 SHA-256、Base64、图像 data URL 和 UTF-8。既有 JSON 属性顺序、源图片字节和模板路径排序保留；未新增必填指纹版本字段，已有 V1 任务/候选继续使用相同输入校验。工作区 JSON 的二进制标记和 wire 格式保留。
- `engine/rig/` 分开创建草稿、几何/权重、附件、FK/IK/动作采样、检查、编译、Atlas 和文件装配。`engine/images/` 管理校准、原图注册、动作图像归属与像素计算；`engine/archive/` 管理路径/ZIP/资源解析、作者数据、模板快照与 Unity/附件变体导出；`engine/spine/` 只使用 `spine-core` 解析数据和测量几何。
- 浏览器 File/fetch、图片解码/编码、Canvas、UUID 和当前时钟由 `src/infrastructure/` 提供。像素计算显式接收 [PixelPort](../../shared/contracts/pixels.mjs)；保留原有 bitmap 与 DOM-image 两套图片适配器。`src/spine/runtime.js` 保留 WebGL 场景、播放时钟和相机。
- 消费者全部改用实际责任模块，删除 16 个已无消费者的旧 `src/core` 文件及迁移转发；剩余存储和生成编排留待 P3。`server/workspace-store.mjs` 直接使用 shared/engine，四条 `server → src` 例外已清除。
- 架构检查新增按词法作用域识别平台 API 的检查，允许作者文档参数和注入端口，拒绝 shared/engine 中的全局 DOM、网络、存储、Node Buffer、平台加密和当前时钟。唯一剩余例外是 P3 待处理的 `server/workbench-server.mjs → desktop/server.mjs`，无循环或缺失模块。

验证：

| 检查 | 结果 |
| --- | --- |
| 主测试（含新增引擎检查） | 476/476 |
| 架构边界 / 隔离服务 / Sites | 4/4、2/2、4/4 |
| Python 本地工具 | 3/3、4/4 |
| 隔离真实浏览器 | 15/15；包含继承的历史关闭桥测试，未构建或验收 App |
| 无 DOM / 平台 I/O 禁用 | 全部 shared/engine 模块在独立 Node 进程成功导入 |
| 迁移前后语义对照 | 两份 JSON 完全相同：38 模板指纹、动作/皮肤取景；三格式 ZIP 全包与逐条 hash；4 种旋转/PMA 像素校准；4 动作采样、权重、附件切换、编译及作者数据 |
| 浏览器引擎端口 | 真实图片解码/编码、骨架构建与运行库采样、200 个脚锁区间样本、释放状态、校准/可编辑 ZIP 回导、逐部件 PNG 和作者数据通过 |
| 素材与 Sites 保护 | 相对 P2 起点的 `public/`、`outputs/` 与四个受保护 Sites 文件 hash 均保持 |

证据：[迁移前](../evidence/architecture-p2/engine-before.json)、[迁移后](../evidence/architecture-p2/engine-after.json)、[依赖图](../evidence/architecture-p2/dependencies.json)、[验证摘要](../evidence/architecture-p2/verification.json)。`scripts/measure-engine.mjs` 可重测，主测试会持续比较迁移前样本。完整日志在 `/tmp/ispine-P2-main-final.log`、`/tmp/ispine-P2-browser-final.log`、`/tmp/ispine-P2-support.log` 和两份 Python 日志。构建在临时目录完成；更新后的隔离预览已在浏览器打开，服务实例和假 AI 均与正式数据隔离。

固定 ZIP 时间使本次三格式样本连打包字节也一致。模板创建/校验的当前时间改由适配器传入，动作图应用的时钟由适配器注入、仍在完成计算后读取；它们的真实时间值不作为固定 hash。未改变角色美术、动作语义、图片像素、存储/归档身份、HTTP 协议或 UI 布局。

回退：逆向恢复 P2 的函数位置和对应消费者 import，并恢复同一版本的依赖声明与锁文件；所有数据格式保持，既有资源不需要迁回。不要把运行中的旧网页/后台与另一套前端模块混用。正式数据迁移、独立摘要、二进制传输、桌面退役和任务/provider 整理仍分别由后续阶段完成。

## P3 网页边界与桌面源码退役（已完成）

2026-10-21：先完成后台、运行环境与桌面退役部分；前端组装、功能/应用用例/rig 会话重组仍待继续，P3 未完成。

已实施：

- 将原 `desktop/server.mjs` 的回环 HTTP、静态文件/CSP/Host/Origin/路径边界和关闭生命周期迁到 `server/http/server.mjs`。HTTP 层只接收路由和关闭端口，不构造数据库、任务或 provider。API 按工作区、生成和 rig 分开；URL、请求限额和错误码保留。
- `server/bootstrap/workbench.mjs` 是 Node 服务组装点，显式区分 production/development/preview/test，注入工作区、任务、路由与保护能力。先取得端口才打开数据库/恢复任务；端口冲突仅关闭本次传入的能力，不打开既有历史。服务关闭和失败清理幂等。
- Vite 插件保留薄接线：默认开发数据隔离，默认开发任务沿用旧目录，其他开发/预览端口拥有各自历史。只有显式 `ISPINE_BACKEND_ORIGIN` 才代理另一回环后台。严格端口、监听后装配和关闭前排空共同保护在途任务；真实 Vite 重启验证新实例不会提前读取旧历史。
- `server/bootstrap/launcher.mjs` 负责独立网页启动、可用正式服务复用和旧端口别名；启动脚本仅调用它并注册退出清理。测试实际启动独立服务、由注入 opener 核对打开地址，并检查复用者关闭不会停止已有后台。当前 `local.ispine.workbench` 登录启动项仍指向 `scripts/start-workbench.mjs`，没有桌面壳参数；未改登录项或重启正式后台。
- 移除 `desktop/`、`src/core/desktop.js` 和三个桌面专属脚本；删除 Electron/packager 依赖及三个 App 命令。当前 pnpm 完整依赖树不含 Electron。旧网页命名启动别名继续打开浏览器；原 profile、IndexedDB、真实二进制、备份和输出证据不属于本次源码删除。
- `App.jsx` 删除桌面平台分支、标题栏、菜单/closeReady 桥接和桌面示例初始化。网页空库不新增例子；网页保存和离页保护保留。历史关闭桥测试退役，新增真实浏览器空库/墓碑重载与共享服务失败不分叉存储检查。
- `tests/desktop.test.mjs` 的 6 个有效后台/密钥检查迁至 `tests/backend.test.mjs`，2 个归档检查迁至 `tests/archive-fixtures.test.mjs`，实际 App 包测试删除。新增 5 个组装/启动/环境/端口与真实 Vite 生命周期检查。密钥测试使用 Node 保护端口和拒绝系统调用的替身，未调用实际钥匙串。
- 依赖例外清零。静态检查新增桌面目录、Electron 包和 aiSpineDesktop 桥接禁用，检查当前依赖声明；既有历史数据中的 desktop 来源标识仍保留。

验证：主测试 **489/489**；真实浏览器 **16/16**；架构/隔离/Sites **10/10**。主测试继续覆盖 P2 固定语义样本、旧数据迁移幂等/冲突/墓碑、资源和草稿 CAS、密文保留与按需解锁；浏览器继续实际下载并解析可编辑 ZIP。构建和新版预览均在临时目录完成，已打开新版预览；正式静态目录未覆盖，真实 AI 未调用。`public/`、`outputs/` 和四个 Sites 保护文件相对 P3 起点均无 hash 变化。

证据：[后台阶段摘要](../evidence/architecture-p3-backend/verification.json)、[依赖图](../evidence/architecture-p3-backend/dependencies.json)。日志：`/tmp/ispine-P3-main-final.log`、`/tmp/ispine-P3-browser-final.log`、`/tmp/ispine-P3-support.log`。完整依赖树核对位于 `/tmp/ispine-P3-tree.json`。当前只更新选定的 `pnpm-lock.yaml`。

后台批次结束时的剩余范围为前端组装、功能/用例与会话重组；后续完成情况见下一批记录。不能将无依赖例外解释为这些职责已经拆分。

回退：恢复上一版可用的网页/Node 接线或单个运行环境配置，保留通用 HTTP 服务和全部用户数据；不重新安装或发布 App。不回退或清理用户的历史 profile、备份、候选、独立导出和本机加密配置。

### P3 前端入口与应用用例批次

2026-10-21：根界面迁到 `src/app/AppShell.jsx`，主入口在 React 挂载前通过 `browser-services.js` 一次组装存储模式、API 地址、仓储、Worker、下载、图片、预览和 AI 客户端。存储/API/传输身份一经选定不能在失败时改用另一套；共享服务失败仍保留本地编辑。预览通过专门 Provider 注入已有场景工厂，捕获参考图使用同一能力；播放时钟、相机与手动缩放仍由原运行时组件持有。

已实施：

- `src/features/library/` 包含资源/模板库，`generation/` 包含生成面板/流程，`connections/` 包含连接设置。它们接收命令或客户端，不再自行读取工程仓储、解析 Atlas、创建 HTTP 客户端。模板区域统计的原规则迁入纯 engine helper；搜索、选择、输入与候选展示保持为视图状态。
- `resource-actions.js` 承担资源打开/预览、导入选择、删除恢复、模板固化和同源模板更新。固化仍先烘焙校准、真实导出/解包、解析检查，再调用模板仓储；取消不调用保存，不复制生成描述到模板。
- `export-project.js` 依次编译图片、同步 rig 作者数据、由 Worker 导出并重解析、触发下载、强制持久化。下载后的保存失败单独返回，已成功的导出不会被误报为打包失败。
- `apply-candidate.js` 保留模板指纹/部件映射校验、指定动作变体及原生图片记录；重复应用相同候选保留已有手动校准。未应用候选仍与工程内容分离。
- `editor-persistence.js` 管理普通工程入库政策、保存提交与摘要回执，使用原 P1 writer。保留清空名称时临时稿不入库、显式保存、独立会话版本与迟到回调身份；缩略图通过注入端口捕获，不查询 DOM。
- `rig-resource.js` 管理草稿恢复/归属、校准烘焙后进入骨架编辑、普通资源发布和冲突另存。发布仍使用共享 writer，普通资源回执和草稿归属先后顺序保持；原生图片、动作和无关草稿不被迁移操作覆盖。
- 删除 6 个被迁出的旧文件，更新所有消费者与测试，没有保留路径转发。AppShell 依赖检查拒绝 engine/core/具体平台模块；应用层的平台 API 检查和既有功能边界检查继续通过。编辑历史、导航与 rig 文档所有权尚未收口，因此本批不宣称 AppShell 已成为最终的纯组装组件。

验证：主测试 **496/496**；真实浏览器 **18/18**；架构/隔离/Sites **10/10**；传输身份锁定和最终架构规则后的集中复核 **11/11**。新增 6 个应用用例检查使用实际模板、Canvas 和三格式 ZIP，覆盖烘焙固化、原始文件不变、失败不写仓储、候选重用校准、下载/保存顺序和临时稿政策；组装检查证明自定义 API 路径贯穿工程/生成/rig，服务失败不创建另一份 IndexedDB。

新增浏览器流程在隔离假 AI 下通过：模板取消、保存、更新相同 ID、刷新复用；可见生成提交、按任务映射应用单个候选、校准、保存后刷新恢复。核对了原资源文件与后台原生候选均保持，未将这类单部件材料测试解释为完成角色美术验收。其余保存、版本冲突、墓碑、空库和实际下载回导继续通过。

证据：[前端批次摘要](../evidence/architecture-p3-frontend/verification.json)、[依赖图](../evidence/architecture-p3-frontend/dependencies.json)。日志：`/tmp/ispine-P3-front-main-final.log`、`/tmp/ispine-P3-front-browser-final.log`、`/tmp/ispine-P3-front-support.log`、`/tmp/ispine-P3-front-final-focused.log`。构建与预览仍在临时目录，新版网页已打开；素材、正式静态目录、真实用户数据与受保护 Sites 文件均未切换。

该批次结束时 P3 剩余：编辑器内容/历史/另存与导航的会话所有权；编辑器功能边界；rig 会话与结构、部件、绑定、动作、验证面板；整阶段的窄屏、拖动/相机与下载回导验收。后续修改继续验证 P1 保存边界与 P2 内容样本。回退本批仅恢复同版本的前端入口、用例/能力接线与消费者，保留已有保存数据和独立模板，不改数据库或退回桌面壳。


### P3 编辑与骨架会话、面板批次

2026-10-21：本批完成会话所有权和视图拆分，P3 仍在执行。

- `editor-workspace.js` 持有当前文档、会话身份、图片编辑历史、临时稿保存政策接线和另存 fork。撤销只恢复图片编辑与部件选择，不回滚后来写入的名称或创作说明；文件和 PNG 字节共享不可变引用。迟到回调带原会话 key，不能修改后来打开的资源。另存提交未确认时保留相同目标 ID，并阻止关闭或回写原资源，读回确认后继续原 fork。
- `navigation.js` 持有离页事务的 pending 状态，保存/草稿 flush 完成前冻结重复导航，失败后保留原页面。骨架弹窗通过显式 blocking 回调保护导航，AppShell 不再查询弹窗 DOM。
- `rig-session.js` 持有唯一骨架文档、撤销/重做和拖动检查点。正常取消恢复原文档；手势期间文档已被其他操作修改时，只移除该手势的检查点并保留后来修改。工作台异步操作仍沿用当前文档引用与存活状态校验。
- 普通编辑布局移到 `src/features/editor/EditorView.jsx`，读取同一会话快照并接收 UI 命令。`src/features/rig` 拆出结构、部件补绘、绑定/权重、动作及验证/保存面板，以及共享部件属性、坐标对齐和数值/握点控件；面板不各自保存文档。所有布局、样式、文案及图像计算沿用原实现。`RigWorkbench.jsx` 仍有命令编排和平台引用，不能因面板已拆出而将其视为最终边界。

验证：主测试 **501/501**，隔离真实浏览器 **21/21**，架构/隔离/Sites **10/10**；会话与实际面板集中测试 **51/51**。新增五项应用检查覆盖历史引用、迟到回调、另存响应丢失与相同 ID 核对、重复导航/失败解锁、拖动取消保留后来修改。

新增浏览器检查实际拖动部件和关节、撤销/重做、经过五类面板、校准弹窗期间键盘导航保护、草稿离页保存及刷新恢复；确认未将草稿写入普通资源。真实 WebGL 相机参数在手动缩放/平移和切换动作后保持，资源内容不变。390px 窄屏保留三列模板图片、列表/预览返回和资源库独立视图状态。浏览器截图仅为合成流程夹具或既有模板，不代表新角色美术验收。

证据：[会话批次摘要](../evidence/architecture-p3-sessions/verification.json)、[依赖图](../evidence/architecture-p3-sessions/dependencies.json)、[内容保护核对](../evidence/architecture-p3-sessions/content.json)、[骨架面板截图](../evidence/architecture-p3-sessions/rig-panels.png)、[窄屏预览截图](../evidence/architecture-p3-sessions/narrow-template-preview.png)。完整日志在 `/tmp/ispine-P3-sessions-main-final.log`、`/tmp/ispine-P3-sessions-browser-final.log`、`/tmp/ispine-P3-sessions-support-final.log`、`/tmp/ispine-P3-session-panel-final-focused.log`。网页构建在临时目录完成，新版隔离预览已打开；正式服务、正式静态目录、数据库 schema、素材、旧迁移来源和真实 AI 均未切换。

该批次结束时 P3 剩余：骨架命令/图片/任务能力的应用端口与功能边界，`PartEditor`/`RigCanvas` 等消费者归属；整阶段三格式实际下载/文件导入回导、网页启动及数据/任务保护核查。P4–P7 未开始。本批回退恢复同版本会话与消费者接线，不回退已保存工程或草稿，不恢复桌面壳。


### P3 应用命令与网页交付收口

2026-10-21 完成全部 P3。逐项核对执行计划的 11 步和 10 个验收门槛，结果见[验收审计](../evidence/architecture-p3-final/acceptance.json)。

- `rig-commands.js` 从唯一会话读取当前文档，接管关节/部件修改、缩放/移动、握持、网格权重、影响骨骼、显示组/默认附件、部件增删和关键帧命令。`rig-operations.js` 接管程序初稿、来源/映射校验、候选准备、原图坐标对齐、逐帧处理、真实 Spine 预览编译和发布前全部动作检查。`rig-view.js` 从现有引擎派生网格、姿势、可见附件、父级候选和部件标注；未复制或重写计算算法。
- `part-calibration.js` 接管临时校准及撤销历史，PNG 字节保持不可变引用，应用前不改主工程。默认图片初始化不能覆盖后来选择的替换图，关闭或修改后的异步适配结果不能回写旧会话。图片解码、Canvas、文件读取和部件/动作处理能力由 `browser-services.js` 注入。
- `PartEditor` 移至 `features/editor`；`RigWorkbench`、`RigCanvas`、动作画面/完整部件/部件标注/局部变换 UI 移至 `features/rig`。跨功能的校准窗口通过组装入口传入，不让 rig 导入 editor 内部。动作画面用例、时间边界 helper 和草稿 writer 归入 `application`；删除旧路径及不再需要的兼容转发。样式只调整入口导入，CSS 内容保持基线。
- `library-controller.js` 管理初始查询、共享工作区通知与回执更新。迟到的旧读取不能覆盖已保存回执；失效期间会重新读取，保留其他客户端的修改。停止订阅后抑制旧查询和通知。预览图片准备与取消放入 editor hook，AppShell 只组装页面、能力和命令，不再访问具体仓储或执行图片/任务业务。
- 编辑会话在打开应保存的导入资源及作者修改时立即排队，骨架文档命令也同步通知草稿 writer，不依赖后一次 React 被动效果建立刷新保护。已产生作者修改的临时稿在首次写入前撤销时，待写快照替换为当前内容，避免旧编辑残留。未改动模板预览与 AI 打开/关闭继续保持临时状态。异步动作检查期间关闭视图，不发布旧资源。

最终验证：主测试 **509/509**；真实隔离浏览器 **23/23**；架构/隔离/Sites **10/10**。完整浏览器回归修正了发布回调的一处旧缓存引用，随后全部通过；另对 77 个前端模块做词法引用核查，没有未声明标识符。依赖图为 151 个模块、557 条导入，例外/循环/平台引用均为 0；完整依赖树不包含 Electron 或 `@electron/*`。

三格式验收使用真实模板和带权重、互斥附件、脚锁释放时间线的合成骨架。六个 ZIP 均由可见导出控件下载，通过文件选择再次导入并保存为独立资源；核对骨架原字节、骨骼/约束/皮肤/动作、实际 PNG、作者关节/网格/附件/时间线、可编辑校准和原资源不变。合成附件只验证数据切换，不代表表情或角色美术验收；未声称运行官方 Spine 编辑器。包的实际字节数和 SHA256 记录在[下载证据](../evidence/architecture-p3-final/downloads.json)。

浏览器夹具通过正式使用的 `launchWorkbench` 启动隔离服务，并验证交给浏览器的 URL；真实 Chrome 打开同一地址。端口/数据根/假 AI 能力仍独立，不触达正式实例。新版预览已在本轮浏览器打开。生产 PID 71292 未重启，正式静态目录未覆盖；素材、CSS 和四个 Sites 保护文件相对 P0 基线没有变化。最终验证窗口对生产工作区、生成目录、迁移备份、旧 IndexedDB/Local Storage 及开发任务历史的 **1366 个文件**核对 SHA256，六个目录的内容均不变；该窗口的时间范围单独记录，不将其解释为更早全时段的外部状态证明。

证据：[阶段摘要](../evidence/architecture-p3-final/verification.json)、[逐项审计](../evidence/architecture-p3-final/acceptance.json)、[依赖图](../evidence/architecture-p3-final/dependencies.json)、[内容核对](../evidence/architecture-p3-final/content.json)、[真实数据保护](../evidence/architecture-p3-final/live-preservation.json)。日志：`/tmp/ispine-P3-final-main.log`、`/tmp/ispine-P3-final-browser-verified.log`、`/tmp/ispine-P3-final-support.log`，依赖树位于 `/tmp/ispine-P3-final-dependency-tree.json`。

P4–P7 尚未执行。下一阶段仅建立不读大图片的资源摘要查询；正式数据切换、图片分离和任务能力重组仍按后续阶段边界执行。P3 回退应成组恢复前端会话/用例/消费者和通用后台接线，保留已保存数据及浏览器入口，不恢复桌面壳。


## P4 独立资源摘要查询（已完成）

`server/workspace/project-index.mjs` 为原 SQLite 增加版本 1 的摘要索引、按资源缓存的原字节缩略图及旧写入器变更标记。启动时可重入回填；原始 V8 records 格式不变。摘要包含有界名称、日期、真实计数、替换数和缩略图引用，不含原文件、替换图或生成原图。`projects.list/summary` 只读索引；`get/read` 才读取完整工程。前端按当前后台地址读取缩略图，并沿用原编辑、模板与预览流程。

保存、迁入、回收站、恢复和永久删除在原事务内同步源记录与摘要。只读事务使用 deferred，不抢占写锁；实际写入才推进全局 revision，无变化保存、重复恢复和维护重建不增加修订。旧写入器的删除触发器在同一事务清除摘要与缓存图片，仅留 ID 标记，回退也不遗留被永久删除的角色内容。未来索引版本拒绝写入；损坏记录明确定位并回滚，列表不临时反序列化或静默跳过错误。

新增显式目录的 `scripts/workspace-index.mjs`，提供只读 `--check` 和原事务 `--rebuild`。一致性检查对照原记录、摘要、缩略图字节与变更标记，重建可修复派生数据，不改变数据库身份、作者记录或 revision。维护不遍历外部任务、导出文件和旧浏览器库。

最终验证：主测试 **519/519**、真实隔离浏览器 **24/24**、架构/隔离/Sites **10/10**。覆盖不读 payload、不反序列化、写锁下读取、源/索引/缩略图故障回滚、两次重建一致、损坏记录阻断、版本拒绝、旧写入器永久删除以及实际缩略图显示后打开原工程。已有资源、回收站、墓碑、草稿、自建模板和全部导出回导测试保持通过。

同机固定种子的合成素材，每组重新打开后查询一次，再测 30 次。未清空系统文件缓存；下表只反映 SQLite 摘要查询，不包含 HTTP、图片读取或界面绘制。首次回填单独计量，全部摘要查询读取源 payload 次数为 **0**：

| 资源数 × 单资源素材 | 首次回填 ms | 摘要 p95 ms |
| --- | ---: | ---: |
| 10 × 1 MiB | 18.341 | 0.096 |
| 100 × 1 MiB | 208.205 | 0.270 |
| 500 × 1 MiB | 1460.841 | 0.887 |
| 10 × 10 MiB | 173.334 | 0.088 |
| 1 × 50 MiB | 46.216 | 0.094 |

P0 同机 500 × 1 MiB 列表 p95 为 2384.467ms，本阶段为 0.887ms；原先的完整 payload 读取已移出列表。50 MiB 工程改名仍发送约 69.9MB，二进制分离与小文档传输属于 P5，不能据摘要结果宣称保存已优化。

通过 SQLite 只读一致性备份复制正在运行的生产数据库，只修改临时副本。实际 4 个正常资源、2 个回收站资源回填、检查及两次重建全部通过；所有分区原记录合并 SHA-256、ID、数据库身份与 revision 保持。生产进程 71292、正式静态目录和生产 schema 未切换；核对窗口内 6 个范围、1366 个文件内容一致。未调用真实 AI 或解锁密钥。

证据见[逐项验收](../evidence/architecture-p4/acceptance.json)、[阶段验证](../evidence/architecture-p4/verification.json)、[性能](../evidence/architecture-p4/performance.json)、[实际副本](../evidence/architecture-p4/live-copy.json)与[生产内容保持](../evidence/architecture-p4/live-preservation.json)。最新隔离预览为 `http://127.0.0.1:53961`，独立数据与 fake provider。P5–P7 待执行。

本阶段回退可恢复旧查询，保留或重建索引；原 payload、图片、作者文档与 ZIP 不需要转换。正式激活和存储格式变更严格留在 P5。


## P5 图片分离与版本化保存（执行中）

### 第 1 步：临时仓储批次完成，未激活

`shared/domain/workspace-assets.mjs` 定义存储格式 2 的已知素材字段与引用契约；它与现有作者文档、工程 ZIP、rig 文档版本分别管理。原文件、替换图、已应用形象、草稿原图、外观参考、部件、配准底图、动作帧、比较图和动作裁片按明确路径转换，不扫描任意字符串猜测图片。引用标记只在这些字段识别，未知扩展字段与其中的二进制、图片样式字符串及同名标记对象均保留。还原保留原字节、ArrayBuffer/Uint8Array、data URL 前缀与 padding；无法无损还原时整条转换回滚。

`server/workspace/v2-repository.mjs` 在调用者提供的 SQLite 内建立 `documents_v2`、`asset_blobs`、`asset_refs`、`mutations`、`asset_uploads`。SHA-256 取自原字节，不重新编码 PNG。独立资源、草稿和模板按 namespace/store/ID 持有引用，`sourceProjectId` 无删除级联。普通资源永久删除清除 V1/V2 内容与旧回执，保留 ID 墓碑；任何旧 mutation、创建或转换都不能绕过墓碑。上传租约随同数据库保存，提交后释放本次租约；活跃租约、回收站和任一独立实体引用阻止回收。

提交要求明确基础版本，版本 0 代表仅在不存在时创建。文档、引用、索引回调、revision 和小回执同事务提交；同 mutation 内容返回原回执，不同内容复用 ID 明确拒绝。无变化提交可补回执但不推进作者版本或库 revision。源图片查询与提交引用验证只取存在性/字节数；改名、校准和关键帧修改不读取或重写未变 BLOB。原字节完整性检查单独扫描并定位损坏字节、孤立引用、缺失租约与墓碑冲突，不在每次列表或保存时全量读取图片。

最终主回归 **533/533**、仓储集中测试 **14/14**、架构/隔离/Sites **10/10**。新增证据覆盖：

- 原文件与未知字段还原；存储往返后的 runtime、editable、Unity 三种 ZIP 与原包逐字节相同。
- 重启后图片、版本、尚未提交的租约和原 mutation 回执保持。
- SQLite 在插入回执后故障，真实摘要索引、文档、引用、revision 与回执一起回滚。
- 三种小修改的 JSON 请求均小于 64 KiB，提交期间不查询 BLOB 字节、不插入新 BLOB；这属于仓储层证据，尚不是 HTTP 接线后的传输验收。
- 哈希伪造、引用缺失/重复/未知编码/内嵌字节、空图、256 MiB 总量、4096 素材上限、旧版本和未来格式明确拒绝。
- 删除原资源后，自建模板和独立草稿的图片在租约过期并回收后仍完整。

实际库的一致性临时副本仅以只读方式检查了 21 条记录与 423 处 Uint8Array 的类型分布，没有执行 V2 副本迁移。生产服务仍为进程 71292，原服务及 schema 未切换。沿用核对文件集的 6 个范围、1366 个文件内容保持，未发起真实 AI 或解锁密钥。浏览器界面与当前服务没有接入本批模块，沿用 P4 的实际浏览器证据，本批没有重复声明新的浏览器验收。

证据见[批次范围](../evidence/architecture-p5-repository/acceptance.json)、[验证](../evidence/architecture-p5-repository/verification.json)、[依赖](../evidence/architecture-p5-repository/dependencies.json)与[生产文件保持](../evidence/architecture-p5-repository/live-preservation.json)。现行 README 使用流程和工作台操作未变，本批无需修改。回退可移除未接入的新模块与临时测试库，正式数据无需转换。

P5 尚待：能力协商、V2 HTTP 路由、前端仓储和保存回执接线；统一资源/草稿/模板事务与 V1 兼容读写；一致性副本的检查点迁移、导出回导、反向转换；维护、备份、任务/编辑协调及正式激活。当前不能宣称完整 P5 通过。


### 第 2 步：统一仓储与 HTTP 子批次完成，前端待接线

`WorkspaceStore` 按显式激活标记选择一份仓储。格式 2 的工程、草稿和模板均走 `documents_v2` 与独立引用，旧 V1 读取/迁入和带安全时间戳条件的兼容写入也走同一仓储。缺失版本条件的旧写入明确要求刷新；切换前已打开的服务对象不能继续访问旧格式。原始表的写保护在 SQLite 内执行，旧二进制直接写入同样被拒绝。已有数据不会在启动时自动切换；仅新建的空测试库使用显式初始化，并在写锁内再次检查空库条件。

`server/workspace/v2-commands.mjs` 保留现有领域校验，将草稿/模板的 metadata 与 document/files 成对提交。数字版本、已有时间戳条件和草稿移动的原草稿版本均受检查。资源多选永久删除全组原子提交，revision 只推进一次，过渡期旧 payload 一同清除。源资源删除不影响自建模板或独立草稿。模板删除、草稿移动后，旧 mutation 回执失效为仅含 ID 的标记，迟到重试不能重建旧记录；资源永久删除仍只保留 ID 墓碑。

`server/http/workspace-routes.mjs` 提供状态能力、缺失 hash 查询、原字节 PUT/GET 与小文档分类命令。POST/PUT 均要求同源；声明长度和实际分块流都受限制，文档与引用再次合计校验。源图片不进入成功保存响应。同一次保存重试及服务重启可取回原回执，复用 mutation ID 的不同内容被拒绝。具体请求与兼容边界见[协议 2](workspace-v2-protocol.md)。

新增真实 HTTP 用例发现并修复了 SQLite 外层 UPSERT 对触发器 `INSERT OR IGNORE` 的冲突行为：摘要标记改用显式 `ON CONFLICT DO NOTHING`，旧派生触发器可重建升级；旧源记录已有标记时，新仓储提交仍保持源/摘要原子性。该修复不改变作者数据和图片格式。

最终验证：主测试 **540/540**、索引/仓储/HTTP 集中检查 **31/31**、真实原格式浏览器 **24/24**、架构/隔离/Sites **10/10**。7 个 HTTP 场景覆盖新接口、去重和重试、重启、跨来源 PUT、伪造/缺失 hash、错误版本、声明/分块超限、草稿/模板成对回滚、多选删除回滚、V1 兼容、旧二进制写保护、墓碑优先和草稿移动竞态。实际 HTTP 测量：

| 合成输入 | 首次上传素材 | 后续改名/校准上传素材 | 后续 JSON 命令体 | 小回执 |
| --- | ---: | ---: | ---: | ---: |
| 1 MiB 源文件、替换图与缩略图 | 1,048,649 B | 0 B | 871 B | 558 B |

这是临时库的实际 HTTP 传输证据，不代表完整 V2 浏览器验收。后台目前复用完整领域校验，会还原记录并读取素材；本批不宣称集成保存已经完全免读 BLOB。新前端协议适配与保存调度重试仍待接线，当前 24 个浏览器场景验证原格式路径保持。

生产仍为进程 71292，正式服务、静态目录、数据格式和任务未切换；核对的 6 个范围、1366 个文件内容保持。没有真实 AI 或密钥解锁。最新隔离预览为 `http://127.0.0.1:55647`，使用原格式、独立数据和 fake provider。证据见[后台验收范围](../evidence/architecture-p5-http/acceptance.json)、[验证](../evidence/architecture-p5-http/verification.json)、[实际传输](../evidence/architecture-p5-http/transfer.json)与[生产文件保持](../evidence/architecture-p5-http/live-preservation.json)。本批回退恢复同批仓储、路由与测试接线即可，生产无需反向转换。

P5 剩余：前端能力/素材/保存回执适配与实际 V2 浏览器验收；一致性副本的检查点迁移、下载回导和反向转换；维护、备份、任务与编辑协调、正式激活。P6–P7 未开始，整阶段验收仍未完成。


### 第 2 步：前端素材与保存回执接线完成，隔离验收通过

`src/infrastructure/workspace-v2.js` 在固定后台地址上查询素材、上传缺失原字节、校验下载 hash，并还原现有引擎使用的文件/图片结构。`src/core/workspace.js` 按后台能力选择协议，固定工作区身份；未知格式、未就绪能力和不可写状态明确报告，连接失败不改写 IndexedDB。状态轮询同时识别格式变化。原格式继续使用既有接口。

已知素材先从文档视图替换为引用，再克隆作者元数据，避免复制整套图片后立即丢弃。不可变素材的 hash 使用弱引用缓存，图片字符串缓存依附其所属文档对象；下载字节缓存有 64 MiB 预算，已确认/明确拒绝的请求最多保留 64 条并受元数据预算约束。未知提交保留原请求用于恢复。上传/下载最多并行 4 项，首个失败后不启动新项，等待在途项结束才报告失败。未知字段、PNG 原字节与现有作者/归档版本保持。

普通工程、骨架草稿和骨架发布通过组装根注入独立 UUID 工厂。保存调度为每个待写快照保留稳定 mutation ID；重试沿用原文档、原基础版本与原缩略图。A 的响应未知而本地已有 C 时，先取回 A 的原回执，再以确认版本写 C；若另一个页面已提交 B，C 继续被版本检查拒绝，本地内容仍保留。未知提交属于原格式时仍按 P1 读回核对，不能因为随后能力变化就改成不带条件的新写入。

主回归 **548/548**、前端/组装/普通与草稿调度集中检查 **29/29**、架构/隔离/Sites **10/10**。真实浏览器原格式 **24** 项、格式 2 **13** 项通过；默认回归运行 28 项，其中 4 项格式 2 与专门运行重叠，不重复计算：

- 普通资源改名、校准、立即导航与重开保持源 PNG、已有替换图和变换。后续请求体小于 64 KiB；只允许新预览缩略图上传，不重传未变素材。
- 连续丢失两个保存响应后，同 ID 回执确认 A，再写 C；版本仅推进两次。两个页面的冲突继续保留本地修改，并可另存为独立资源。
- 草稿关键帧时间和角度修改时图片上传为 0；立绘、独立部件、关节与重启后文档保持。源图草稿和普通资源库仍分开，骨架正式发布正确关联保存版本。
- 自建模板取消/保存/更新、候选应用/校准、真实部件/关节拖动和撤销、相机保持、三列模板及窄屏导航均通过格式 2。
- 原模板与带权重/附件变体/约束释放时间线的合成骨架分别实际下载 runtime、editable、Unity ZIP，再通过文件选择器重新导入并保存，核对骨架、图片、作者数据、关键帧和校准，共六包。

已实际打开格式 2 的独立预览 `http://127.0.0.1:56585` 并检查动画编辑器；测试截图中原始与当前角色均正常渲染，界面布局未更换。正式服务仍为进程 71292，未重启、覆盖静态构建或切换格式；核对的 6 个范围、1366 个文件内容保持。没有真实 AI、账号路由核对或密钥解锁。新导出证明格式与资料往返，不代表新角色美术、全部动作观感或官方 Spine 编辑器验收。

证据见[阶段验证](../evidence/architecture-p5-client/verification.json)、[逐项范围](../evidence/architecture-p5-client/acceptance.json)、[六个实际下载包清单](../evidence/architecture-p5-client/downloads.json)、[依赖](../evidence/architecture-p5-client/dependencies.json)与[生产内容保持](../evidence/architecture-p5-client/live-preservation.json)。后台依然复用完整领域校验，本批不宣称保存已完全免读 BLOB。旧浏览器迁入、缓存页面切换和大数据规模矩阵仍需随第 3 步实际副本迁移验证。

P5 第 1、2 步已实现并通过隔离验收。下一步为第 3 步一致性副本的检查点迁移、全部 namespace/删除标记/hash、下载回导与反向转换；再进入第 4 步维护、备份、任务/编辑协调与正式激活。P5 整阶段及 P6–P7 尚未完成。当前可成组回退前端协议/调度/对应测试接线，生产数据无需转换。

### 检查点迁移与反向转换批次

2026-10-21：P5 第 3 步完成。新增独立维护锁与检查点迁移器、显式目录 CLI、格式感知的只读摘要检查，以及相应浏览器维护协商。每批转换与检查点同事务；SQLite 一致性备份包含 WAL 并核对原内容及文件 SHA-256。所有 namespace、扩展字段、原始记录字节、身份、revision、旧浏览器迁入映射与删除标记逐项核对，不能无损转换或发现损坏时停止并定位。激活事务同时切换格式、重建/核查摘要、保护旧分支并释放维护；不会修改生成历史、账号、旧 profile 或导出文件。

六个正向检查点（冻结、备份、批次、验证、激活提交前、提交后）实际退出子进程后可继续；反向提交前退出也保留当前 V2 新编辑。激活前取消仅撤销暂存目标；激活后回退以当前数据重新备份并反向转换。退役 V2 表不可继续写入，V1 永久删除同步清理其旧文档/引用并失效旧回执。只读检查不补建缺失的已声明表。维护暂时拒绝保存时，客户端保留请求和上传来源，租约过期后仍能补传原 mutation。

正式库仅以只读方式制作一致性副本；其中 21 条记录（4 正常资源、2 回收站、7 删除标记、3 组草稿、1 组模板）完成正向激活、改名、反向转换及全量核对。原 6 个项目分别导出 runtime、editable、Unity；18 组迁移前后 ZIP 逐字节相同。迁移后 18 包全部通过隔离浏览器文件选择重新导入并保存，核对每张 PNG、骨架、动作、约束及可编辑作者数据，未写入正式资源库。

主回归 **563/563**、迁移含嵌套退出点 **14** 项、仓储/前端/迁移集中 **35/35** 加新增维护重试检查通过；默认浏览器 **31/31**、架构/隔离/Sites **10/10**。浏览器覆盖维护中重启与本地编辑保留、全新 profile 只读浏览/延后旧库迁入、取消后重试、已缓存页面 V1→V2 与 V2→V1。架构 162 模块、606 import，违规与循环为 0。生产 PID 71292 未重启、静态构建未替换；原核对 6 范围 1366 文件内容保持。没有真实 AI 请求或密钥解锁。

证据见[迁移验证](../evidence/architecture-p5-migration/verification.json)、[逐项范围](../evidence/architecture-p5-migration/acceptance.json)、[生产副本](../evidence/architecture-p5-migration/production-copy.json)、[导出](../evidence/architecture-p5-migration/exports.json)、[浏览器回导](../evidence/architecture-p5-migration/reimports.json)和[维护操作](workspace-v2-protocol.md#检查点迁移与维护)。第 4 步正式任务/编辑协调、当前完整备份、激活与交付构建核查尚未完成，不能据副本演练宣称生产切换；P5 整阶段及 P6–P7 仍未完成。

### 正式维护与激活完成

2026-10-21：P5 第 4 步完成。维护前读取正式生成目录的 67 个任务，54 完成、9 失败、4 取消，无在途或排队任务；可观察的 Chrome 停在资源库，没有打开的编辑。卸载并停止原登录服务 PID 71292，完整复制本机数据、旧构建及启动项到 `~/Library/Application Support/iSpine Backups/20261021-041242-before-workspace-v2`。1183 个数据文件共 1,143,027,672 字节与 160 个旧构建文件逐文件 hash 相等；另保留 SQLite 一致性维护备份。

在服务停写状态下转换全部 21 条记录，核查后于单事务激活格式 2 和独立摘要、释放维护。原 records 字节、数据库身份、revision 4 保持，当前 V2 全记录与维护前完整备份逐条深相等。独立目录构建完成后核对 160 个产物，再完整替换 dist，恢复同一登录启动项为 PID 94728。4175、4173、4180 均返回同一格式 2 身份；素材完整性与摘要检查通过。Chrome 刷新加载实际新构建，原齐天悟空模板/替换动画两侧正常渲染，145 骨骼、49 纹理区域及原 7 动作信息存在；未编辑、仍已保存。返回资源库后原 4 正常资源与 2 回收站保持，revision 未推进。

生成、migration、旧 IndexedDB/Local Storage 及开发任务内容保持。当前 Sub2API 选择与密文未改；按既有规则重启后保持锁定，不自动解锁、审核上游或发起生成。真实 AI、角色美术和官方 Spine 编辑器不是本次结构调整验收。激活后如需回退，先停写并备份当前数据，执行已验证的反向转换，不能直接恢复维护前旧库而丢失新编辑。

证据见[正式验证](../evidence/architecture-p5-production/verification.json)、[激活/备份](../evidence/architecture-p5-production/activation.json)、[内容保持](../evidence/architecture-p5-production/preservation.json)与[实际 Chrome 预览](../evidence/architecture-p5-production/editor.png)。P5 第 1–4 步及阶段验收项全部完成，P6–P7 尚未完成。

## P6 任务调度与 AI 能力边界（已完成）

2026-10-21 完成源码实现和隔离验收。`server/jobs` 抽取按任务序列化的原子 manifest、受目录约束的加载、持久化后入队、状态/取消/关闭排空；模板、骨架图片、结构/动作规划和动作研究分别执行 handler。请求和业务校验保留在两个服务入口，任务 ID、文件布局、原提示词和候选映射不变。图片适配器明确声明 image，独立 Codex 规划适配器只接受明确 planning 身份；密钥保护和按需解锁仍由连接服务负责。

关闭现在等待两队列、创建中的操作、全部图片/规划请求与记录收尾，再关闭共享连接和 RPC。未持久化的新任务不会进入可运行 Map，避免创建失败后被另一个工程排空而隐式生图；同工程同时创建被拒绝。原并发政策保留：模板/骨架各同时一个任务，部件各 1–4，两个图片任务合计可达 8 在途；动作画面最多 3。没有引入全进程共享限额。重试继续只处理未完成的固定 part/frame，provider、model、endpoint、protocol 不能自动替换。

主测试 **570/570**、provider/任务/生命周期集中 **100/100**、架构/隔离/Sites **10/10**，格式 2 浏览器模板和假生成/应用/校准 **2/2**。新增 7 项覆盖在途关闭、手动排空的所有权、创建竞争/关闭、初始记录失败、原子写失败与恢复、能力隔离，以及三个 native turn/start 尚未返回时取消并在迟到 turn ID 后逐个 interrupt/释放监听。6 个 handler/提示函数的字面文本、数值、模板片段和校验模式与原基线 AST 相等。

正式 23 条模板任务与 44 条骨架任务从完整备份复制到临时目录，使用禁止账号/生成的端口完成新恢复和关闭流程，67 条历史与所有文件字节相同、无自动续做。正式 PID 94728 仍运行 P5 代码，当前正式数据 6 个核对范围保持；最终安装和全阶段性能/浏览器收口在 P7。见[P6 验证](../evidence/architecture-p6/verification.json)、[验收](../evidence/architecture-p6/acceptance.json)、[handler 等价](../evidence/architecture-p6/handler-equivalence.json)及[历史副本](../evidence/architecture-p6/history-copy.json)。


## P7 最终验收与目录收口（已完成）

P7 完成了剩余存储与后台入口的职责迁移：浏览器仓储和历史 IndexedDB 归入 `src/infrastructure/`，资源包 Worker 归入 `src/workers/`；共享结构化输出校验归入 `shared/contracts/`。工作区应用服务接收注入的仓储，SQLite 留在 `server/workspace/repository.mjs`，HTTP 路由仅调用服务端口。连接、RPC、密钥保护和各类 handler 分别归属 `server/ai/`、`server/infrastructure/`、`server/providers/`、`server/jobs/handlers/`。迁移不更改历史数据库名称或任务文件布局。

最终验收修复了跨资源候选应用保护、取消时迟到的原生 turn 控制请求等待，并让 Worker 转移其拥有的输出缓冲区。输入原始图片仍保留，编辑规则、提示词和既有骨架导出内容保持。新增服务器应用层禁止直接依赖具体仓储和 Node I/O 的检查，临时架构例外为零。

详细测试、生产替换和外部验收边界见 [P7 验收](../evidence/architecture-p7/acceptance.md)。此前各阶段记录保留其当时状态；本节及最终验收为当前结论。
