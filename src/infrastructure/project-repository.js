import { createLegacyProjectDatabase } from "./legacy-indexeddb.js";
import { sameAuthoredProjectContent } from "../../shared/domain/project.mjs";
import { usesSharedWorkspace, workspaceThumbnailURL, workspaceCall } from "./workspace-client.js";

const { openDB, transaction } = createLegacyProjectDatabase();
let sharedLibraryRead;
export async function listProjectLibrary() {
  if (usesSharedWorkspace()) {
    sharedLibraryRead ||= workspaceCall("projects", "summary").then((library) => ({ ...library,
      ...Object.fromEntries(["projects", "trash"].map((key) => [key, library[key].map((record) => record.thumbnailRef
        ? { ...record, thumbnail: workspaceThumbnailURL(record.thumbnailRef) } : record)])),
    })).finally(() => { sharedLibraryRead = null; });
    return sharedLibraryRead;
  }
  const [records, removed] = await Promise.all([
    transaction("readonly", (store) => store.getAll()),
    transaction("readonly", (store) => store.count(), "removedProjects"),
  ]);
  return { projects: records.filter((record) => !record.deletedAt), trash: records.filter((record) => record.deletedAt), hasDeletedProjects: removed > 0 };
}
export const listProjects = async () => (await listProjectLibrary()).projects;
export const listTrashedProjects = async () => (await listProjectLibrary()).trash;
export const getProjectForPreview = (id) => usesSharedWorkspace() ? workspaceCall("projects", "read", id) : transaction("readonly", (store) => store.get(id));
export async function getProject(id) {
  if (typeof id !== "string" || !id) throw new Error("资源标识无效。");
  if (usesSharedWorkspace()) return workspaceCall("projects", "get", id);
  const record = await transaction("readonly", (store) => store.get(id));
  return record && !record.deletedAt ? record : null;
}

// Read and mutate within one transaction so a late autosave cannot revive a deleted project.
async function updateProject(id, change) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["projects", "removedProjects"], "readwrite"), store = tx.objectStore("projects");
    let result, failure;
    const removed = tx.objectStore("removedProjects").get(id);
    removed.onsuccess = () => {
      if (removed.result) { failure = new Error("资源已永久删除，请导入工程备份后继续编辑。"); tx.abort(); return; }
      const request = store.get(id);
      request.onsuccess = () => {
        try { result = change(request.result); if (result !== request.result) store.put(result); }
        catch (error) { failure = error; tx.abort(); }
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => { failure ||= new Error("资源保存失败，请检查本机存储空间。"); };
    tx.onabort = () => reject(failure || new Error("资源操作已中断，请重试。"));
  });
}
export const saveProject = async (project, { expectedUpdatedAt, mutationId } = {}) => {
  if (usesSharedWorkspace()) return workspaceCall("projects", "save", project, { expectedUpdatedAt, mutationId });
  return updateProject(project.id, (existing) => {
  if (existing?.deletedAt || project.deletedAt) throw new Error("资源已移入回收站，请先恢复后再编辑。");
  if (expectedUpdatedAt !== undefined && existing?.updatedAt !== expectedUpdatedAt)
    throw Object.assign(new Error("原资源已有新的修改，当前骨架草稿将保留，请重新保存为新资源。"), { code: "RESOURCE_CHANGED" });
  if (sameAuthoredProjectContent(existing, project)) return existing;
  const previous = Date.parse(existing?.updatedAt);
  return { ...project, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString() };
  });
};
export const trashProject = async (id) => {
  if (usesSharedWorkspace()) return workspaceCall("projects", "trash", id);
  return updateProject(id, (existing) => {
  if (!existing) throw new Error("资源不存在，请刷新资源库。");
  return { ...existing, deletedAt: existing.deletedAt || new Date().toISOString() };
  });
};
export const restoreProject = async (id) => {
  if (usesSharedWorkspace()) return workspaceCall("projects", "restore", id);
  return updateProject(id, (existing) => {
  if (!existing) throw new Error("资源不存在，请刷新资源库。");
  const { deletedAt, ...project } = existing;
  return { ...project, updatedAt: new Date().toISOString() };
  });
};

export async function permanentlyDeleteProjects(ids) {
  if (usesSharedWorkspace()) return workspaceCall("projects", "remove", ids);
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id))
    throw new Error("请先选择回收站中的资源。");
  const targets = [...new Set(ids)], db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["projects", "removedProjects"], "readwrite"),
      store = tx.objectStore("projects"), removed = tx.objectStore("removedProjects");
    let failure;
    for (const id of targets) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result?.deletedAt) {
          failure = new Error("只能永久删除仍在回收站中的资源，请刷新后重试。");
          tx.abort(); return;
        }
        // Retain only an ID tombstone, never character data, to reject stale autosaves.
        removed.put({ id, removedAt: new Date().toISOString() });
        store.delete(id);
      };
    }
    tx.oncomplete = () => resolve(targets.length);
    tx.onerror = () => { failure ||= new Error("永久删除失败，请重试。"); };
    tx.onabort = () => reject(failure || new Error("永久删除已中断。"));
  });
}
