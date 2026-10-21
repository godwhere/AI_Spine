# iSpine 文档导航

项目功能、格式、代码职责与常用命令见[项目首页](../README.md)。日常使用从[本机网页工作台](workbench.md)开始。

## 使用与制作

| 文档 | 内容 |
| --- | --- |
| [本机网页工作台](workbench.md) | 启动、共享资源、本地数据、备份与恢复 |
| [角色制作工作流](character-production-workflow.md) | 制作计划、设定与分镜、分阶段审阅、实际导出回导 |
| [骨架与动作](rig-authoring.md) | 部件、关节、绑定、约束、动作和手动调整 |
| [AI 连接](ai-connections.md) | Codex、API Key、连接状态与密钥保护 |
| [AI 生成](generation.md) | 模板部件生成、候选应用、并发、取消与恢复 |
| [Sub2API](sub2api.md) | 显式网关配置、图片协议与本机转发工具 |
| [模板附件与动作变体](template-variants.md) | 独立附件、默认规则与动作切换 |
| [模板动画经验](template-animation-lessons.md) | 制作中的校准与动作检查经验 |
| [Unity 导出与 Spine 编辑](unity-export.md) | 导出格式、版本匹配与编辑器导入边界 |
| [模板素材来源](reference-assets.md) | 模板目录与素材说明 |

## 架构与维护

| 文档 | 内容 |
| --- | --- |
| [架构方案](architecture/plan.md) | 模块职责、依赖方向、修改边界及迁移目标 |
| [分阶段执行计划](architecture/execution-plan.md) | P0–P7 任务、验证与回退条件 |
| [架构实施记录](architecture/progress.md) | 实际完成状态与各阶段证据 |
| [工作区协议](architecture/workspace-v2-protocol.md) | 文档/图片分离、版本、提交回执和显式迁移 |
| [架构例外清单](architecture/exceptions.json) | 架构检查直接读取的机器配置 |
| [工具脚本导航](../scripts/README.md) | 启动、构建、检查、存储维护和网关工具 |

架构方案与执行计划保留设计时的目标和阶段上下文；实施记录说明已执行内容。代码边界由 `pnpm test:architecture` 检查。

## 验证与历史

| 文档或目录 | 内容 |
| --- | --- |
| [验收记录](validation.md) | 按日期记录的本地验证及外部验收边界 |
| [验收快照](evidence/) | 原始报告、哈希与阶段证据；记录中的旧路径保留当时含义 |
| [历史桌面交付](archive/desktop.md) | 已退役 App 的交付和迁移记录 |
| [历史设计检查](archive/design-qa.md) | 早期角色与界面检查记录 |
| [本地制作产物](../outputs/README.md) | 交付包、原图和截图的保留规则 |

历史记录中的 App 启动、打包命令及旧测试数量仅描述当时的交付。当前入口和操作以项目首页、功能指南及最新验收记录为准。

新增功能说明放在本目录，架构与协议放在 `architecture/`，退役交付记录放在 `archive/`，原始验收快照放在 `evidence/`。更新或移动文档时同步维护此导航及相对链接。
