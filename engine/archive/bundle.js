import { cleanPath } from "./paths.js";
import { decodeText } from "../../shared/codec/text.mjs";
import { dirname } from "./paths.js";
import { resolveFile } from "./paths.js";
import { TextureAtlas } from "@esotericsoftware/spine-core";

const PROJECT_PATH = ".ai-spine/project.json";

function skeletonCandidates(files) {
  return Object.keys(files).filter((path) => {
    if (path.startsWith(".ai-spine/")) return false;
    if (/\.skel(?:\.bytes)?$/i.test(path)) return true;
    if (!/\.json$/i.test(path)) return false;
    try {
      return Array.isArray(JSON.parse(decodeText(files[path])).bones);
    } catch {
      return false;
    }
  });
}

function parseBundle(
  inputFiles,
  { skeletonPath, name = "导入的模板", id } = {},
) {
  let files = Object.fromEntries(
    Object.entries(inputFiles).map(([p, b]) => [cleanPath(p), b]),
  );
  let restoredEdits = Object.create(null),
    projectName = name,
    generation = {};
  if (files[PROJECT_PATH]) {
    const project = JSON.parse(decodeText(files[PROJECT_PATH]));
    if (project.version !== 1 || !Array.isArray(project.originalFiles))
      throw new Error("不支持的 iSpine 工程版本。");
    const originals = {};
    for (const path of project.originalFiles) {
      const key = cleanPath(path),
        bytes = files[`.ai-spine/original/${key}`];
      if (!bytes) throw new Error(`工程缺少原始文件：${key}`);
      originals[key] = bytes;
    }
    for (const [key, edit] of Object.entries(project.edits || {})) {
      if (!files[edit.imagePath]) throw new Error("工程缺少替换图片。");
      const transform = edit.transform || {};
      for (const field of ["x", "y", "scaleX", "scaleY", "rotation"]) {
        if (
          !Number.isFinite(transform[field]) ||
          Math.abs(transform[field]) > 32768
        )
          throw new Error("工程包含无效的校准参数。");
      }
      if (transform.scaleX <= 0 || transform.scaleY <= 0)
        throw new Error("工程缩放参数无效。");
      restoredEdits[key] = { ...edit, image: files[edit.imagePath] };
    }
    skeletonPath = project.skeletonPath;
    projectName = project.name;
    if (project.generation) {
      const saved = project.generation;
      for (const key of ["appearancePrompt", "partsPrompt"])
        if (typeof saved[key] === "string") generation[key] = saved[key].slice(0,4000);
      if (saved.appearance) {
        const imagePath = cleanPath(saved.appearance.imagePath);
        if (!imagePath.startsWith(".ai-spine/generation/") || !files[imagePath])
          throw new Error("工程缺少 AI 形象参考图片。");
        generation.appearance = {
          image: files[imagePath],
          fileName: String(saved.appearance.fileName || "appearance.png").slice(0,240),
          prompt: String(saved.appearance.prompt || "").slice(0,4000),
        };
      }
    }
    files = originals;
  }
  const candidates = skeletonCandidates(files);
  if (!candidates.length) throw new Error("没有找到 Spine 骨架 JSON 或 SKEL。");
  if (!skeletonPath && candidates.length > 1)
    throw Object.assign(new Error("请选择要导入的骨架。"), { candidates });
  skeletonPath ||= candidates[0];
  if (!files[skeletonPath]) throw new Error("选定的骨架文件不存在。");
  const binary = /\.skel(?:\.bytes)?$/i.test(skeletonPath);
  const json = binary ? null : JSON.parse(decodeText(files[skeletonPath]));
  const version = json?.skeleton?.spine;
  if (version && !version.startsWith("4.3."))
    throw new Error(
      `当前支持 Spine 4.3.x，文件是 ${version}。请从对应编辑器重新导出。`,
    );
  let atlasPaths = Object.keys(files).filter((p) =>
    /\.atlas(?:\.txt)?$/i.test(p),
  );
  const sameName = atlasPaths.filter(
    (p) =>
      p.replace(/\.atlas(?:\.txt)?$/i, "") ===
      skeletonPath.replace(/\.(json|skel(?:\.bytes)?)$/i, ""),
  );
  if (sameName.length && candidates.length > 1) atlasPaths = sameName;
  if (!atlasPaths.length)
    throw new Error("缺少 Atlas 文件，请与骨架和贴图一起导入。");
  const pages = [],
    parts = [],
    regionNames = new Set();
  for (const path of atlasPaths) {
    const atlas = new TextureAtlas(decodeText(files[path]));
    if (!atlas.pages.length) throw new Error(`Atlas 中没有贴图页：${path}`);
    for (const page of atlas.pages) {
      if (
        !page.width ||
        !page.height ||
        page.width > 16384 ||
        page.height > 16384
      )
        throw new Error("Atlas 贴图尺寸无效或超过 16384。");
      const resolved = resolveFile(files, path, page.name),
        file = cleanPath(dirname(path) + page.name);
      if (!files[file]) files[file] = files[resolved];
      pages.push({
        id: `${path}::${page.name}`,
        name: page.name,
        file,
        atlasPath: path,
        width: page.width,
        height: page.height,
        pma: page.pma,
      });
    }
    for (const region of atlas.regions) {
      if (regionNames.has(region.name))
        throw new Error(`Atlas 区域重名：${region.name}，请拆分资源包。`);
      regionNames.add(region.name);
      if (![0, 90].includes(region.degrees))
        throw new Error(`暂不支持 ${region.degrees}° 的 Atlas 区域。`);
      if (
        region.width <= 0 ||
        region.height <= 0 ||
        region.originalWidth <= 0 ||
        region.originalHeight <= 0 ||
        region.originalWidth > 16384 ||
        region.originalHeight > 16384
      )
        throw new Error(`部件尺寸无效：${region.name}`);
      const page = pages.find(
        (p) => p.atlasPath === path && p.name === region.page.name,
      );
      const packedWidth = region.degrees === 90 ? region.height : region.width;
      const packedHeight = region.degrees === 90 ? region.width : region.height;
      if (
        region.x < 0 ||
        region.y < 0 ||
        region.x + packedWidth > page.width ||
        region.y + packedHeight > page.height
      )
        throw new Error(`Atlas 区域超出贴图：${region.name}`);
      parts.push({
        id: region.name,
        name: region.name.split("/").at(-1),
        pageId: page.id,
        pageFile: page.file,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        originalWidth: region.originalWidth,
        originalHeight: region.originalHeight,
        offsetX: region.offsetX,
        offsetY: region.offsetY,
        degrees: region.degrees,
        packedWidth,
        packedHeight,
        pma: page.pma,
      });
    }
  }
  if (!parts.length) throw new Error("Atlas 没有可替换的图片部件。");
  for (const key of Object.keys(restoredEdits))
    if (!regionNames.has(key)) throw new Error(`工程部件不存在：${key}`);
  return {
    id,
    name: projectName,
    files,
    skeletonPath,
    binary,
    json,
    atlasPaths,
    pages,
    parts,
    edits: restoredEdits,
    generation,
    version: version || "4.3.x",
    animations: Object.keys(json?.animations || {}),
    skins: Array.isArray(json?.skins)
      ? json.skins.map((s) => s.name)
      : Object.keys(json?.skins || {}),
    boneCount: json?.bones?.length ?? 0,
  };
}

export { PROJECT_PATH, parseBundle, skeletonCandidates };
