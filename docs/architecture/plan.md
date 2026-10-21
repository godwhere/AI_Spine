# iSpine 架构调整方案

状态：P0–P7 实施与本地验收已完成。日期：2026-10-21。

最终记录见 [P7 验收](../evidence/architecture-p7/acceptance.md)。后文保留各阶段原实施边界和当时批次进度；当前实现以最终记录及 README 为准。真实 AI、官方编辑器与人工美术检查的外部边界单列，不计为通过。

保留 React、Vite、Spine 4.3、本机 Node 服务和 SQLite 的技术组合，按业务职责整理模块。优先统一保存机制，再建立共享规则与计算引擎边界，随后优化资源查询和二进制存储。每一步均保持现有创作流程可用。

产品入口已明确为纯网页：浏览器承载全部创作界面，自动启动的本机 Node 服务继续负责共享数据、任务和系统密钥保护。桌面 App 已放弃，不再列入目标架构、兼容目标或交付验收；旧桌面数据只保留为迁移来源。P2 已抽出共享规则和计算引擎；P3 已完成通用后台、网页功能/会话/应用命令边界与桌面源码退役，并通过三格式实际下载回导和整体网页验收。P4 已完成独立摘要、按需缩略图、事务同步与回填核查。P5 的仓储、传输、前端回执与检查点迁移通过隔离/生产副本验收，反向转换保留新编辑；正式维护、完整备份、21 条记录激活与完整构建替换已完成，原地址的资源与动画读取通过，身份及 revision 保持。

P5 详情见[激活证据](../evidence/architecture-p5-production/verification.json)。

用户已授权按本方案和[执行计划](execution-plan.md)开始实施。以下目录、接口和数据库结构仍是目标设计；实际完成状态和验证证据按阶段记录，不能视为已全部实现。

## 调整前基线与目标

下表记录最初评估时的问题，行数和保存方式不是当前实施进度。P0、P1 的实际变更见[实施记录](progress.md)，后续阶段沿用本表中的职责目标。

| 调整前实现 | 可核查的位置 | 调整目标 |
| --- | --- | --- |
| `App.jsx` 有 1,563 行、50 个 `useState` 和 12 个 `useEffect`，同时编排资源、编辑、草稿、保存和导出 | 当前为[AppShell](../../src/app/AppShell.jsx) | 用编辑会话和应用服务管理业务，根组件只组装页面 |
| 普通工程采用 850ms 防抖保存；骨架草稿另有串行写入和离页保护 | [普通工程保存用例](../../src/application/editor-persistence.js)、[草稿写入器](../../src/application/rig-draft-writer.js) | 共享保存调度机制，保留两类数据各自的持久化规则 |
| 保存携带完整 `files`；列表摘要查询仍反序列化全部资源 payload | [工作区客户端](../../src/infrastructure/workspace-client.js)、[存储](../../server/workspace/repository.mjs) | 摘要独立查询；图片按内容保存，普通编辑只提交文档变化 |
| 后台依赖 `src/core` 中的工程、草稿、模板模块 | [WorkspaceStore](../../server/workspace/repository.mjs) | 后台只依赖共享规则和平台无关的引擎 |
| `rig-client.js` 同时包含网络请求、几何投影和文档修改 | P2 后为[骨架 HTTP 适配器](../../src/infrastructure/rig-client.js)与[数据规则](../../shared/domain/rig.mjs) | 将数据规则、计算与传输分开 |
| 浏览器后台入口复用 `desktop/server.mjs`；开发代理默认连接正式后台 | P3 迁出后为[后台组装](../../server/bootstrap/workbench.mjs)、[开发插件](../../server/generation-plugin.mjs) | 平台中立的服务入口，显式选择运行模式和数据目录 |
| 部分界面测试改写组件源码并模拟 Hooks | [骨架界面测试](../../tests/rig-workbench.test.mjs) | 保留核心测试，增加真实 React 和浏览器的关键流程测试 |

文件大小是职责集中的提示，不作为单独的重构验收标准。真正的验收标准是业务所有者明确、依赖方向可检查、状态变化可测试。

## 必须保持的产品与数据约束

| 边界 | 必须保持 |
| --- | --- |
| 产品与入口 | iSpine 名称、唯一浏览器界面入口、本机后台自动启动方式、现有三栏布局和手动调整流程 |
| 本机数据 | `~/Library/Application Support/AI Spine`、现有数据库路径；正式服务不可用时明确报错 |
| 历史数据 | 原 IndexedDB 名称、旧 profile、备份与迁移识别信息保持；原 bundle ID 仅作历史来源标识，不要求维护 App；不清理用户原始迁移数据 |
| 资源生命周期 | 临时模板未创作不入库；保存过的资源撤销后仍存在；回收站、恢复和 ID 删除标记继续生效 |
| 独立生命周期 | 草稿、模板、普通资源和生成历史独立；删除资源不能级联删除自建模板、导出文件或生成历史 |
| 骨架与艺术 | 原始图片、源像素坐标、权重、附件切换、动作来源和已接受动作保留；不改变角色制作路线 |
| 导出 | 保留 `.ai-spine/`、`.ispine/` 路径及现有格式版本、独立 PNG、`skeleton.images`、JSON/二进制骨架与 Unity 格式 |
| AI | 显式选择 provider；失败不切换；模型、网关身份和候选映射固定；启动浏览不解锁密钥 |
| 验证 | 全部动作、校准和实际导出回导继续验证；数值通过不能代替美术表现验收 |
| 交付 | `.openai/hosting.json`、`worker/index.js`、`scripts/prepare-sites-build.mjs`、`tests/sites-worker.test.mjs` 保持完整 |

本次调整不引入远程数据库、账号系统或计费功能。继续使用 JavaScript ESM；新增边界以 JSDoc 和运行时校验表达契约，类型系统整体迁移不与本次重构捆绑。

## 目标目录

按阶段创建下列目录，不提前铺设空目录。现有入口文件在迁移期间可以保留薄兼容层。

```text
shared/
  domain/                 工程、草稿、模板、附件和任务的纯规则
  contracts/              请求、响应、错误码和端口的 JSDoc 契约
  codec/                  字节编码与现有指纹算法
engine/
  archive/                资源包解析、路径校验、打包与 Unity 文件映射
  images/                 校准、合成、轮廓与像素归属算法
  rig/                    网格、权重、IK、动作采样、编译与 Atlas
  spine/                  无 WebGL 上下文的骨架解析及数据检查
src/
  main.jsx                浏览器启动
  app/                    服务组装、页面切换、全局错误与离页协调
  application/            编辑会话、保存、导入导出、候选应用等用例
  features/
    library/              资源、模板、回收站界面
    editor/               部件编辑、校准、撤销与播放控制
    rig/                  骨架工作台与动作编辑界面
    generation/           生成进度、候选审阅与应用界面
    connections/          AI 连接设置界面
  infrastructure/         HTTP 仓储、历史 IndexedDB、浏览器图片适配
  components/             跨功能共用的展示组件
  spine/                  WebGL 场景、相机、拾取和运行时资源释放
  workers/                图片与资源包后台计算入口
server/
  bootstrap/              正式、开发、预览和测试环境的对象组装
  http/                   路由、请求来源检查、限额与错误响应
  application/            资源操作、迁移和生成任务用例
  workspace/              SQLite 仓储、摘要、附件、迁移与一致性检查
  jobs/                   调度、任务状态和业务 handler
  ai/                     连接配置与能力选择
  providers/              独立图像和结构化规划适配器
  infrastructure/         任务文件、Codex RPC、系统密钥保护和图片适配
tests/                    现有测试及后续架构、浏览器、性能验证
```

`desktop/` 不属于最终目录。P3 先迁出其中仍被网页后台使用的 HTTP 服务，再移除桌面壳代码和构建依赖。`src/app` 与 `AppShell.jsx` 仅表示网页应用的组装层和 React 根组件。

### 依赖方向

| 层 | 允许依赖 | 禁止依赖或行为 |
| --- | --- | --- |
| `shared/domain`、`shared/contracts` | 本层、纯 `shared/codec` | React、DOM、网络、SQLite、文件系统、Spine 场景 |
| `shared/codec` | 标准语言能力 | UI、业务服务、平台 I/O；改变既有指纹输入顺序 |
| `engine` | `shared`、fflate、隔离的 Spine 数据解析、传入的图片端口 | `src`、`server`、React、直接 fetch、默认浏览器全局变量 |
| `src/application` | `shared`、`engine`、注入的仓储与运行时端口 | JSX、具体 HTTP/IndexedDB 实现、组件、全局 DOM 查询 |
| `src/features` | 自己的组件、应用层、共享契约、共用展示组件 | SQL、密钥、provider 请求、其他功能的内部状态 |
| `src/infrastructure` | `shared`、必要的 `engine`、浏览器 API | 业务状态所有权、决定资源是否应保存 |
| `src/spine`、`src/workers` | `engine`、`shared`、必要的平台适配 | 直接保存资源或创建 AI 任务 |
| `server/http` | 契约、注入的应用服务 | SQL、图片算法、直接调用 provider |
| `server/application`、`server/jobs`、`server/ai` | `shared`、`engine`、注入的仓储和能力端口 | `src`、Electron、具体 HTTP 响应对象 |
| `server/workspace`、`server/infrastructure`、`server/providers` | `shared`、必要的 `engine`、各自平台依赖 | 修改 UI 状态、决定用户是否应用候选 |
| `src/app`、`server/bootstrap` | 对应运行环境需要的具体实现 | 承载编辑算法或复制生命周期规则 |

功能组件通过应用命令协作，不互相读取另一功能的状态。入口组装层允许依赖具体实现，其余应用代码只通过注入的端口访问外部能力。迁移兼容层只转发，不保留第二份业务逻辑。

P3 完成后，前端、后台和启动脚本均不得依赖 Electron、`desktop/` 或 `window.aiSpineDesktop`。旧数据读取器可以识别原 profile、IndexedDB 和归档格式，但不依赖桌面进程。

## 代码迁移边界

### 前端与计算代码

下表定义目标所有者；P1 已创建的会话与保存模块继续沿用，其他路径随对应阶段建立。一个文件包含多个职责时按函数拆分，不能仅移动整文件后宣称边界完成。

| 当前文件或函数 | 目标所有者 | 拆分要求 |
| --- | --- | --- |
| `App.jsx` 的页面、modal 与导航 | `src/app/AppShell.jsx`、`src/application/navigation.js` | 导航调用保存与退出用例；不直接拼装工程记录 |
| `openProject`、`openEditor`、`persist`、编辑撤销 | `src/application/editor-workspace.js`、`editor-session.js`、`save-coordinator.js` | 会话身份、内容版本与保存状态有唯一所有者 |
| 资源导入、删除恢复、加入模板 | `src/application/resource-actions.js` | 导入校验和模板固化完成后调用仓储；UI 负责明确的删除确认 |
| `doExport`、`saveRigResource` | `src/application/export-project.js`、`rig-resource.js` | 保留导出前检查、作者数据同步、实际结果重新解析 |
| `RigWorkbench.jsx` | `src/features/rig/` | 分离结构、部件、绑定、动作、验证面板；文档命令进入 rig session |
| `ResourceLibrary`、`TemplateLibrary` | `src/features/library/` | 搜索、列表选择是视图状态；不决定持久化规则 |
| `GenerationPanel`、`CreationWorkflow` | `src/features/generation/` | 显示任务和候选；应用行为调用独立命令 |
| `AIConnectionPanel` | `src/features/connections/` | 输入只交给连接服务；不进入工程、导出或保存历史 |
| `PartEditor`、`RigCanvas` | `src/features/editor/`、`src/features/rig/` | 指针操作生成明确的部件/关节命令；不混同相机平移 |
| `SpineViewer`、`PreviewTransport`、`ResourceThumbnail` | `src/components/`、`src/spine/` | 保持受控输入；场景和图片句柄按生命周期释放 |
| `project-content.js`、`project-draft.js` | `shared/domain/project.mjs` | 保留作者内容比较与临时模板保存政策 |
| `rig-drafts.js` 的 `validateRigDraftDocument`、`rigDraftDestination` | `shared/domain/draft.mjs` | 校验 source-only 草稿、资源归属和另存规则；不打开数据库 |
| `storage.js`、`rig-drafts.js`、`custom-templates.js` 的读写 | `src/infrastructure/*-repository.js` | 统一 API 端口；历史 IndexedDB 实现单独隔离 |
| `workspace.js` | `src/infrastructure/workspace-client.js`、`legacy-indexeddb.js` | 请求、迁移和 revision 观察分开；明确存储模式 |
| `custom-templates.js` 的名称、类型和归属规则 | `shared/domain/template.mjs` | 源资源 ID 是来源信息，不是删除级联关系 |
| `createCustomTemplateRecord`、`validatedSnapshot` 的素材检查 | `engine/archive/template-snapshot.js` | 校验真实骨架、Atlas、图片；组装后的元数据交给共享规则 |
| `archive.js` | `engine/archive/` | 路径、ZIP、解析与导出移入引擎；File/fetch 导入入口留在浏览器适配层 |
| `pixels.js`、`rig-images.js` | `engine/images/` | 算法接受 `PixelPort`；`browserPixels` 移到浏览器适配层 |
| `rig-client.js` 的 `rigGeometry`、附件规则和候选匹配 | `shared/domain/rig.mjs`、`shared/domain/generation.mjs` | 几何投影和指纹原料前后端只有一份 |
| `rig-client.js` 的 `createRigClient`、`motion-study-client.js` 的 HTTP 方法 | `src/infrastructure/rig-client.js` | 只负责请求、解码、取消和错误转换 |
| `rig-authoring.js` 的 mesh、weights、IK、sample、inspect | `engine/rig/` | 纯计算；不加载图片，不访问浏览器 |
| `compileRigSkeleton`、`buildRigFiles`、`rig-atlas.js` | `engine/rig/compile.js`、`build-files.js`、`atlas.js` | 编译依赖采样；文件构建通过图片端口生成 PNG |
| `rig-project.js` | `shared/domain/rig-summary.mjs`、`engine/archive/rig-project.js` | 摘要、字节编码、作者数据嵌入和校准固化分别归属 |
| `rig-registration.js`、`rig-motion-ownership.js` | `engine/images/registration.js`、`motion-ownership.js` | 保留源像素锁定、覆盖/误差指标与审阅规则 |
| `rig-motion-studies.js` | `shared/domain/motion-study.mjs`、`engine/rig/motion-study.js`、`engine/images/motion-study.js` | 数据校验、姿势采样与图片切片分离，保护原图和 idle |
| `rig-part-adjustment.js`、`rig-part-annotations.js` | `engine/rig/part-adjustment.js`、`annotations.js` | 调整 setup placement；标注按实际采样结果计算 |
| `template-variants.js` | `engine/archive/template-variants.js` | 保持附件命名、恢复备份和动作切换；hash 实现收敛但输入字节不变 |
| `parseSkeleton` | `engine/spine/parse.js` | 可在无 DOM 的 Node 中执行；场景创建仍属于 `src/spine/runtime.js` |
| `archive-worker.js`、`package.worker.js` | 浏览器 Worker 客户端、`src/workers/package.worker.js` | 请求携带会话/计算版本；旧结果不能覆盖新编辑 |
| `src/core/desktop.js` | 删除平台检测；必要的资源初始化归 `src/application` | 去除 `isDesktop` 与桌面桥接；先核查示例初始化是否仍有消费者，不把原桌面自动播种行为引入网页；保留空库和删除标记规则 |

`engine` 内部依赖顺序为共享规则 → 几何/像素基础 → 动作采样和检查 → 骨架编译 → 图片与 Atlas 构建 → 资源包导出。基础层不得反向导入导出用例。

### 后台代码

| 当前文件 | 目标所有者 | 必须保留的行为 |
| --- | --- | --- |
| `workspace-store.mjs` | `server/application/workspace-service.mjs`、`server/workspace/` | 事务、版本冲突、墓碑、迁移冲突保留、作者内容无变化时不增版本 |
| `workspace-middleware.mjs` | `server/http/workspace-routes.mjs` | 来源检查、请求限额、409 冲突、错误码；不在路由内实现迁移规则 |
| `generation-plugin.mjs` | Vite 薄插件、`server/http/generation-routes.mjs`、`rig-routes.mjs` | 原 URL、端口任务隔离、图片访问限制 |
| `workbench-server.mjs`、`desktop/server.mjs` | `server/bootstrap/workbench.mjs`、`server/http/server.mjs` | 先迁出可复用的 Node HTTP 服务，保留回环监听、CSP、静态文件边界、关闭时排空任务和写入；移除对 desktop 目录的引用 |
| `generation-service.mjs`、`rig-service.mjs` | `server/jobs/` 中的调度器与各类 handler | 候选不可变映射、并发上限、失败保留结果、仅重试未完成项 |
| `rig-planning.mjs`、`rig-motion-study.mjs` | `server/jobs/handlers/` | 提示词和业务输出检查归各任务所有；不同动作路线不混合 |
| `ai-connections.mjs` | `server/ai/connections.mjs` | 连接状态、受保护配置、显式选择和按需解锁 |
| `providers/*.mjs` | 原目录保留，补充能力契约 | provider 只负责外部协议，不写项目、不决定应用候选 |
| `codex-rpc.mjs`、`codex-structured.mjs` | `server/infrastructure/codex-rpc.mjs`、规划适配器 | 托管认证、事件生命周期、超时与取消；不复制账号凭据 |
| `key-protection.mjs` | `server/infrastructure/key-protection.mjs` | 系统加密不可用时仅会话存储；失败不覆盖原密文 |

### 桌面代码退役边界

以下是 P3 的处理边界；后台迁出、测试归属和桌面专属入口/依赖删除已经执行，前端功能、文档会话与应用命令已完成重组及网页验收，详见[实施记录](progress.md#p3-网页边界与桌面源码退役已完成)。

| 当前文件或内容 | 处理与验收边界 |
| --- | --- |
| `desktop/server.mjs` | 将通用 HTTP 服务移入 `server/http/`，同步正式入口、隔离测试和安全测试；确认网页后台正常运行后才移除旧文件 |
| `desktop/main.mjs`、`bootstrap.cjs`、`preload.cjs`、桌面专用 `key-protection.mjs` | 去掉 Electron 窗口、原生菜单/对话框、IPC 和桌面密钥适配；先迁出仍有用的纯逻辑，确认无消费者后删除。保留 Node 后台自己的系统密钥保护与现有密文 |
| `src/App.jsx`、`src/core/desktop.js` | 删除平台分支、桌面标题栏、`onAction`/`closeReady` 桥接；网页保存统一使用会话调度与浏览器离页保护 |
| `scripts/start-desktop.mjs`、`scripts/build-desktop.mjs`、`scripts/desktop-assets.mjs` | 移除 App 启动和打包。素材准备脚本先核查网页/测试消费者，仍需使用的示例准备逻辑移到中性的资源脚本；不删除示例素材 |
| `package.json` 与当前包管理器锁文件 | 删除 `desktop`、`build:desktop` 和退役后的 `test:desktop` 入口，移除 `electron`、`@electron/packager` 等仅桌面使用的依赖；保留 Node、SQLite 和图片计算所需原生依赖 |
| `tests/desktop.test.mjs` | 将静态资源、Host/Origin、路径穿越、AI 路由、关闭清理和按需解锁测试移到后台测试；可复用归档 fixture 移到导出/迁移测试。停止要求实际 App 包和原生保存对话框验收 |
| `启动工作台.command`、旧桌面命名启动脚本 | 正式入口继续自动启动本机服务并打开浏览器；旧命名脚本若保留，只作网页启动别名，不启动或安装 App |
| 旧 profile、IndexedDB、归档、密文、备份和历史交付证据 | 作为迁移输入或历史记录保留，不为清理目录而删除，不把历史 App 验证结果算作当前网页验收 |

## 编辑会话与保存契约

### 状态所有权

| 状态 | 所有者 | 是否触发保存 |
| --- | --- | --- |
| 工程内容、编辑、已应用候选、作者数据 | editor/rig session | 有真实作者内容变化时 |
| 当前资源 ID、基础版本、保存过标记、撤销历史 | session | 按业务命令处理 |
| 待写快照、正在写入、确认版本、错误 | save coordinator | 调度并等待实际提交 |
| 搜索、选择、modal、展开面板、预览模式 | feature 或 app shell | 否 |
| 播放时钟、相机、手动缩放、WebGL 纹理 | viewer/runtime | 否 |
| 未应用候选、任务进度 | generation controller 与后台任务 | 不自动写入角色内容 |

每次打开编辑器产生独立 `sessionKey`。内容修订号 `localRevision` 与服务器版本分开；选择部件、播放和缩放不增加内容修订号。图片字节按不可变引用共享，撤销记录不能复制整个资源文件集合，也不能原地修改旧字节。

### 保存端口

目标接口示意如下，名称可在首次实现时局部调整，语义必须保持：

```js
const writer = createSaveCoordinator({
  repository,             // save(snapshot, { expectedVersion, mutationId })
  shouldPersist,          // 普通工程和骨架草稿使用各自政策
  schedule, cancel,       // 可测试的时间调度
});

writer.enqueue({ sessionKey, entityId, localRevision, snapshot, reason });
await writer.flush(sessionKey);
writer.getStatus(sessionKey);
writer.hasUnsaved(sessionKey);
```

1. 同一实体最多一个写请求在途；后续编辑合并为最新待写快照。不同会话指向同一实体时不能各自绕过串行队列。
2. 自动保存、主动保存、导出后的持久化、网页内部导航以及页面隐藏时的提前保存统一经过 writer。刷新与关闭标签页使用下述浏览器离页保护，不再接入桌面关闭协议。
3. 仅真实事务成功后更新发起快照所属会话的 `expectedVersion`。确认 A 版本时若 B 已编辑，仍显示待保存，不能显示全部已保存。另一个会话必须使用自己读入的基础版本，不能借用队列中的最新版本绕过冲突检查。
4. 写入回调携带原会话身份。旧会话完成可以更新仓储缓存，不能改变新会话的文档、状态或选中项。
5. `flush` 排空当前及写入期间产生的快照。导航用例在离开期间阻止新编辑，确认无待写数据后才切页。
6. 冲突保留本地内容，停止自动重试，提供重新打开或明确另存；不得自动覆盖远端新版本。
7. 连接中断但提交结果未知时，P1 先读取当前记录并比较作者内容；不能假定失败后直接覆盖。P5 使用稳定 `mutationId` 恢复提交回执。
8. 浏览器隐藏时提早 flush；存在 pending、in-flight 或 failed 内容时启用离页提示。浏览器强制退出或系统崩溃前未确认的写入仍不能保证完成，不能依赖 `beforeunload` 等待网络。
9. 普通工程继续使用 `shouldPersistProject`；未触碰模板和空骨架起点不入库。已保存标记属于资源生命周期，不能被撤销操作清除。
10. 现有草稿 `resourceId`、`resourceUpdatedAt` 和 `previousDraftId` 语义保留；source-only 草稿可保存，未完成 rig 仍不能成为普通资源。

P1 先兼容现有 `expectedUpdatedAt`。后续仓储向应用层暴露不透明的 `version`，由适配器转换，业务代码不能解析时间字符串来判断写入顺序。

## 仓储与外部能力端口

| 端口 | 主要操作 | 约束 |
| --- | --- | --- |
| `ProjectRepository` | `listSummaries/get/save/trash/restore/remove` | `save` 带预期版本；读取和删除都受生命周期规则限制 |
| `DraftRepository` | `list/get/save` | 保存 source-only 文档；资源归属和版本由 session 传入 |
| `TemplateRepository` | `list/get/save/delete` | 同一来源更新同一模板；模板素材拥有独立引用 |
| `GenerationClient`、`RigClient` | `start/list/get/cancel/retry/readImage` | 只返回任务与候选；应用候选是另一条用例 |
| `PixelPort` | `createCanvas/loadImage/encode` | 浏览器、Worker、Node 各自实现；调用者负责释放临时图像 |
| `PreviewPort` | 场景创建、取景、播放、拾取、缩略图 | 应用服务不通过 `document.querySelector` 访问画布 |
| `ImageProvider` | `describe/status/generate` | provider/model/endpoint 快照固定，取消信号贯穿请求 |
| `PlanningProvider` | `describe/status/plan` | 初始仅提供显式 Codex 规划；图像 provider 不隐式获得规划能力 |
| `JobRepository` | `load/list/writeManifest/readImage/writeImage` | 保持现有任务目录与原子 manifest 替换 |

错误以稳定 `code` 传递，至少区分版本冲突、资源删除、服务不可用、请求不合法、迁移中、客户端需要刷新和任务中断。HTTP 层映射状态码，UI 层转换为中文操作说明。

## 存储调整

### 第一步 增加资源摘要索引

保持现有 `records.payload` 和序列化方式，新增 `project_index`，记录 ID、名称、更新时间、删除时间、骨骼/基础部件/纹理/动作数、替换数和有限大小的缩略图信息。

保存、回收站、恢复、永久删除以及旧数据迁入时，在同一事务内更新原记录和摘要。列表只查询该索引。迁移时遍历旧 payload 一次生成摘要；损坏记录必须定位并报告，不以空摘要冒充迁移成功。

同时将只读操作与写事务分离，避免列表查询也执行 `BEGIN IMMEDIATE`。保留全局 revision 用于刷新通知；无作者变化的保存不增加资源版本。索引可以从原数据重建，因此该阶段可独立交付和回退。

### 第二步 分离文档与图片

继续使用同一个 `workspace.sqlite`。首版选择数据库内 BLOB，减少数据库与外部文件双写的故障窗口；是否将大型 BLOB 移到文件目录，留到测量证明有必要后再决定。

| 目标表 | 保存内容 |
| --- | --- |
| `documents_v2` | namespace、entity ID、存储格式版本、作者文档、资源版本、更新时间与删除时间 |
| `asset_blobs` | SHA-256、原始字节数、原始二进制数据 |
| `asset_refs` | namespace、entity ID、字段或文件路径、hash、必要的 MIME/编码信息 |
| `project_index` | 无需读取原图即可展示的资源摘要 |
| `mutations` | entity、mutation ID、请求摘要、提交版本和小型结果回执 |
| `asset_uploads` | 尚未提交的上传会话及暂存引用，防止上传期间被回收 |
| 既有迁移/设置/删除标记 | 保留历史来源映射、数据库身份、revision 和 ID tombstone |

`namespace` 保留工程、草稿、模板的现有逻辑身份。自建模板的 `sourceProjectId` 不建立删除级联外键。相同图片可以去重，但每个独立资源、模板和草稿都有自己的引用。

文档转换按已知字段处理 `files`、替换图片、已应用形象、草稿原图、部件和动作图等二进制内容，不用“匹配所有字符串”猜测图片。保留未知扩展字段；不能无损转换的记录阻止激活新格式。读出时由适配器还原当前引擎需要的字节/图片结构，不改变导出格式。

图片以原字节计算 hash，不为迁移重新编码 PNG。现有工程元数据版本、rig 文档版本和数据库存储格式版本是三件事，不能一起升级。

### 传输与兼容

| 接口 | 目标用途 |
| --- | --- |
| `GET /api/workspace/status` | 保留现有字段，增加协议能力和可写状态 |
| `POST /api/workspace/v2/blobs/query` | 批量查询缺失 hash，避免重复上传 |
| `PUT /api/workspace/v2/blobs/:hash` | 上传单个原始二进制，服务器重新计算 hash 并建立暂存租约 |
| `GET /api/workspace/v2/blobs/:hash` | 按需读取有效引用或当前暂存会话的字节 |
| `POST /api/workspace/v2/:collection` | 执行有版本约束的资源、草稿和模板命令 |

保存请求包含文档、素材引用、预期版本和 `mutationId`；新实体使用明确的 create-if-absent 语义。响应只返回 ID、版本、更新时间与摘要，不回传整套图片。

同一 mutation ID 和相同请求返回同一回执；不同内容复用 ID 要拒绝。若资源后来已删除，重试不能通过旧回执绕过删除规则。文档、引用、摘要、revision 与回执在同一个事务提交。

V1 接口在过渡期通过适配器读写新仓储。现有版本条件必须保留；无法安全表达版本条件的旧写请求返回“需要刷新”，不能当作无条件覆盖。旧客户端不得继续向旧表独立写入。能力切换需要缓存旧页面、多浏览器和服务重启测试。

所有新增端点继续校验本机 Host、Origin、请求来源和大小；PUT 也必须覆盖。分块/去重不能绕过目前单包 256 MiB、4,096 文件及各图像路径已有的尺寸约束。

### 删除与回收

移入回收站保留全部内容引用。永久删除只移除指定资源及其引用，保留 ID tombstone；共享素材只有在所有正常资源、回收站、独立草稿、模板和有效上传会话均不再引用时才可回收。

迁移过渡期的旧 payload 也必须遵守永久删除，不能成为隐蔽的资源副本。单独保存的迁移备份、独立导出与生成历史继续按既有规则保留。逻辑删除不等同于文件系统级安全擦除，不额外承诺物理擦除。

### 迁移与回退

1. 先在独立数据副本演练；记录各 namespace 数量、ID、版本、源文件 hash、删除标记和生成任务状态。
2. 正式迁移开始前让编辑器完成保存，进入明确维护状态；既有 AI 任务完成或显式暂停后再处理，迁移不得自动恢复任务。
3. 使用一致性备份或停止服务后的完整备份；运行中的 SQLite 不能仅复制主文件忽略 WAL。
4. 新表在未激活状态下逐批构建，记录检查点；中断后可重入。维护期间拒绝写请求，避免扫描与新增编辑竞态。
5. 验证数量、字节 hash、引用、草稿归属、墓碑以及导出回导。通过后原子切换 schema 标记，单一仓储成为唯一写入者。
6. 激活前失败可以清理未激活的新结构并继续用旧结构；保留原始备份。
7. 激活后已有新写入时，不能只回滚程序或直接恢复旧备份。先停止写入并备份当前 V2 数据，再执行验证过的反向转换，或保留兼容读取 V2 的上一版程序。
8. 用户已经新写入的数据不能为了回退丢弃。旧表清理与素材回收单独验收，不与首次激活绑定。

## AI 任务与运行环境

任务存储保留当前 production、development、preview 的历史位置。统一抽取 manifest 写入、取消、关停排空和状态迁移机制，业务 handler 继续分别负责模板部件、独立 rig、动作图与规划。

所有 in-flight turn 都属于可取消任务；进程关闭需等待正在进行的任务收尾和 manifest 写入后返回。中断任务保持中断状态，重启不自动重新计费或生成。候选的 provider、模型、endpoint、源图指纹和 part ID 映射保持不可变。

统一机制不等于自动扩大并发。先保持两条现有队列的语义，测出实际活跃请求数；若增加共享 provider 并发限制，明确总预算及排队行为，并同时覆盖模板与 rig 路径。

| 运行模式 | 数据与任务所有者 | 约束 |
| --- | --- | --- |
| 正式工作台 | 现有用户数据目录和 4175 后台 | 单一长期运行服务 |
| 日常开发界面 | 显式配置的工作台代理 | 当前默认连接正式后台的事实必须可见；自动化测试不能沿用此默认值 |
| 独立 preview/test | 显式临时或端口隔离的 workspace 与 jobs | 自己的服务实例与生命周期；不触碰正式任务 |
| 既有托管预览 | 明确选择的浏览器本地适配模式 | 保留现有打包边界；不宣称具备正式本机后台的能力 |

本机服务失败不触发浏览器存储回退。历史 IndexedDB 只用于明确的迁移或既有托管预览模式，不因一次 fetch 失败改变存储所有者。

## 验证与完成标准

依赖检查覆盖静态导入、再导出和可解析的动态导入。最终禁止 `server → src`、`engine → src/server`、共享规则访问平台 API，以及运行代码依赖 `desktop`/Electron/桌面 IPC。过渡例外按文件登记，并在对应阶段退出时移除；旧数据名称与历史文档不属于运行依赖。

新增保存测试必须覆盖响应乱序、写入期间编辑、失去回执、跨会话回调、版本冲突和删除后的迟到保存。浏览器测试使用独立后台与临时目录，真实操作编辑、刷新、导航、草稿恢复和导出回导。

图片和骨架验收继续覆盖旋转 Atlas、裁切偏移、PMA、多页、binary、mesh、附件变体、脚锁释放边界及动作循环。抽取算法阶段先保证既有输出与采样结果一致，再单独安排算法改进。

性能验收先建立基线，再测摘要查询、单次校准保存字节量和 Node 事件循环延迟。硬性要求是列表不解码大素材、校准不重复传输未变化素材；具体耗时预算和样本规模见[执行计划](execution-plan.md)。

README 的目录说明只随对应阶段已经实现的结构更新。使用方法、协议、迁移操作和验证结论随对应实现提交更新，不提前将目标结构写成现状。
