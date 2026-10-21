import { cleanPath } from "./paths.js";
import { parseBundle } from "./bundle.js";
import { parseSkeleton } from "../spine/parse.js";
import { requireCustomId, customTemplateMetadata } from "../../shared/domain/template.mjs";

function copyBytes(value, path) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value).slice();
  else if (ArrayBuffer.isView(value))
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (!bytes?.length) throw new Error(`模板文件缺少有效数据：${path}`);
  return bytes;
}

function createCustomTemplateRecord(project, bakedFiles, { type = "role", categories = [], now } = {}) {
  const metadata = customTemplateMetadata(project, { type, categories, now });
  if (!bakedFiles || typeof bakedFiles !== "object" || Array.isArray(bakedFiles))
    throw new Error("请先生成完整的运行时资源包。");
  const input = Object.create(null);
  for (const [path, bytes] of Object.entries(bakedFiles)) {
    const normalized = cleanPath(path);
    if (normalized.startsWith(".ai-spine/")) continue;
    if (Object.hasOwn(input, normalized)) throw new Error(`模板文件路径重复：${normalized}`);
    input[normalized] = copyBytes(bytes, normalized);
  }
  const bundle = parseBundle(input, {
    skeletonPath: project.skeletonPath ? cleanPath(project.skeletonPath) : undefined,
    name: project.name.trim(),
    id: project.id,
  });
  const { data } = parseSkeleton(bundle);
  const textureFiles = [...new Set(bundle.pages.map((page) => page.file))];
  const runtimePaths = [...new Set([bundle.skeletonPath, ...bundle.atlasPaths, ...textureFiles])];
  return {
    ...metadata,
    animationCount: data.animations.length, regionCount: bundle.parts.length, partCount: bundle.parts.length,
    boneCount: data.bones.length, spineVersion: data.version,
    skeletonPath: bundle.skeletonPath, skeletonFile: bundle.skeletonPath,
    atlasFiles: [...bundle.atlasPaths], textureFiles,
    files: Object.fromEntries(runtimePaths.map((path) => [path, bundle.files[path]])),
  };
}

function validatedSnapshot(record, { now } = {}) {
  requireCustomId(record?.id);
  if (record.source !== "custom" || record.id !== `custom-${record.sourceProjectId}`)
    throw new Error("自建模板标识与来源资源不一致。");
  const snapshot = createCustomTemplateRecord({
    id: record.sourceProjectId, name: record.name, thumbnail: record.thumbnail,
    skeletonPath: record.skeletonPath, deletedAt: record.deletedAt,
  }, record.files, { type: record.type, categories: record.categories, now });
  if (typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)))
    snapshot.createdAt = record.createdAt;
  return snapshot;
}

export { createCustomTemplateRecord, validatedSnapshot };
