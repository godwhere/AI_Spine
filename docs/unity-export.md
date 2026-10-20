# Unity 导出与 Spine 编辑

## 选择导出格式

| 格式 | 用途 | 内容 |
| --- | --- | --- |
| Spine 运行时资源包 | 接入对应版本的 Spine 运行库 | 原骨架、Atlas、烘焙后的 PNG |
| iSpine 可编辑工程 | 在 iSpine 继续修改和备份 | 原始资源、替换原图、校准参数、形象参考和描述 |
| Unity 资源包 | 导入安装了 spine-unity 的 Unity 工程 | JSON / `.skel.bytes`、`.atlas.txt`、PNG、导入说明 |

在编辑器中点击「导出」，选择「Unity 资源包」。导出会烘焙当前部件校准后的贴图，保持原骨架的网格、权重、皮肤和全部动画数据。PNG 文件名、Atlas 页面引用、旋转和 PMA 设置保持一致；检测到文件名冲突会明确报错。

## 在 Unity 中使用

1. 为 Unity 工程安装与骨架版本匹配的官方 spine-unity 运行库。目前内置模板的骨架版本为 4.3.x。
2. 解压导出的 ZIP，将骨架、`.atlas.txt` 和全部 PNG 一起放入 Unity 的 Assets 文件夹，保留子目录结构。
3. 按包内 `README-Unity.md` 配置贴图透明度和材质。直通透明度与预乘透明度需要和实际 Atlas、材质及项目颜色空间一致。
4. 让 spine-unity 创建 Atlas、材质和 SkeletonDataAsset，再拖入场景并选择动画。

JSON 骨架保持 `.json`；二进制骨架使用 `.skel.bytes`；Atlas 使用 `.atlas.txt`。导出 ZIP 不包含 Unity 工程生成的 `.meta` 或序列化资产，因此不是 `.unitypackage`。

官方流程：[spine-unity 资源导入](https://esotericsoftware.com/spine-unity-assets)。

## 需要 `.spine` 源工程时

iSpine 的可编辑 ZIP 是本软件的工程备份。需要调整骨骼、权重或动画关键帧时，在匹配版本的官方 Spine 编辑器执行：

1. 使用 Texture Unpacker 将 Atlas 和 PNG 解包为独立图片。
2. 使用 Import Data 导入 JSON 或二进制骨架。
3. 将 Images 路径指向解包图片，检查动画和网格。
4. 保存为真正的 `.spine` 工程。

运行时数据没有包含的编辑器信息无法完整恢复，例如未导出的非必要网格信息。iSpine 不直接写出专有 `.spine` 文件。

官方说明：[Import Data](https://esotericsoftware.com/spine-import)、[骨架数据重新导入与图集解包](https://esotericsoftware.com/blog/Importing-skeleton-data)。

## 当前验证范围

悟空的 Unity ZIP 已实际下载，在独立的工作台窗口重新导入，并再次导出；两次 ZIP 逐字节一致，保留 49 个区域、7 个动作和 2 个皮肤。二进制、嵌套多页面、旋转、PMA、命名冲突及 worker 导出有自动检查。Unity 编辑器内的导入和场景播放尚未实机验收。
