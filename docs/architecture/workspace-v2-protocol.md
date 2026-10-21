# 本机工作区协议 2

2026-10-21：仓储、HTTP、前端保存及检查点迁移已实现并正式激活格式 2。生产一致性副本的 21 条记录完成正向/反向转换；6 个项目的三种导出共 18 组逐字节相同，迁移后 18 包已在隔离浏览器回导。维护中编辑、重启及旧页面正反切换通过。正式切换前已协调任务/编辑并完整备份，原地址的资源与动画读取通过，身份及作者 revision 保持。

## 协商和单一仓储

`GET /api/workspace/status` 保留数据库身份、revision、storage、version，增加 `writable` 和 `capabilities`。格式 1 公布 `protocols: [1]`；已激活格式 2 公布 `[1, 2]`、`assets: true`、`mutationReceipts: true`。已经打开但持有旧格式的服务对象返回不可写，并拒绝后续访问，不能继续维护旧存储分支。

启动只读取激活标记，不自动转换已有数据。`initializeEmptyV2()` 是空隔离库的显式初始化入口；它在写锁内再次检查原记录与暂存新表均为空。已有数据必须经过独立迁移流程。

激活后的 `get/all/put/remove/migrate` 均使用 V2 文档与素材仓储。既有 `removedProjects` 继续保存 ID 墓碑。原表的工程、草稿、模板写入受 SQLite 触发器保护；兼容墓碑或旧 payload 清理的授权仅在当前事务内可见，其他连接不能趁此继续写旧分支。

## 素材端点

| 方法与路径 | 请求 | 结果 |
| --- | --- | --- |
| `POST /api/workspace/v2/blobs/query` | `{ hashes, leaseId }` | `{ missing, expiresAt }`，同时为已存在的 hash 建立上传租约 |
| `PUT /api/workspace/v2/blobs/:hash` | 原始字节；`Content-Type: application/octet-stream`；`X-iSpine-Upload: leaseId` | 重新计算 SHA-256，返回 hash、size、租约时间 |
| `GET /api/workspace/v2/blobs/:hash` | 可选 `?leaseId=...` | 有持久引用或当前有效租约时返回原字节，否则 404 |

所有路由继续检查回环 Host、Origin 和请求来源。POST、PUT 必须提供同源 Origin。声明大小和分块流均限制为 256 MiB；文档与所引用素材按逻辑字节数再次合计校验，去重不免除总量与 4096 素材限制。骨架图片仍受 32 MiB、文档尺寸等现有规则约束。读取响应使用 no-store 和 nosniff。

文档中的已知素材位置使用 `{ "$ispineAsset": 2 }` 占位；`refs` 是 `{ path, hash, size, encoding }` 数组。路径为字符串数组，编码为 Uint8Array、ArrayBuffer 或带原前缀/padding 的 data URL。引用不能携带额外的原图字节。未知作者字段保持原值，不按字符串外观推断素材；正常业务保存仍执行原有领域校验，迁移应使用无损转换入口。

## 分类命令

`POST /api/workspace/v2/:collection` 的 collection 为 `projects`、`drafts`、`templates`。返回 `{ value }`。

| 操作 | 请求 | 结果 |
| --- | --- | --- |
| `head` | `operation, id` | ID、数字版本、更新时间、删除时间，或 null |
| `get/read` | `operation, id` | `{ payload: { document, refs }, version }`，或 null；普通 get 不返回回收站资源 |
| `list/summary` | `operation` | 当前领域列表；资源只返回独立索引摘要 |
| `save` | `operation, id, mutationId, expectedVersion, payload, leaseId, options` | 小回执：ID、版本、更新时间及摘要/非图片元数据 |
| 资源 `trash/restore` | `operation, id, mutationId, expectedVersion` | 版本化回执 |
| 资源 `remove` | `operation, ids, mutationId, expectedVersions` | 整组原子删除，返回 removed 数量；全局 revision 只推进一次 |
| 自建模板 `delete` | `operation, id, mutationId, expectedVersion` | 删除回执 |

版本 0 明确表示仅在实体不存在时创建。错误基础版本返回 409。项目/草稿同时携带旧时间戳条件时，数字版本和时间戳条件都必须满足。普通资源按 projects 记录计版本；草稿和自建模板以 metadata 为实体版本，其文档/文件表与 metadata 同事务提交。

草稿的传输文档包含 `{ id: 保存目标ID, document: 骨架文档 }`；保存目标可以是 `resource-资源ID`。`options` 保留 resourceId、resourceUpdatedAt、previousDraftId。移动原草稿还要求 `previousDraftVersion`，防止清除另一页面的新编辑。自建模板的传输文档包含元数据和 files，读出时也合并其独立引用。

同一实体和 mutation ID 的相同请求返回原回执，lease ID 的更新不改变作者请求身份；不同请求复用 ID 返回 `MUTATION_REUSED`。文档、引用、摘要、revision 和回执位于同一事务。资源墓碑优先于旧回执；资源永久删除后清除原 payload、V2 文档、引用、缩略图和回执。模板删除或草稿移动会清空旧回执内容并保留请求身份，防止旧保存请求重新创建旧记录；显式新建可使用新的 mutation ID。

源资源与自建模板、独立草稿之间没有删除级联。未提交素材受租约保护，提交后释放本次租约；回收操作保留任一实体引用和有效租约。回收是显式仓储维护操作，本批没有新增自动清理任务。

## V1 兼容边界

V1 列表、读取和旧浏览器迁入通过同一仓储适配。项目/草稿保存只有在带现有时间戳条件且不涉及草稿移动时才接受；其他旧写请求明确返回 `WORKSPACE_REFRESH_REQUIRED`，不把缺失版本解释成无条件覆盖。迁入继续执行原有去重、冲突保留和墓碑优先政策。

目前新后台提交会复用完整领域校验并还原必要的记录；网络图片分离已验证，未宣称服务端保存完全免读 BLOB。迁移后实际数据的三种导出与回导已核对；10/100/500 规模的最终测量已完成，500 条摘要 p95 为 1.11 ms，校准/改名提交 812–819 字节，未变素材上传为 0。50 MiB 校准保存约 332 ms，大素材同步入库仍有短暂阻塞，详见 [P7 性能及限制](../evidence/architecture-p7/acceptance.md#性能)。

## 前端会话与回执

前端仅在状态声明格式 2、素材及回执能力齐备时使用新接口；其他明确支持的旧服务保留原协议。工作区身份固定，服务失败不切换为另一份浏览器存储。素材 hash 缓存以不可变作者对象为边界，未知字段原样保留；上传/下载有界并行，下载校验原始 SHA-256。元数据克隆发生在已知素材剥离之后。

每个待写快照由组装根分配 mutation ID，未知提交保留完整请求供重试，成功响应不携带整套图片。改名、普通部件校准和草稿关键帧编辑不上传未变素材；新捕获的预览缩略图可独立上传。普通工程/草稿用会话的时间戳匹配 head，再提交数字版本；模板显式更新及回收站操作在提交前读取 head 并进行版本约束。

若 A 的结果未知，较新的本地 C 必须先恢复 A 的原回执，然后使用确认版本。另一页面提交 B 后，旧回执不允许 C 覆盖 B。失败仍保留未写内容和离页提示；强制关闭不能保证尚未提交内容完成。原格式的未知提交继续用读回核对，不能因能力更新而无条件重发。

## 检查点迁移与维护

迁移器仅处理显式指定的现有 SQLite 工作区，不启动服务、不触碰账号、生成历史、旧 profile 或独立导出。`scripts/migrate-workspace.mjs` 没有默认生产路径；执行者须先协调生成与编辑，再操作目标目录。只读 `--status` 可查看当前格式、维护状态与检查点。

```sh
node scripts/migrate-workspace.mjs /absolute/workspace --prepare --to=2 --backup=/absolute/backups/new.sqlite
node scripts/migrate-workspace.mjs /absolute/workspace --resume --batch=10
node scripts/migrate-workspace.mjs /absolute/workspace --verify
node scripts/migrate-workspace.mjs /absolute/workspace --activate
```

`--prepare` 在事务中冻结作者写入并记录身份、revision、所有 namespace、原始 payload 指纹、浏览器迁入映射和设置。随后用 SQLite 一致性备份机制处理 WAL，校验备份内容并记录文件 SHA-256；已有备份不会被覆盖。`--resume` 按事务批次继续，转换与检查点同提交。来源损坏、无法无损传输的扩展类型、目标损坏或备份变化均停止并定位记录，不跳过记录、不替换为空内容。只读仓储不会补建缺失的声明表。

维护锁位于数据库中，SQLite 触发器同时阻止旧进程继续写入原表、设置和迁入映射。读取仍允许；新打开的浏览器延后其首次旧数据迁入。维护错误返回 `WORKSPACE_MAINTENANCE`（HTTP 503），当前编辑保留，可在解锁后重试。未确认请求继续保留原 mutation 和上传来源，即使租约过期也能补传。

`--activate` 复核备份及全量往返内容，再把激活标记、摘要重建、旧分支保护和维护释放放入同一事务。已有服务对象察觉格式不符后拒绝访问；需以完整构建重启服务。当前页面在相同工作区身份下可重新协商协议，未经保存的内容保持；更老页面只可使用受条件保护的兼容接口，或得到刷新要求。

激活前可用 `--abort` 删除暂存目标并释放维护，保留原记录、身份、revision 和原摘要脏标记。激活后必须先冻结并备份**当前**数据，再用相同流程 `--to=1` 反向转换；它保留激活后的新编辑，不能用旧备份替代。反向转换留下的 V2 副本受写保护；V1 永久删除也清理对应退役文档和引用、失效旧回执，不能形成独立旧写分支。无引用 BLOB 的回收另行显式执行，备份不随回收站清空。

测试实际退出子进程覆盖冻结、备份、批次、验证、激活提交前与提交后；反向激活提交前退出也能恢复。正式任务/编辑协调和生产激活已完成，详见[正式激活](../evidence/architecture-p5-production/verification.json)。完整备份在 `~/Library/Application Support/iSpine Backups/20261021-041242-before-workspace-v2`；后续已有新写入时，仍须使用当前数据反向转换，不能直接覆盖为该旧备份。

## 当前证据

见 [HTTP 批次](../evidence/architecture-p5-http/verification.json)、[前端批次](../evidence/architecture-p5-client/verification.json)、[副本迁移批次](../evidence/architecture-p5-migration/verification.json)与 [实施记录](progress.md#p5-图片分离与版本化保存执行中)。正式迁移及激活不得以隔离验收代替。
