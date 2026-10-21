# 工具脚本导航

使用项目指定的 pnpm 和 Node.js 24 或更新版本。常用操作通过 [package.json](../package.json) 的命令运行；应用代码位于 `src/`、`engine/`、`shared/` 和 `server/`。

## 启动与交付

| 脚本 | 入口与用途 |
| --- | --- |
| [start-workbench.mjs](start-workbench.mjs) | `pnpm workbench`；启动或复用正式后台并打开网页，根目录启动器与登录启动项沿用此路径 |
| [preview-isolated.mjs](preview-isolated.mjs) | `pnpm preview:isolated --format=2`；临时工作区、临时构建和假 AI 预览 |
| [prepare-sites-build.mjs](prepare-sites-build.mjs) | 由 `pnpm build` 调用，准备 Sites 交付目录 |

## 检查与测量

| 脚本 | 入口与用途 |
| --- | --- |
| [check-architecture.mjs](check-architecture.mjs) | 模块依赖、平台边界与循环检查；`pnpm test:architecture` 包含完整断言 |
| [architecture-baseline.mjs](architecture-baseline.mjs) | `pnpm baseline:architecture`；采集架构与受保护文件基线 |
| [measure-engine.mjs](measure-engine.mjs) | 核对计算引擎的解析、校准与导出样本 |
| [measure-workspace.mjs](measure-workspace.mjs)、[measure-workspace-v2.mjs](measure-workspace-v2.mjs) | `pnpm test:performance`；工作区读取、保存及素材传输测量 |

`pnpm test` 自动发现 `tests/` 顶层的全部 `*.test.mjs`，包含架构、隔离、Sites 和保留角色交付包检查。浏览器用例位于 `tests/browser/`，通过 `pnpm test:e2e` 运行；Python 网关用例单独运行。

## 工作区与素材维护

| 脚本 | 入口与用途 |
| --- | --- |
| [workspace-index.mjs](workspace-index.mjs) | `pnpm index:workspace <目录> --check` 只读检查，`--rebuild` 重建派生索引 |
| [migrate-workspace.mjs](migrate-workspace.mjs) | `pnpm migrate:workspace <目录> --status` 查看状态；备份、迁移与激活需显式参数，见[协议](../docs/architecture/workspace-v2-protocol.md) |
| [sync-reference-templates.py](sync-reference-templates.py) | 同步参考模板；素材许可见[第三方声明](../THIRD_PARTY_NOTICES.md) |

## 网关工具

| 脚本 | 用途 |
| --- | --- |
| [sub2api-web-entry.py](sub2api-web-entry.py) | ChatGPT 网页图片入口与路径约束 |
| [sub2api-web-sync.py](sub2api-web-sync.py) | 网关网页账号同步工具 |
| [sub2api-gemini-egress.py](sub2api-gemini-egress.py) | Gemini 图片请求转发 |

网关工具仅用于显式配置的 Sub2API 集成，具体配置与部署位置见 [Sub2API 说明](../docs/sub2api.md)。
