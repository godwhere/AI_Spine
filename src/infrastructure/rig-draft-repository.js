import { createLegacyRigDatabase } from "./legacy-indexeddb.js";
import { usesSharedWorkspace } from "./workspace-client.js";
import { validateRigDraftDocument } from "../../shared/domain/draft.mjs";
import { workspaceCall } from "./workspace-client.js";

const { withTransaction } = createLegacyRigDatabase();
const sharedVersions = new Map();
async function saveRigDraft(document, options = {}) {
  const { resourceId, resourceUpdatedAt, previousDraftId } = options;
  if (resourceId !== undefined && resourceId !== null && (typeof resourceId !== "string" || !resourceId.trim()))
    throw new Error("骨架草稿关联的资源标识无效。");
  if (previousDraftId !== undefined && previousDraftId !== null && (typeof previousDraftId !== "string" || !previousDraftId.trim()))
    throw new Error("原骨架草稿标识无效。");
  const rig = validateRigDraftDocument(document);
  if (usesSharedWorkspace()) {
    const key = resourceId ? `resource-${resourceId}` : rig.id;
    const expectedUpdatedAt = Object.hasOwn(options, "expectedUpdatedAt") ? options.expectedUpdatedAt : sharedVersions.get(key);
    const saved = await workspaceCall("drafts", "save", rig, { resourceId, resourceUpdatedAt, previousDraftId, expectedUpdatedAt,
      mutationId: options.mutationId, previousDraftUpdatedAt: sharedVersions.get(previousDraftId) });
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
    const previous = tx.objectStore("metadata").get(id);
    previous.onsuccess = () => {
      try {
        if (options.expectedUpdatedAt !== undefined && previous.result?.updatedAt !== options.expectedUpdatedAt)
          throw Object.assign(new Error("其他工作台已修改这份草稿，本地修改仍保留，请重新打开或另存。"), { code: "DRAFT_CHANGED" });
        const timestamp = Date.parse(previous.result?.updatedAt);
        metadata.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(timestamp) ? timestamp + 1 : 0)).toISOString();
        tx.objectStore("metadata").put(metadata);
        tx.objectStore("documents").put({ id, document: rig });
        // Move only the explicitly selected prior draft, retaining independent owners.
        if (previousDraftId && previousDraftId !== id) {
          tx.objectStore("metadata").delete(previousDraftId);
          tx.objectStore("documents").delete(previousDraftId);
        }
      } catch (error) { failure = error; tx.abort(); }
    };
  }));
}

async function listRigDrafts() {
  if (usesSharedWorkspace()) return workspaceCall("drafts", "list");
  return withTransaction("metadata", "readonly", (tx) => new Promise((resolve, reject) => {
    const request = tx.objectStore("metadata").getAll();
    tx.oncomplete = () => resolve(request.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    tx.onabort = tx.onerror = () => reject(new Error("骨架草稿列表读取失败。"));
  }));
}

async function getRigDraft(id) {
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

export { getRigDraft, listRigDrafts, saveRigDraft };
