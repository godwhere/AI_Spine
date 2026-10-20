export function unityAssetPath(path) {
  if (/\.skel$/i.test(path)) return `${path}.bytes`;
  if (/\.atlas$/i.test(path)) return `${path}.txt`;
  return path;
}

function unityReadme(bundle) {
  const pages = bundle.pages.map((page) => `- ${page.file}: pma:${Boolean(page.pma)}`).join("\n");
  return `# iSpine · Unity 资源包

## 导入 Unity

1. 安装与骨架数据 major.minor 匹配的官方 spine-unity 运行库。本项目支持 Spine 4.3.x，请使用对应的 4.3 运行库；此包不转换骨架版本，beta 数据还需确认对应运行库支持。
2. 解压后将整个资源文件夹放入 Unity 项目的 Assets，保留文件与子目录关系。骨架 JSON 保留原文件；二进制使用 .skel.bytes，Atlas 使用 .atlas.txt，PNG 页名称不变。
3. 官方导入器会创建 AtlasAsset、每页材质与 SkeletonDataAsset。选中生成的 SkeletonDataAsset 检查动画预览，再将其拖入场景创建角色。

## 贴图与透明度

本包保留烘焙贴图的颜色、Alpha 和 Atlas 的 pma 标记，不自动转换预乘透明度。各页如下：

${pages}

spine-unity 4.3 默认使用 Straight Alpha 工作流。pma:false 页使用 Spine Preferences 中的 Straight Alpha 预设；pma:true 页需使用 Gamma 色彩空间与 PMA 预设。混合页应分别核对贴图和材质设置；不能只改 Atlas 的 pma 文本。

## 在 Spine 编辑器继续调整

使用匹配版本的 Spine 编辑器，通过 Texture Unpacker 解包 Atlas（.atlas.txt 可直接使用），按 pma 设置正确处理透明度；再用 Import Data 导入 JSON 或二进制骨架，并把 Images 路径指向解包图片。运行时数据可继续编辑，但原导出未包含的 Nonessential 数据、骨骼图标等编辑信息不保证恢复。此 ZIP 不包含伪造的 .spine 源工程或 .unitypackage；如需保留 iSpine 原图、替换和校准，请另存可编辑工程。

官方说明：[Unity 资源导入](https://esotericsoftware.com/spine-unity-assets)、[版本匹配](https://esotericsoftware.com/spine-versioning)、[恢复编辑流程](https://esotericsoftware.com/blog/Importing-skeleton-data)、[Import Data](https://esotericsoftware.com/spine-import)。
`;
}

export function unityPackageFiles(bundle, pageBytes) {
  const texturePaths = new Set(bundle.pages.map((page) => page.file));
  for (const path of texturePaths)
    if (unityAssetPath(path) !== path) throw new Error(`Unity 贴图页名称与文本资源扩展名冲突：${path}`);
  for (const path of Object.keys(pageBytes))
    if (!texturePaths.has(path)) throw new Error(`Unity 导出收到非 Atlas 贴图页的覆盖：${path}`);
  const output = Object.create(null), names = new Map();
  const add = (path, bytes) => {
    const identity = path.normalize("NFC").toLowerCase();
    if (identity === "__proto__") throw new Error(`资源包不支持这个文件名：${path}，请先重命名。`);
    const conflict = names.get(identity);
    if (conflict) throw new Error(`Unity 导出文件名冲突：${conflict} 与 ${path}。请先重命名冲突文件。`);
    for (const [other, original] of names)
      if (other.startsWith(`${identity}/`) || identity.startsWith(`${other}/`))
        throw new Error(`Unity 导出文件与目录冲突：${original} 与 ${path}。`);
    names.set(identity, path); output[path] = bytes;
  };
  for (const [path, bytes] of Object.entries({ ...bundle.files, ...pageBytes })) add(unityAssetPath(path), bytes);
  const readme = new TextEncoder().encode(unityReadme(bundle)), existingReadme = names.get("readme-unity.md");
  if (existingReadme) {
    const existing = output[existingReadme];
    if (existing.length !== readme.length || existing.some((byte, index) => byte !== readme[index]))
      throw new Error(`Unity 导出文件名冲突：${existingReadme} 与 README-Unity.md。请先重命名冲突文件。`);
  } else add("README-Unity.md", readme);
  return output;
}
