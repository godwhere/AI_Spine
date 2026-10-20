import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { TextureAtlas } from "@esotericsoftware/spine-webgl";
import { unityPackageFiles } from "./unity-export.js";

export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 4096;
const PROJECT_PATH = ".ai-spine/project.json";
export const decodeText = (bytes) => strFromU8(bytes);
export const encodeText = (text) => strToU8(text);

export function cleanPath(path) {
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !value ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value) ||
    value.split("/").some((p) => p === ".." || p === ".")
  ) {
    throw new Error(`资源路径无效：${path}`);
  }
  return value;
}
const dirname = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
const basename = (path) => path.split("/").at(-1);

// Check central-directory sizes before asking the decompressor to allocate memory.
export function unpackZip(bytes) {
  if (bytes.byteLength > MAX_PACKAGE_BYTES)
    throw new Error("资源包超过 256 MB，请拆分后导入。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP 文件不完整或格式无效。");
  const count = view.getUint16(end + 10, true);
  let position = view.getUint32(end + 16, true),
    total = 0;
  if (count > MAX_PACKAGE_FILES || count === 65535) throw new Error("资源包文件数量过多。");
  for (let i = 0; i < count; i++) {
    if (
      position + 46 > bytes.length ||
      view.getUint32(position, true) !== 0x02014b50
    )
      throw new Error("ZIP 目录无效。");
    total += view.getUint32(position + 24, true);
    if (total > MAX_PACKAGE_BYTES) throw new Error("资源包解压后超过 256 MB。");
    position +=
      46 +
      view.getUint16(position + 28, true) +
      view.getUint16(position + 30, true) +
      view.getUint16(position + 32, true);
  }
  const extracted = unzipSync(bytes),
    files = {};
  for (const [path, data] of Object.entries(extracted)) {
    if (
      path.endsWith("/") ||
      path.includes("__MACOSX/") ||
      path.endsWith(".DS_Store")
    )
      continue;
    files[cleanPath(path)] = data;
  }
  return files;
}

export function resolveFile(files, owner, reference) {
  const wanted = cleanPath(dirname(owner) + reference);
  if (files[wanted]) return wanted;
  const matches = Object.keys(files).filter(
    (p) => p.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  const loose = Object.keys(files).filter(
    (p) => basename(p).toLowerCase() === basename(reference).toLowerCase(),
  );
  if (loose.length === 1) return loose[0];
  throw new Error(
    `找不到贴图：${reference}。请一起导入 JSON / Atlas / 所有贴图。`,
  );
}

export function skeletonCandidates(files) {
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

export function parseBundle(
  inputFiles,
  { skeletonPath, name = "导入的模板", id = crypto.randomUUID() } = {},
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

export async function readImportFiles(fileList, { unpack = unpackZip } = {}) {
  const result = {};
  for (const file of fileList) {
    if (file.size > MAX_PACKAGE_BYTES) throw new Error("单个文件超过 256 MB。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const incoming = /\.zip$/i.test(file.name)
      ? await unpack(bytes)
      : { [file.webkitRelativePath || file.name]: bytes };
    for (const [name, content] of Object.entries(incoming)) {
      if (result[name]) throw new Error(`文件重复：${name}`);
      result[name] = content;
    }
  }
  if (
    Object.values(result).reduce((s, b) => s + b.byteLength, 0) >
    MAX_PACKAGE_BYTES
  )
    throw new Error("导入文件总大小超过 256 MB。");
  return result;
}

export async function loadCatalogTemplate(template) {
  const paths = [
    ...new Set([
      template.skeletonFile,
      ...template.atlasFiles,
      ...template.textureFiles,
    ]),
  ];
  const entries = await Promise.all(
    paths.map(async (path) => {
      const response = await fetch(template.folder + path);
      if (!response.ok) throw new Error(`模板加载失败：${path}`);
      return [path, new Uint8Array(await response.arrayBuffer())];
    }),
  );
  return parseBundle(Object.fromEntries(entries), {
    name: template.name,
    id: `template-${template.id}`,
  });
}

export function exportPackage(
  bundle,
  pageBytes = {},
  { editable = false, edits = {}, name = bundle.name, generation = {}, target } = {},
) {
  if (target === "unity" && editable) throw new Error("Unity 资源包与可编辑工程请分别导出。");
  const output = target === "unity" ? unityPackageFiles(bundle, pageBytes) : { ...bundle.files, ...pageBytes };
  if (editable) {
    const metadata = {
      version: 1,
      name,
      skeletonPath: bundle.skeletonPath,
      originalFiles: Object.keys(bundle.files),
      edits: {},
    };
    for (const [path, bytes] of Object.entries(bundle.files))
      output[`.ai-spine/original/${path}`] = bytes;
    let index = 0;
    for (const [key, edit] of Object.entries(edits)) {
      const imagePath = `.ai-spine/replacements/${index++}.png`;
      output[imagePath] = edit.image;
      metadata.edits[key] = {
        fileName: edit.fileName,
        transform: edit.transform,
        imagePath,
      };
    }
    if (generation.appearancePrompt || generation.partsPrompt || generation.appearance) {
      metadata.generation = {
        appearancePrompt: generation.appearancePrompt || "",
        partsPrompt: generation.partsPrompt || "",
      };
      if (generation.appearance?.image instanceof Uint8Array) {
        const imagePath = ".ai-spine/generation/appearance.png";
        output[imagePath] = generation.appearance.image;
        metadata.generation.appearance = {
          imagePath, fileName: generation.appearance.fileName, prompt: generation.appearance.prompt,
        };
      }
    }
    output[PROJECT_PATH] = encodeText(JSON.stringify(metadata));
  }
  const entries = Object.entries(output);
  if (entries.length > MAX_PACKAGE_FILES) throw new Error("资源包文件数量过多，请拆分后导出。");
  let total = 0;
  for (const [, bytes] of entries) {
    if (!(bytes instanceof Uint8Array)) throw new Error("资源包包含无效的文件数据。");
    total += bytes.byteLength;
    if (total > MAX_PACKAGE_BYTES) throw new Error("资源包解压后超过 256 MB，请拆分后导出。");
  }
  const bytes = zipSync(
    Object.fromEntries(
      entries.map(([p, data]) => [
        p,
        [data, { mtime: new Date("2026-01-01T00:00:00Z") }],
      ]),
    ),
    { level: 6 },
  );
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("资源包超过 256 MB，请拆分后导出。");
  return bytes;
}
