import { validateRigDocument, validateRigAppearanceFields } from "../../shared/rig-schema.mjs";
import { imageDataBytes } from "./rig-project.js";
import { usesSharedWorkspace, workspaceCall } from "./workspace.js";

const DB_NAME = "ispine-rig-drafts";
let database;
const sharedVersions = new Map();
export function validateRigDraftDocument(document) {
  if (document?.joints?.length || document?.parts?.length || document?.motions?.length)
    return validateRigDocument(document);
  if (!document || document.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(document.id || "") ||
      typeof document.name !== "string" || !document.name.trim() ||
      ![document.width, document.height].every((value) => Number.isInteger(value) && value >= 1 && value <= 8192) ||
      ![document.joints, document.parts, document.motions].every((value) => Array.isArray(value) && value.length === 0))
    throw new Error("骨架草稿无效，请检查角色名称和立绘尺寸。");
  if (document.sourceImage) imageDataBytes(document.sourceImage);
  validateRigAppearanceFields(document);
  if (document.appearanceReference) imageDataBytes(document.appearanceReference.image);
  return structuredClone(document);
}
function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("无法保存骨架草稿，请使用支持本机存储的工作台。"));
  if (database) return database.promise;
  const entry = { db: null, promise: null };
  database = entry;
  const clear = () => { if (database === entry) database = null; };
  entry.promise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of ["metadata", "documents"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onblocked = () => { blocked = true; clear(); reject(new Error("骨架草稿存储暂不可用，请关闭其他工作台后重试。")); };
    request.onerror = () => { clear(); reject(new Error("无法打开骨架草稿存储。")); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      const db = request.result;
      entry.db = db;
      db.onversionchange = () => { clear(); db.close(); };
      db.onclose = clear;
      resolve(db);
    };
  }).catch((error) => { clear(); throw error; });
  return entry.promise;
}

async function withTransaction(stores, mode, callback) {
  let db = await openDB(), tx;
  for (let attempt = 0; ; attempt++) {
    try { tx = db.transaction(stores, mode); break; }
    catch (error) {
      if (error?.name !== "InvalidStateError") throw error;
      // A closing connection may reject before its close event is dispatched.
      // No transaction exists yet, so reopening once cannot replay any writes.
      if (database?.db === db) database = null;
      db.close();
      if (attempt) throw error;
      db = await openDB();
    }
  }
  return callback(tx);
}

export async function saveRigDraft(document, { resourceId, resourceUpdatedAt, previousDraftId } = {}) {
  if (resourceId !== undefined && resourceId !== null && (typeof resourceId !== "string" || !resourceId.trim()))
    throw new Error("骨架草稿关联的资源标识无效。");
  if (previousDraftId !== undefined && previousDraftId !== null && (typeof previousDraftId !== "string" || !previousDraftId.trim()))
    throw new Error("原骨架草稿标识无效。");
  const rig = validateRigDraftDocument(document);
  if (usesSharedWorkspace()) {
    const key = resourceId ? `resource-${resourceId}` : rig.id;
    const saved = await workspaceCall("drafts", "save", rig, { resourceId, resourceUpdatedAt, previousDraftId, expectedUpdatedAt: sharedVersions.get(key) });
    sharedVersions.set(key, saved.updatedAt); return saved;
  }
  const id = resourceId ? `resource-${resourceId}` : rig.id;
  const metadata = { id, documentId: rig.id, name: rig.name, updatedAt: new Date().toISOString(),
    partCount: rig.parts.length, completeParts: rig.parts.filter((part) => part.image).length,
    jointCount: rig.joints.length, motionCount: rig.motions.length, resourceId: resourceId || null, resourceUpdatedAt };
  return withTransaction(["metadata", "documents"], "readwrite", (tx) => new Promise((resolve, reject) => {
    let failure;
    tx.oncomplete = () => resolve(metadata);
    tx.onabort = tx.onerror = () => reject(failure || new Error("骨架草稿保存失败，请检查本机存储空间。"));
    try {
      tx.objectStore("metadata").put(metadata);
      tx.objectStore("documents").put({ id, document: rig });
      // Move only the explicitly selected prior draft. The same document ID can
      // belong to independent imported resources or an unrelated unsaved draft.
      if (previousDraftId && previousDraftId !== id) {
        tx.objectStore("metadata").delete(previousDraftId);
        tx.objectStore("documents").delete(previousDraftId);
      }
    } catch (error) { failure = error; tx.abort(); }
  }));
}

export function rigDraftDestination(draft, resources) {
  if (!draft?.resourceId) return { resourceId: null, resourceUpdatedAt: null, forked: false, notice: "" };
  const resource = resources.find((record) => record.id === draft.resourceId && !record.deletedAt);
  if (resource && typeof draft.resourceUpdatedAt === "string" && draft.resourceUpdatedAt.trim() && draft.resourceUpdatedAt === resource.updatedAt)
    return { resourceId: resource.id, resourceUpdatedAt: resource.updatedAt, forked: false, notice: "" };
  return { resourceId: null, resourceUpdatedAt: null, forked: true,
    notice: "关联资源已更新、删除或版本无法确认，旧草稿将另存为新资源，保留最新校准。" };
}

export async function listRigDrafts() {
  if (usesSharedWorkspace()) return workspaceCall("drafts", "list");
  return withTransaction("metadata", "readonly", (tx) => new Promise((resolve, reject) => {
    const request = tx.objectStore("metadata").getAll();
    tx.oncomplete = () => resolve(request.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    tx.onabort = tx.onerror = () => reject(new Error("骨架草稿列表读取失败。"));
  }));
}

export async function getRigDraft(id) {
  if (usesSharedWorkspace()) {
    const draft = await workspaceCall("drafts", "get", id);
    if (draft) sharedVersions.set(id, draft.updatedAt);
    return draft;
  }
  return withTransaction(["metadata", "documents"], "readonly", (tx) => new Promise((resolve, reject) => {
    const meta = tx.objectStore("metadata").get(id), data = tx.objectStore("documents").get(id);
    tx.oncomplete = () => {
      try { resolve(meta.result && data.result ? { ...meta.result, document: validateRigDraftDocument(data.result.document) } : null); }
      catch (error) { reject(error); }
    };
    tx.onabort = tx.onerror = () => reject(new Error("骨架草稿读取失败。"));
  }));
}
