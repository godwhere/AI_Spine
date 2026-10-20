import { cleanPath, parseBundle } from "./archive.js";
import { parseSkeleton } from "../spine/runtime.js";
import { usesSharedWorkspace, workspaceCall } from "./workspace.js";

const DB_NAME = "ai-spine-custom-templates";
let database;

function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("当前环境无法保存本机模板。"));
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of ["metadata", "files"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onblocked = () => {
      blocked = true; database = null;
      reject(new Error("本机模板库暂时无法打开，请关闭其他工作台窗口后重试。"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = () => {
      database = null;
      reject(new Error("无法打开本机模板库，原资源不会受影响。"));
    };
  });
  return database;
}

function copyBytes(value, path) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value).slice();
  else if (ArrayBuffer.isView(value))
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (!bytes?.length) throw new Error(`模板文件缺少有效数据：${path}`);
  return bytes;
}

function requireCustomId(id) {
  if (typeof id !== "string" || !id.startsWith("custom-") || !id.slice(7).trim())
    throw new Error("只能操作我创建的模板，内置模板不可删除。");
}

export function createCustomTemplateRecord(project, bakedFiles, { type = "role", categories = [] } = {}) {
  if (project?.deletedAt) throw new Error("资源已在回收站，请先恢复后再加入模板。");
  if (typeof project?.id !== "string" || !project.id.trim() || typeof project.name !== "string" || !project.name.trim())
    throw new Error("资源缺少名称或有效标识。");
  if (!["role", "effect"].includes(type) || !Array.isArray(categories) || categories.some((value) => typeof value !== "string"))
    throw new Error("模板类型或分类无效。");
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
  const now = new Date().toISOString();
  return {
    id: `custom-${project.id}`, source: "custom", sourceProjectId: project.id,
    name: project.name.trim(), thumbnail: typeof project.thumbnail === "string" ? project.thumbnail : "",
    type, categories: [...new Set(categories.map((value) => value.trim()).filter(Boolean))],
    createdAt: now, updatedAt: now,
    animationCount: data.animations.length, regionCount: bundle.parts.length, partCount: bundle.parts.length,
    boneCount: data.bones.length, spineVersion: data.version,
    skeletonPath: bundle.skeletonPath, skeletonFile: bundle.skeletonPath,
    atlasFiles: [...bundle.atlasPaths], textureFiles,
    files: Object.fromEntries(runtimePaths.map((path) => [path, bundle.files[path]])),
  };
}

export function validatedSnapshot(record) {
  requireCustomId(record?.id);
  if (record.source !== "custom" || record.id !== `custom-${record.sourceProjectId}`)
    throw new Error("自建模板标识与来源资源不一致。");
  const snapshot = createCustomTemplateRecord({
    id: record.sourceProjectId, name: record.name, thumbnail: record.thumbnail,
    skeletonPath: record.skeletonPath, deletedAt: record.deletedAt,
  }, record.files, { type: record.type, categories: record.categories });
  if (typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)))
    snapshot.createdAt = record.createdAt;
  return snapshot;
}

export async function saveCustomTemplate(record) {
  if (usesSharedWorkspace()) return workspaceCall("templates", "save", record);
  const snapshot = validatedSnapshot(record), { files, ...metadata } = snapshot;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readwrite");
    let failure;
    const store = tx.objectStore("metadata"), request = store.get(snapshot.id);
    request.onsuccess = () => {
      try {
        metadata.createdAt = request.result?.createdAt || metadata.createdAt;
        store.put(metadata);
        tx.objectStore("files").put({ id: snapshot.id, files });
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(metadata);
    tx.onerror = () => { failure ||= new Error("本机模板保存失败，请检查存储空间。原资源不会受影响。"); };
    tx.onabort = () => reject(failure || new Error("本机模板保存已中断，请重试。"));
  });
}

export async function listCustomTemplates() {
  if (usesSharedWorkspace()) return workspaceCall("templates", "list");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("metadata", "readonly"), request = tx.objectStore("metadata").getAll();
    tx.oncomplete = () => resolve(request.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    tx.onabort = tx.onerror = () => reject(new Error("无法读取本机模板列表。"));
  });
}

export async function getCustomTemplate(id) {
  requireCustomId(id);
  if (usesSharedWorkspace()) return workspaceCall("templates", "get", id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readonly");
    const metadata = tx.objectStore("metadata").get(id), payload = tx.objectStore("files").get(id);
    tx.oncomplete = () => {
      if (!metadata.result && !payload.result) { resolve(null); return; }
      if (!metadata.result || !payload.result?.files) {
        reject(new Error("本机模板数据不完整，请从原资源重新加入模板。")); return;
      }
      resolve({ ...metadata.result, files: payload.result.files });
    };
    tx.onabort = tx.onerror = () => reject(new Error("无法读取本机模板。"));
  });
}

export async function deleteCustomTemplate(id) {
  requireCustomId(id);
  if (usesSharedWorkspace()) return workspaceCall("templates", "delete", id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readwrite"), store = tx.objectStore("metadata");
    const request = store.getKey(id);
    store.delete(id); tx.objectStore("files").delete(id);
    tx.oncomplete = () => resolve(request.result !== undefined);
    tx.onabort = tx.onerror = () => reject(new Error("删除本机模板失败，原资源不会受影响。"));
  });
}
